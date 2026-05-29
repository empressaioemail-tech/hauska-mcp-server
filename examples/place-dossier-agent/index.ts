// Hauska MCP — place dossier example agent (GTM sprint M6 / E11).
//
// Flow: search_atoms → get_atom → resolve_place → get_place_dossier
//
//   npm install && npm start
//
// Env:
//   HAUSKA_MCP_URL  (default https://mcp.hauska.dev/mcp)
//   HAUSKA_KEY      (required for place tools)
//   PILOT_ADDRESS   (default Bastrop pilot address)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.HAUSKA_MCP_URL ?? "https://mcp.hauska.dev/mcp";
const KEY = process.env.HAUSKA_KEY;
const ADDRESS =
  process.env.PILOT_ADDRESS ?? "1311 Main St, Bastrop, TX 78602";

function parseEnvelope(result: unknown): {
  data: unknown;
  atoms: Array<{ did: string }>;
} {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  const text = content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("HAUSKA_KEY is required for resolve_place / get_place_dossier.");
    process.exit(1);
  }

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { "X-Hauska-Key": KEY } },
  });
  const client = new Client({ name: "hauska-place-dossier-agent", version: "1.0.0" });
  await client.connect(transport);
  console.log(`Connected to ${MCP_URL}`);

  const jurisdictions = parseEnvelope(
    await client.callTool({ name: "list_jurisdictions", arguments: {} }),
  );
  const tenant =
    (
      jurisdictions.data as {
        jurisdictions?: Array<{ jurisdictionTenant: string }>;
      }
    ).jurisdictions?.[0]?.jurisdictionTenant ?? "bastrop-tx";
  console.log(`Jurisdiction: ${tenant}`);

  const search = parseEnvelope(
    await client.callTool({
      name: "search_atoms",
      arguments: { query: "setback", jurisdiction: tenant, limit: 1 },
    }),
  );
  const hit = (
    search.data as { results?: Array<{ atomDid: string }> }
  ).results?.[0];
  if (hit) {
    await client.callTool({
      name: "get_atom",
      arguments: { atom_id: hit.atomDid, include_composition: false },
    });
    console.log(`Retrieved atom ${hit.atomDid}`);
  }

  const resolved = parseEnvelope(
    await client.callTool({
      name: "resolve_place",
      arguments: { address: ADDRESS },
    }),
  );
  const placeKey = (resolved.data as { placeKey?: string }).placeKey;
  if (!placeKey) {
    console.error("resolve_place did not return placeKey:", resolved.data);
    await client.close();
    process.exit(1);
  }
  console.log(`placeKey=${placeKey}`);

  const dossier = parseEnvelope(
    await client.callTool({
      name: "get_place_dossier",
      arguments: { place_key: placeKey },
    }),
  );
  console.log("\n--- dossier (truncated) ---");
  console.log(JSON.stringify(dossier.data, null, 2).slice(0, 4000));

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
