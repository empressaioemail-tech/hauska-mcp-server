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

import type { AccessPolicy } from "@empressaio/atom-contract";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  codexEnvelope,
  codexProvenance,
  credentialPendingEnvelope,
  encumbrancesEnvelope,
  generateBriefEnvelope,
  getAtomEnvelope,
  atomTraceEnvelope,
  propertyAtomChainEnvelope,
  parcelTerrainExportEnvelope,
  parcelSitePlanExportEnvelope,
  parcelDossierExportEnvelope,
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
  parcelTerrainModelEnvelope,
  normalizeTerrainConfidence,
  buildEnvelope,
  type ToolEnvelope,
} from "./atom-shape.js";
import { assembleDownloadableAtomExport } from "./atom-export.js";
import { checkReadToolConformance } from "./conformance-check.js";
import {
  EngineApiHttpError,
  EngineApiTimeoutError,
  EngineApiUnreachableError,
  engineApiClient,
} from "./engine-api-client.js";
import {
  gateFrontProductFor,
  resolveGateAccessTier,
  resolveGateTenantId,
} from "./gate-front.js";
import {
  assertJurisdictionTenantScope,
  assertMapLayersPackageGate,
  assertResponseTenantScope,
  filterLayersForEntitlement,
} from "./gate-packages.js";
import {
  mapLayersBboxSchema,
  mapLayersJurisdictionSchema,
  mapLayersParcelSchema,
  mapLayerKeySchema,
} from "./map-layers-contract.js";
import { requiredProductForTool } from "./product-gates.js";
import {
  logToolInvocation,
  placeApiEnabled,
  type GtmErrorClass,
} from "./gtm-observability.js";
import { authorizePaidRead, logToolRead } from "./read-attribution.js";
import { authorizePaidCall, isSdkMeteringEnabled } from "./sdk-metering.js";
import { TOOL_COPY, CODEX_TIER, CORTEX_TIER, REPORTING_TIER, MAP_TIER } from "./tool-copy.js";
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
import {
  composeWorkspace,
  type EngagementContext,
} from "./compose-workspace.js";
import { logger } from "./logger.js";
import type { Product } from "./products.js";
import { registerSmartFilesTools } from "./smart-files-tools.js";
import { registerPlanReviewTools } from "./plan-review-tools.js";
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
  getCurrentRequestId,
  getCurrentTier,
} from "./request-context.js";
import {
  PropertyAtomChainInputError,
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
  PARCEL_NODE_ID_REGEX,
  chainStatusNote,
  readableChainAtoms,
  resolvePropertyAtomChain,
} from "./property-atom-chain.js";
import {
  isTerrainExportFormatDeferred,
  TERRAIN_EXPORT_FORMATS,
  TERRAIN_EXPORT_MAX_INLINE_BYTES,
  terrainExportContentType,
  terrainExportDownloadPath,
  type TerrainExportFormat,
} from "./terrain-export-contract.js";
import {
  isSitePlanExportFormatDeferred,
  SITE_PLAN_EXPORT_FORMATS,
  SITE_PLAN_EXPORT_MAX_INLINE_BYTES,
  sitePlanExportContentType,
  sitePlanExportDownloadPath,
  type SitePlanExportFormat,
} from "./site-plan-export-contract.js";
import {
  isDossierExportArtifactDeferred,
  DOSSIER_EXPORT_CONTENT_TYPE,
  DOSSIER_EXPORT_FORMATS,
  DOSSIER_EXPORT_MAX_INLINE_BYTES,
  dossierExportDownloadPath,
} from "./dossier-export-contract.js";

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
    sourceAdapter:
      typeof atom.sourceAdapter === "string" ? atom.sourceAdapter : undefined,
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

// Product gate + SDK money authorize (Gate D / WDLL 3.11).
// Returns a 4xx-shaped error envelope when the caller's product does not
// include this tool's product, or when McpMeteringGate.authorizeCall denies.
// Authorize runs BEFORE serve (gate-then-serve), never post-success only.
//
// Exported for direct testing of the gate semantics under various
// AsyncLocalStorage bindings without spinning up a full McpServer.
export async function requireProduct(
  tool: string,
  expected: Product | readonly Product[],
): Promise<
  { ok: true } | { ok: false; content: ReturnType<typeof errorContent> }
> {
  const actual = getCurrentProduct();
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual)) {
    const expectedLabel = allowed.join('" or "');
    logger.warn("tool_product_denied", { tool, expected: allowed, actual });
    return {
      ok: false,
      content: errorContent(
        `Tool "${tool}" requires a "${expectedLabel}"-product API key. The caller is on product "${actual}". Contact support@hauska.dev to request access.`,
      ),
    };
  }

  // Paid path: authorize via @hauska-sdk/metering before serve.
  const meter = await authorizePaidRead({ tool });
  if (!meter.allowed) {
    logger.warn("tool_metering_denied", {
      tool,
      deny_reason: "denyReason" in meter ? meter.denyReason : null,
    });
    return {
      ok: false,
      content: errorContent(
        meter.denyMessage ??
          `Metering denied for tool "${tool}". Upgrade or retry after quota resets.`,
      ),
    };
  }

  return { ok: true };
}

async function requireToolProduct(
  tool: string,
): Promise<
  { ok: true } | { ok: false; content: ReturnType<typeof errorContent> }
> {
  const expected = requiredProductForTool(tool);
  if (!expected) return { ok: true };
  return requireProduct(tool, expected);
}

