// Hauska MCP Server - Tool registrations.
//
// Five tools wired against the `hauska-engine` retrieval API per Stream 2A.
// Tool design principles:
//   1. Names are verbs describing what the agent wants done.
//   2. Descriptions are written for LLM consumption. Clear, no jargon.
//   3. Parameters use Zod for runtime validation. LLMs hallucinate.
//   4. Responses use the atom-shape envelope: original engine payload
//      under `data`, provenance entries (DID, content hash, source) under
//      `atoms`, and free-tier attribution under `meta.attribution`.
//   5. Tier-aware behavior reads from request-scoped AsyncLocalStorage so
//      tool handlers do not need access to the Express request.

import type { AccessPolicy } from "@hauska/atom-contract";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  codexEnvelope,
  codexProvenance,
  credentialPendingEnvelope,
  encumbrancesEnvelope,
  generateBriefEnvelope,
  getAtomEnvelope,
  getBriefRunEnvelope,
  getPlaceDossierEnvelope,
  getPlaceLayersEnvelope,
  getPropertyWorkspaceEnvelope,
  listJurisdictionsEnvelope,
  listPropertyWorkspacesEnvelope,
  listWorkspaceShareEdgesEnvelope,
  lSurfaceProvenance,
  queryJurisdictionEnvelope,
  resolvePlaceEnvelope,
  restrictionsEnvelope,
  searchAtomsEnvelope,
  searchPermitAtomsEnvelope,
  siteDrainageEnvelope,
  siteTopographyEnvelope,
  type ToolEnvelope,
} from "./atom-shape.js";
import {
  logToolInvocation,
  placeApiEnabled,
  type GtmErrorClass,
} from "./gtm-observability.js";
import { TOOL_COPY, CODEX_TIER, CORTEX_TIER } from "./tool-copy.js";
import {
  EngineHttpError,
  EngineUnreachableError,
  hauskaClient,
} from "./hauska-client.js";
import {
  LegacyHttpError,
  LegacyUnreachableError,
  legacyClient,
} from "./legacy-client.js";
import { logger } from "./logger.js";
import type { Product } from "./products.js";
import {
  canReadAccessTarget,
  effectiveAccessPolicy,
  filterByAccessPolicy,
  logAccessDenied,
  readSharedWithTenants,
} from "./access-policy.js";
import {
  provenanceEntriesFromFindings,
  type FindingWire,
} from "./codex-citation-lineage.js";
import { assertSubmissionPartitionReadable } from "./codex-submission-tenant.js";
import {
  getCurrentAccessSubject,
  getCurrentAuthContext,
  getCurrentProduct,
  getCurrentTier,
} from "./request-context.js";

const ATOM_DID_REGEX = /^did:hauska:[a-z-]+:[^\s]+$/;

const FINDING_CITATION_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("code-section"),
    atomId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("briefing-source"),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
]);

const CODE_ENTITY_TYPES = [
  "code-section",
  "code-definition",
  "code-amendment",
  "code-cross-reference",
  "code-edition",
  "jurisdiction-corpus",
] as const;

function envelopeContent<T>(envelope: ToolEnvelope<T>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}

