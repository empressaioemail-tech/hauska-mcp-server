# Repo notes

This repo holds the Hauska MCP Server. It is the public Layer 1 MCP
surface for the Hauska catalog per doc_repo 50_hauska_mcp_server.md
and the v1 sprint plan at doc_repo 51_substrate_v1_sprint.md.

Repo placement and substrate layer per:

- doc_repo 80_adrs/adr_008_engine_factor_out.md (Hauska commercial
  layer, alongside hauska-sdk and hauska-engine)
- doc_repo 80_adrs/adr_018_atom_contract_substrate_layer.md (atom
  contract is Hauska substrate, peer to the Hauska SDK; this server
  consumes `@hauska/atom-contract` directly, not via the SDK)

Decision records for this repo's creation:

- doc_repo _decisions/2026-05-18_hauska_mcp_server_dedicated_repo.md
- doc_repo _decisions/2026-05-18_atom_contract_hauska_namespace.md

## Local dev (the engine + mcp-server pair)

For end-to-end testing the MCP server runs paired with the hauska-engine
retrieval API. The MCP server hits the engine for every tool call.

### One-time setup

1. Install dependencies in both repos. On the Windows workstation set
   `NODE_OPTIONS=--use-system-ca` before npm/pnpm install so Node trusts
   the Windows cert store. The corporate root that the network presents
   for `registry.npmjs.org` is not in Node's bundled CA list, but it is
   in the Windows cert store; without this flag installs fail with
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

   ```powershell
   $env:NODE_OPTIONS = '--use-system-ca'
   # hauska-engine
   Set-Location p:\hauska-engine
   pnpm install --no-audit --no-fund
   # hauska-mcp-server
   Set-Location p:\hauska-mcp-server
   npm install --no-audit --no-fund
   ```

2. Stand up an empty Postgres database for the api_keys table only if
   you want to exercise Stream 2B (paid-tier key auth + admin endpoints).
   For Stream 2A wire-level testing, set `HAUSKA_DEV_MODE=true` and skip
   Postgres + Upstash entirely.

### Starting the pair

Two terminals.

**Terminal 1 — hauska-engine retrieval-api on :8080:**

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
Set-Location p:\hauska-engine\services\retrieval-api
pnpm dev
```

The engine emits a startup log line like
`{"level":"info","service":"retrieval-api","event":"server.started","port":8080,...}`.
The retrieval-api defaults to port 8080; override with `PORT=...`.

**Terminal 2 — hauska-mcp-server on :3000 in dev mode:**

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
$env:HAUSKA_DEV_MODE = 'true'
$env:HAUSKA_BACKEND_URL = 'http://localhost:8080'
$env:PORT = '3000'
Set-Location p:\hauska-mcp-server
npm run dev
```

`HAUSKA_DEV_MODE=true` swaps the auth + rate-limit stack out for a
trivial pass-through (every request treated as free_anonymous) so the
server starts without a real Postgres or Upstash. The startup log warns
about the mode; never set this in production.

### Smoke-test via curl

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:8080/health

# Initialize the MCP session (stateless mode still needs a per-request init).
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.0"}}}'

# List tools.
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call list_jurisdictions.
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_jurisdictions","arguments":{}}}'
```

Against an empty engine corpus the tools return empty arrays plus the
free-tier attribution string. That is the expected Stream 2A state until
cc-agent-E loads Bastrop UDC + Grand County IRC (Sync 4 target).

### MCP Inspector (browser tool)

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

The Inspector is browser-based; it opens a local URL printed to stdout.

### Notes worth carrying forward

- **Stateless transport, per-request build.** `src/index.ts` builds a
  fresh `McpServer` + `StreamableHTTPServerTransport` per `/mcp` POST.
  The MCP SDK throws `Stateless transport cannot be reused across
  requests` on the second call if you share one transport (caught at
  end-to-end probe time Stream 2A; see `node_modules/.../webStandardStreamableHttp.js:140`).
  Tool registration is cheap, so per-request construction is fine.
- **AsyncLocalStorage threads tier into tools.** The MCP SDK tool
  handlers do not see the Express request. `src/request-context.ts`
  wraps the transport handle in an ALS bind so `getCurrentTier()` from
  inside any tool handler returns the caller's tier without changing
  handler signatures.
- **Attribution string carries an em dash.** `Powered by Hauska Engine — hauska.dev`.
  The em dash is intentional in the brand string; internal prose stays
  em-dash-free per doc_repo CLAUDE.md.
- **Cross-repo: hauska-engine isMain on Windows.** `services/retrieval-api/src/index.ts`
  originally compared `process.argv[1].endsWith("services/retrieval-api/src/index.ts")`
  with forward slashes, which never matches on Windows. Patched
  2026-05-19 to normalize backslashes before the check.

## Pending follow-ups for cc-agent-M

- Stream 2C structured logger upgrade (Phase 0 shape:
  `{request_id, response_status, atom_ids_returned, latency_ms, ...}`).
- Stream 2D Dockerfile + Cloud Run scaffold.
- Stream 2A nice-to-haves: response payload size cap, hauska-engine
  pagination support if list endpoints grow.
- Stripe scaffold + self-serve signup (Stream 2B Phase 8).
