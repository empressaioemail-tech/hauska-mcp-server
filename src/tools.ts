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
import { logger } from "./logger.js";
import { getCurrentTier } from "./request-context.js";

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
}