function errorContent(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function describeEngineFailure(tool: string, err: unknown): string {
  if (err instanceof EngineUnreachableError) {
    logger.error("tool_engine_unreachable", { tool, url: err.url });
    return `Hauska Engine is unreachable. The retrieval backend at ${err.url} did not respond. Try again or contact support@hauska.dev if the outage persists.`;
  }
  if (err instanceof EngineHttpError) {
    logger.warn("tool_engine_http_error", {
      tool,
      status: err.status,
      url: err.url,
    });
    if (err.status >= 500) {
      return "Hauska Engine returned a server error. Engineering has been notified.";
    }
    return `Hauska Engine rejected the request (${err.status}): ${err.body.slice(0, 200)}`;
  }
  logger.error("tool_unknown_error", { tool, error: String(err) });
  return `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`;
}

function legacyErrorClass(err: unknown): GtmErrorClass {
  if (err instanceof LegacyUnreachableError) return "upstream_timeout";
  if (err instanceof LegacyHttpError) {
    if (err.status === 401 || err.status === 403) return "auth_reject";
    if (err.status === 404) return "no_coverage";
    if (err.status >= 500) return "upstream_timeout";
    return "validation_error";
  }
  return "unknown";
}

function describeLegacyFailure(tool: string, err: unknown): string {
  if (err instanceof LegacyUnreachableError) {
    logger.error("tool_legacy_unreachable", { tool, url: err.url });
    return `Codex backend is unreachable. ${err.url} did not respond. Try again or contact support@hauska.dev if the outage persists.`;
  }
  if (err instanceof LegacyHttpError) {
    logger.warn("tool_legacy_http_error", {
      tool,
      status: err.status,
      url: err.url,
    });
    if (err.status >= 500) {
      return "Codex backend returned a server error. Engineering has been notified.";
    }
    if (err.status === 404) {
      return `Codex backend returned 404: ${err.body.slice(0, 200)}`;
    }
    if (err.status === 409) {
      return `Codex backend returned a conflict (409): ${err.body.slice(0, 200)}`;
    }
    return `Codex backend rejected the request (${err.status}): ${err.body.slice(0, 200)}`;
  }
  logger.error("tool_unknown_error", { tool, error: String(err) });
  return `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`;
}

// Visibility partition for `list_jurisdictions`. Unauthenticated
// (free_anonymous) callers get the `["public-free"]` allow-list, which
// the engine applies at the storage layer (snapshots with an absent
// `accessPolicy` are treated as public-free engine-side). Authenticated
// callers get `undefined` — no filter, every jurisdiction including
// partnership-pending `platform-internal` ones.
//
// Exported for direct testing without a full McpServer round-trip.
export function accessPoliciesForTier(
  tier: ReturnType<typeof getCurrentTier>,
): ReadonlyArray<AccessPolicy> | undefined {
  return tier === "free_anonymous" ? ["public-free"] : undefined;
}

function atomInstanceAccessTarget(
  atom: Record<string, unknown> & { jurisdictionTenant: string },
) {
  const accessPolicy =
    typeof atom.accessPolicy === "string"
      ? (atom.accessPolicy as AccessPolicy)
      : undefined;
  return {
    accessPolicy,
    jurisdictionTenant: atom.jurisdictionTenant,
    sharedWithTenants: readSharedWithTenants(atom),
  };
}

function assertAtomReadable(
  tool: string,
  atom: Record<string, unknown> & { jurisdictionTenant: string },
): boolean {
  const subject = getCurrentAccessSubject();
  const target = atomInstanceAccessTarget(atom);
  if (canReadAccessTarget(subject, target)) return true;
  logAccessDenied({
    tool,
    policy: effectiveAccessPolicy(target),
    atomJurisdiction: target.jurisdictionTenant,
    subjectTenant: subject.jurisdictionTenant,
    platformInternal: subject.platformInternal,
    reason: "single_atom_read",
  });
  return false;
}

// Product gate. Returns a 4xx-shaped error envelope when the caller's
// product does not include this tool's product. Mirrors the
// errorContent() helper so callers see a consistent isError envelope.
//
// Exported for direct testing of the gate semantics under various
// AsyncLocalStorage bindings without spinning up a full McpServer.
export function requireProduct(
  tool: string,
  expected: Product,
): { ok: true } | { ok: false; content: ReturnType<typeof errorContent> } {
  const actual = getCurrentProduct();
  if (actual === expected) return { ok: true };
  logger.warn("tool_product_denied", { tool, expected, actual });
  return {
    ok: false,
    content: errorContent(
      `Tool "${tool}" requires a "${expected}"-product API key. The caller is on product "${actual}". Contact support@hauska.dev to request access.`,
    ),
  };
}

function requireIdentifiedCaller(
  tool: string,
): { ok: true; requesterKeyId: string } | {
  ok: false;
  content: ReturnType<typeof errorContent>;
} {
  const keyId = getCurrentAuthContext()?.key_id;
  if (typeof keyId === "string" && keyId.length > 0) {
    return { ok: true, requesterKeyId: keyId };
  }
  logger.warn("tool_identity_required", { tool });
  return {
    ok: false,
    content: errorContent(
      `Tool "${tool}" requires an authenticated API key so owner/collaborator access can be verified.`,
    ),
  };
}

export function registerTools(server: McpServer) {
  // -----------------------------------------------------------------
  // Tool 1: search_atoms
  // Free-text search over the ingested code corpus.
  // -----------------------------------------------------------------
  server.tool(
    "search_atoms",
    TOOL_COPY.search_atoms,
    {
      query: z.string().min(1).describe("Free-text search query. Required."),
      jurisdiction: z
        .string()
        .optional()
        .describe(
          'Jurisdiction tenant identifier (e.g. "bastrop-tx"). Defaults to all loaded jurisdictions.',
        ),
      entity_type: z
        .enum(CODE_ENTITY_TYPES)
        .optional()
        .describe(
          "Restrict results to a single atom type. Defaults to all types.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(25)
        .describe("Maximum number of atom references to return. Defaults to 25."),
    },
    async ({ query, jurisdiction, entity_type, limit }) => {
      const tier = getCurrentTier();
      try {
        const response = await hauskaClient.searchAtoms({
          query,
          jurisdiction,
          entityType: entity_type,
          limit,
        });
        const subject = getCurrentAccessSubject();
        const filtered = filterByAccessPolicy(
          response.results,
          subject,
          (r) => ({
            accessPolicy: r.accessPolicy,
            jurisdictionTenant: r.jurisdictionTenant,
          }),
          { tool: "search_atoms" },
        );
        const filteredResponse = { ...response, results: filtered };
        logToolInvocation({
          tool: "search_atoms",
          query,
          jurisdiction,
          entity_type,
          tier,
          count: filtered.length,
          pre_filter_count: response.results.length,
        });
        return envelopeContent(searchAtomsEnvelope(filteredResponse, { tier }));
      } catch (err) {
        return errorContent(describeEngineFailure("search_atoms", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2: get_atom
  // Retrieve a specific atom by DID with provenance.
  // -----------------------------------------------------------------
  server.tool(
    "get_atom",
    TOOL_COPY.get_atom,
    {
      atom_id: z
        .string()
        .regex(ATOM_DID_REGEX, "atom_id must be a DID of the form did:hauska:<entityType>:<localId>")
        .describe(
          "Atom DID: did:hauska:<entityType>:<localId>. Required.",
        ),
      include_composition: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return composition-resolved children of this atom. Defaults to false.",
        ),
    },
    async ({ atom_id, include_composition }) => {
      const tier = getCurrentTier();
      try {
        const response = await hauskaClient.getAtom({
          atomDid: atom_id,
          includeComposition: include_composition,
        });
        logToolInvocation({
          tool: "get_atom",
          atom_id,
          tier,
          found: response.atom !== null,
          composition_count: response.composition?.length ?? 0,
        });
        if (!response.atom) {
          return envelopeContent(
            getAtomEnvelope(response, {
              tier,
              note: `No atom found at DID ${atom_id}.`,
            }),
          );
        }
        if (!assertAtomReadable("get_atom", response.atom)) {
          return envelopeContent(
            getAtomEnvelope({ atom: null, composition: [] }, {
              tier,
              note: `No atom found at DID ${atom_id}.`,
            }),
          );
        }
        const composition = response.composition?.filter(
          (edge) => edge.atom && assertAtomReadable("get_atom", edge.atom),
        );
        return envelopeContent(
          getAtomEnvelope(
            { ...response, composition },
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(describeEngineFailure("get_atom", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 3: query_jurisdiction
  // Jurisdiction-scoped lookup. v1 returns the loaded edition + quality
  // bar. Parcel-level lookups (zoning, setbacks by parcel) are Bump 2;
  // dropped here per Phase 0.
  // -----------------------------------------------------------------
  server.tool(
    "query_jurisdiction",
    TOOL_COPY.query_jurisdiction,
    {
      jurisdiction: z
        .string()
        .min(1)
        .describe(
          'Jurisdiction tenant identifier (e.g. "bastrop-tx"). Required.',
        ),
      query_type: z
        .enum(["summary"])
        .optional()
        .default("summary")
        .describe(
          'Only "summary" is supported at v1. Per-parcel querying is Bump 2.',
        ),
    },
    async ({ jurisdiction, query_type }) => {
      const tier = getCurrentTier();
      try {
        const response = await hauskaClient.queryJurisdiction({
          jurisdiction,
          queryType: query_type,
        });
        logToolInvocation({
          tool: "query_jurisdiction",
          jurisdiction,
          tier,
          found: response.status !== null,
        });
        if (!response.status) {
          return envelopeContent(
            queryJurisdictionEnvelope(response, {
              tier,
              note: `Jurisdiction "${jurisdiction}" is not loaded. Call list_jurisdictions to see available tenants.`,
            }),
          );
        }
        const subject = getCurrentAccessSubject();
        const statusReadable = canReadAccessTarget(subject, {
          accessPolicy: response.status.accessPolicy,
          jurisdictionTenant: response.status.jurisdictionTenant,
        });
        if (!statusReadable) {
          logAccessDenied({
            tool: "query_jurisdiction",
            policy: effectiveAccessPolicy({
              accessPolicy: response.status.accessPolicy,
              jurisdictionTenant: response.status.jurisdictionTenant,
            }),
            atomJurisdiction: response.status.jurisdictionTenant,
            subjectTenant: subject.jurisdictionTenant,
            platformInternal: subject.platformInternal,
            reason: "jurisdiction_status",
          });
          return envelopeContent(
            queryJurisdictionEnvelope({ status: null }, {
              tier,
              note: `Jurisdiction "${jurisdiction}" is not loaded. Call list_jurisdictions to see available tenants.`,
            }),
          );
        }
        const permitAtoms = response.permitAtoms
          ? filterByAccessPolicy(
              response.permitAtoms,
              subject,
              (r) => ({
                accessPolicy: r.accessPolicy,
                jurisdictionTenant: r.jurisdictionTenant,
              }),
              { tool: "query_jurisdiction" },
            )
          : undefined;
        return envelopeContent(
          queryJurisdictionEnvelope({ ...response, permitAtoms }, { tier }),
        );
      } catch (err) {
        return errorContent(describeEngineFailure("query_jurisdiction", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 4: search_permit_atoms
  // Renamed from get_permit_requirements per Phase 0. Honest Layer 1
  // retrieval: returns permit-tagged code atoms matching a project type
  // description. The engine does NOT infer "what permits do I need" —
  // that is engine-side reasoning, deferred to a paid tier per
  // 29_mcp_surface_tier_model.md.
  // -----------------------------------------------------------------
  server.tool(
    "search_permit_atoms",
    TOOL_COPY.search_permit_atoms,
    {
      jurisdiction: z
        .string()
        .min(1)
        .describe(
          'Jurisdiction tenant identifier (e.g. "bastrop-tx"). Required.',
        ),
      project_type: z
        .string()
        .min(1)
        .describe(
          'Project type description. Examples: "single-family residence", ' +
            '"commercial tenant finishout", "multifamily new construction", "ADU".',
        ),
    },
    async ({ jurisdiction, project_type }) => {
      const tier = getCurrentTier();
      try {
        const response = await hauskaClient.searchPermitAtoms({
          jurisdiction,
          projectType: project_type,
        });
        const subject = getCurrentAccessSubject();
        const permitAtoms = response.permitAtoms
          ? filterByAccessPolicy(
              response.permitAtoms,
              subject,
              (r) => ({
                accessPolicy: r.accessPolicy,
                jurisdictionTenant: r.jurisdictionTenant,
              }),
              { tool: "search_permit_atoms" },
            )
          : undefined;
        logToolInvocation({
          tool: "search_permit_atoms",
          jurisdiction,
          project_type,
          tier,
          count: permitAtoms?.length ?? 0,
        });
        return envelopeContent(
          searchPermitAtomsEnvelope({ ...response, permitAtoms }, { tier }),
        );
      } catch (err) {
        return errorContent(describeEngineFailure("search_permit_atoms", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 5: list_jurisdictions
  // Discovery. Returns all loaded jurisdictions with quality status.
  // -----------------------------------------------------------------
  server.tool(
    "list_jurisdictions",
    TOOL_COPY.list_jurisdictions,
    {
      quality_bar_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return only jurisdictions whose eval-harness quality bar is passing.",
        ),
    },
    async ({ quality_bar_only }) => {
      const tier = getCurrentTier();
      // Visibility filter per Lane Foundation v1.1.0 and the 2026-05-19
      // sprint pre-mortem Path A resolution. The partition is applied
      // engine-side at the storage layer: unauthenticated callers send
      // `accessPolicies=public-free`, authenticated callers send no
      // filter. Replaces the prior client-side filter shim now that the
      // engine retrieval API exposes the `accessPolicies` query param.
      const accessPolicies = accessPoliciesForTier(tier);
      try {
        const response = await hauskaClient.listJurisdictions({
          qualityBarOnly: quality_bar_only,
          ...(accessPolicies !== undefined ? { accessPolicies } : {}),
        });
        const subject = getCurrentAccessSubject();
        const jurisdictions = filterByAccessPolicy(
          response.jurisdictions,
          subject,
          (j) => ({
            accessPolicy: j.accessPolicy,
            jurisdictionTenant: j.jurisdictionTenant,
          }),
          { tool: "list_jurisdictions" },
        );
        logToolInvocation({
          tool: "list_jurisdictions",
          tier,
          count: jurisdictions.length,
          public_filtered: accessPolicies !== undefined,
          quality_bar_only,
        });
        return envelopeContent(
          listJurisdictionsEnvelope({ jurisdictions }, { tier }),
        );
      } catch (err) {
        return errorContent(describeEngineFailure("list_jurisdictions", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Brokerage tool 1: list_property_workspaces
  // List owner/collaborator-visible workspaces, newest-first.
  // -----------------------------------------------------------------
  server.tool(
    "list_property_workspaces",
    TOOL_COPY.list_property_workspaces,
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(25)
        .describe("Maximum number of workspace summaries to return. Defaults to 25."),
    },
    async ({ limit }) => {
      const identity = requireIdentifiedCaller("list_property_workspaces");
      if (!identity.ok) return identity.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listPropertyWorkspaces({
          requesterKeyId: identity.requesterKeyId,
          limit,
        });
        logToolInvocation({
          tool: "list_property_workspaces",
          requester_key_id: identity.requesterKeyId,
          tier,
          count: response.workspaces.length,
        });
        return envelopeContent(listPropertyWorkspacesEnvelope(response, { tier }));
      } catch (err) {
        return errorContent(describeLegacyFailure("list_property_workspaces", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Brokerage tool 2: get_property_workspace
  // Fetch full workspace package (owner/collaborator gated).
  // -----------------------------------------------------------------
  server.tool(
    "get_property_workspace",
    TOOL_COPY.get_property_workspace,
    {
      workspace_id: z.string().min(1).describe("Stable workspace id. Required."),
    },
    async ({ workspace_id }) => {
      const identity = requireIdentifiedCaller("get_property_workspace");
      if (!identity.ok) return identity.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getPropertyWorkspace({
          workspaceId: workspace_id,
          requesterKeyId: identity.requesterKeyId,
        });
        logToolInvocation({
          tool: "get_property_workspace",
          workspace_id,
          requester_key_id: identity.requesterKeyId,
          tier,
          found: response.workspace !== null,
        });
        return envelopeContent(getPropertyWorkspaceEnvelope(response, { tier }));
      } catch (err) {
        return errorContent(describeLegacyFailure("get_property_workspace", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Brokerage tool 3: list_workspace_share_edges
  // Consent-aware share-edge visibility for one workspace.
  // -----------------------------------------------------------------
  server.tool(
    "list_workspace_share_edges",
    TOOL_COPY.list_workspace_share_edges,
    {
      workspace_id: z.string().min(1).describe("Stable workspace id. Required."),
      consent_visible_only: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "If true, return only consent-visible edges. Defaults to true.",
        ),
    },
    async ({ workspace_id, consent_visible_only }) => {
      const identity = requireIdentifiedCaller("list_workspace_share_edges");
      if (!identity.ok) return identity.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listWorkspaceShareEdges({
          workspaceId: workspace_id,
          requesterKeyId: identity.requesterKeyId,
          consentVisibleOnly: consent_visible_only,
        });
        logToolInvocation({
          tool: "list_workspace_share_edges",
          workspace_id,
          requester_key_id: identity.requesterKeyId,
          tier,
          consent_visible_only,
          count: response.edges.length,
        });
        return envelopeContent(listWorkspaceShareEdgesEnvelope(response, { tier }));
      } catch (err) {
        return errorContent(describeLegacyFailure("list_workspace_share_edges", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Place tool 1: resolve_place
  // -----------------------------------------------------------------
  server.tool(
    "resolve_place",
    TOOL_COPY.resolve_place,
    {
      address: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Street address to geocode (e.g. "1311 Main St, Bastrop, TX"). Provide address OR lat+lng.',
        ),
      lat: z.number().optional().describe("Latitude. Required with lng if address omitted."),
      lng: z.number().optional().describe("Longitude. Required with lat if address omitted."),
    },
    async ({ address, lat, lng }) => {
      const identity = requireIdentifiedCaller("resolve_place");
      if (!identity.ok) return identity.content;
      if (!placeApiEnabled()) {
        logToolInvocation({
          tool: "resolve_place",
          error_class: "feature_disabled",
        });
        return errorContent(
          "Place API is not enabled on this deployment (PLACE_API_ENABLED≠true). " +
            "Operator enables after cortex-api place routes ship.",
        );
      }
      if (!address && (lat === undefined || lng === undefined)) {
        logToolInvocation({
          tool: "resolve_place",
          error_class: "validation_error",
        });
        return errorContent("resolve_place: provide address or both lat and lng.");
      }
      const tier = getCurrentTier();
      const started = Date.now();
      try {
        const response = await legacyClient.resolvePlace({
          requesterKeyId: identity.requesterKeyId,
          address,
          lat,
          lng,
        });
        logToolInvocation({
          tool: "resolve_place",
          tier,
          jurisdiction_key: response.jurisdiction_key,
          latency_ms: Date.now() - started,
          place_key: response.placeKey,
        });
        return envelopeContent(resolvePlaceEnvelope(response, { tier }));
      } catch (err) {
        logToolInvocation({
          tool: "resolve_place",
          tier,
          error_class: legacyErrorClass(err),
          latency_ms: Date.now() - started,
        });
        return errorContent(describeLegacyFailure("resolve_place", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Place tool 2: get_place_layers
  // -----------------------------------------------------------------
  server.tool(
    "get_place_layers",
    TOOL_COPY.get_place_layers,
    {
      place_key: z.string().min(1).describe("placeKey from resolve_place. Required."),
    },
    async ({ place_key }) => {
      const identity = requireIdentifiedCaller("get_place_layers");
      if (!identity.ok) return identity.content;
      if (!placeApiEnabled()) {
        logToolInvocation({
          tool: "get_place_layers",
          error_class: "feature_disabled",
        });
        return errorContent(
          "Place API is not enabled on this deployment (PLACE_API_ENABLED≠true).",
        );
      }
      const tier = getCurrentTier();
      const started = Date.now();
      try {
        const response = await legacyClient.getPlaceLayers({
          placeKey: place_key,
          requesterKeyId: identity.requesterKeyId,
        });
        const atomCount = response.layers.filter((l) => l.atomDid).length;
        logToolInvocation({
          tool: "get_place_layers",
          tier,
          jurisdiction_key: response.jurisdiction_key,
          latency_ms: Date.now() - started,
          atom_ids_returned: atomCount,
          layer_count: response.layers.length,
        });
        return envelopeContent(getPlaceLayersEnvelope(response, { tier }));
      } catch (err) {
        logToolInvocation({
          tool: "get_place_layers",
          tier,
          error_class: legacyErrorClass(err),
          latency_ms: Date.now() - started,
        });
        return errorContent(describeLegacyFailure("get_place_layers", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Place tool 3: get_place_dossier
  // -----------------------------------------------------------------
  server.tool(
    "get_place_dossier",
    TOOL_COPY.get_place_dossier,
    {
      place_key: z.string().min(1).describe("placeKey from resolve_place. Required."),
    },
    async ({ place_key }) => {
      const identity = requireIdentifiedCaller("get_place_dossier");
      if (!identity.ok) return identity.content;
      if (!placeApiEnabled()) {
        logToolInvocation({
          tool: "get_place_dossier",
          error_class: "feature_disabled",
        });
        return errorContent(
          "Place API is not enabled on this deployment (PLACE_API_ENABLED≠true).",
        );
      }
      const tier = getCurrentTier();
      const started = Date.now();
      try {
        const response = await legacyClient.getPlaceDossier({
          placeKey: place_key,
          requesterKeyId: identity.requesterKeyId,
        });
        const refCount =
          (response.inlineRefs?.length ?? 0) + (response.layers?.length ?? 0);
        logToolInvocation({
          tool: "get_place_dossier",
          tier,
          jurisdiction_key: response.jurisdiction_key,
          latency_ms: Date.now() - started,
          atom_ids_returned: refCount,
        });
        return envelopeContent(getPlaceDossierEnvelope(response, { tier }));
      } catch (err) {
        logToolInvocation({
          tool: "get_place_dossier",
          tier,
          error_class: legacyErrorClass(err),
          latency_ms: Date.now() - started,
        });
        return errorContent(describeLegacyFailure("get_place_dossier", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Codex tool 1: codex_finding_generation
  // Kicks off engine full-pass mode against a submission. Returns the
  // generationId so the agent can poll status, OR the in-flight job's
  // generationId if a single-flight race lost.
  // Wraps POST /api/submissions/:submissionId/findings/generate.
  // Gate: product='codex' required.
  // -----------------------------------------------------------------
  server.tool(
    "codex_finding_generation",
    "Codex (plan review): kick off engine finding generation against an existing submission. " +
      "Returns the generationId for status polling. If a finding-generation job is already in " +
      "flight for the submission, returns that job's generationId with alreadyInFlight=true " +
      "rather than starting a new one. " + CODEX_TIER,
    {
      submission_id: z
        .string()
        .uuid()
        .describe(
          "UUID of the submission to generate findings against. Required.",
        ),
    },
    async ({ submission_id }) => {
      const gate = requireProduct("codex_finding_generation", "codex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.generateFindings({
          submissionId: submission_id,
        });
        logToolInvocation({
          tool: "codex_finding_generation",
          submission_id,
          tier,
          generation_id: response.generationId,
          already_in_flight: response.alreadyInFlight ?? false,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            codexProvenance({
              atomKind: "finding-generation-run",
              rowId: response.generationId,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/submissions/${submission_id}/findings/generate`,
            }),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("codex_finding_generation", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Codex tool 1b: codex_findings_fetch (P0a citation lineage)
  // Returns persisted findings with citations[].atomId verbatim plus
  // optional generation status (rail-quiet: no calibration grade fields).
  // Tenant-scoped via ADR-005 Layer A (#29).
  // -----------------------------------------------------------------
  server.tool(
    "codex_findings_fetch",
    "Codex (plan review): fetch findings for a submission after generation. " +
      "Returns data.findings[].citations with atom ids as stored on the server, " +
      "plus envelope atoms for cited code-section DIDs. Optionally includes " +
      "generation status (generationId, state, timestamps) without calibration " +
      "grade fields. Chain after codex_finding_generation when polling for " +
      "completed findings with citation lineage. " + CODEX_TIER,
    {
      submission_id: z
        .string()
        .uuid()
        .describe("UUID of the submission to list findings for. Required."),
      include_status: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "When true (default), include rail-quiet generation status alongside findings.",
        ),
    },
    async ({ submission_id, include_status }) => {
      const gate = requireProduct("codex_findings_fetch", "codex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      try {
        let submissionTenant: string | undefined;
        let statusPublic:
          | {
              generationId: string | null;
              state: string;
              startedAt: string | null;
              completedAt: string | null;
              error: string | null;
            }
          | undefined;

        if (include_status) {
          const statusRaw = await legacyClient.getFindingGenerationStatus({
            submissionId: submission_id,
          });
          submissionTenant = statusRaw.jurisdictionTenant;
          statusPublic = {
            generationId: statusRaw.generationId,
            state: statusRaw.state,
            startedAt: statusRaw.startedAt,
            completedAt: statusRaw.completedAt,
            error: statusRaw.error,
          };
        }

        const findingsResponse = await legacyClient.fetchSubmissionFindings({
          submissionId: submission_id,
        });
        submissionTenant =
          submissionTenant ?? findingsResponse.jurisdictionTenant;

        const partition = assertSubmissionPartitionReadable(
          subject,
          submissionTenant,
          "codex_findings_fetch",
        );
        if (!partition.ok) {
          return errorContent(partition.message);
        }

        const findings = findingsResponse.findings as FindingWire[];
        const citationAtomCount = findings.reduce(
          (n, f) =>
            n +
            (f.citations?.filter((c) => c.kind === "code-section").length ?? 0),
          0,
        );
        const atoms = provenanceEntriesFromFindings(
          findings,
          submission_id,
          partition.submissionTenant,
        );

        logToolInvocation({
          tool: "codex_findings_fetch",
          submission_id,
          tier,
          finding_count: findings.length,
          citation_atom_count: citationAtomCount,
          submission_tenant: partition.submissionTenant,
        });

        const data: Record<string, unknown> = { findings };
        if (include_status && statusPublic) {
          data.status = statusPublic;
        }

        return envelopeContent(
          codexEnvelope(data, atoms, { tier }),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("codex_findings_fetch", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Codex tool 2: codex_override_write
  // Writes a reviewer-authored revision finding against an existing
  // finding atom. Wraps POST /api/findings/:findingId/override.
  // Note: known carry-over from PR #20 close-out: the 409
  // finding_already_overridden envelope does not carry resolvedBy /
  // resolvedAt fields, so cross-tab race attribution is partial. Tool
  // callers should not rely on those fields when handling 409.
  // -----------------------------------------------------------------
  server.tool(
    "codex_override_write",
    "Codex (plan review): write a reviewer-authored override revision against an existing " +
      "finding. Pass the finding atom id plus the new text, severity (blocker / concern / advisory), " +
      "category (setback / height / coverage / egress / use / overlay-conflict / divergence-related / " +
      "other), optional citations[] (code-section atomId or briefing-source id/label), and an optional " +
      "reviewer comment. A finding can be overridden ONCE; a second override returns a 409 conflict. " +
      CODEX_TIER,
    {
      finding_id: z
        .string()
        .min(1)
        .describe("Finding atom id to override. Required."),
      text: z
        .string()
        .min(1)
        .describe("Reviewer-authored finding body. Required."),
      severity: z
        .enum(["blocker", "concern", "advisory"])
        .describe(
          "Finding severity: blocker (code violation requiring resolution), " +
            "concern (ambiguity or risk), advisory (preference / coordination note). Required.",
        ),
      category: z
        .enum([
          "setback",
          "height",
          "coverage",
          "egress",
          "use",
          "overlay-conflict",
          "divergence-related",
          "other",
        ])
        .describe("Finding category. Required."),
      reviewer_comment: z
        .string()
        .optional()
        .describe(
          "Optional reviewer comment captured alongside the override. Surfaces in the audit chain.",
        ),
      citations: z
        .array(FINDING_CITATION_SCHEMA)
        .optional()
        .describe(
          "Citation lineage to preserve on the override revision. Code-section entries carry atomId verbatim; briefing-source entries carry id and label.",
        ),
    },
    async ({ finding_id, text, severity, category, reviewer_comment, citations }) => {
      const gate = requireProduct("codex_override_write", "codex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.overrideFinding({
          findingId: finding_id,
          text,
          severity,
          category,
          reviewerComment: reviewer_comment,
          citations,
        });
        const overrideFinding = response.finding as FindingWire | undefined;
        const overrideAtoms =
          overrideFinding && Array.isArray(overrideFinding.citations)
            ? provenanceEntriesFromFindings(
                [overrideFinding],
                String(overrideFinding.submissionId ?? "unknown"),
                getCurrentAccessSubject().jurisdictionTenant ?? "legacy",
              )
            : [];
        logToolInvocation({
          tool: "codex_override_write",
          finding_id,
          severity,
          category,
          tier,
          citation_count: citations?.length ?? 0,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            overrideAtoms.length > 0
              ? overrideAtoms
              : codexProvenance({
                  atomKind: "finding-override",
                  rowId: finding_id,
                  jurisdictionTenant: "legacy",
                  sourcePath: `/api/findings/${finding_id}/override`,
                }),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("codex_override_write", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Codex tool 3: codex_briefing_fetch
  // Returns the engagement's parcel briefing as a wire object, or null
  // when no briefing has been uploaded yet. Wraps
  // GET /api/engagements/:id/briefing.
  // -----------------------------------------------------------------
  server.tool(
    "codex_briefing_fetch",
    "Codex (plan review): fetch the parcel briefing for an engagement. " +
      "Returns the briefing wire shape or { briefing: null } when no briefing has been uploaded " +
      "yet. A 404 means the engagement id is unknown (input error, not empty result). " +
      CODEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement to fetch the briefing for. Required."),
    },
    async ({ engagement_id }) => {
      const gate = requireProduct("codex_briefing_fetch", "codex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.fetchBriefing({
          engagementId: engagement_id,
        });
        logToolInvocation({
          tool: "codex_briefing_fetch",
          engagement_id,
          tier,
          has_briefing: response.briefing !== null,
        });
        const provenance = response.briefing
          ? codexProvenance({
              atomKind: "parcel-briefing",
              rowId: engagement_id,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/engagements/${engagement_id}/briefing`,
            })
          : null;
        return envelopeContent(codexEnvelope(response, provenance, { tier }));
      } catch (err) {
        return errorContent(
          describeLegacyFailure("codex_briefing_fetch", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Codex tool 4: codex_snapshot_ingest
  // Records that a plan-review package has been submitted to the
  // jurisdiction. Wraps POST /api/engagements/:id/submissions.
  // Downstream pipelines (auto-trigger classification + auto-trigger
  // finding generation) fire automatically against the inserted row.
  //
  // Naming note: the Lane B dispatch named this tool snapshot_ingest
  // matching its "PDF + metadata snapshot" intent. The legacy backend's
  // /snapshots route is Cortex-side (Revit add-in model snapshots); the
  // Codex-side analog is /engagements/:id/submissions. Surfacing as
  // codex_snapshot_ingest preserves dispatch naming while wrapping the
  // correct endpoint. Flagged in session summary for planner ratification.
  // -----------------------------------------------------------------
  server.tool(
    "codex_snapshot_ingest",
    "Codex (plan review): record a plan-review submission against an engagement. The legacy " +
      "backend auto-triggers classification + finding generation downstream from the inserted " +
      "row; chain into codex_finding_generation if you want to poll status explicitly. " +
      "Optional discipline tag filters the canned-finding library on the reviewer side. " +
      CODEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe(
          "UUID of the engagement this submission belongs to. Required.",
        ),
      note: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'Optional free-text note (e.g. "Permit set v1, all sheets cleaned."). 2KB cap; rejected with 400 if longer.',
        ),
      discipline: z
        .enum(["building", "fire", "zoning", "civil"])
        .optional()
        .describe(
          "Optional discipline tag. Drives the reviewer's canned-finding library default.",
        ),
    },
    async ({ engagement_id, note, discipline }) => {
      const gate = requireProduct("codex_snapshot_ingest", "codex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.createSubmission({
          engagementId: engagement_id,
          note,
          discipline,
        });
        const submissionId =
          typeof response.submission?.id === "string"
            ? response.submission.id
            : engagement_id;
        logToolInvocation({
          tool: "codex_snapshot_ingest",
          engagement_id,
          submission_id: submissionId,
          discipline,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            codexProvenance({
              atomKind: "submission",
              rowId: submissionId,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/engagements/${engagement_id}/submissions`,
            }),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("codex_snapshot_ingest", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Cortex tool 1: cortex_snapshot_register
  // Registers a Cortex (design accelerator) snapshot against an existing
  // engagement (or creates a new engagement via projectName branch).
  // Wraps POST /api/snapshots, which uses the x-snapshot-secret service
  // auth path. Gate: product='cortex' required.
  // -----------------------------------------------------------------
  server.tool(
    "cortex_snapshot_register",
    "Cortex (design accelerator): register a versioned design snapshot. Provide engagement_id " +
      "to attach to an existing engagement, OR project_name (plus optional revit_central_guid / " +
      "revit_document_path) to create a new engagement at the same time. The payload object " +
      "carries the Revit add-in's snapshot fields (project metadata, sheet refs, address, etc.). " +
      CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "UUID of an existing engagement to attach the snapshot to. " +
            "Mutually exclusive with project_name.",
        ),
      project_name: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Name for a new engagement when no engagement_id is supplied. " +
            "Mutually exclusive with engagement_id.",
        ),
      revit_central_guid: z
        .string()
        .optional()
        .describe(
          "Revit central document GUID. Only meaningful when project_name is supplied.",
        ),
      revit_document_path: z
        .string()
        .optional()
        .describe(
          "Revit document path. Only meaningful when project_name is supplied.",
        ),
      payload: z
        .record(z.unknown())
        .describe(
          "Snapshot payload object (project metadata, sheets, address, etc.). " +
            "Passed through to the legacy backend after engagement-id / project-name routing.",
        ),
    },
    async ({
      engagement_id,
      project_name,
      revit_central_guid,
      revit_document_path,
      payload,
    }) => {
      const gate = requireProduct("cortex_snapshot_register", "cortex");
      if (!gate.ok) return gate.content;
      if (!engagement_id && !project_name) {
        return errorContent(
          "cortex_snapshot_register requires either engagement_id (attach to existing engagement) or project_name (create new engagement).",
        );
      }
      if (engagement_id && project_name) {
        return errorContent(
          "cortex_snapshot_register: engagement_id and project_name are mutually exclusive.",
        );
      }
      const tier = getCurrentTier();
      try {
        const response = engagement_id
          ? await legacyClient.registerSnapshot({ engagementId: engagement_id, payload })
          : await legacyClient.registerSnapshot({
              projectName: project_name as string,
              revitCentralGuid: revit_central_guid,
              revitDocumentPath: revit_document_path,
              payload,
            });
        const rowId =
          (typeof response["snapshotId"] === "string" && response["snapshotId"]) ||
          (typeof response["id"] === "string" && response["id"]) ||
          (engagement_id ?? "unknown");
        logToolInvocation({
          tool: "cortex_snapshot_register",
          engagement_id,
          project_name,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            codexProvenance({
              atomKind: "submission",
              rowId,
              jurisdictionTenant: "legacy",
              sourcePath: "/api/snapshots",
            }),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_snapshot_register", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Cortex tool 2: cortex_ifc_ingest
  // Uploads an IFC file against a registered snapshot. Accepts the IFC
  // bytes as base64; decodes to a buffer and POSTs as multipart/form-data
  // to /api/snapshots/:id/ifc. Triggers lib/ifcIngest.ts on the legacy
  // side. Known carry-over: IFC import has unresolved failure modes per
  // the sprint decision record; this tool surfaces raw legacy responses
  // so callers see whatever the backend returns. Gate: product='cortex'.
  // -----------------------------------------------------------------
  server.tool(
    "cortex_ifc_ingest",
    "Cortex (design accelerator): ingest an IFC file against an existing snapshot. " +
      "Pass the IFC bytes as base64 plus a filename. The legacy backend parses the IFC and " +
      "emits a bim-model atom symmetric with Push-to-Revit. Practical size limit applies " +
      "(MCP JSON-RPC message envelopes are bounded by client implementations; typical IFC " +
      "files of a few MB are fine, very large models may need a different ingest path). " +
      "Known issue: IFC import has unresolved failure modes carried over from the prior " +
      "sprint; this tool surfaces raw legacy responses so callers see backend errors directly. " +
      CORTEX_TIER,
    {
      snapshot_id: z
        .string()
        .uuid()
        .describe("UUID of the snapshot to attach the IFC to. Required."),
      filename: z
        .string()
        .min(1)
        .describe(
          'IFC filename (e.g. "Project.ifc"). Required; used for multipart field metadata.',
        ),
      ifc_base64: z
        .string()
        .min(1)
        .describe(
          "Base64-encoded IFC file bytes. Required. " +
            "The MCP server decodes to a Buffer before POSTing to the legacy backend.",
        ),
    },
    async ({ snapshot_id, filename, ifc_base64 }) => {
      const gate = requireProduct("cortex_ifc_ingest", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      let bytes: Buffer;
      try {
        bytes = Buffer.from(ifc_base64, "base64");
      } catch (err) {
        return errorContent(
          `cortex_ifc_ingest: ifc_base64 is not valid base64 (${String(err).slice(0, 100)}).`,
        );
      }
      if (bytes.length === 0) {
        return errorContent(
          "cortex_ifc_ingest: decoded IFC payload is empty. Check the base64 encoding.",
        );
      }
      try {
        const response = await legacyClient.ingestIfc({
          snapshotId: snapshot_id,
          filename,
          bytes,
          contentType: "application/octet-stream",
        });
        logToolInvocation({
          tool: "cortex_ifc_ingest",
          snapshot_id,
          filename,
          bytes: bytes.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            codexProvenance({
              atomKind: "submission",
              rowId: snapshot_id,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/snapshots/${snapshot_id}/ifc`,
            }),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("cortex_ifc_ingest", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Cortex tool 3: cortex_bim_model_query
  // Returns the bim-model atom for an engagement, or { bimModel: null }
  // when no model has been pushed. The legacy backend may synthesize a
  // wire shape from a parsed IFC ingest when the bim_models row is
  // absent. Wraps GET /api/engagements/:id/bim-model. Gate: cortex.
  // Note: requires Lane C bearer-token middleware on the legacy side.
  // -----------------------------------------------------------------
  server.tool(
    "cortex_bim_model_query",
    "Cortex (design accelerator): fetch the bim-model atom for an engagement. Returns the " +
      "model wire shape (materializable elements, glTF refs, ingest metadata) or " +
      "{ bimModel: null } when no model has been pushed yet. The legacy backend may " +
      "synthesize a wire shape from a parsed IFC ingest when the bim_models row is absent. " +
      CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement. Required."),
    },
    async ({ engagement_id }) => {
      const gate = requireProduct("cortex_bim_model_query", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.queryBimModel({
          engagementId: engagement_id,
        });
        logToolInvocation({
          tool: "cortex_bim_model_query",
          engagement_id,
          tier,
          has_model: response.bimModel !== null,
        });
        const provenance = response.bimModel
          ? codexProvenance({
              atomKind: "submission",
              rowId: engagement_id,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/engagements/${engagement_id}/bim-model`,
            })
          : null;
        return envelopeContent(codexEnvelope(response, provenance, { tier }));
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_bim_model_query", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Cortex tool 4: cortex_briefing_emit
  // Kicks off parcel-briefing generation for an engagement. Same 202 /
  // 409-already-in-flight pattern as finding generation; legacy-client
  // normalizes 409 into alreadyInFlight=true.
  // Wraps POST /api/engagements/:id/briefing/generate. Gate: cortex.
  // Note: requires Lane C bearer-token middleware on the legacy side.
  // -----------------------------------------------------------------
  server.tool(
    "cortex_briefing_emit",
    "Cortex (design accelerator): kick off parcel-briefing generation for an engagement. " +
      "Returns generationId for status polling. If a briefing-generation job is already in " +
      "flight, returns that job's generationId with alreadyInFlight=true rather than starting " +
      "a new one. The engagement must already have briefing sources uploaded (use the legacy " +
      "UI's source-upload flow); a 400 surfaces when no sources are attached. " +
      CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe(
          "UUID of the engagement to generate the briefing for. Required.",
        ),
      regenerate: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Informational hint when re-running generation after a prior pass. Currently the " +
            "legacy backend auto-detects prior narratives; this field exists for forward compat.",
        ),
    },
    async ({ engagement_id, regenerate }) => {
      const gate = requireProduct("cortex_briefing_emit", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.emitBriefing({
          engagementId: engagement_id,
          regenerate,
        });
        logToolInvocation({
          tool: "cortex_briefing_emit",
          engagement_id,
          generation_id: response.generationId,
          already_in_flight: response.alreadyInFlight ?? false,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            codexProvenance({
              atomKind: "brief-run",
              rowId: response.generationId,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/engagements/${engagement_id}/briefing/generate`,
            }),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_briefing_emit", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Group 3 L1 — response-task tools (cortex_response_task_*).
  //
  // Wraps the L1 response-task endpoints on legacy-design-tools. These
  // endpoints are an MCP-first contract defined in legacy-client.ts and
  // built to match by cc-agent-C in Lane C.4 — until then the tools are
  // mocked-fetch testable only. Atoms carry real did:hauska DIDs, so
  // provenance uses lSurfaceProvenance, not the synthetic codexProvenance
  // path the Groups 1+2 tools use. Gate: product='cortex'.
  // -----------------------------------------------------------------

  // L1 tool 1: cortex_response_task_create
  server.tool(
    "cortex_response_task_create",
    "Cortex (design accelerator): create a response-task within an engagement. A response-task " +
      "tracks a unit of architect follow-up work, typically created from a client comment. " +
      "The task starts in state \"open\". Optionally link it to a source client-comment atom " +
      "and/or a finding at creation time. " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement this task belongs to. Required."),
      title: z
        .string()
        .min(1)
        .describe("Short human title shown in task lists. Required."),
      description: z
        .string()
        .describe(
          "Long-form task description. Pass an empty string for trivial tasks. Required.",
        ),
      source_client_comment_id: z
        .string()
        .optional()
        .describe(
          "entityId of the client-comment atom this task responds to. Omit for architect-authored tasks.",
        ),
      finding_id: z
        .string()
        .optional()
        .describe(
          "entityId of a finding to scope this task to. Omit for non-finding-scoped tasks.",
        ),
      due_at: z
        .string()
        .datetime()
        .optional()
        .describe("ISO-8601 deadline. Omit when there is no deadline."),
      actor_id: z
        .string()
        .optional()
        .describe("Actor assigned to execute the task (ADR-015)."),
      principal_actor_id: z
        .string()
        .optional()
        .describe(
          "Actor accountable for the task; may differ from actor_id for delegated work.",
        ),
    },
    async ({
      engagement_id,
      title,
      description,
      source_client_comment_id,
      finding_id,
      due_at,
      actor_id,
      principal_actor_id,
    }) => {
      const gate = requireProduct("cortex_response_task_create", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.createResponseTask({
          engagementId: engagement_id,
          title,
          description,
          sourceClientCommentId: source_client_comment_id,
          findingId: finding_id,
          dueAt: due_at,
          actorId: actor_id,
          principalActorId: principal_actor_id,
        });
        logToolInvocation({
          tool: "cortex_response_task_create",
          engagement_id,
          response_task_id: response.responseTask.entityId,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.responseTask),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_response_task_create", err),
        );
      }
    },
  );

  // L1 tool 2: cortex_response_task_update_state
  server.tool(
    "cortex_response_task_update_state",
    "Cortex (design accelerator): transition a response-task to a new state. Valid states are " +
      "open, in-progress, done, cancelled. The backend validates the transition and records an " +
      "audit event; moving to \"done\" stamps the completion timestamp. A forbidden transition " +
      "returns a 409 conflict. " + CORTEX_TIER,
    {
      response_task_id: z
        .string()
        .min(1)
        .describe("entityId of the response-task to transition. Required."),
      state: z
        .enum(["open", "in-progress", "done", "cancelled"])
        .describe("Target state. Required."),
    },
    async ({ response_task_id, state }) => {
      const gate = requireProduct(
        "cortex_response_task_update_state",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.updateResponseTaskState({
          responseTaskId: response_task_id,
          state,
        });
        logToolInvocation({
          tool: "cortex_response_task_update_state",
          response_task_id,
          state,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.responseTask),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_response_task_update_state", err),
        );
      }
    },
  );

  // L1 tool 3: cortex_response_task_list
  server.tool(
    "cortex_response_task_list",
    "Cortex (design accelerator): list the response-tasks for an engagement, newest-first. " +
      "Optionally filter to a single state. " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement. Required."),
      state: z
        .enum(["open", "in-progress", "done", "cancelled"])
        .optional()
        .describe(
          "Optional state filter. Omit to list response-tasks in every state.",
        ),
    },
    async ({ engagement_id, state }) => {
      const gate = requireProduct("cortex_response_task_list", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listResponseTasks({
          engagementId: engagement_id,
          state,
        });
        logToolInvocation({
          tool: "cortex_response_task_list",
          engagement_id,
          state,
          count: response.responseTasks.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            response.responseTasks.map(lSurfaceProvenance),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_response_task_list", err),
        );
      }
    },
  );

  // L1 tool 4: cortex_response_task_link
  server.tool(
    "cortex_response_task_link",
    "Cortex (design accelerator): link a response-task to a finding by setting the task's " +
      "finding reference. Use this when a task that was created standalone is later scoped to a " +
      "specific finding. " + CORTEX_TIER,
    {
      response_task_id: z
        .string()
        .min(1)
        .describe("entityId of the response-task to link. Required."),
      finding_id: z
        .string()
        .min(1)
        .describe("entityId of the finding to link the task to. Required."),
    },
    async ({ response_task_id, finding_id }) => {
      const gate = requireProduct("cortex_response_task_link", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.linkResponseTaskFinding({
          responseTaskId: response_task_id,
          findingId: finding_id,
        });
        logToolInvocation({
          tool: "cortex_response_task_link",
          response_task_id,
          finding_id,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.responseTask),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_response_task_link", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Group 3 L2 — sheet-content-extraction + attached-document tools.
  //
  // Two coupled atoms (emitted together by the sheet-ingest pass).
  // MCP-first contract built to match by cc-agent-C in Lane C.4.
  // Gate: product='cortex'. Provenance via lSurfaceProvenance.
  // -----------------------------------------------------------------

  // L2 tool 1: cortex_sheet_content_extraction_trigger
  server.tool(
    "cortex_sheet_content_extraction_trigger",
    "Cortex (design accelerator): trigger the structured-content extraction pass on a sheet. " +
      "The backend runs OCR plus structured-annotation extraction (revision clouds, dimensions, " +
      "schedule rows, callouts) and produces a sheet-content-extraction atom. Returns the " +
      "produced atom. " + CORTEX_TIER,
    {
      sheet_id: z
        .string()
        .min(1)
        .describe(
          "entityId / blob ref of the source sheet to extract. Required.",
        ),
    },
    async ({ sheet_id }) => {
      const gate = requireProduct(
        "cortex_sheet_content_extraction_trigger",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.triggerSheetContentExtraction({
          sheetId: sheet_id,
        });
        logToolInvocation({
          tool: "cortex_sheet_content_extraction_trigger",
          sheet_id,
          extracted: response.sheetContentExtraction !== null,
          tier,
        });
        const provenance = response.sheetContentExtraction
          ? lSurfaceProvenance(response.sheetContentExtraction)
          : null;
        return envelopeContent(codexEnvelope(response, provenance, { tier }));
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_sheet_content_extraction_trigger",
            err,
          ),
        );
      }
    },
  );

  // L2 tool 2: cortex_sheet_content_extraction_fetch
  server.tool(
    "cortex_sheet_content_extraction_fetch",
    "Cortex (design accelerator): fetch the sheet-content-extraction atom for a sheet — the " +
      "OCR text segments and structured annotations produced by a prior extraction pass. " +
      "Returns { sheetContentExtraction: null } when the sheet has not been extracted yet " +
      "(call cortex_sheet_content_extraction_trigger first). " + CORTEX_TIER,
    {
      sheet_id: z
        .string()
        .min(1)
        .describe("entityId / blob ref of the sheet. Required."),
    },
    async ({ sheet_id }) => {
      const gate = requireProduct(
        "cortex_sheet_content_extraction_fetch",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.fetchSheetContentExtraction({
          sheetId: sheet_id,
        });
        logToolInvocation({
          tool: "cortex_sheet_content_extraction_fetch",
          sheet_id,
          found: response.sheetContentExtraction !== null,
          tier,
        });
        const provenance = response.sheetContentExtraction
          ? lSurfaceProvenance(response.sheetContentExtraction)
          : null;
        return envelopeContent(codexEnvelope(response, provenance, { tier }));
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_sheet_content_extraction_fetch", err),
        );
      }
    },
  );

  // L2 tool 3: cortex_attached_document_list
  server.tool(
    "cortex_attached_document_list",
    "Cortex (design accelerator): list the supporting documents attached to an engagement " +
      "(specifications, calculations, product-data sheets, design narratives). Optionally " +
      "filter to a single document type. Returns atom metadata; call " +
      "cortex_attached_document_fetch for a document's parsed text. " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement. Required."),
      document_type: z
        .enum(["specification", "calculation", "product-data", "narrative"])
        .optional()
        .describe(
          "Optional document-type filter. Omit to list every attached document.",
        ),
    },
    async ({ engagement_id, document_type }) => {
      const gate = requireProduct("cortex_attached_document_list", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listAttachedDocuments({
          engagementId: engagement_id,
          documentType: document_type,
        });
        logToolInvocation({
          tool: "cortex_attached_document_list",
          engagement_id,
          document_type,
          count: response.attachedDocuments.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            response.attachedDocuments.map(lSurfaceProvenance),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_attached_document_list", err),
        );
      }
    },
  );

  // L2 tool 4: cortex_attached_document_fetch
  server.tool(
    "cortex_attached_document_fetch",
    "Cortex (design accelerator): fetch a single attached-document atom by id, including its " +
      "parsed extracted text and the reference to the stored original blob. Requires a " +
      "Cortex-product API key.",
    {
      attached_document_id: z
        .string()
        .min(1)
        .describe("entityId of the attached-document atom. Required."),
    },
    async ({ attached_document_id }) => {
      const gate = requireProduct("cortex_attached_document_fetch", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.fetchAttachedDocument({
          attachedDocumentId: attached_document_id,
        });
        logToolInvocation({
          tool: "cortex_attached_document_fetch",
          attached_document_id,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.attachedDocument),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_attached_document_fetch", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Group 3 L3 — deliverable-letter tools (cortex_deliverable_letter_*).
  //
  // The comment-response letter as a classified atom: ordered sections
  // (cover / intro / per-comment-response / signature), per-section
  // provenance, draft/sent lifecycle. MCP-first contract built to match
  // by cc-agent-C in Lane C.4. Gate: product='cortex'.
  // -----------------------------------------------------------------

  // L3 tool 1: cortex_deliverable_letter_create
  server.tool(
    "cortex_deliverable_letter_create",
    "Cortex (design accelerator): create a deliverable letter (the comment-response letter) " +
      "in draft status. Optionally pass initial sections — each carries a kind (cover / intro / " +
      "per-comment-response / signature), a heading, and body content; section provenance starts " +
      "empty (attach it later with cortex_deliverable_letter_attach_provenance). A letter needs " +
      "a cover, an intro, and a signature section before it can be sent. Requires a " +
      "Cortex-product API key.",
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement this letter belongs to. Required."),
      title: z
        .string()
        .min(1)
        .describe("Human letter title. Required."),
      sections: z
        .array(
          z.object({
            kind: z.enum([
              "cover",
              "intro",
              "per-comment-response",
              "signature",
            ]),
            heading: z.string().describe("Section heading. May be empty."),
            content: z.string().describe("Section body text."),
          }),
        )
        .optional()
        .describe(
          "Optional initial sections, in letter order. Omit to start with an empty letter.",
        ),
      recipient_actor_id: z
        .string()
        .optional()
        .describe("Client actor receiving the letter (ADR-015)."),
      actor_id: z
        .string()
        .optional()
        .describe("Architect / staff member authoring the letter (ADR-015)."),
      principal_actor_id: z
        .string()
        .optional()
        .describe("Actor accountable for the engagement; may differ from actor_id."),
    },
    async ({
      engagement_id,
      title,
      sections,
      recipient_actor_id,
      actor_id,
      principal_actor_id,
    }) => {
      const gate = requireProduct("cortex_deliverable_letter_create", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.createDeliverableLetter({
          engagementId: engagement_id,
          title,
          sections,
          recipientActorId: recipient_actor_id,
          actorId: actor_id,
          principalActorId: principal_actor_id,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_create",
          engagement_id,
          letter_id: response.deliverableLetter.entityId,
          section_count: response.deliverableLetter.sections.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_deliverable_letter_create", err),
        );
      }
    },
  );

  // L3 tool 2: cortex_deliverable_letter_update_section
  server.tool(
    "cortex_deliverable_letter_update_section",
    "Cortex (design accelerator): upsert a section of a deliverable letter by index. " +
      "section_index within the current sections array replaces that section's kind / heading / " +
      "content (its provenance is preserved); section_index equal to the current section count " +
      "appends a new section. Use cortex_deliverable_letter_attach_provenance to link a section " +
      "to its source atoms. " + CORTEX_TIER,
    {
      letter_id: z
        .string()
        .min(1)
        .describe("entityId of the deliverable letter. Required."),
      section_index: z
        .number()
        .int()
        .min(0)
        .describe(
          "Zero-based section index. Equal to the current section count appends a new section.",
        ),
      kind: z
        .enum(["cover", "intro", "per-comment-response", "signature"])
        .describe("Section kind. Required."),
      heading: z.string().describe("Section heading. May be empty. Required."),
      content: z.string().describe("Section body text. Required."),
    },
    async ({ letter_id, section_index, kind, heading, content }) => {
      const gate = requireProduct(
        "cortex_deliverable_letter_update_section",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.updateDeliverableLetterSection({
          letterId: letter_id,
          sectionIndex: section_index,
          kind,
          heading,
          content,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_update_section",
          letter_id,
          section_index,
          kind,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_deliverable_letter_update_section",
            err,
          ),
        );
      }
    },
  );

  // L3 tool 3: cortex_deliverable_letter_attach_provenance
  server.tool(
    "cortex_deliverable_letter_attach_provenance",
    "Cortex (design accelerator): attach source-atom provenance to a deliverable-letter section. " +
      "Pass any combination of response-task, sheet-content-extraction, finding, and " +
      "adjudication-state atom entityIds — they are merged (deduped) into the section's existing " +
      "provenance. This is how a per-comment-response section names exactly the finding plus " +
      "response-task plus adjudication it answers. " + CORTEX_TIER,
    {
      letter_id: z
        .string()
        .min(1)
        .describe("entityId of the deliverable letter. Required."),
      section_index: z
        .number()
        .int()
        .min(0)
        .describe("Zero-based index of the section to attach provenance to. Required."),
      response_task_ids: z
        .array(z.string())
        .optional()
        .describe("L1 response-task atom entityIds to cite."),
      sheet_content_extraction_ids: z
        .array(z.string())
        .optional()
        .describe("L2 sheet-content-extraction atom entityIds to cite."),
      finding_ids: z
        .array(z.string())
        .optional()
        .describe("Finding atom entityIds to cite."),
      adjudication_state_ids: z
        .array(z.string())
        .optional()
        .describe("Adjudication-state atom entityIds to cite."),
    },
    async ({
      letter_id,
      section_index,
      response_task_ids,
      sheet_content_extraction_ids,
      finding_ids,
      adjudication_state_ids,
    }) => {
      const gate = requireProduct(
        "cortex_deliverable_letter_attach_provenance",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      if (
        response_task_ids === undefined &&
        sheet_content_extraction_ids === undefined &&
        finding_ids === undefined &&
        adjudication_state_ids === undefined
      ) {
        return errorContent(
          "cortex_deliverable_letter_attach_provenance: pass at least one of response_task_ids, sheet_content_extraction_ids, finding_ids, adjudication_state_ids.",
        );
      }
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.attachDeliverableLetterProvenance({
          letterId: letter_id,
          sectionIndex: section_index,
          responseTaskIds: response_task_ids,
          sheetContentExtractionIds: sheet_content_extraction_ids,
          findingIds: finding_ids,
          adjudicationStateIds: adjudication_state_ids,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_attach_provenance",
          letter_id,
          section_index,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_deliverable_letter_attach_provenance",
            err,
          ),
        );
      }
    },
  );

  // L3 tool 4: cortex_deliverable_letter_completeness_check
  server.tool(
    "cortex_deliverable_letter_completeness_check",
    "Cortex (design accelerator): check whether a deliverable letter is complete (sendable). " +
      "Returns { complete, missing } — a letter is complete when it has a cover, an intro, and " +
      "a signature section. Call this before cortex_deliverable_letter_send. Requires a " +
      "Cortex-product API key.",
    {
      letter_id: z
        .string()
        .min(1)
        .describe("entityId of the deliverable letter. Required."),
    },
    async ({ letter_id }) => {
      const gate = requireProduct(
        "cortex_deliverable_letter_completeness_check",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.checkDeliverableLetterCompleteness({
          letterId: letter_id,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_completeness_check",
          letter_id,
          complete: response.complete,
          missing_count: response.missing.length,
          tier,
        });
        // The completeness result is a derived check, not an atom — no
        // provenance entry.
        return envelopeContent(codexEnvelope(response, null, { tier }));
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_deliverable_letter_completeness_check",
            err,
          ),
        );
      }
    },
  );

  // L3 tool 5: cortex_deliverable_letter_send
  server.tool(
    "cortex_deliverable_letter_send",
    "Cortex (design accelerator): send a deliverable letter — transitions it from draft to " +
      "sent. The backend gates on completeness: an incomplete letter (missing a cover, intro, " +
      "or signature section) is rejected and the response names the missing sections. Add the " +
      "missing sections with cortex_deliverable_letter_update_section, then retry. Requires a " +
      "Cortex-product API key.",
    {
      letter_id: z
        .string()
        .min(1)
        .describe("entityId of the deliverable letter to send. Required."),
    },
    async ({ letter_id }) => {
      const gate = requireProduct("cortex_deliverable_letter_send", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.sendDeliverableLetter({
          letterId: letter_id,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_send",
          letter_id,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          ),
        );
      } catch (err) {
        // A 409 here is the completeness gate. Surface the missing
        // sections clearly so the agent knows what to add before retry.
        if (err instanceof LegacyHttpError && err.status === 409) {
          let missing: unknown;
          try {
            missing = (JSON.parse(err.body) as { missing?: unknown }).missing;
          } catch {
            missing = undefined;
          }
          const missingNote = Array.isArray(missing)
            ? ` Missing section(s): ${missing.join(", ")}.`
            : "";
          logger.warn("tool_legacy_http_error", {
            tool: "cortex_deliverable_letter_send",
            status: 409,
            url: err.url,
          });
          return errorContent(
            `cortex_deliverable_letter_send: the letter is not complete and cannot be sent.${missingNote} ` +
              "Add the missing sections with cortex_deliverable_letter_update_section, then retry.",
          );
        }
        return errorContent(
          describeLegacyFailure("cortex_deliverable_letter_send", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Group 3 L4 — detail-callout-spec tools (cortex_detail_callout_spec_*).
  //
  // A structured spec for a Revit detail callout the Revit Connector
  // pushes via APS Design Automation. `spec` is a discriminated union
  // (door-schedule / wall-section / wall-type / room-finish); the tool
  // surface keeps detail_type as an explicit enum and forwards the
  // type-specific fields as an opaque `spec` object — the legacy
  // backend validates the assembled payload against the engine
  // discriminated-union schema. This avoids nested-oneOf MCP-client
  // friction (same pattern as cortex_snapshot_register). MCP-first
  // contract built to match by cc-agent-C in Lane C.4. Gate:
  // product='cortex'.
  // -----------------------------------------------------------------

  // L4 tool 1: cortex_detail_callout_spec_create
  server.tool(
    "cortex_detail_callout_spec_create",
    "Cortex (design accelerator): create a detail-callout spec — a structured spec for a Revit " +
      "detail the Revit Connector pushes into the model. detail_type selects the spec shape; " +
      "pass the type-specific fields in spec:\n" +
      "  - door-schedule: { rows: [{ doorMark, doorType, width, height, material, fireRating, hardwareSet }] }\n" +
      "  - wall-section:  { sectionMark, cutLocation, assemblyLayers: [{ material, thickness, function }], baseDatum, topDatum }\n" +
      "  - wall-type:     { typeMark, assemblyLayers: [{ material, thickness, function }], fireRating, stcRating }\n" +
      "  - room-finish:   { roomName, roomNumber, floorFinish, baseFinish, wallFinish, ceilingFinish, ceilingHeight }\n" +
      "The new spec starts in push state \"pending\". " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement this callout spec belongs to. Required."),
      detail_type: z
        .enum(["door-schedule", "wall-section", "wall-type", "room-finish"])
        .describe("Detail-callout type. Selects the required spec shape. Required."),
      spec: z
        .record(z.unknown())
        .describe(
          "Type-specific spec fields for the chosen detail_type (see the field lists above). " +
            "Required. The legacy backend validates this against the per-type schema.",
        ),
      finding_id: z
        .string()
        .optional()
        .describe("Source finding atom entityId that drove this callout, if any."),
      response_task_id: z
        .string()
        .optional()
        .describe("Source response-task atom entityId, if task-driven."),
      actor_id: z
        .string()
        .optional()
        .describe("Architect / staff member authoring the spec (ADR-015)."),
      principal_actor_id: z
        .string()
        .optional()
        .describe("Actor accountable for the engagement; may differ from actor_id."),
    },
    async ({
      engagement_id,
      detail_type,
      spec,
      finding_id,
      response_task_id,
      actor_id,
      principal_actor_id,
    }) => {
      const gate = requireProduct("cortex_detail_callout_spec_create", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.createDetailCalloutSpec({
          engagementId: engagement_id,
          detailType: detail_type,
          spec,
          findingId: finding_id,
          responseTaskId: response_task_id,
          actorId: actor_id,
          principalActorId: principal_actor_id,
        });
        logToolInvocation({
          tool: "cortex_detail_callout_spec_create",
          engagement_id,
          detail_type,
          spec_id: response.detailCalloutSpec.entityId,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_detail_callout_spec_create", err),
        );
      }
    },
  );

  // L4 tool 2: cortex_detail_callout_spec_update_push_state
  server.tool(
    "cortex_detail_callout_spec_update_push_state",
    "Cortex (design accelerator): transition a detail-callout spec to a new push state. Legal " +
      "transitions: pending → pushed; pushed → applied or rejected-by-user; rejected-by-user → " +
      "pending (revise and re-push); applied is terminal. An illegal transition returns a 409 " +
      "naming the legal next states. " + CORTEX_TIER,
    {
      spec_id: z
        .string()
        .min(1)
        .describe("entityId of the detail-callout spec. Required."),
      push_state: z
        .enum(["pending", "pushed", "applied", "rejected-by-user"])
        .describe("Target push state. Required."),
    },
    async ({ spec_id, push_state }) => {
      const gate = requireProduct(
        "cortex_detail_callout_spec_update_push_state",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.updateDetailCalloutSpecPushState({
          specId: spec_id,
          pushState: push_state,
        });
        logToolInvocation({
          tool: "cortex_detail_callout_spec_update_push_state",
          spec_id,
          push_state,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          ),
        );
      } catch (err) {
        // A 409 here is the illegal-transition gate. Surface the legal
        // next states so the agent can pick a valid transition.
        if (err instanceof LegacyHttpError && err.status === 409) {
          let legal: unknown;
          let from: unknown;
          try {
            const parsed = JSON.parse(err.body) as {
              from?: unknown;
              legalNextStates?: unknown;
            };
            from = parsed.from;
            legal = parsed.legalNextStates;
          } catch {
            from = undefined;
            legal = undefined;
          }
          const fromNote =
            typeof from === "string" ? ` from state "${from}"` : "";
          const legalNote = Array.isArray(legal)
            ? ` Legal next state(s): ${legal.join(", ") || "none (terminal)"}.`
            : "";
          logger.warn("tool_legacy_http_error", {
            tool: "cortex_detail_callout_spec_update_push_state",
            status: 409,
            url: err.url,
          });
          return errorContent(
            `cortex_detail_callout_spec_update_push_state: illegal push-state transition${fromNote}.${legalNote}`,
          );
        }
        return errorContent(
          describeLegacyFailure(
            "cortex_detail_callout_spec_update_push_state",
            err,
          ),
        );
      }
    },
  );

  // L4 tool 3: cortex_detail_callout_spec_attach_aps_ref
  server.tool(
    "cortex_detail_callout_spec_attach_aps_ref",
    "Cortex (design accelerator): attach the APS Design Automation work-item reference to a " +
      "detail-callout spec. The Revit Connector writes this once a push fires so the spec can " +
      "be correlated with its APS job. " + CORTEX_TIER,
    {
      spec_id: z
        .string()
        .min(1)
        .describe("entityId of the detail-callout spec. Required."),
      aps_task_ref: z
        .string()
        .min(1)
        .describe("Opaque APS Design Automation work-item reference. Required."),
    },
    async ({ spec_id, aps_task_ref }) => {
      const gate = requireProduct(
        "cortex_detail_callout_spec_attach_aps_ref",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.attachDetailCalloutSpecApsRef({
          specId: spec_id,
          apsTaskRef: aps_task_ref,
        });
        logToolInvocation({
          tool: "cortex_detail_callout_spec_attach_aps_ref",
          spec_id,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_detail_callout_spec_attach_aps_ref",
            err,
          ),
        );
      }
    },
  );

  // L4 tool 4: cortex_detail_callout_spec_list
  server.tool(
    "cortex_detail_callout_spec_list",
    "Cortex (design accelerator): list the detail-callout specs for an engagement, optionally " +
      "filtered to a single push state. " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement. Required."),
      push_state: z
        .enum(["pending", "pushed", "applied", "rejected-by-user"])
        .optional()
        .describe("Optional push-state filter. Omit to list specs in every state."),
    },
    async ({ engagement_id, push_state }) => {
      const gate = requireProduct("cortex_detail_callout_spec_list", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listDetailCalloutSpecs({
          engagementId: engagement_id,
          pushState: push_state,
        });
        logToolInvocation({
          tool: "cortex_detail_callout_spec_list",
          engagement_id,
          push_state,
          count: response.detailCalloutSpecs.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            response.detailCalloutSpecs.map(lSurfaceProvenance),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_detail_callout_spec_list", err),
        );
      }
    },
  );

  // L4 tool 5: cortex_detail_callout_spec_get
  server.tool(
    "cortex_detail_callout_spec_get",
    "Cortex (design accelerator): fetch a single detail-callout-spec atom by id, including its " +
      "discriminated spec payload, push state, and APS work-item ref. Requires a Cortex-product " +
      "API key.",
    {
      spec_id: z
        .string()
        .min(1)
        .describe("entityId of the detail-callout spec. Required."),
    },
    async ({ spec_id }) => {
      const gate = requireProduct("cortex_detail_callout_spec_get", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getDetailCalloutSpec({
          specId: spec_id,
        });
        logToolInvocation({
          tool: "cortex_detail_callout_spec_get",
          spec_id,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_detail_callout_spec_get", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Group 3 L5 — product-spec-reference tools
  // (cortex_product_spec_reference_*).
  //
  // A reference to an ICC-ES-evaluated product spec with live status
  // (active / withdrawn / expired). The refresh tool triggers a
  // synchronous backend re-poll of the ICC-ES listing; the periodic
  // background re-poll is a separate legacy-side runtime concern.
  // MCP-first contract built to match by cc-agent-C in Lane C.4.
  // Gate: product='cortex'.
  // -----------------------------------------------------------------

  // L5 tool 1: cortex_product_spec_reference_create
  server.tool(
    "cortex_product_spec_reference_create",
    "Cortex (design accelerator): add a product-spec reference to an engagement — an " +
      "ICC-ES-evaluated product (identified by manufacturer + name) and its ESR number. The " +
      "reference starts with status \"active\"; use cortex_product_spec_reference_refresh_status " +
      "to re-verify it against the live ICC-ES listing. " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement this product reference belongs to. Required."),
      product_name: z
        .string()
        .min(1)
        .describe(
          'Product name (e.g. "Strong-Drive SDWS Timber Screw"). Required.',
        ),
      manufacturer: z
        .string()
        .min(1)
        .describe('Manufacturer (e.g. "Simpson Strong-Tie"). Required.'),
      esr_number: z
        .string()
        .regex(
          /^ESR-\d+$/,
          'esr_number must be an ICC-ES report number of the form "ESR-<digits>", e.g. ESR-1234.',
        )
        .describe('ICC-ES Evaluation Service Report number (format "ESR-<digits>"). Required.'),
      finding_id: z
        .string()
        .optional()
        .describe("Source finding atom entityId that referenced this product, if any."),
      response_task_id: z
        .string()
        .optional()
        .describe("Source response-task atom entityId, if task-driven."),
      actor_id: z
        .string()
        .optional()
        .describe("Architect / staff member who added the reference (ADR-015)."),
      principal_actor_id: z
        .string()
        .optional()
        .describe("Actor accountable for the engagement; may differ from actor_id."),
    },
    async ({
      engagement_id,
      product_name,
      manufacturer,
      esr_number,
      finding_id,
      response_task_id,
      actor_id,
      principal_actor_id,
    }) => {
      const gate = requireProduct(
        "cortex_product_spec_reference_create",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.createProductSpecReference({
          engagementId: engagement_id,
          product: { name: product_name, manufacturer },
          esrNumber: esr_number,
          findingId: finding_id,
          responseTaskId: response_task_id,
          actorId: actor_id,
          principalActorId: principal_actor_id,
        });
        logToolInvocation({
          tool: "cortex_product_spec_reference_create",
          engagement_id,
          esr_number,
          reference_id: response.productSpecReference.entityId,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.productSpecReference),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_product_spec_reference_create", err),
        );
      }
    },
  );

  // L5 tool 2: cortex_product_spec_reference_refresh_status
  server.tool(
    "cortex_product_spec_reference_refresh_status",
    "Cortex (design accelerator): re-verify a product-spec reference against the live ICC-ES " +
      "listing. The backend synchronously re-polls ICC-ES; if the status changed it appends to " +
      "the reference's status history and updates the current status. Returns the refreshed " +
      "reference — check `status` for active / withdrawn / expired. Requires a Cortex-product " +
      "API key.",
    {
      reference_id: z
        .string()
        .min(1)
        .describe("entityId of the product-spec reference to refresh. Required."),
    },
    async ({ reference_id }) => {
      const gate = requireProduct(
        "cortex_product_spec_reference_refresh_status",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.refreshProductSpecReferenceStatus({
          referenceId: reference_id,
        });
        logToolInvocation({
          tool: "cortex_product_spec_reference_refresh_status",
          reference_id,
          status: response.productSpecReference.status,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.productSpecReference),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_product_spec_reference_refresh_status",
            err,
          ),
        );
      }
    },
  );

  // L5 tool 3: cortex_product_spec_reference_list
  server.tool(
    "cortex_product_spec_reference_list",
    "Cortex (design accelerator): list the product-spec references for an engagement, optionally " +
      "filtered to a single ICC-ES status. Filter to \"withdrawn\" or \"expired\" to surface " +
      "references that need review. " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement. Required."),
      status: z
        .enum(["active", "withdrawn", "expired"])
        .optional()
        .describe("Optional ICC-ES status filter. Omit to list references in every status."),
    },
    async ({ engagement_id, status }) => {
      const gate = requireProduct(
        "cortex_product_spec_reference_list",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listProductSpecReferences({
          engagementId: engagement_id,
          status,
        });
        logToolInvocation({
          tool: "cortex_product_spec_reference_list",
          engagement_id,
          status,
          count: response.productSpecReferences.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            response.productSpecReferences.map(lSurfaceProvenance),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_product_spec_reference_list", err),
        );
      }
    },
  );

  // L5 tool 4: cortex_product_spec_reference_get
  server.tool(
    "cortex_product_spec_reference_get",
    "Cortex (design accelerator): fetch a single product-spec-reference atom by id, including " +
      "its current ICC-ES status and the full append-only status history. Requires a " +
      "Cortex-product API key.",
    {
      reference_id: z
        .string()
        .min(1)
        .describe("entityId of the product-spec reference. Required."),
    },
    async ({ reference_id }) => {
      const gate = requireProduct("cortex_product_spec_reference_get", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getProductSpecReference({
          referenceId: reference_id,
        });
        logToolInvocation({
          tool: "cortex_product_spec_reference_get",
          reference_id,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.productSpecReference),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_product_spec_reference_get", err),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Group 3 L6 — deliverable-letter render tools.
  //
  // The rendered DOCX/PDF artifact of an L3 deliverable-letter, as a
  // first-class atom. Render is synchronous and completeness-gated
  // server-side (an incomplete letter cannot be rendered — that would
  // produce a confusing partial document). MCP-first contract built
  // to match by cc-agent-C in Lane C.4. Gate: product='cortex'.
  // This phase closes Group 3 — all six L-surface MCP tool sets live.
  // -----------------------------------------------------------------

  // L6 tool 1: cortex_deliverable_letter_render
  server.tool(
    "cortex_deliverable_letter_render",
    "Cortex (design accelerator): render a deliverable letter to DOCX or PDF. Produces a " +
      "first-class deliverable-letter-render atom (the render is queryable + provenance-pinned, " +
      "not an ephemeral byte side-effect) and returns it plus a download URL for the rendered " +
      "file. The render is gated on completeness — an incomplete letter (missing a cover, intro, " +
      "or signature section) is rejected and the response names the missing sections. The render " +
      "pins the source letter's version, so re-rendering after the letter changes produces a " +
      "distinct render. " + CORTEX_TIER,
    {
      letter_id: z
        .string()
        .min(1)
        .describe("entityId of the deliverable letter to render. Required."),
      format: z
        .enum(["docx", "pdf"])
        .describe("Render output format. Required."),
      rendered_by_actor_id: z
        .string()
        .optional()
        .describe("Actor who triggered the render (ADR-015). Omit for system renders."),
    },
    async ({ letter_id, format, rendered_by_actor_id }) => {
      const gate = requireProduct("cortex_deliverable_letter_render", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.renderDeliverableLetter({
          letterId: letter_id,
          format,
          renderedByActorId: rendered_by_actor_id,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_render",
          letter_id,
          format,
          render_id: response.render.entityId,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.render),
            { tier },
          ),
        );
      } catch (err) {
        // A 409 here is the completeness gate (same shape as
        // cortex_deliverable_letter_send). Surface the missing sections.
        if (err instanceof LegacyHttpError && err.status === 409) {
          let missing: unknown;
          try {
            missing = (JSON.parse(err.body) as { missing?: unknown }).missing;
          } catch {
            missing = undefined;
          }
          const missingNote = Array.isArray(missing)
            ? ` Missing section(s): ${missing.join(", ")}.`
            : "";
          logger.warn("tool_legacy_http_error", {
            tool: "cortex_deliverable_letter_render",
            status: 409,
            url: err.url,
          });
          return errorContent(
            `cortex_deliverable_letter_render: the letter is not complete and cannot be rendered.${missingNote} ` +
              "Add the missing sections with cortex_deliverable_letter_update_section, then retry.",
          );
        }
        return errorContent(
          describeLegacyFailure("cortex_deliverable_letter_render", err),
        );
      }
    },
  );

  // L6 tool 2: cortex_deliverable_letter_renders_list
  server.tool(
    "cortex_deliverable_letter_renders_list",
    "Cortex (design accelerator): list every render of a deliverable letter, newest-first. A " +
      "letter is one-to-many with its renders — format changes and re-renders against an updated " +
      "source letter each produce a distinct render atom. " + CORTEX_TIER,
    {
      letter_id: z
        .string()
        .min(1)
        .describe("entityId of the deliverable letter. Required."),
    },
    async ({ letter_id }) => {
      const gate = requireProduct(
        "cortex_deliverable_letter_renders_list",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listDeliverableLetterRenders({
          letterId: letter_id,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_renders_list",
          letter_id,
          count: response.renders.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            response.renders.map(lSurfaceProvenance),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_deliverable_letter_renders_list",
            err,
          ),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Amendment 8 follow-on — L3/L6 read + download tools.
  //
  // cc-agent-C's Lane C.4 added three read endpoints beyond the original
  // write-path-only L3/L6 contract: a letter list, a single-letter
  // fetch, and a render byte-serve download. The additions were ratified
  // in-scope by Sprint Amendment 8 — symmetric read capability is
  // dual-interface coherence. These three tools match them on the MCP
  // surface. Gate: product='cortex'.
  // -----------------------------------------------------------------

  // L3 read tool: cortex_deliverable_letter_list
  server.tool(
    "cortex_deliverable_letter_list",
    "Cortex (design accelerator): list the deliverable letters for an engagement, newest-first, " +
      "optionally filtered to a single status (draft or sent). " + CORTEX_TIER,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("UUID of the engagement. Required."),
      status: z
        .enum(["draft", "sent"])
        .optional()
        .describe(
          "Optional status filter. Omit to list letters in every status.",
        ),
    },
    async ({ engagement_id, status }) => {
      const gate = requireProduct("cortex_deliverable_letter_list", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listDeliverableLetters({
          engagementId: engagement_id,
          status,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_list",
          engagement_id,
          status,
          count: response.deliverableLetters.length,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            response.deliverableLetters.map(lSurfaceProvenance),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_deliverable_letter_list", err),
        );
      }
    },
  );

  // L3 read tool: cortex_deliverable_letter_fetch
  server.tool(
    "cortex_deliverable_letter_fetch",
    "Cortex (design accelerator): fetch a single deliverable-letter atom by id, including its " +
      "ordered sections and per-section provenance. " + CORTEX_TIER,
    {
      letter_id: z
        .string()
        .min(1)
        .describe("entityId of the deliverable letter. Required."),
    },
    async ({ letter_id }) => {
      const gate = requireProduct("cortex_deliverable_letter_fetch", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getDeliverableLetter({
          letterId: letter_id,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_fetch",
          letter_id,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(
          describeLegacyFailure("cortex_deliverable_letter_fetch", err),
        );
      }
    },
  );

  // L6 read tool: cortex_deliverable_letter_render_download
  server.tool(
    "cortex_deliverable_letter_render_download",
    "Cortex (design accelerator): download the rendered DOCX or PDF file for a " +
      "deliverable-letter-render atom. Returns the file as an embedded resource (a base64 blob) " +
      "with its content type, plus a metadata summary. Use cortex_deliverable_letter_renders_list " +
      "to find a render's id. " + CORTEX_TIER,
    {
      render_id: z
        .string()
        .min(1)
        .describe(
          "entityId of the deliverable-letter-render to download. Required.",
        ),
    },
    async ({ render_id }) => {
      const gate = requireProduct(
        "cortex_deliverable_letter_render_download",
        "cortex",
      );
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const download = await legacyClient.downloadDeliverableLetterRender({
          renderId: render_id,
        });
        logToolInvocation({
          tool: "cortex_deliverable_letter_render_download",
          render_id,
          content_type: download.contentType,
          byte_length: download.bytes.byteLength,
          tier,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  render_id,
                  filename: download.filename,
                  content_type: download.contentType,
                  byte_length: download.bytes.byteLength,
                },
                null,
                2,
              ),
            },
            {
              type: "resource" as const,
              resource: {
                uri: `cortex://deliverable-letter-render/${render_id}/${download.filename}`,
                mimeType: download.contentType,
                blob: Buffer.from(download.bytes).toString("base64"),
              },
            },
          ],
        };
      } catch (err) {
        return errorContent(
          describeLegacyFailure(
            "cortex_deliverable_letter_render_download",
            err,
          ),
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Tier 1 Group A — Property Brief (generate_property_brief,
  // get_property_brief_run). Gate: product='cortex'.
  // -----------------------------------------------------------------

  server.tool(
    "generate_property_brief",
    TOOL_COPY.generate_property_brief,
    {
      address: z.string().min(1).describe("Street address to brief. Required."),
      mls_id: z.string().optional().describe("Optional MLS listing id."),
      source: z
        .string()
        .optional()
        .describe("Optional source label (e.g. mcp-agent)."),
      presentation_mode: z
        .enum(["consumer", "pro"])
        .optional()
        .default("consumer")
        .describe("Brief voice: consumer (lay) or pro."),
    },
    async ({ address, mls_id, source, presentation_mode }) => {
      const gate = requireProduct("generate_property_brief", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      const started = Date.now();
      try {
        const response = await legacyClient.generateBrief({
          address,
          mls_id,
          source,
          presentationMode: presentation_mode,
        });
        logToolInvocation({
          tool: "generate_property_brief",
          tier,
          run_id: response.runId,
          jurisdiction_key: response.jurisdiction ?? undefined,
          latency_ms: Date.now() - started,
          atom_ids_returned: (response.atoms?.inlineRefs?.length ?? 0) + 1,
        });
        return envelopeContent(generateBriefEnvelope(response, { tier }));
      } catch (err) {
        logToolInvocation({
          tool: "generate_property_brief",
          tier,
          error_class: legacyErrorClass(err),
          latency_ms: Date.now() - started,
        });
        return errorContent(describeLegacyFailure("generate_property_brief", err));
      }
    },
  );

  server.tool(
    "get_property_brief_run",
    TOOL_COPY.get_property_brief_run,
    {
      run_id: z
        .string()
        .uuid()
        .describe("brief-run id from generate_property_brief. Required."),
    },
    async ({ run_id }) => {
      const gate = requireProduct("get_property_brief_run", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getBriefRun({ runId: run_id });
        logToolInvocation({
          tool: "get_property_brief_run",
          run_id,
          tier,
        });
        return envelopeContent(getBriefRunEnvelope(response, { tier }));
      } catch (err) {
        return errorContent(describeLegacyFailure("get_property_brief_run", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tier 1 Group B — Hydrology and topography. Gate: product='cortex'.
  // -----------------------------------------------------------------

  server.tool(
    "simulate_site_drainage",
    TOOL_COPY.simulate_site_drainage,
    {
      engagement_id: z
        .string()
        .uuid()
        .describe("Engagement id with site topography ingested. Required."),
      manual_depth_inches: z
        .number()
        .positive()
        .max(50)
        .optional()
        .describe("Rainfall depth in inches (default 4 for smoke tests)."),
      return_period_years: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("NOAA Atlas 14 return period when not using manual depth."),
      force_refresh: z
        .boolean()
        .optional()
        .describe("Re-run drainage even when a recent result exists."),
    },
    async ({
      engagement_id,
      manual_depth_inches,
      return_period_years,
      force_refresh,
    }) => {
      const gate = requireProduct("simulate_site_drainage", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.refreshSiteDrainage({
          engagementId: engagement_id,
          manualDepthInches: manual_depth_inches,
          returnPeriodYears: return_period_years,
          forceRefresh: force_refresh,
        });
        logToolInvocation({
          tool: "simulate_site_drainage",
          engagement_id,
          tier,
          flow_line_count: response.flowLineCount,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            response.materializableElementId
              ? {
                  did: `did:hauska:site-drainage:${response.materializableElementId}`,
                  entityType: "site-drainage",
                  entityId: response.materializableElementId,
                  jurisdictionTenant: "legacy",
                  contentHash: null,
                  cidNote:
                    "Site-drainage materializable element id; canonical atom DID at storage layer.",
                  source: {
                    adapter: "legacy-design-tools",
                    url: `/api/engagements/${engagement_id}/site-drainage/refresh`,
                    fetchedAt: new Date().toISOString(),
                  },
                }
              : null,
            { tier },
          ),
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("simulate_site_drainage", err));
      }
    },
  );

  server.tool(
    "get_site_drainage",
    TOOL_COPY.get_site_drainage,
    {
      engagement_id: z.string().uuid().describe("Engagement id. Required."),
      include_design_storms: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, attach NOAA Atlas 14 design-storm estimates."),
    },
    async ({ engagement_id, include_design_storms }) => {
      const gate = requireProduct("get_site_drainage", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const drainage = await legacyClient.getSiteDrainage({
          engagementId: engagement_id,
        });
        const designStorms = include_design_storms
          ? await legacyClient.getSiteDrainageDesignStorms({
              engagementId: engagement_id,
            })
          : undefined;
        logToolInvocation({
          tool: "get_site_drainage",
          engagement_id,
          tier,
          include_design_storms,
        });
        const envelope = siteDrainageEnvelope(drainage, engagement_id, { tier });
        if (designStorms !== undefined) {
          return envelopeContent({
            data: { drainage, designStorms },
            atoms: envelope.atoms,
            meta: envelope.meta,
          });
        }
        return envelopeContent(envelope);
      } catch (err) {
        return errorContent(describeLegacyFailure("get_site_drainage", err));
      }
    },
  );

  server.tool(
    "get_site_topography",
    TOOL_COPY.get_site_topography,
    {
      engagement_id: z.string().uuid().describe("Engagement id. Required."),
      refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, POST refresh before reading the active row."),
      force_refresh: z
        .boolean()
        .optional()
        .describe("Passed to refresh when refresh=true."),
    },
    async ({ engagement_id, refresh, force_refresh }) => {
      const gate = requireProduct("get_site_topography", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        if (refresh) {
          await legacyClient.refreshSiteTopography({
            engagementId: engagement_id,
            forceRefresh: force_refresh,
          });
        }
        const response = await legacyClient.getSiteTopography({
          engagementId: engagement_id,
        });
        logToolInvocation({
          tool: "get_site_topography",
          engagement_id,
          tier,
          refreshed: refresh,
        });
        return envelopeContent(
          siteTopographyEnvelope(response, engagement_id, { tier }),
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("get_site_topography", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tier 1 Group C — Encumbrances. Gate: product='cortex'.
  // -----------------------------------------------------------------

  server.tool(
    "search_encumbrances",
    TOOL_COPY.search_encumbrances,
    {
      workspace_did: z
        .string()
        .min(1)
        .describe(
          "Property workspace DID (did:hauska:property-workspace:<listingKey>). Required.",
        ),
    },
    async ({ workspace_did }) => {
      const gate = requireProduct("search_encumbrances", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.searchEncumbrances({
          workspaceDid: workspace_did,
        });
        logToolInvocation({
          tool: "search_encumbrances",
          workspace_did,
          tier,
          instrument_count: response.instruments.length,
          clause_count: response.clauses.length,
        });
        return envelopeContent(encumbrancesEnvelope(response, { tier }));
      } catch (err) {
        return errorContent(describeLegacyFailure("search_encumbrances", err));
      }
    },
  );

  server.tool(
    "get_restrictions",
    TOOL_COPY.get_restrictions,
    {
      workspace_did: z
        .string()
        .min(1)
        .describe("Property workspace DID. Required."),
    },
    async ({ workspace_did }) => {
      const gate = requireProduct("get_restrictions", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getRestrictions({
          workspaceDid: workspace_did,
        });
        logToolInvocation({
          tool: "get_restrictions",
          workspace_did,
          tier,
          clause_count: response.clauses.length,
        });
        return envelopeContent(restrictionsEnvelope(response, { tier }));
      } catch (err) {
        return errorContent(describeLegacyFailure("get_restrictions", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tier 1 Group D — Cotality data tier (designed, inert). Gate: cortex.
  // Returns credential-pending when CoreLogic OAuth is absent; never fakes data.
  // -----------------------------------------------------------------

  const cotalityLocationSchema = {
    address: z
      .string()
      .optional()
      .describe("Street address for adapter lookup."),
    lat: z.number().optional().describe("Latitude when address is omitted."),
    lng: z.number().optional().describe("Longitude when address is omitted."),
  };

  function wrapCotalityTool(
    tool: string,
    call: () => Promise<Record<string, unknown> | import("./legacy-client.js").CredentialPendingResponse>,
    tier: ReturnType<typeof getCurrentTier>,
  ) {
    return call().then((response) => {
      if (
        typeof response === "object" &&
        response !== null &&
        "status" in response &&
        response.status === "credential-pending"
      ) {
        logToolInvocation({ tool, tier, credential_pending: true });
        return envelopeContent(
          credentialPendingEnvelope(
            response as import("./legacy-client.js").CredentialPendingResponse,
            { tier },
          ),
        );
      }
      logToolInvocation({ tool, tier, credential_pending: false });
      return envelopeContent(codexEnvelope(response, null, { tier }));
    });
  }

  server.tool(
    "get_property_detail",
    TOOL_COPY.get_property_detail,
    cotalityLocationSchema,
    async ({ address, lat, lng }) => {
      const gate = requireProduct("get_property_detail", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        return await wrapCotalityTool(
          "get_property_detail",
          () => legacyClient.getPropertyDetail({ address, lat, lng }),
          tier,
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("get_property_detail", err));
      }
    },
  );

  server.tool(
    "get_replacement_cost",
    TOOL_COPY.get_replacement_cost,
    cotalityLocationSchema,
    async ({ address, lat, lng }) => {
      const gate = requireProduct("get_replacement_cost", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        return await wrapCotalityTool(
          "get_replacement_cost",
          () => legacyClient.getReplacementCost({ address, lat, lng }),
          tier,
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("get_replacement_cost", err));
      }
    },
  );

  server.tool(
    "get_hazard_profile",
    TOOL_COPY.get_hazard_profile,
    cotalityLocationSchema,
    async ({ address, lat, lng }) => {
      const gate = requireProduct("get_hazard_profile", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        return await wrapCotalityTool(
          "get_hazard_profile",
          () => legacyClient.getHazardProfile({ address, lat, lng }),
          tier,
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("get_hazard_profile", err));
      }
    },
  );

  server.tool(
    "get_parcel_polygon",
    TOOL_COPY.get_parcel_polygon,
    cotalityLocationSchema,
    async ({ address, lat, lng }) => {
      const gate = requireProduct("get_parcel_polygon", "cortex");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        return await wrapCotalityTool(
          "get_parcel_polygon",
          () => legacyClient.getParcelPolygon({ address, lat, lng }),
          tier,
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("get_parcel_polygon", err));
      }
    },
  );
}
