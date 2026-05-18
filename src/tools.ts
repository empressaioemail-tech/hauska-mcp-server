// Hauska MCP Server - Tool registrations.
// Five tools. Each has a Zod schema for input validation and a thin handler
// that calls the Hauska backend client.
//
// Tool design principles:
//   1. Names are verbs describing what the agent wants done.
//   2. Descriptions are written for LLM consumption. Clear, no jargon.
//   3. Parameters use Zod for runtime validation. LLMs hallucinate.
//   4. Responses include provenance. Every answer is traceable to a source atom.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { hauskaClient } from "./hauska-client.js";
import { logger } from "./logger.js";

export function registerTools(server: McpServer) {
  // -----------------------------------------------------------------
  // Tool 1: search_atoms
  // Free-text search over the ingested code corpus.
  // -----------------------------------------------------------------
  server.tool(
    "search_atoms",
    "Search the ingested municipal code corpus for atoms matching a free-text query. " +
      "Returns ranked atom references with provenance. Use this when the agent needs " +
      "to find code sections related to a topic (e.g. setbacks, parking, occupancy).",
    {
      query: z.string().min(2).describe("Free-text search query. Required."),
      jurisdiction: z
        .string()
        .optional()
        .describe(
          'Jurisdiction identifier (e.g. "bastrop-tx"). Defaults to all available jurisdictions.'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Maximum number of atom references to return. Defaults to 10."),
    },
    async ({ query, jurisdiction, limit }) => {
      const result = await hauskaClient.searchAtoms({ query, jurisdiction, limit });
      logger.info("tool_call", { tool: "search_atoms", query, jurisdiction, count: result.atoms.length });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // -----------------------------------------------------------------
  // Tool 2: get_atom
  // Retrieve a specific atom by ID with full provenance.
  // -----------------------------------------------------------------
  server.tool(
    "get_atom",
    "Retrieve a specific atom by its unique ID. Returns the atom content plus " +
      "provenance metadata including the source document, ingestion date, " +
      "cryptographic hash, and any composition relationships to other atoms.",
    {
      atom_id: z.string().describe("The atom identifier. Required."),
      include_composition: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, also return atoms that compose this atom or are composed of it. " +
            "Defaults to false."
        ),
    },
    async ({ atom_id, include_composition }) => {
      const result = await hauskaClient.getAtom({ atom_id, include_composition });
      logger.info("tool_call", { tool: "get_atom", atom_id });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // -----------------------------------------------------------------
  // Tool 3: query_jurisdiction
  // Jurisdiction-specific lookups (zoning, setbacks, use restrictions)
  // by parcel ID or address.
  // -----------------------------------------------------------------
  server.tool(
    "query_jurisdiction",
    "Query jurisdiction-specific information (zoning, setbacks, use restrictions, " +
      "overlay districts) for a specific parcel or address. Returns the applicable " +
      "rules with citations to the underlying atoms.",
    {
      jurisdiction: z
        .string()
        .describe('Jurisdiction identifier (e.g. "bastrop-tx"). Required.'),
      parcel_id: z
        .string()
        .optional()
        .describe("Parcel identifier. Provide this OR an address."),
      address: z
        .string()
        .optional()
        .describe("Street address. Provide this OR a parcel_id."),
      query_type: z
        .enum(["zoning", "setbacks", "use_restrictions", "overlay", "all"])
        .optional()
        .default("all")
        .describe("What aspect to return. Defaults to all available."),
    },
    async ({ jurisdiction, parcel_id, address, query_type }) => {
      if (!parcel_id && !address) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: must provide either parcel_id or address.',
            },
          ],
          isError: true,
        };
      }
      const result = await hauskaClient.queryJurisdiction({
        jurisdiction,
        parcel_id,
        address,
        query_type,
      });
      logger.info("tool_call", { tool: "query_jurisdiction", jurisdiction, query_type });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // -----------------------------------------------------------------
  // Tool 4: get_permit_requirements
  // Return the permits required for a project type in a jurisdiction.
  // -----------------------------------------------------------------
  server.tool(
    "get_permit_requirements",
    "Return the permits required for a specific project type in a jurisdiction. " +
      "Includes building permits, zoning approvals, environmental clearances, and " +
      "any sequence dependencies. Each requirement cites the originating code atom.",
    {
      jurisdiction: z
        .string()
        .describe('Jurisdiction identifier (e.g. "bastrop-tx"). Required.'),
      project_type: z
        .string()
        .describe(
          'Project type description. Examples: "single-family residence", ' +
            '"commercial tenant finishout", "multifamily new construction", "ADU".'
        ),
      parcel_id: z
        .string()
        .optional()
        .describe(
          "Optional parcel identifier. Improves accuracy by considering zoning."
        ),
    },
    async ({ jurisdiction, project_type, parcel_id }) => {
      const result = await hauskaClient.getPermitRequirements({
        jurisdiction,
        project_type,
        parcel_id,
      });
      logger.info("tool_call", {
        tool: "get_permit_requirements",
        jurisdiction,
        project_type,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // -----------------------------------------------------------------
  // Tool 5: list_jurisdictions
  // Discovery tool. Returns the jurisdictions currently available.
  // -----------------------------------------------------------------
  server.tool(
    "list_jurisdictions",
    "List all jurisdictions currently ingested and available for query. Returns " +
      "the jurisdiction identifier, display name, state, last ingestion date, and " +
      "the atom count. Call this first if you do not know which jurisdictions exist.",
    {},
    async () => {
      const result = await hauskaClient.listJurisdictions();
      logger.info("tool_call", { tool: "list_jurisdictions", count: result.jurisdictions.length });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
