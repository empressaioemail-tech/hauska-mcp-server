/**
 * Dashboards MCP tools on the existing Hauska MCP server (G-61 item 6 / G-62 item 5).
 * No second MCP process. No Product "dashboards". Not cortex-api.
 * Compose is anonymous; adapter kinds are anonymous; city-pack stays identified-caller.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildEnvelope } from "./atom-shape.js";
import { dashboardsBackendUrl, dashboardsClient } from "./dashboards-client.js";
import { LegacyHttpError } from "./legacy-client.js";
import { getCurrentAuthContext, getCurrentTier } from "./request-context.js";
import { TOOL_COPY } from "./tool-copy.js";

function envelopeContent(envelope: ReturnType<typeof buildEnvelope>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }] };
}

function errorContent(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

function describeFailure(tool: string, err: unknown): string {
  if (err instanceof LegacyHttpError) {
    return `${tool}: dashboards HTTP ${err.status}: ${err.body}`;
  }
  return `${tool}: ${String(err)}`;
}

function requireBackend(tool: string) {
  try {
    dashboardsBackendUrl();
  } catch (err) {
    return { ok: false as const, content: errorContent(`${tool}: ${String(err)}`) };
  }
  return { ok: true as const };
}

function requireIdentified(tool: string) {
  const keyId = getCurrentAuthContext()?.key_id;
  if (typeof keyId === "string" && keyId.length > 0) {
    return { ok: true as const };
  }
  return {
    ok: false as const,
    content: errorContent(
      `Tool "${tool}" requires an authenticated API key. Anonymous callers are refused.`,
    ),
  };
}

function wrap(data: unknown) {
  return envelopeContent(
    buildEnvelope(data, [], {
      tier: getCurrentTier(),
      readKind: "catalog",
      note: "Served by Dashboards product HTTP. Not cortex-api. Not the live Bastrop city.",
    }),
  );
}

export function registerDashboardsTools(server: McpServer): void {
  server.tool(
    "dashboards_list_lenses",
    TOOL_COPY.dashboards_list_lenses,
    {},
    async () => {
      const tool = "dashboards_list_lenses";
      const gate = requireBackend(tool);
      if (!gate.ok) return gate.content;
      try {
        return wrap(await dashboardsClient.listLenses());
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "dashboards_get_city_pack",
    TOOL_COPY.dashboards_get_city_pack,
    {
      cityKey: z
        .string()
        .min(1)
        .describe("City pack key, e.g. template-city. Tenant pack, not a lens definition."),
    },
    async ({ cityKey }) => {
      const tool = "dashboards_get_city_pack";
      const identity = requireIdentified(tool);
      if (!identity.ok) return identity.content;
      const gate = requireBackend(tool);
      if (!gate.ok) return gate.content;
      try {
        return wrap(await dashboardsClient.getCityPack(cityKey));
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "dashboards_compose_city_manager",
    TOOL_COPY.dashboards_compose_city_manager,
    {
      parcel_node_id: z
        .string()
        .regex(
          /^\d{5}:[A-Za-z0-9._-]+$/,
          "parcel_node_id must be county_fips:prop_id (e.g. 48021:34137)",
        )
        .describe("Parcel node id, e.g. 48021:34137."),
      city_key: z
        .string()
        .min(1)
        .default("template-city")
        .describe("City pack key. Default template-city. Not the live Bastrop city."),
    },
    async ({ parcel_node_id, city_key }) => {
      const tool = "dashboards_compose_city_manager";
      const gate = requireBackend(tool);
      if (!gate.ok) return gate.content;
      try {
        return wrap(
          await dashboardsClient.composeCityManager({
            parcelNodeId: parcel_node_id,
            cityKey: city_key,
          }),
        );
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "dashboards_list_adapter_kinds",
    TOOL_COPY.dashboards_list_adapter_kinds,
    {},
    async () => {
      const tool = "dashboards_list_adapter_kinds";
      const gate = requireBackend(tool);
      if (!gate.ok) return gate.content;
      try {
        return wrap(await dashboardsClient.listAdapterKinds());
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );
}
