# Quickstart: custom SDK agent

Call the Hauska MCP Server from a custom agent with the official MCP
TypeScript SDK.

## Install

```
npm install @modelcontextprotocol/sdk
```

## Connect and call

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport }
  from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.hauska.dev/mcp"),
  // Headers are optional. Omit for the free public catalog; supply a key
  // for a higher tier or the Codex / Cortex product tools.
  {
    requestInit: {
      headers: process.env.HAUSKA_KEY
        ? { "X-Hauska-Key": process.env.HAUSKA_KEY }
        : {},
    },
  },
);

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Discover the surface.
const { tools } = await client.listTools();

// Search the code.
const result = await client.callTool({
  name: "search_atoms",
  arguments: { query: "fire-rated wall assemblies", jurisdiction: "bastrop-tx" },
});
console.log(result.content);

await client.close();
```

## Notes

- The transport is Streamable HTTP; the SDK handles the protocol.
- The auth header is `X-Hauska-Key`. A missing or misnamed header is
  served as the free public tier, not rejected.
- A complete, runnable example agent (a multi-step search-to-citation
  flow) is published as a standalone repository; see the
  [Overview](index.html).