function finalizeReadEnvelope<T>(
  tool: string,
  envelope: ToolEnvelope<T>,
  accessPolicy?: import("@empressaio/atom-contract").AccessPolicy,
): ToolEnvelope<T> {
  const conformance = checkReadToolConformance({
    tool,
    readContract: envelope.readContract,
    accessPolicy,
  });
  if (!conformance.ok) {
    return {
      ...envelope,
      meta: {
        ...envelope.meta,
        note: [
          envelope.meta.note,
          `Conformance ${conformance.conformanceTargetVersion} miss (non-fatal).`,
        ]
          .filter(Boolean)
          .join(" "),
      },
    };
  }
  return envelope;
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
        const __readEnv = searchAtomsEnvelope(filteredResponse, { tier });
        logToolRead({
          tool: "search_atoms",
          query,
          jurisdiction,
          entity_type,
          tier,
          count: filtered.length,
          pre_filter_count: response.results.length,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
        if (!response.atom) {
          const __readEnv = getAtomEnvelope(response, {
            tier,
            note: `No atom found at DID ${atom_id}.`,
          });
          logToolRead({
            tool: "get_atom",
            atom_id,
            tier,
            found: false,
          }, __readEnv.atoms);
          return envelopeContent(__readEnv);
        }
        if (!assertAtomReadable("get_atom", response.atom)) {
          logToolRead({
            tool: "get_atom",
            atom_id,
            tier,
            found: false,
          }, []);
          return errorContent(
            `Atom at DID ${atom_id} is not readable under the caller's accessPolicy.`,
          );
        }
        const composition = response.composition?.filter(
          (edge) => edge.atom && assertAtomReadable("get_atom", edge.atom),
        );
        const __readEnv = finalizeReadEnvelope(
          "get_atom",
          getAtomEnvelope(
            { ...response, composition },
            { tier },
          ),
          response.atom.accessPolicy as import("@empressaio/atom-contract").AccessPolicy | undefined,
        );
        logToolRead({
          tool: "get_atom",
          atom_id,
          tier,
          found: true,
          composition_count: composition?.length ?? 0,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
      } catch (err) {
        return errorContent(describeEngineFailure("get_atom", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2b: get_property_atom_chain
  // Catalog path for all parcel-keyed property entity types (derived from
  // PARCEL_KEYED_PROPERTY_ENTITY_TYPES / engine PROPERTY_ENTITY_TYPES minus road-node).
  // WDLL 3.13(a): per-atom accessPolicy, not package/tier path.
  // -----------------------------------------------------------------
  server.tool(
    "get_property_atom_chain",
    TOOL_COPY.get_property_atom_chain,
    {
      parcel_node_id: z
        .string()
        .regex(PARCEL_NODE_ID_REGEX, "parcel_node_id must be county_fips:prop_id (e.g. 48209:156346)")
        .optional()
        .describe(
          "Permanent parcel node id county_fips:prop_id (e.g. 48209:156346). Provide this OR atom_did.",
        ),
      atom_did: z
        .string()
        .regex(ATOM_DID_REGEX, "atom_did must be a Hauska DID")
        .optional()
        .describe(
          `Any parcel-keyed property atom DID (${PARCEL_KEYED_PROPERTY_ENTITY_TYPES.join(", ")}). Provide this OR parcel_node_id.`,
        ),
    },
    async ({ parcel_node_id, atom_did }) => {
      const tier = getCurrentTier();
      if (!parcel_node_id && !atom_did) {
        return errorContent(
          "Provide parcel_node_id (e.g. 48209:156346) or atom_did for a property-chain atom.",
        );
      }
      try {
        const subject = getCurrentAccessSubject();
        const data = await resolvePropertyAtomChain(
          { parcelNodeId: parcel_node_id, atomDid: atom_did },
          subject,
          "get_property_atom_chain",
        );
        const readable = readableChainAtoms(data);
        const note = chainStatusNote(data);
        const __readEnv = finalizeReadEnvelope(
          "get_property_atom_chain",
          propertyAtomChainEnvelope(data, readable, { tier, note }),
          readable[0]?.accessPolicy as AccessPolicy | undefined,
        );
        logToolRead(
          {
            tool: "get_property_atom_chain",
            parcel_node_id: data.parcelNodeId,
            tier,
            status: data.status,
            readable_count: readable.length,
            pending_slots: data.pendingSlots,
            withheld_slots: data.withheldSlots,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof PropertyAtomChainInputError) {
          return errorContent(err.message);
        }
        return errorContent(describeEngineFailure("get_property_atom_chain", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2c: refresh_parcel_terrain_export (Gate Y catalog paid path)
  // WDLL terrain-ifc-spine item 5: public-paid terrain-export atom via
  // engine-api; one authorizePaidCall per export request.
  // -----------------------------------------------------------------
  server.tool(
    "refresh_parcel_terrain_export",
    TOOL_COPY.refresh_parcel_terrain_export,
    {
      parcel_node_id: z
        .string()
        .regex(
          PARCEL_NODE_ID_REGEX,
          "parcel_node_id must be county_fips:prop_id (e.g. 48021:27303)",
        )
        .describe("Permanent parcel node id county_fips:prop_id. Required."),
      format: z
        .enum(TERRAIN_EXPORT_FORMATS)
        .optional()
        .describe(
          "Optional artifact format to download after refresh (glb, ifc, dxf-3dface, dxf-contour, landxml-tin).",
        ),
      resolution_meters: z
        .number()
        .positive()
        .optional()
        .describe("Optional DEM resolution in meters forwarded to engine-api."),
      contour_interval_meters: z
        .number()
        .positive()
        .optional()
        .describe("Optional contour interval in meters for dxf-contour."),
    },
    async ({
      parcel_node_id,
      format,
      resolution_meters,
      contour_interval_meters,
    }) => {
      const tool = "refresh_parcel_terrain_export";
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      const paidTarget = {
        accessPolicy: "public-paid" as const,
        jurisdictionTenant: "property-spine",
        sharedWithTenants: [] as string[],
      };
      if (!canReadAccessTarget(subject, paidTarget)) {
        logAccessDenied({
          tool,
          policy: "public-paid",
          atomJurisdiction: paidTarget.jurisdictionTenant,
          subjectTenant: subject.jurisdictionTenant,
          platformInternal: subject.platformInternal,
          reason: "terrain_export_paid_catalog",
        });
        return errorContent(
          `${tool} requires a paid X-Hauska-Key (public-paid). Anonymous and free tiers cannot refresh terrain exports.`,
        );
      }

      const identity = requireIdentifiedCaller(tool);
      if (!identity.ok) return identity.content;

      const authCtx = getCurrentAuthContext();
      if (isSdkMeteringEnabled()) {
        const meter = await authorizePaidCall({
          keyId: authCtx!.key_id!,
          keyHash: authCtx?.key_hash,
          mcpTier: tier,
          tool,
          requestId: getCurrentRequestId(),
          product: getCurrentProduct(),
        });
        if (!meter.allowed) {
          logger.warn("tool_metering_denied", {
            tool,
            deny_reason: meter.denyReason ?? null,
          });
          return errorContent(
            meter.denyMessage ??
              `Metering denied for tool "${tool}". Upgrade or retry after quota resets.`,
          );
        }
      }

      const gateProduct = gateFrontProductFor(getCurrentProduct()) ?? "cortex";
      const gate = {
        gateProduct,
        accessTier: "public-paid" as const,
        tenantId:
          resolveGateTenantId(authCtx) ??
          authCtx?.key_id ??
          "public-catalog",
        gateCredentialId: authCtx!.key_id!,
        requestId: getCurrentRequestId(),
      };

      try {
        const refresh = await engineApiClient.refreshParcelTerrainExport(
          parcel_node_id,
          {
            resolutionMeters: resolution_meters,
            contourIntervalMeters: contour_interval_meters,
          },
          gate,
        );

        const data: import("./terrain-export-contract.js").ParcelTerrainExportToolData =
          {
            parcelNodeId: parcel_node_id,
            atom: refresh.atom,
            artifacts: refresh.artifacts,
          };

        if (format && !isTerrainExportFormatDeferred(refresh.artifacts, format)) {
          const artifactEntry = refresh.artifacts[format];
          const { bytes, contentType } =
            await engineApiClient.downloadParcelTerrainExport(
              parcel_node_id,
              format,
              gate,
            );
          const byteCount = bytes.byteLength;
          const downloadPath = terrainExportDownloadPath(parcel_node_id, format);
          if (byteCount <= TERRAIN_EXPORT_MAX_INLINE_BYTES) {
            data.download = {
              format,
              contentType: contentType || terrainExportContentType(format),
              base64: Buffer.from(bytes).toString("base64"),
              byteCount,
            };
          } else {
            data.download = {
              format,
              contentType: contentType || terrainExportContentType(format),
              ref: artifactEntry?.ref ?? downloadPath,
              byteCount,
              downloadPath,
            };
          }
        } else if (format && isTerrainExportFormatDeferred(refresh.artifacts, format)) {
          const deferred = refresh.artifacts[format];
          data.download = undefined;
          data.artifacts = {
            ...data.artifacts,
            [format]: deferred ?? {
              format,
              deferred: true,
              deferredReason: `${format} is deferred or unavailable for this parcel.`,
            },
          };
        }

        const __readEnv = finalizeReadEnvelope(
          tool,
          parcelTerrainExportEnvelope(data, {
            tier,
            readKind: "catalog",
            note:
              typeof refresh.atom.sourceCitation === "string"
                ? `Source: ${refresh.atom.sourceCitation}. One SDK meter consumed per export request.`
                : "Source: USGS 3DEP. One SDK meter consumed per export request.",
          }),
          "public-paid",
        );
        logToolRead(
          {
            tool,
            parcel_node_id,
            tier,
            format: format ?? null,
            artifact_count: Object.keys(refresh.artifacts).length,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof EngineApiTimeoutError) {
          return errorContent(
            `${err.message}. The engine may be cold-starting; retry the export in a moment.`,
          );
        }
        if (err instanceof EngineApiUnreachableError) {
          return errorContent(
            `Engine API unreachable at ${err.url}. Terrain export requires engine-api.`,
          );
        }
        if (err instanceof EngineApiHttpError) {
          return errorContent(
            `Engine API rejected terrain export (${err.status}): ${err.body.slice(0, 200)}`,
          );
        }
        return errorContent(
          `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2d: refresh_parcel_site_plan_export (Wave 3 pay-gate extension,
  // site-plan-export sprint, WDLL items 7-8).
  // Sibling of refresh_parcel_terrain_export above: SAME public-paid
  // accessPolicy gate, SAME one-meter-per-export-request metering
  // discipline via the shared SDK metering helper below — a distinct
  // engine route (site-plan-export/*) and format set (dxf-site-plan,
  // ifc-site-plan, pdf-site-plan) rather than an extension of the
  // terrain-export tool, because the engine already ships the site-plan
  // formats as a separate route group on the same parcel-terrain-model
  // atom. No new SKU, no new metering shape — format/tier addition on
  // the existing pay-gate. See
  // _inbox/2026-07-25_site_plan_export_STATUS.md (Wave 3) for the
  // decision record.
  // -----------------------------------------------------------------
  server.tool(
    "refresh_parcel_site_plan_export",
    TOOL_COPY.refresh_parcel_site_plan_export,
    {
      parcel_node_id: z
        .string()
        .regex(
          PARCEL_NODE_ID_REGEX,
          "parcel_node_id must be county_fips:prop_id (e.g. 48029:105129)",
        )
        .describe("Permanent parcel node id county_fips:prop_id. Required."),
      format: z
        .enum(SITE_PLAN_EXPORT_FORMATS)
        .optional()
        .describe(
          "Optional artifact format to download after refresh (dxf-site-plan, ifc-site-plan, pdf-site-plan).",
        ),
      resolution_meters: z
        .number()
        .positive()
        .optional()
        .describe("Optional DEM resolution in meters forwarded to engine-api."),
      contour_interval_meters: z
        .number()
        .positive()
        .optional()
        .describe("Optional contour interval in meters for the CONTOUR layer."),
      address: z
        .string()
        .optional()
        .describe(
          "Optional caller-supplied street address for the PDF summary block. Never fabricated by the engine when omitted.",
        ),
      county_name: z
        .string()
        .optional()
        .describe(
          "Optional caller-supplied county name for the PDF summary block. Never fabricated by the engine when omitted.",
        ),
    },
    async ({
      parcel_node_id,
      format,
      resolution_meters,
      contour_interval_meters,
      address,
      county_name,
    }) => {
      const tool = "refresh_parcel_site_plan_export";
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      const paidTarget = {
        accessPolicy: "public-paid" as const,
        jurisdictionTenant: "property-spine",
        sharedWithTenants: [] as string[],
      };
      if (!canReadAccessTarget(subject, paidTarget)) {
        logAccessDenied({
          tool,
          policy: "public-paid",
          atomJurisdiction: paidTarget.jurisdictionTenant,
          subjectTenant: subject.jurisdictionTenant,
          platformInternal: subject.platformInternal,
          reason: "site_plan_export_paid_catalog",
        });
        return errorContent(
          `${tool} requires a paid X-Hauska-Key (public-paid). Anonymous and free tiers cannot refresh site-plan exports.`,
        );
      }

      const identity = requireIdentifiedCaller(tool);
      if (!identity.ok) return identity.content;

      const authCtx = getCurrentAuthContext();
      if (isSdkMeteringEnabled()) {
        const meter = await authorizePaidCall({
          keyId: authCtx!.key_id!,
          keyHash: authCtx?.key_hash,
          mcpTier: tier,
          tool,
          requestId: getCurrentRequestId(),
          product: getCurrentProduct(),
        });
        if (!meter.allowed) {
          logger.warn("tool_metering_denied", {
            tool,
            deny_reason: meter.denyReason ?? null,
          });
          return errorContent(
            meter.denyMessage ??
              `Metering denied for tool "${tool}". Upgrade or retry after quota resets.`,
          );
        }
      }

      const gateProduct = gateFrontProductFor(getCurrentProduct()) ?? "cortex";
      const gate = {
        gateProduct,
        accessTier: "public-paid" as const,
        tenantId:
          resolveGateTenantId(authCtx) ??
          authCtx?.key_id ??
          "public-catalog",
        gateCredentialId: authCtx!.key_id!,
        requestId: getCurrentRequestId(),
      };

      try {
        const refresh = await engineApiClient.refreshParcelSitePlanExport(
          parcel_node_id,
          {
            resolutionMeters: resolution_meters,
            contourIntervalMeters: contour_interval_meters,
            address,
            countyName: county_name,
          },
          gate,
        );

        const data: import("./site-plan-export-contract.js").ParcelSitePlanExportToolData =
          {
            parcelNodeId: parcel_node_id,
            atom: refresh.atom,
            artifacts: refresh.artifacts,
            setbackDegenerate: refresh.setbackDegenerate,
            setbackDegenerateReason: refresh.setbackDegenerateReason,
            setbackHonestAbsence: refresh.setbackHonestAbsence,
            setbackHonestAbsenceReason: refresh.setbackHonestAbsenceReason,
            streetHonestAbsence: refresh.streetHonestAbsence,
            zoningHonestAbsence: refresh.zoningHonestAbsence,
            floodZoneHonestUnavailable: refresh.floodZoneHonestUnavailable,
          };

        if (format && !isSitePlanExportFormatDeferred(refresh.artifacts, format)) {
          const artifactEntry = refresh.artifacts[format];
          const { bytes, contentType } =
            await engineApiClient.downloadParcelSitePlanExport(
              parcel_node_id,
              format,
              gate,
            );
          const byteCount = bytes.byteLength;
          const downloadPath = sitePlanExportDownloadPath(parcel_node_id, format);
          if (byteCount <= SITE_PLAN_EXPORT_MAX_INLINE_BYTES) {
            data.download = {
              format,
              contentType: contentType || sitePlanExportContentType(format),
              base64: Buffer.from(bytes).toString("base64"),
              byteCount,
            };
          } else {
            data.download = {
              format,
              contentType: contentType || sitePlanExportContentType(format),
              ref: artifactEntry?.ref ?? downloadPath,
              byteCount,
              downloadPath,
            };
          }
        } else if (format && isSitePlanExportFormatDeferred(refresh.artifacts, format)) {
          const deferred = refresh.artifacts[format];
          data.download = undefined;
          data.artifacts = {
            ...data.artifacts,
            [format]: deferred ?? {
              format,
              deferred: true,
              deferredReason: `${format} is deferred or unavailable for this parcel.`,
            },
          };
        }

        const __readEnv = finalizeReadEnvelope(
          tool,
          parcelSitePlanExportEnvelope(data, {
            tier,
            readKind: "catalog",
            note:
              "Derived from public GIS records. Not a boundary survey. Not for legal record. " +
              "One SDK meter consumed per export request regardless of format count.",
          }),
          "public-paid",
        );
        logToolRead(
          {
            tool,
            parcel_node_id,
            tier,
            format: format ?? null,
            artifact_count: Object.keys(refresh.artifacts).length,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof EngineApiTimeoutError) {
          return errorContent(
            `${err.message}. The engine may be cold-starting; retry the export in a moment.`,
          );
        }
        if (err instanceof EngineApiUnreachableError) {
          return errorContent(
            `Engine API unreachable at ${err.url}. Site-plan export requires engine-api.`,
          );
        }
        if (err instanceof EngineApiHttpError) {
          if (err.status === 422) {
            return errorContent(
              `Engine API rejected site-plan export (422 — setback-rule missing, engine refuses to fabricate F/S/R): ${err.body.slice(0, 200)}`,
            );
          }
          return errorContent(
            `Engine API rejected site-plan export (${err.status}): ${err.body.slice(0, 200)}`,
          );
        }
        return errorContent(
          `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2e: download_parcel_site_plan_export
  //
  // Streams the bytes for one already-refreshed site-plan artifact back to
  // the caller as base64. The refresh tool inlines artifacts under
  // SITE_PLAN_EXPORT_MAX_INLINE_BYTES (256 KiB); larger CAD/PDF artifacts
  // (a PDF site-plan sheet is ~430 KiB) return a ref only, and the caller
  // must fetch them separately. This tool is that separate hop.
  //
  // Why it exists: engine-api accepts ONLY gate-signed calls (the
  // X-Hauska-Gate-Context / X-Hauska-Gate-Signature pair produced from
  // GATE_CONTEXT_SIGNING_KEY, which lives only here in the gate). A BFF
  // that calls engine-api directly with a Bearer token and plain gate-front
  // headers is rejected with gate_front_context_required. So the download
  // hop must run through the gate too, exactly like the refresh hop.
  //
  // SAME public-paid gate as the refresh tool. NOT metered: the SDK meter is
  // consumed once at refresh time; the download is the cheap second hop of
  // that same paid request (mirrors cortex_deliverable_letter_render_download,
  // which gates but does not meter). Returns the bytes in data.download as
  // { format, contentType, base64, byteCount } so BFF callers reuse the same
  // inline-download extractor they use for the refresh response.
  // -----------------------------------------------------------------
  server.tool(
    "download_parcel_site_plan_export",
    "Download the bytes for one already-refreshed site-plan export artifact " +
      "(dxf-site-plan, ifc-site-plan, pdf-site-plan). Gate-signed proxy to " +
      "engine-api; returns the file as base64 with its content type. Call " +
      "refresh_parcel_site_plan_export first to build the artifacts. " +
      "public-paid; one SDK meter is consumed at refresh, not here.",
    {
      parcel_node_id: z
        .string()
        .regex(
          PARCEL_NODE_ID_REGEX,
          "parcel_node_id must be county_fips:prop_id (e.g. 48029:105129)",
        )
        .describe("Permanent parcel node id county_fips:prop_id. Required."),
      format: z
        .enum(SITE_PLAN_EXPORT_FORMATS)
        .describe(
          "Artifact format to download (dxf-site-plan, ifc-site-plan, pdf-site-plan). Required.",
        ),
    },
    async ({ parcel_node_id, format }) => {
      const tool = "download_parcel_site_plan_export";
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      const paidTarget = {
        accessPolicy: "public-paid" as const,
        jurisdictionTenant: "property-spine",
        sharedWithTenants: [] as string[],
      };
      if (!canReadAccessTarget(subject, paidTarget)) {
        logAccessDenied({
          tool,
          policy: "public-paid",
          atomJurisdiction: paidTarget.jurisdictionTenant,
          subjectTenant: subject.jurisdictionTenant,
          platformInternal: subject.platformInternal,
          reason: "site_plan_export_download_paid_catalog",
        });
        return errorContent(
          `${tool} requires a paid X-Hauska-Key (public-paid). Anonymous and free tiers cannot download site-plan exports.`,
        );
      }

      const identity = requireIdentifiedCaller(tool);
      if (!identity.ok) return identity.content;

      const authCtx = getCurrentAuthContext();
      const gateProduct = gateFrontProductFor(getCurrentProduct()) ?? "cortex";
      const gate = {
        gateProduct,
        accessTier: "public-paid" as const,
        tenantId:
          resolveGateTenantId(authCtx) ??
          authCtx?.key_id ??
          "public-catalog",
        gateCredentialId: authCtx!.key_id!,
        requestId: getCurrentRequestId(),
      };

      try {
        const { bytes, contentType } =
          await engineApiClient.downloadParcelSitePlanExport(
            parcel_node_id,
            format,
            gate,
          );
        const byteCount = bytes.byteLength;
        const data = {
          parcelNodeId: parcel_node_id,
          download: {
            format,
            contentType: contentType || sitePlanExportContentType(format),
            base64: Buffer.from(bytes).toString("base64"),
            byteCount,
          },
        };
        const __readEnv = finalizeReadEnvelope(
          tool,
          buildEnvelope(
            data,
            [
              {
                did: `did:hauska:site-plan-export:${parcel_node_id}:${format}`,
                entityType: "parcel-site-plan-export-artifact",
                entityId: parcel_node_id,
                jurisdictionTenant: "property-spine",
                contentHash: null,
                cidNote:
                  "Binary artifact returned as base64; derived from public GIS records.",
                source: {
                  adapter: "engine-api",
                  url: sitePlanExportDownloadPath(parcel_node_id, format),
                  fetchedAt: new Date().toISOString(),
                },
              },
            ],
            { tier, readKind: "catalog" },
          ),
          "public-paid",
        );
        logToolRead(
          {
            tool,
            parcel_node_id,
            tier,
            format,
            byte_length: byteCount,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof EngineApiTimeoutError) {
          return errorContent(
            `${err.message}. The engine may be cold-starting; retry the download in a moment.`,
          );
        }
        if (err instanceof EngineApiUnreachableError) {
          return errorContent(
            `Engine API unreachable at ${err.url}. Site-plan export download requires engine-api.`,
          );
        }
        if (err instanceof EngineApiHttpError) {
          if (err.status === 404) {
            return errorContent(
              `Site-plan artifact not found (404) for ${parcel_node_id} format ${format}. ` +
                "Call refresh_parcel_site_plan_export first to build it.",
            );
          }
          return errorContent(
            `Engine API rejected site-plan export download (${err.status}): ${err.body.slice(0, 200)}`,
          );
        }
        return errorContent(
          `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2d-2: refresh_parcel_dossier_export (engine #174 wiring).
  // Sibling of refresh_parcel_site_plan_export above: SAME public-paid
  // accessPolicy gate, SAME one-meter-per-export-request metering
  // discipline via the shared SDK metering helper — a distinct engine
  // route (dossier-export/*) and a single format (pdf-dossier). The
  // dossier is ONE hand-to-client PDF: cover (caller-supplied verdict,
  // verbatim + labeled), cited brief facts, AI chat summary (labeled with
  // disclaimer), owner notes, and the parcel's site-plan sheets appended.
  // The request body is forwarded to the engine VERBATIM; the engine
  // renders exactly what it carries and honest-degrades on anything
  // absent — a missing site-plan capability never fails the export.
  // -----------------------------------------------------------------
  server.tool(
    "refresh_parcel_dossier_export",
    TOOL_COPY.refresh_parcel_dossier_export,
    {
      parcel_node_id: z
        .string()
        .regex(
          PARCEL_NODE_ID_REGEX,
          "parcel_node_id must be county_fips:prop_id (e.g. 48029:105129)",
        )
        .describe("Permanent parcel node id county_fips:prop_id. Required."),
      format: z
        .enum(DOSSIER_EXPORT_FORMATS)
        .optional()
        .describe(
          "Optional artifact format to download after refresh (pdf-dossier is the only dossier format).",
        ),
      address: z
        .string()
        .optional()
        .describe(
          "Optional caller-supplied street address for the cover and summary blocks. Never fabricated by the engine when omitted.",
        ),
      county_name: z
        .string()
        .optional()
        .describe(
          "Optional caller-supplied county name for the cover and summary blocks. Never fabricated by the engine when omitted.",
        ),
      verdict_line: z
        .string()
        .optional()
        .describe(
          "Optional caller-supplied verdict line rendered VERBATIM and labeled as caller-supplied on the dossier cover.",
        ),
      brief: z
        .object({
          sections: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              facts: z.array(
                z.object({
                  label: z.string(),
                  value: z.string().optional(),
                  source: z.string().optional(),
                  vintage: z.string().optional(),
                }),
              ),
            }),
          ),
        })
        .optional()
        .describe(
          "Optional brief facts (sections of label/value facts with per-fact source and vintage) rendered in the summary-grid language. Absent values render as honest UNAVAILABLE chips.",
        ),
      chat_summary: z
        .object({
          summary: z.string(),
          savedAt: z.string(),
          disclaimer: z.string().optional(),
        })
        .optional()
        .describe(
          "Optional AI research summary (labeled page with user disclaimer in fine print).",
        ),
      notes: z
        .string()
        .optional()
        .describe("Optional owner notes rendered on their own dossier page."),
    },
    async ({
      parcel_node_id,
      format,
      address,
      county_name,
      verdict_line,
      brief,
      chat_summary,
      notes,
    }) => {
      const tool = "refresh_parcel_dossier_export";
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      const paidTarget = {
        accessPolicy: "public-paid" as const,
        jurisdictionTenant: "property-spine",
        sharedWithTenants: [] as string[],
      };
      if (!canReadAccessTarget(subject, paidTarget)) {
        logAccessDenied({
          tool,
          policy: "public-paid",
          atomJurisdiction: paidTarget.jurisdictionTenant,
          subjectTenant: subject.jurisdictionTenant,
          platformInternal: subject.platformInternal,
          reason: "dossier_export_paid_catalog",
        });
        return errorContent(
          `${tool} requires a paid X-Hauska-Key (public-paid). Anonymous and free tiers cannot refresh dossier exports.`,
        );
      }

      const identity = requireIdentifiedCaller(tool);
      if (!identity.ok) return identity.content;

      const authCtx = getCurrentAuthContext();
      if (isSdkMeteringEnabled()) {
        const meter = await authorizePaidCall({
          keyId: authCtx!.key_id!,
          keyHash: authCtx?.key_hash,
          mcpTier: tier,
          tool,
          requestId: getCurrentRequestId(),
          product: getCurrentProduct(),
        });
        if (!meter.allowed) {
          logger.warn("tool_metering_denied", {
            tool,
            deny_reason: meter.denyReason ?? null,
          });
          return errorContent(
            meter.denyMessage ??
              `Metering denied for tool "${tool}". Upgrade or retry after quota resets.`,
          );
        }
      }

      const gateProduct = gateFrontProductFor(getCurrentProduct()) ?? "cortex";
      const gate = {
        gateProduct,
        accessTier: "public-paid" as const,
        tenantId:
          resolveGateTenantId(authCtx) ??
          authCtx?.key_id ??
          "public-catalog",
        gateCredentialId: authCtx!.key_id!,
        requestId: getCurrentRequestId(),
      };

      try {
        const refresh = await engineApiClient.refreshParcelDossierExport(
          parcel_node_id,
          {
            address,
            countyName: county_name,
            verdictLine: verdict_line,
            brief,
            chatSummary: chat_summary,
            notes,
          },
          gate,
        );

        const data: import("./dossier-export-contract.js").ParcelDossierExportToolData =
          {
            parcelNodeId: parcel_node_id,
            atom: refresh.atom,
            artifacts: refresh.artifacts,
            pageCount: refresh.pageCount,
            dossierPageCount: refresh.dossierPageCount,
            sitePlanAppended: refresh.sitePlanAppended,
            sitePlanUnavailableReason: refresh.sitePlanUnavailableReason,
            verdictIncluded: refresh.verdictIncluded,
            briefSectionCount: refresh.briefSectionCount,
            briefFactCount: refresh.briefFactCount,
            chatSummaryIncluded: refresh.chatSummaryIncluded,
            notesIncluded: refresh.notesIncluded,
            setbackDegenerate: refresh.setbackDegenerate,
            setbackHonestAbsence: refresh.setbackHonestAbsence,
            streetHonestAbsence: refresh.streetHonestAbsence,
            zoningHonestAbsence: refresh.zoningHonestAbsence,
            floodZoneHonestUnavailable: refresh.floodZoneHonestUnavailable,
          };

        if (format && !isDossierExportArtifactDeferred(refresh.artifacts)) {
          const artifactEntry = refresh.artifacts["pdf-dossier"];
          const { bytes, contentType } =
            await engineApiClient.downloadParcelDossierExport(
              parcel_node_id,
              gate,
            );
          const byteCount = bytes.byteLength;
          const downloadPath = dossierExportDownloadPath(parcel_node_id);
          if (byteCount <= DOSSIER_EXPORT_MAX_INLINE_BYTES) {
            data.download = {
              format: "pdf-dossier",
              contentType: contentType || DOSSIER_EXPORT_CONTENT_TYPE,
              base64: Buffer.from(bytes).toString("base64"),
              byteCount,
            };
          } else {
            data.download = {
              format: "pdf-dossier",
              contentType: contentType || DOSSIER_EXPORT_CONTENT_TYPE,
              ref: artifactEntry?.ref ?? downloadPath,
              byteCount,
              downloadPath,
            };
          }
        } else if (format && isDossierExportArtifactDeferred(refresh.artifacts)) {
          const deferred = refresh.artifacts["pdf-dossier"];
          data.download = undefined;
          data.artifacts = {
            ...data.artifacts,
            "pdf-dossier": deferred ?? {
              format: "pdf-dossier",
              deferred: true,
              deferredReason:
                "pdf-dossier is deferred or unavailable for this parcel.",
            },
          };
        }

        const __readEnv = finalizeReadEnvelope(
          tool,
          parcelDossierExportEnvelope(data, {
            tier,
            readKind: "catalog",
            note:
              "Site geometry derived from public GIS records; verdict, brief facts, chat summary, and notes are caller-supplied and rendered verbatim with honest-absence chips. Not a boundary survey. Not for legal record. " +
              "One SDK meter consumed per export request.",
          }),
          "public-paid",
        );
        logToolRead(
          {
            tool,
            parcel_node_id,
            tier,
            format: format ?? null,
            artifact_count: Object.keys(refresh.artifacts).length,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof EngineApiTimeoutError) {
          return errorContent(
            `${err.message}. The engine may be cold-starting; retry the export in a moment.`,
          );
        }
        if (err instanceof EngineApiUnreachableError) {
          return errorContent(
            `Engine API unreachable at ${err.url}. Dossier export requires engine-api.`,
          );
        }
        if (err instanceof EngineApiHttpError) {
          return errorContent(
            `Engine API rejected dossier export (${err.status}): ${err.body.slice(0, 200)}`,
          );
        }
        return errorContent(
          `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2e-2: download_parcel_dossier_export
  //
  // Streams the bytes for the already-refreshed pdf-dossier artifact back
  // to the caller as base64. A multi-sheet dossier PDF routinely exceeds
  // the 256 KiB inline cap, so the refresh tool returns a ref and the BFF
  // fetches the bytes through this gate-signed hop (engine-api accepts
  // ONLY gate-signed calls — same reason download_parcel_site_plan_export
  // exists). No format param: the engine's dossier download route serves
  // the single pdf-dossier artifact unconditionally.
  //
  // SAME public-paid gate as the refresh tool. NOT metered: the SDK meter
  // is consumed once at refresh time; the download is the cheap second hop
  // of that same paid request.
  // -----------------------------------------------------------------
  server.tool(
    "download_parcel_dossier_export",
    "Download the bytes for the already-refreshed property-dossier PDF " +
      "(pdf-dossier). Gate-signed proxy to engine-api; returns the file as " +
      "base64 with its content type. Call refresh_parcel_dossier_export " +
      "first to build the artifact. " +
      "public-paid; one SDK meter is consumed at refresh, not here.",
    {
      parcel_node_id: z
        .string()
        .regex(
          PARCEL_NODE_ID_REGEX,
          "parcel_node_id must be county_fips:prop_id (e.g. 48029:105129)",
        )
        .describe("Permanent parcel node id county_fips:prop_id. Required."),
    },
    async ({ parcel_node_id }) => {
      const tool = "download_parcel_dossier_export";
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      const paidTarget = {
        accessPolicy: "public-paid" as const,
        jurisdictionTenant: "property-spine",
        sharedWithTenants: [] as string[],
      };
      if (!canReadAccessTarget(subject, paidTarget)) {
        logAccessDenied({
          tool,
          policy: "public-paid",
          atomJurisdiction: paidTarget.jurisdictionTenant,
          subjectTenant: subject.jurisdictionTenant,
          platformInternal: subject.platformInternal,
          reason: "dossier_export_download_paid_catalog",
        });
        return errorContent(
          `${tool} requires a paid X-Hauska-Key (public-paid). Anonymous and free tiers cannot download dossier exports.`,
        );
      }

      const identity = requireIdentifiedCaller(tool);
      if (!identity.ok) return identity.content;

      const authCtx = getCurrentAuthContext();
      const gateProduct = gateFrontProductFor(getCurrentProduct()) ?? "cortex";
      const gate = {
        gateProduct,
        accessTier: "public-paid" as const,
        tenantId:
          resolveGateTenantId(authCtx) ??
          authCtx?.key_id ??
          "public-catalog",
        gateCredentialId: authCtx!.key_id!,
        requestId: getCurrentRequestId(),
      };

      try {
        const { bytes, contentType } =
          await engineApiClient.downloadParcelDossierExport(
            parcel_node_id,
            gate,
          );
        const byteCount = bytes.byteLength;
        const data = {
          parcelNodeId: parcel_node_id,
          download: {
            format: "pdf-dossier" as const,
            contentType: contentType || DOSSIER_EXPORT_CONTENT_TYPE,
            base64: Buffer.from(bytes).toString("base64"),
            byteCount,
          },
        };
        const __readEnv = finalizeReadEnvelope(
          tool,
          buildEnvelope(
            data,
            [
              {
                did: `did:hauska:dossier-export:${parcel_node_id}:pdf-dossier`,
                entityType: "parcel-site-plan-export-artifact",
                entityId: parcel_node_id,
                jurisdictionTenant: "property-spine",
                contentHash: null,
                cidNote:
                  "Binary artifact returned as base64; site geometry derived from public GIS records, dossier content caller-supplied.",
                source: {
                  adapter: "engine-api",
                  url: dossierExportDownloadPath(parcel_node_id),
                  fetchedAt: new Date().toISOString(),
                },
              },
            ],
            { tier, readKind: "catalog" },
          ),
          "public-paid",
        );
        logToolRead(
          {
            tool,
            parcel_node_id,
            tier,
            format: "pdf-dossier",
            byte_length: byteCount,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof EngineApiTimeoutError) {
          return errorContent(
            `${err.message}. The engine may be cold-starting; retry the download in a moment.`,
          );
        }
        if (err instanceof EngineApiUnreachableError) {
          return errorContent(
            `Engine API unreachable at ${err.url}. Dossier export download requires engine-api.`,
          );
        }
        if (err instanceof EngineApiHttpError) {
          if (err.status === 404) {
            return errorContent(
              `Dossier artifact not found (404) for ${parcel_node_id}. ` +
                "Call refresh_parcel_dossier_export first to build it.",
            );
          }
          if (err.status === 410) {
            return errorContent(
              `Dossier artifact bytes evicted (410) for ${parcel_node_id}. ` +
                "Call refresh_parcel_dossier_export again to rebuild it.",
            );
          }
          return errorContent(
            `Engine API rejected dossier export download (${err.status}): ${err.body.slice(0, 200)}`,
          );
        }
        return errorContent(
          `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 2f: download_parcel_terrain_export
  //
  // Terrain sibling of download_parcel_site_plan_export. SAME public-paid
  // gate, SAME gate-signed engine hop, SAME not-metered discipline. Streams
  // one already-refreshed terrain artifact (glb, ifc, dxf-3dface,
  // dxf-contour, landxml-tin) back as base64. Terrain meshes routinely
  // exceed the 256 KiB inline cap, so the BFF must download through the
  // gate here rather than calling engine-api directly.
  // -----------------------------------------------------------------
  server.tool(
    "download_parcel_terrain_export",
    "Download the bytes for one already-refreshed terrain export artifact " +
      "(glb, ifc, dxf-3dface, dxf-contour, landxml-tin). Gate-signed proxy " +
      "to engine-api; returns the file as base64 with its content type. Call " +
      "refresh_parcel_terrain_export first to build the artifacts. " +
      "public-paid; one SDK meter is consumed at refresh, not here.",
    {
      parcel_node_id: z
        .string()
        .regex(
          PARCEL_NODE_ID_REGEX,
          "parcel_node_id must be county_fips:prop_id (e.g. 48021:27303)",
        )
        .describe("Permanent parcel node id county_fips:prop_id. Required."),
      format: z
        .enum(TERRAIN_EXPORT_FORMATS)
        .describe(
          "Artifact format to download (glb, ifc, dxf-3dface, dxf-contour, landxml-tin). Required.",
        ),
    },
    async ({ parcel_node_id, format }) => {
      const tool = "download_parcel_terrain_export";
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      const paidTarget = {
        accessPolicy: "public-paid" as const,
        jurisdictionTenant: "property-spine",
        sharedWithTenants: [] as string[],
      };
      if (!canReadAccessTarget(subject, paidTarget)) {
        logAccessDenied({
          tool,
          policy: "public-paid",
          atomJurisdiction: paidTarget.jurisdictionTenant,
          subjectTenant: subject.jurisdictionTenant,
          platformInternal: subject.platformInternal,
          reason: "terrain_export_download_paid_catalog",
        });
        return errorContent(
          `${tool} requires a paid X-Hauska-Key (public-paid). Anonymous and free tiers cannot download terrain exports.`,
        );
      }

      const identity = requireIdentifiedCaller(tool);
      if (!identity.ok) return identity.content;

      const authCtx = getCurrentAuthContext();
      const gateProduct = gateFrontProductFor(getCurrentProduct()) ?? "cortex";
      const gate = {
        gateProduct,
        accessTier: "public-paid" as const,
        tenantId:
          resolveGateTenantId(authCtx) ??
          authCtx?.key_id ??
          "public-catalog",
        gateCredentialId: authCtx!.key_id!,
        requestId: getCurrentRequestId(),
      };

      try {
        const { bytes, contentType } =
          await engineApiClient.downloadParcelTerrainExport(
            parcel_node_id,
            format,
            gate,
          );
        const byteCount = bytes.byteLength;
        const data = {
          parcelNodeId: parcel_node_id,
          download: {
            format,
            contentType: contentType || terrainExportContentType(format),
            base64: Buffer.from(bytes).toString("base64"),
            byteCount,
          },
        };
        const __readEnv = finalizeReadEnvelope(
          tool,
          buildEnvelope(
            data,
            [
              {
                did: `did:hauska:terrain-export:${parcel_node_id}:${format}`,
                entityType: "parcel-terrain-export-artifact",
                entityId: parcel_node_id,
                jurisdictionTenant: "property-spine",
                contentHash: null,
                cidNote:
                  "Binary artifact returned as base64; derived from USGS 3DEP and public GIS records.",
                source: {
                  adapter: "engine-api",
                  url: terrainExportDownloadPath(parcel_node_id, format),
                  fetchedAt: new Date().toISOString(),
                },
              },
            ],
            { tier, readKind: "catalog" },
          ),
          "public-paid",
        );
        logToolRead(
          {
            tool,
            parcel_node_id,
            tier,
            format,
            byte_length: byteCount,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof EngineApiTimeoutError) {
          return errorContent(
            `${err.message}. The engine may be cold-starting; retry the download in a moment.`,
          );
        }
        if (err instanceof EngineApiUnreachableError) {
          return errorContent(
            `Engine API unreachable at ${err.url}. Terrain export download requires engine-api.`,
          );
        }
        if (err instanceof EngineApiHttpError) {
          if (err.status === 404) {
            return errorContent(
              `Terrain artifact not found (404) for ${parcel_node_id} format ${format}. ` +
                "Call refresh_parcel_terrain_export first to build it.",
            );
          }
          return errorContent(
            `Engine API rejected terrain export download (${err.status}): ${err.body.slice(0, 200)}`,
          );
        }
        return errorContent(
          `Unexpected error invoking ${tool}: ${String(err).slice(0, 200)}`,
        );
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
        if (!response.status) {
          const __readEnv = queryJurisdictionEnvelope(response, {
            tier,
            note: `Jurisdiction "${jurisdiction}" is not loaded. Call list_jurisdictions to see available tenants.`,
          });
          logToolRead({
            tool: "query_jurisdiction",
            jurisdiction,
            tier,
            found: false,
          }, __readEnv.atoms);
          return envelopeContent(__readEnv);
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
          const __readEnv = queryJurisdictionEnvelope({ status: null }, {
            tier,
            note: `Jurisdiction "${jurisdiction}" is not loaded. Call list_jurisdictions to see available tenants.`,
          });
          logToolRead({
            tool: "query_jurisdiction",
            jurisdiction,
            tier,
            found: false,
          }, __readEnv.atoms);
          return envelopeContent(__readEnv);
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
        const __readEnv = queryJurisdictionEnvelope(
          { ...response, permitAtoms },
          { tier },
        );
        logToolRead({
          tool: "query_jurisdiction",
          jurisdiction,
          tier,
          found: true,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
        const __readEnv = searchPermitAtomsEnvelope({ ...response, permitAtoms }, { tier });
        logToolRead({
          tool: "search_permit_atoms",
          jurisdiction,
          project_type,
          tier,
          count: permitAtoms?.length ?? 0,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
        const __readEnv = listJurisdictionsEnvelope({ jurisdictions }, { tier });
        logToolRead({
          tool: "list_jurisdictions",
          tier,
          count: jurisdictions.length,
          public_filtered: accessPolicies !== undefined,
          quality_bar_only,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
      } catch (err) {
        return errorContent(describeEngineFailure("list_jurisdictions", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Tool 6: atom_trace
  // Engine GET /atoms/trace/:did — parcel-to-atoms-to-lineage (public).
  // -----------------------------------------------------------------
  server.tool(
    "atom_trace",
    TOOL_COPY.atom_trace,
    {
      atom_id: z
        .string()
        .regex(ATOM_DID_REGEX, "atom_id must be a Hauska DID")
        .describe("Atom DID to trace. Required."),
      audience: z
        .enum(["user", "ai", "internal"])
        .optional()
        .default("ai")
        .describe("Scope audience for context summary filtering."),
    },
    async ({ atom_id, audience }) => {
      const tier = getCurrentTier();
      try {
        const trace = await hauskaClient.getAtomTrace({
          atomDid: atom_id,
          audience,
        });
        if (trace?.atom && !assertAtomReadable("atom_trace", trace.atom)) {
          const __readEnv = atomTraceEnvelope(null, {
            tier,
            note: `No readable atom at DID ${atom_id}.`,
          });
          logToolRead({
            tool: "atom_trace",
            atom_id,
            tier,
            found: false,
          }, __readEnv.atoms);
          return envelopeContent(__readEnv);
        }
        const __readEnv = finalizeReadEnvelope(
          "atom_trace",
          atomTraceEnvelope(trace, { tier }),
          trace?.atom?.accessPolicy as import("@empressaio/atom-contract").AccessPolicy | undefined,
        );
        logToolRead({
          tool: "atom_trace",
          atom_id,
          tier,
          found: Boolean(trace),
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
      } catch (err) {
        return errorContent(describeEngineFailure("atom_trace", err));
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
      const productGate = await requireToolProduct("list_property_workspaces");
      if (!productGate.ok) return productGate.content;
      const identity = requireIdentifiedCaller("list_property_workspaces");
      if (!identity.ok) return identity.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listPropertyWorkspaces({
          requesterKeyId: identity.requesterKeyId,
          limit,
        });
        const __readEnv = listPropertyWorkspacesEnvelope(response, { tier });
        logToolRead({
          tool: "list_property_workspaces",
          requester_key_id: identity.requesterKeyId,
          tier,
          count: response.workspaces.length,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const productGate = await requireToolProduct("get_property_workspace");
      if (!productGate.ok) return productGate.content;
      const identity = requireIdentifiedCaller("get_property_workspace");
      if (!identity.ok) return identity.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getPropertyWorkspace({
          workspaceId: workspace_id,
          requesterKeyId: identity.requesterKeyId,
        });
        const __readEnv = getPropertyWorkspaceEnvelope(response, { tier });
        logToolRead({
          tool: "get_property_workspace",
          workspace_id,
          requester_key_id: identity.requesterKeyId,
          tier,
          found: response.workspace !== null,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const productGate = await requireToolProduct("list_workspace_share_edges");
      if (!productGate.ok) return productGate.content;
      const identity = requireIdentifiedCaller("list_workspace_share_edges");
      if (!identity.ok) return identity.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listWorkspaceShareEdges({
          workspaceId: workspace_id,
          requesterKeyId: identity.requesterKeyId,
          consentVisibleOnly: consent_visible_only,
        });
        const __readEnv = listWorkspaceShareEdgesEnvelope(response, { tier });
        logToolRead({
          tool: "list_workspace_share_edges",
          workspace_id,
          requester_key_id: identity.requesterKeyId,
          tier,
          consent_visible_only,
          count: response.edges.length,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const productGate = await requireToolProduct("resolve_place");
      if (!productGate.ok) return productGate.content;
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
        const __readEnv = resolvePlaceEnvelope(response, { tier });
        logToolRead({
          tool: "resolve_place",
          tier,
          jurisdiction_key: response.jurisdiction_key,
          latency_ms: Date.now() - started,
          place_key: response.placeKey,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const productGate = await requireToolProduct("get_place_layers");
      if (!productGate.ok) return productGate.content;
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
        const __readEnv = getPlaceLayersEnvelope(response, { tier });
        logToolRead({
          tool: "get_place_layers",
          tier,
          jurisdiction_key: response.jurisdiction_key,
          latency_ms: Date.now() - started,
          layer_count: response.layers.length,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const productGate = await requireToolProduct("get_place_dossier");
      if (!productGate.ok) return productGate.content;
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
        const __readEnv = getPlaceDossierEnvelope(response, { tier });
        logToolRead({
          tool: "get_place_dossier",
          tier,
          jurisdiction_key: response.jurisdiction_key,
          latency_ms: Date.now() - started,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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

  registerPlanReviewTools(server);

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
      const gate = await requireProduct("cortex_snapshot_register", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            codexProvenance({
              atomKind: "submission",
              rowId,
              jurisdictionTenant: "legacy",
              sourcePath: "/api/snapshots",
            }),
            { tier },
          );
        logToolRead({
          tool: "cortex_snapshot_register",
          engagement_id,
          project_name,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_ifc_ingest", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            codexProvenance({
              atomKind: "submission",
              rowId: snapshot_id,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/snapshots/${snapshot_id}/ifc`,
            }),
            { tier },
          );
        logToolRead({
          tool: "cortex_ifc_ingest",
          snapshot_id,
          filename,
          bytes: bytes.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_bim_model_query", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.queryBimModel({
          engagementId: engagement_id,
        });
        const provenance = response.bimModel
          ? codexProvenance({
              atomKind: "submission",
              rowId: engagement_id,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/engagements/${engagement_id}/bim-model`,
            })
          : null;
        const __readEnv = codexEnvelope(response, provenance, { tier });
        logToolRead({
          tool: "cortex_bim_model_query",
          engagement_id,
          tier,
          has_model: response.bimModel !== null,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_briefing_emit", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.emitBriefing({
          engagementId: engagement_id,
          regenerate,
        });
        const __readEnv = codexEnvelope(
            response,
            codexProvenance({
              atomKind: "brief-run",
              rowId: response.generationId,
              jurisdictionTenant: "legacy",
              sourcePath: `/api/engagements/${engagement_id}/briefing/generate`,
            }),
            { tier },
          );
        logToolRead({
          tool: "cortex_briefing_emit",
          engagement_id,
          generation_id: response.generationId,
          already_in_flight: response.alreadyInFlight ?? false,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_response_task_create", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.responseTask),
            { tier },
          );
        logToolRead({
          tool: "cortex_response_task_create",
          engagement_id,
          response_task_id: response.responseTask.entityId,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_response_task_update_state", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.updateResponseTaskState({
          responseTaskId: response_task_id,
          state,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.responseTask),
            { tier },
          );
        logToolRead({
          tool: "cortex_response_task_update_state",
          response_task_id,
          state,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_response_task_list", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listResponseTasks({
          engagementId: engagement_id,
          state,
        });
        const __readEnv = codexEnvelope(
            response,
            response.responseTasks.map(lSurfaceProvenance),
            { tier },
          );
        logToolRead({
          tool: "cortex_response_task_list",
          engagement_id,
          state,
          count: response.responseTasks.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_response_task_link", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.linkResponseTaskFinding({
          responseTaskId: response_task_id,
          findingId: finding_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.responseTask),
            { tier },
          );
        logToolRead({
          tool: "cortex_response_task_link",
          response_task_id,
          finding_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_sheet_content_extraction_trigger", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.triggerSheetContentExtraction({
          sheetId: sheet_id,
        });
        const provenance = response.sheetContentExtraction
          ? lSurfaceProvenance(response.sheetContentExtraction)
          : null;
        const __readEnv = codexEnvelope(response, provenance, { tier });
        logToolRead({
          tool: "cortex_sheet_content_extraction_trigger",
          sheet_id,
          extracted: response.sheetContentExtraction !== null,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_sheet_content_extraction_fetch", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.fetchSheetContentExtraction({
          sheetId: sheet_id,
        });
        const provenance = response.sheetContentExtraction
          ? lSurfaceProvenance(response.sheetContentExtraction)
          : null;
        const __readEnv = codexEnvelope(response, provenance, { tier });
        logToolRead({
          tool: "cortex_sheet_content_extraction_fetch",
          sheet_id,
          found: response.sheetContentExtraction !== null,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_attached_document_list", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listAttachedDocuments({
          engagementId: engagement_id,
          documentType: document_type,
        });
        const __readEnv = codexEnvelope(
            response,
            response.attachedDocuments.map(lSurfaceProvenance),
            { tier },
          );
        logToolRead({
          tool: "cortex_attached_document_list",
          engagement_id,
          document_type,
          count: response.attachedDocuments.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_attached_document_fetch", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.fetchAttachedDocument({
          attachedDocumentId: attached_document_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.attachedDocument),
            { tier },
          );
        logToolRead({
          tool: "cortex_attached_document_fetch",
          attached_document_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_create", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_create",
          engagement_id,
          letter_id: response.deliverableLetter.entityId,
          section_count: response.deliverableLetter.sections.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_update_section", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_update_section",
          letter_id,
          section_index,
          kind,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_attach_provenance", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_attach_provenance",
          letter_id,
          section_index,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_completeness_check", "reporting");
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
      const gate = await requireProduct("cortex_deliverable_letter_send", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.sendDeliverableLetter({
          letterId: letter_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_send",
          letter_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_detail_callout_spec_create", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          );
        logToolRead({
          tool: "cortex_detail_callout_spec_create",
          engagement_id,
          detail_type,
          spec_id: response.detailCalloutSpec.entityId,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_detail_callout_spec_update_push_state", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.updateDetailCalloutSpecPushState({
          specId: spec_id,
          pushState: push_state,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          );
        logToolRead({
          tool: "cortex_detail_callout_spec_update_push_state",
          spec_id,
          push_state,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_detail_callout_spec_attach_aps_ref", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.attachDetailCalloutSpecApsRef({
          specId: spec_id,
          apsTaskRef: aps_task_ref,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          );
        logToolRead({
          tool: "cortex_detail_callout_spec_attach_aps_ref",
          spec_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_detail_callout_spec_list", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listDetailCalloutSpecs({
          engagementId: engagement_id,
          pushState: push_state,
        });
        const __readEnv = codexEnvelope(
            response,
            response.detailCalloutSpecs.map(lSurfaceProvenance),
            { tier },
          );
        logToolRead({
          tool: "cortex_detail_callout_spec_list",
          engagement_id,
          push_state,
          count: response.detailCalloutSpecs.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_detail_callout_spec_get", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getDetailCalloutSpec({
          specId: spec_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.detailCalloutSpec),
            { tier },
          );
        logToolRead({
          tool: "cortex_detail_callout_spec_get",
          spec_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_product_spec_reference_create", "reporting");
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
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.productSpecReference),
            { tier },
          );
        logToolRead({
          tool: "cortex_product_spec_reference_create",
          engagement_id,
          esr_number,
          reference_id: response.productSpecReference.entityId,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_product_spec_reference_refresh_status", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.refreshProductSpecReferenceStatus({
          referenceId: reference_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.productSpecReference),
            { tier },
          );
        logToolRead({
          tool: "cortex_product_spec_reference_refresh_status",
          reference_id,
          status: response.productSpecReference.status,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_product_spec_reference_list", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listProductSpecReferences({
          engagementId: engagement_id,
          status,
        });
        const __readEnv = codexEnvelope(
            response,
            response.productSpecReferences.map(lSurfaceProvenance),
            { tier },
          );
        logToolRead({
          tool: "cortex_product_spec_reference_list",
          engagement_id,
          status,
          count: response.productSpecReferences.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_product_spec_reference_get", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getProductSpecReference({
          referenceId: reference_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.productSpecReference),
            { tier },
          );
        logToolRead({
          tool: "cortex_product_spec_reference_get",
          reference_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_render", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.renderDeliverableLetter({
          letterId: letter_id,
          format,
          renderedByActorId: rendered_by_actor_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.render),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_render",
          letter_id,
          format,
          render_id: response.render.entityId,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_renders_list", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listDeliverableLetterRenders({
          letterId: letter_id,
        });
        const __readEnv = codexEnvelope(
            response,
            response.renders.map(lSurfaceProvenance),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_renders_list",
          letter_id,
          count: response.renders.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_list", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.listDeliverableLetters({
          engagementId: engagement_id,
          status,
        });
        const __readEnv = codexEnvelope(
            response,
            response.deliverableLetters.map(lSurfaceProvenance),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_list",
          engagement_id,
          status,
          count: response.deliverableLetters.length,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_fetch", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getDeliverableLetter({
          letterId: letter_id,
        });
        const __readEnv = codexEnvelope(
            response,
            lSurfaceProvenance(response.deliverableLetter),
            { tier },
          );
        logToolRead({
          tool: "cortex_deliverable_letter_fetch",
          letter_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("cortex_deliverable_letter_render_download", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const download = await legacyClient.downloadDeliverableLetterRender({
          renderId: render_id,
        });
        const metaEnvelope = finalizeReadEnvelope(
          "cortex_deliverable_letter_render_download",
          buildEnvelope(
            {
              render_id,
              filename: download.filename,
              content_type: download.contentType,
              byte_length: download.bytes.byteLength,
            },
            [
              {
                did: `did:hauska:deliverable-letter-render:${render_id}`,
                entityType: "deliverable-letter-render",
                entityId: render_id,
                jurisdictionTenant: "brokerage",
                contentHash: null,
                cidNote:
                  "Binary body returned as MCP resource; metadata summary is read-contract-shaped.",
                source: {
                  adapter: "legacy-design-tools",
                  url: "/api/engagements/deliverable-letters/renders/download",
                  fetchedAt: new Date().toISOString(),
                },
              },
            ],
            { tier, readKind: "legacy-deterministic" },
          ),
        );
        logToolRead({
          tool: "cortex_deliverable_letter_render_download",
          render_id,
          content_type: download.contentType,
          byte_length: download.bytes.byteLength,
          tier,
        }, metaEnvelope.atoms);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...metaEnvelope,
                  resource_uri: `cortex://deliverable-letter-render/${render_id}/${download.filename}`,
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
      const gate = await requireProduct("generate_property_brief", "reporting");
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
        const __readEnv = generateBriefEnvelope(response, { tier });
        logToolRead({
          tool: "generate_property_brief",
          tier,
          run_id: response.runId,
          jurisdiction_key: response.jurisdiction ?? undefined,
          latency_ms: Date.now() - started,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("get_property_brief_run", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getBriefRun({ runId: run_id });
        const __readEnv = getBriefRunEnvelope(response, { tier });
        logToolRead({
          tool: "get_property_brief_run",
          run_id,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("simulate_site_drainage", "map");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.refreshSiteDrainage({
          engagementId: engagement_id,
          manualDepthInches: manual_depth_inches,
          returnPeriodYears: return_period_years,
          forceRefresh: force_refresh,
        });
        const __readEnv = codexEnvelope(
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
          );
        logToolRead({
          tool: "simulate_site_drainage",
          engagement_id,
          tier,
          flow_line_count: response.flowLineCount,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("get_site_drainage", "map");
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
        const baseEnv = siteDrainageEnvelope(drainage, engagement_id, { tier });
        const __readEnv =
          designStorms !== undefined
            ? ({
                ...baseEnv,
                data: { drainage, designStorms },
              } as ToolEnvelope<{
                drainage: typeof drainage;
                designStorms: typeof designStorms;
              }>)
            : baseEnv;
        logToolRead({
          tool: "get_site_drainage",
          engagement_id,
          tier,
          include_design_storms,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv as ToolEnvelope<unknown>);
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
      const gate = await requireProduct("get_site_topography", "map");
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
        const __readEnv = siteTopographyEnvelope(response, engagement_id, { tier });
        logToolRead({
          tool: "get_site_topography",
          engagement_id,
          tier,
          refreshed: refresh,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
      } catch (err) {
        return errorContent(describeLegacyFailure("get_site_topography", err));
      }
    },
  );

  server.tool(
    "generate_parcel_terrain_model",
    TOOL_COPY.generate_parcel_terrain_model,
    {
      engagementId: z
        .string()
        .uuid()
        .describe("Engagement id whose parcel terrain model to return. Required."),
      formats: z
        .array(z.enum(["mesh", "ifc"]))
        .optional()
        .default(["mesh", "ifc"])
        .describe(
          "Which model references to return. Defaults to both mesh and ifc.",
        ),
    },
    async ({ engagementId, formats }) => {
      // NOTE: the Group B section header above says Gate: product='cortex';
      // that comment is stale. Map tools gate on "map"; follow the code.
      const gate = await requireProduct("generate_parcel_terrain_model", "map");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const model = await legacyClient.getParcelTerrainModel({
          engagementId,
        });
        const wantMesh = formats.includes("mesh");
        const wantIfc = formats.includes("ifc");
        const hasMesh = model.meshRef !== undefined;
        const hasIfc = model.ifcRef !== undefined;

        // Not-yet-generated: the engagement has no materialized mesh/ifc
        // yet. Instruct the caller to run site-topography refresh first.
        // Do NOT fabricate geometry or provenance.
        if (!hasMesh && !hasIfc) {
          const notReady = {
            status: "not-yet-generated" as const,
            engagementId,
            reason:
              model.reason ??
              "No parcel terrain model materialized for this engagement yet.",
            nextStep:
              "Run site-topography refresh (get_site_topography with refresh=true, " +
              "or POST /api/engagements/:id/site-topography/refresh) to generate the " +
              "mesh and IFC, then call generate_parcel_terrain_model again.",
          };
          const __readEnv = parcelTerrainModelEnvelope(
            { ...model, status: "not-yet-generated" },
            engagementId,
            { tier, note: notReady.nextStep },
          );
          const envelope = {
            ...__readEnv,
            data: notReady,
          } as ToolEnvelope<typeof notReady>;
          logToolRead(
            {
              tool: "generate_parcel_terrain_model",
              engagementId,
              tier,
              generated: false,
            },
            envelope.atoms,
          );
          return envelopeContent(envelope);
        }

        const data = {
          status: model.status,
          engagementId,
          materializableElementId: model.materializableElementId,
          mesh: wantMesh
            ? {
                available: hasMesh,
                ref: model.meshRef ?? null,
                metadata: model.mesh ?? null,
              }
            : undefined,
          ifc: wantIfc
            ? {
                available: hasIfc,
                ref: model.ifcRef ?? null,
                metadata: model.ifc ?? null,
              }
            : undefined,
          // Coverage-honesty / quality-gate signals travel with the model.
          // Confidence is defensively normalized so a bare number can never
          // reach the surface as an unqualified score (commitment 2): a raw
          // number is wrapped as asserted, an object keeps its provenance
          // (defaulted to "asserted" if absent), null stays null.
          coverage: model.coverage ?? null,
          confidence: normalizeTerrainConfidence(model.confidence),
          demResolutionMeters: model.demResolutionMeters ?? null,
          sourceCitation: model.sourceCitation ?? "USGS 3DEP",
        };
        const baseEnv = parcelTerrainModelEnvelope(model, engagementId, {
          tier,
        });
        const __readEnv = {
          ...baseEnv,
          data,
        } as ToolEnvelope<typeof data>;
        logToolRead(
          {
            tool: "generate_parcel_terrain_model",
            engagementId,
            tier,
            generated: true,
            mesh: hasMesh,
            ifc: hasIfc,
          },
          __readEnv.atoms,
        );
        return envelopeContent(__readEnv);
      } catch (err) {
        return errorContent(
          describeLegacyFailure("generate_parcel_terrain_model", err),
        );
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
      const gate = await requireProduct("search_encumbrances", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.searchEncumbrances({
          workspaceDid: workspace_did,
        });
        const __readEnv = encumbrancesEnvelope(response, { tier });
        logToolRead({
          tool: "search_encumbrances",
          workspace_did,
          tier,
          instrument_count: response.instruments.length,
          clause_count: response.clauses.length,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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
      const gate = await requireProduct("get_restrictions", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        const response = await legacyClient.getRestrictions({
          workspaceDid: workspace_did,
        });
        const __readEnv = restrictionsEnvelope(response, { tier });
        logToolRead({
          tool: "get_restrictions",
          workspace_did,
          tier,
          clause_count: response.clauses.length,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
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

  function extinguishedCotality(tool: string) {
    return errorContent(
      `${tool}: extinguished. Cotality is dead. Re-route. Never rotate that credential. Zero outbound Cotality calls.`,
    );
  }

  server.tool(
    "get_property_detail",
    TOOL_COPY.get_property_detail,
    cotalityLocationSchema,
    async () => {
      const gate = await requireProduct("get_property_detail", "reporting");
      if (!gate.ok) return gate.content;
      return extinguishedCotality("get_property_detail");
    },
  );

  server.tool(
    "get_replacement_cost",
    TOOL_COPY.get_replacement_cost,
    cotalityLocationSchema,
    async () => {
      const gate = await requireProduct("get_replacement_cost", "reporting");
      if (!gate.ok) return gate.content;
      return extinguishedCotality("get_replacement_cost");
    },
  );

  server.tool(
    "get_hazard_profile",
    TOOL_COPY.get_hazard_profile,
    cotalityLocationSchema,
    async () => {
      const gate = await requireProduct("get_hazard_profile", "map");
      if (!gate.ok) return gate.content;
      return extinguishedCotality("get_hazard_profile");
    },
  );

  server.tool(
    "get_parcel_polygon",
    TOOL_COPY.get_parcel_polygon,
    cotalityLocationSchema,
    async () => {
      const gate = await requireProduct("get_parcel_polygon", "map");
      if (!gate.ok) return gate.content;
      return extinguishedCotality("get_parcel_polygon");
    },
  );

  // ----- Adaptive interface. Gate: product='reporting' (cortex-api reporting function). -----
  server.tool(
    "compose_workspace",
    TOOL_COPY.compose_workspace,
    {
      intent: z
        .string()
        .min(1)
        .describe(
          "Natural-language description of what the workspace should show (e.g. 'compliance and hazard for this parcel').",
        ),
      engagement_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Optional engagement id. When given, tiles are filtered to those whose requirements the engagement satisfies.",
        ),
      available_tile_ids: z
        .array(z.string())
        .optional()
        .describe(
          "Optional allow-list of tile ids to consider. Omit to consider the whole registry.",
        ),
      max_tiles: z
        .number()
        .int()
        .positive()
        .max(12)
        .optional()
        .describe("Max tiles to include, default 4."),
    },
    async ({ intent, engagement_id, available_tile_ids, max_tiles }) => {
      const gate = await requireProduct("compose_workspace", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      try {
        // Fetch the tile capability registry at invocation time (never
        // at module load). This is the live cortex-api registry via the
        // existing Bearer service-token path.
        const registry = await legacyClient.getTileRegistry();

        // Build engagement context only when an engagement_id is given.
        // cortex-api has no single engagement-context endpoint, so we
        // derive a conservative context: the engagementId requirement is
        // satisfied by the id itself; we probe the briefing to learn
        // whether the parcel is resolved (apn/jurisdiction). We cannot
        // cheaply confirm uploaded documents or completed findings, so
        // we treat them as present (optimistic) — an active engagement
        // in the workspace normally has an uploaded submission, and
        // strict filtering here would wrongly drop compliance-run /
        // document-viewer for a valid engagement. A dedicated
        // engagement-context endpoint is a follow-on.
        let ctx: EngagementContext | undefined;
        if (engagement_id) {
          const briefing = await legacyClient
            .fetchBriefing({ engagementId: engagement_id })
            .catch(() => null);
          const resolved = !!(briefing && briefing.briefing);
          ctx = {
            id: engagement_id,
            apn: resolved,
            jurisdiction: resolved,
            hasDocuments: true,
            hasFindings: true,
          };
        }

        const composition = composeWorkspace(
          {
            intent,
            engagementId: engagement_id,
            availableTileIds: available_tile_ids,
            maxTiles: max_tiles,
          },
          registry,
          ctx,
        );

        logToolInvocation({
          tool: "compose_workspace",
          tier,
          engagement_id,
          tile_count: composition.tiles.length,
        });

        // Return the bare WorkspaceComposition JSON verbatim. The
        // consumer (@hauska/tile-shell) expects the raw object, not an
        // atom envelope.
        return {
          content: [
            { type: "text", text: JSON.stringify(composition, null, 2) },
          ],
        };
      } catch (err) {
        return errorContent(describeLegacyFailure("compose_workspace", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // Map tool: assemble_map_layers (engine-api gate-front proxy).
  // -----------------------------------------------------------------
  server.tool(
    "assemble_map_layers",
    TOOL_COPY.assemble_map_layers,
    {
      parcel: mapLayersParcelSchema,
      jurisdiction: mapLayersJurisdictionSchema,
      layers: z.array(mapLayerKeySchema).optional(),
      force_refresh: z.boolean().optional(),
      bbox: mapLayersBboxSchema.optional(),
    },
    async ({ parcel, jurisdiction, layers, force_refresh, bbox }) => {
      const gate = await requireProduct("assemble_map_layers", "map");
      if (!gate.ok) return gate.content;
      const pkgGate = assertMapLayersPackageGate("assemble_map_layers");
      if (!pkgGate.ok) return errorContent(pkgGate.message);
      const subject = getCurrentAccessSubject();
      const layerFilter = filterLayersForEntitlement(layers, subject);
      if (!layerFilter.ok) return errorContent(layerFilter.message);
      const tenantScope = assertJurisdictionTenantScope(
        "assemble_map_layers",
        jurisdiction,
        subject,
      );
      if (!tenantScope.ok) return errorContent(tenantScope.message);
      const tier = getCurrentTier();
      try {
        const engineEnvelope = await engineApiClient.assembleMapLayers(
          {
            parcel,
            jurisdiction,
            layers: layerFilter.layers,
            forceRefresh: force_refresh,
            bbox,
          },
          pkgGate,
        );
        const scopeCheck = assertResponseTenantScope(
          "assemble_map_layers",
          engineEnvelope.payload.tenantScope,
          subject,
        );
        if (!scopeCheck.ok) return errorContent(scopeCheck.message);
        const __readEnv = finalizeReadEnvelope(
          "assemble_map_layers",
          buildEnvelope(engineEnvelope.payload, [], {
            tier,
            readKind: "catalog",
          }),
        );
        logToolRead({
          tool: "assemble_map_layers",
          tier,
          layer_count: engineEnvelope.payload.layers.length,
          tenant_scope: engineEnvelope.payload.tenantScope,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
      } catch (err) {
        if (err instanceof EngineApiTimeoutError) {
          return errorContent(
            `${err.message}. The engine may be cold-starting; retry in a moment.`,
          );
        }
        if (err instanceof EngineApiUnreachableError) {
          return errorContent(
            `Engine API unreachable at ${err.url}. Map layer assembly requires engine-api.`,
          );
        }
        if (err instanceof EngineApiHttpError) {
          return errorContent(
            `Engine API rejected map layer assembly (${err.status}): ${err.body.slice(0, 200)}`,
          );
        }
        return errorContent(
          `Unexpected error invoking assemble_map_layers: ${String(err).slice(0, 200)}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------
  // atom_export — DownloadableAtom (accessPolicy-gated).
  // -----------------------------------------------------------------
  server.tool(
    "atom_export",
    TOOL_COPY.atom_export,
    {
      atom_id: z
        .string()
        .regex(ATOM_DID_REGEX)
        .describe("Atom DID to export. Required."),
      include_trace: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true, enrich export with atom_trace graph data."),
    },
    async ({ atom_id, include_trace }) => {
      const gate = await requireProduct("atom_export", "reporting");
      if (!gate.ok) return gate.content;
      const identity = requireIdentifiedCaller("atom_export");
      if (!identity.ok) return identity.content;
      const tier = getCurrentTier();
      const subject = getCurrentAccessSubject();
      try {
        const getAtom = await hauskaClient.getAtom({
          atomDid: atom_id,
          includeComposition: true,
        });
        if (!getAtom.atom || !assertAtomReadable("atom_export", getAtom.atom)) {
          return errorContent(
            `atom_export: atom ${atom_id} not found or not readable under caller access policy.`,
          );
        }
        const trace =
          include_trace ?
            await hauskaClient.getAtomTrace({ atomDid: atom_id, audience: "ai" })
          : null;
        const readEnv = getAtomEnvelope(getAtom, { tier });
        const outcome = assembleDownloadableAtomExport({
          atomDid: atom_id,
          getAtom,
          trace: trace as import("./atom-export.js").AtomTraceWire | null,
          readContract: readEnv.readContract,
          subject,
        });
        if (!outcome.ok) {
          return errorContent(
            `atom_export conformance failed: ${outcome.errors.map((e) => e.message).join("; ")}`,
          );
        }
        const __readEnv = buildEnvelope(
          { export: outcome.export },
          readEnv.atoms,
          { tier, readKind: "catalog" },
        );
        logToolRead({
          tool: "atom_export",
          atom_id,
          requester_key_id: identity.requesterKeyId,
          tier,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
      } catch (err) {
        return errorContent(describeEngineFailure("atom_export", err));
      }
    },
  );

  // -----------------------------------------------------------------
  // read_atom_calibration — calibration overlay read-contract-per-atom.
  // -----------------------------------------------------------------
  server.tool(
    "read_atom_calibration",
    TOOL_COPY.read_atom_calibration,
    {
      atom_id: z
        .string()
        .regex(ATOM_DID_REGEX)
        .describe("Atom DID for overlay read-contract. Required."),
    },
    async ({ atom_id }) => {
      const gate = await requireProduct("read_atom_calibration", "reporting");
      if (!gate.ok) return gate.content;
      const tier = getCurrentTier();
      const ctx = getCurrentAuthContext();
      const gateProduct = gateFrontProductFor("reporting");
      const accessTier = resolveGateAccessTier(ctx);
      const tenantId = resolveGateTenantId(ctx);
      let overlayReadContract: unknown | undefined;
      if (gateProduct && accessTier && tenantId && ctx?.key_id) {
        try {
          const overlay = await engineApiClient.readAtomCalibration(atom_id, {
            gateProduct,
            accessTier,
            tenantId,
            gateCredentialId: ctx.key_id,
          });
          overlayReadContract = overlay.readContract;
        } catch (err) {
          if (
            !(
              err instanceof EngineApiHttpError &&
              (err.status === 404 || err.status === 501)
            )
          ) {
            logger.warn("read_atom_calibration_overlay_miss", {
              atom_id,
              error: String(err).slice(0, 200),
            });
          }
        }
      }
      try {
        const getAtom = await hauskaClient.getAtom({ atomDid: atom_id });
        if (!getAtom.atom || !assertAtomReadable("read_atom_calibration", getAtom.atom)) {
          return errorContent(`read_atom_calibration: atom ${atom_id} not readable.`);
        }
        const base = getAtomEnvelope(getAtom, { tier });
        const readContract = overlayReadContract ?? base.readContract;
        const __readEnv = finalizeReadEnvelope(
          "read_atom_calibration",
          buildEnvelope(
            {
              atom_id,
              readContract,
              overlay_available: overlayReadContract !== undefined,
            },
            base.atoms,
            {
              tier,
              readKind: overlayReadContract ? "model-assisted" : "catalog",
              note:
                overlayReadContract ?
                  undefined
                : "Calibration overlay route not available — returning catalog read-contract.",
            },
          ),
          getAtom.atom.accessPolicy as import("@empressaio/atom-contract").AccessPolicy | undefined,
        );
        logToolRead({
          tool: "read_atom_calibration",
          atom_id,
          tier,
          overlay_available: overlayReadContract !== undefined,
        }, __readEnv.atoms);
        return envelopeContent(__readEnv);
      } catch (err) {
        return errorContent(describeEngineFailure("read_atom_calibration", err));
      }
    },
  );

  registerSmartFilesTools(server);
}
