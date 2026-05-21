// Hauska MCP Server — example catalog agent.
//
// A self-contained, runnable example: connect to the public catalog,
// then run a multi-step discover -> search -> retrieve -> traverse flow
// and print a source-cited answer. No API key needed; the public
// catalog is free.
//
//   npm install
//   npm start
//
// Override the endpoint or supply a key with environment variables:
//   HAUSKA_MCP_URL  (default https://mcp.hauska.dev/mcp)
//   HAUSKA_KEY      (optional; only for higher tiers / product tools)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.HAUSKA_MCP_URL ?? "https://mcp.hauska.dev/mcp";
const KEY = process.env.HAUSKA_KEY;

// Tool results come back as a JSON string in a text content block; the
// catalog tools wrap their payload in the atom-shape envelope.
function parseEnvelope(result: unknown): {
  data: unknown;
  atoms: Array<{ did: string; entityType: string }>;
} {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  const text = content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: KEY ? { "X-Hauska-Key": KEY } : {} },
  });
  const client = new Client({ name: "hauska-catalog-agent", version: "1.0.0" });
  await client.connect(transport);
  console.log(`Connected to ${MCP_URL}`);

  // 1. Discover which jurisdictions are loaded.
  const jurisdictions = parseEnvelope(
    await client.callTool({
      name: "list_jurisdictions",
      arguments: { quality_bar_only: true },
    }),
  );
  const loaded = (jurisdictions.data as { jurisdictions?: Array<{ jurisdictionTenant: string }> })
    .jurisdictions ?? [];
  if (loaded.length === 0) {
    console.log("No jurisdictions are loaded yet. Try again later.");
    await client.close();
    return;
  }
  const tenant = loaded[0]!.jurisdictionTenant;
  console.log(`Using jurisdiction: ${tenant}`);

  // 2. Search the code for a topic.
  const search = parseEnvelope(
    await client.callTool({
      name: "search_atoms",
      arguments: { query: "setback requirements", jurisdiction: tenant, limit: 3 },
    }),
  );
  const hits = (search.data as { results?: Array<{ atomDid: string; snippet: string }> })
    .results ?? [];
  if (hits.length === 0) {
    console.log("No matching atoms. Try a different query.");
    await client.close();
    return;
  }
  console.log(`Top match: ${hits[0]!.atomDid}`);

  // 3. Retrieve the full atom, following composition edges.
  const atom = parseEnvelope(
    await client.callTool({
      name: "get_atom",
      arguments: { atom_id: hits[0]!.atomDid, include_composition: true },
    }),
  );

  // 4. Report, citing every atom by DID.
  console.log("\n--- cited answer ---");
  console.log(`Answer drawn from ${atom.atoms.length} atom(s):`);
  for (const a of atom.atoms) {
    console.log(`  - ${a.did} (${a.entityType})`);
  }
  console.log(
    "\nAn agent would now reason over the atom body and cite these DIDs.",
  );

  await client.close();
}

main().catch((err) => {
  console.error("example agent failed:", err);
  process.exit(1);
});
