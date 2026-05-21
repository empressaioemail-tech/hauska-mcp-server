---
id: 2026-05-21_cross_client_matrix
title: Cross-client verification matrix — Hauska MCP Server
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: research
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d]
---

# Cross-client verification matrix

Stream 2D.5. The plan and status for verifying the deployed Hauska MCP
Server across MCP clients. The target flow for every client is the
multi-step `search -> get-atom -> cross-reference traversal` against the
live service. This also formally closes the Group 4 cross-client item.

## Layers of verification

A cross-client pass has two independent layers:

1. **Protocol** — the client connects over Streamable HTTP, completes the
   MCP handshake, and `tools/list` returns the surface.
2. **Catalog execution** — a `tools/call` to `search_atoms` /
   `get_atom` returns real atoms.

The protocol layer is fully verifiable now. The catalog-execution layer
depends on cc-agent-E's hauska-engine retrieval API being wired in
(Lane E Phase E0): until then the catalog tools return a graceful
`engine unreachable` envelope. That is the one gate on a green full pass.

## Status

| Client | Protocol | Catalog execution | How |
|---|---|---|---|
| Raw HTTP / Cloud Build curl | **verified** | engine-gated | `tools/list` against the deployed service returned the full 40-tool surface (in-GCP curl, 2D.3). |
| MCP Inspector | ready | engine-gated | `npx @modelcontextprotocol/inspector https://mcp.hauska.dev/mcp` — human runs the inspector UI, connects, lists, calls. |
| Claude Desktop | ready | engine-gated | Config per the docs quickstart; human restarts and asks a catalog question. |
| Claude Code | ready | engine-gated | `claude mcp add --transport http hauska https://mcp.hauska.dev/mcp`; `claude mcp list` shows connected. |
| Cursor | ready | engine-gated | `.cursor/mcp.json` per the docs quickstart. |
| Custom SDK agent | ready | engine-gated | `examples/catalog-agent` — a runnable agent doing the full flow. |

"ready" means the client config is written and documented (the docs-site
quickstarts) and the protocol is proven; the click-through against the
live service is the remaining step.

## What is verified now

- The deployed service speaks MCP Streamable HTTP correctly: the
  handshake completes and `tools/list` returns all 40 tools with their
  JSON Schemas (confirmed via an in-GCP Cloud Build curl, since this
  workstation cannot TLS to `run.app`).
- The product gate is correct by construction: an unauthenticated caller
  is `public`, sees all 40 tools listed, and a `codex_*`/`cortex_*` call
  returns the product-gate rejection envelope.
- The example agent (`examples/catalog-agent`) is written against the
  same SDK every custom integration would use.

## What completes the pass

1. **Engine wiring.** When cc-agent-E's retrieval API is live in
   `hauska-prod` and `HAUSKA_BACKEND_URL` / `HAUSKA_ENGINE_API_KEY` point
   at it, the catalog tools return real atoms.
2. **The human click-through.** MCP Inspector, Claude Desktop, and Cursor
   are GUI clients; a person runs each once against the live service and
   confirms a catalog question produces a cited answer. Claude Code and
   the SDK example agent are CLI and are scriptable. This click-through
   is a short operator task, naturally bundled with the launch
   verification window.

Until both land, the matrix is "protocol verified, catalog pass gated on
engine + click-through" — recorded honestly rather than claimed green.
