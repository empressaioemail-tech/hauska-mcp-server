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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  codexEnvelope,
  codexProvenance,
  getAtomEnvelope,
  listJurisdictionsEnvelope,
  queryJurisdictionEnvelope,
  searchAtomsEnvelope,
  searchPermitAtomsEnvelope,
  type ToolEnvelope,
} from "./atom-shape.js";
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
import { getCurrentProduct, getCurrentTier } from "./request-context.js";

const ATOM_DID_REGEX = /^did:hauska:[a-z-]+:[^\s]+$/;

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

export function registerTools(server: McpServer) {
  // -----------------------------------------------------------------
  // Tool 1: search_atoms
  // Free-text search over the ingested code corpus.
  // -----------------------------------------------------------------
  server.tool(
    "search_atoms",
    "Search the ingested municipal code corpus for atoms matching a free-text query. " +
      "Returns ranked atom references with provenance (DID, source adapter, source URL, content hash). " +
      "Use this when the agent needs to find code sections related to a topic " +
      "(e.g. setbacks, parking, occupancy). Follow up with get_atom on any returned DID " +
      "to retrieve the full atom body.",
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
        logger.info("tool_call", {
          tool: "search_atoms",
          query,
          jurisdiction,
          entity_type,
          tier,
          count: response.results.length,
        });
        return envelopeContent(searchAtomsEnvelope(response, { tier }));
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
    "Retrieve a specific atom by its DID (e.g. did:hauska:code-section:bastrop-tx/udc-2024/5.04). " +
      "Returns the full atom content plus provenance (source adapter, source URL, fetched-at, " +
      "content hash). When include_composition is true, also returns child atoms reached via " +
      "atom-link composition edges (cross-references, definitions, amendments).",
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
        logger.info("tool_call", {
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
        return envelopeContent(getAtomEnvelope(response, { tier }));
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
    "Retrieve a per-jurisdiction status snapshot: which code edition is currently loaded, " +
      "eval-harness quality bar, atom count, last-refreshed timestamp, drift status. " +
      "Use this to confirm a jurisdiction is available before issuing search_atoms calls. " +
      "Parcel-level lookups (zoning, setbacks by parcel) are out of scope at v1; use " +
      "search_atoms with the jurisdiction filter instead.",
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
        logger.info("tool_call", {
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
        return envelopeContent(queryJurisdictionEnvelope(response, { tier }));
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
    "Search for permit-tagged code atoms relevant to a project type in a jurisdiction. " +
      "Returns atom references whose body matches the project_type query (e.g. \"single-family residence\", " +
      "\"commercial tenant finishout\"). This is honest Layer 1 retrieval — the agent should reason " +
      "over the returned atoms to identify permit requirements. End-to-end permit inference is " +
      "engine-side reasoning and lives in Codex 1b, not in the Layer 1 substrate.",
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
        logger.info("tool_call", {
          tool: "search_permit_atoms",
          jurisdiction,
          project_type,
          tier,
          count: response.permitAtoms?.length ?? 0,
        });
        return envelopeContent(searchPermitAtomsEnvelope(response, { tier }));
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
    "List all jurisdictions currently loaded in the Hauska Engine, with eval-harness quality " +
      "bar, atom count, and drift status for each. Call this first if you do not know which " +
      "jurisdictions are available. Optionally filter to quality-bar-passing jurisdictions only.",
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
      try {
        const response = await hauskaClient.listJurisdictions({
          qualityBarOnly: quality_bar_only,
        });
        logger.info("tool_call", {
          tool: "list_jurisdictions",
          tier,
          count: response.jurisdictions.length,
          quality_bar_only,
        });
        return envelopeContent(listJurisdictionsEnvelope(response, { tier }));
      } catch (err) {
        return errorContent(describeEngineFailure("list_jurisdictions", err));
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
      "rather than starting a new one. Requires a Codex-product API key.",
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
        logger.info("tool_call", {
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
      "other), and an optional reviewer comment. A finding can be overridden ONCE; a second override " +
      "returns a 409 conflict. Requires a Codex-product API key.",
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
    },
    async ({ finding_id, text, severity, category, reviewer_comment }) => {
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
        });
        logger.info("tool_call", {
          tool: "codex_override_write",
          finding_id,
          severity,
          category,
          tier,
        });
        return envelopeContent(
          codexEnvelope(
            response,
            codexProvenance({
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
      "Requires a Codex-product API key.",
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
        logger.info("tool_call", {
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
      "Requires a Codex-product API key.",
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
        logger.info("tool_call", {
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
      "Requires a Cortex-product API key.",
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
        logger.info("tool_call", {
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
      "Requires a Cortex-product API key.",
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
        logger.info("tool_call", {
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
      "Requires a Cortex-product API key.",
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
        logger.info("tool_call", {
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
      "Requires a Cortex-product API key.",
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
        logger.info("tool_call", {
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
              atomKind: "finding-generation-run",
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
}
