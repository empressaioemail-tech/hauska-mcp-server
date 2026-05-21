---
id: 2026-05-21_2d4_docs_site
title: cc-agent-M session — Stream 2D.4 docs site
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_2d3_deploy]
---

# Stream 2D.4 — docs site

The public documentation site, served at `mcp.hauska.dev/docs`. Branch
`feat/2d4-docs-site`.

## What shipped

A static docs site built from Markdown and served by the existing
Express app at `/docs`. Twelve pages:

- Overview, example queries.
- Auto-generated tool reference (all 40 tools, grouped Public catalog /
  Codex / Cortex, with per-parameter tables).
- Four quickstarts: Claude Desktop, Claude Code, Cursor, custom SDK agent.
- Tiers and limits, pricing (numbers stubbed for Wave 2), attribution,
  Terms of Service, privacy policy.

`scripts/generate-tool-reference.ts` stands the real tool surface up on
an in-process `McpServer`, pairs it with an in-process MCP `Client` over
`InMemoryTransport`, calls `tools/list`, and renders the result to
`docs/content/tool-reference.md`. The reference is therefore generated
from the live Zod schemas (via the SDK's Zod-to-JSON-Schema conversion)
and cannot drift from the code.

`scripts/build-docs.ts` renders every `docs/content/*.md` to a static
HTML page with one template, an inline stylesheet, and a sidebar nav.
`npm run build:docs` runs both scripts.

The build runs inside the Docker build stage; `docs/site/` is copied into
the runtime image and `index.ts` serves it with `express.static`. The
generated `tool-reference.md` and `docs/site/` are gitignored (rebuilt,
not committed).

## Decisions (decide-and-document)

In-repo Markdown-to-HTML served by Express, not Astro / Next / Docusaurus.
The dispatch named those three and said "pick lightest." Lighter than all
three: plain Markdown rendered with `marked` through one template, served
by the Express app already running. This adds one devDependency
(`marked`), no second build toolchain, no second deployment, and no
second domain. The dispatch explicitly allows `mcp.hauska.dev/docs`, and
serving from the app is the natural fit for that path.

Tool reference generated, not hand-maintained. A hand-written tool
reference for 40 tools rots immediately. Generating it from the live MCP
`tools/list` output means the docs are exactly the wire contract.

Docs centered on the public catalog. Per the dispatch, the public story
is the Layer 1 catalog. The marketing and quickstart pages lead with the
five catalog tools; the Codex and Cortex surfaces are noted as
product-keyed and not self-serve. The generated tool reference still
lists all 40 for completeness, since it is a reference.

ToS and privacy written as honest v1 drafts. The privacy policy
explicitly discloses the training-data capture (the Stream 2C logging):
requests and responses are retained as a corpus used to improve and train
models, with a plain instruction not to send secrets in tool parameters.

## Verification

`npm run build:docs` generates the 40-tool reference and renders 12
pages. Typecheck clean. Test suite 218 pass. Dev-mode boot smoke: `/docs`
serves the index, `/docs/tiers` resolves extensionless to `tiers.html`,
and the generated tool-reference page shows `Public catalog (5)`,
`Codex (4)`, `Cortex (31)`.

The deployed service must be rebuilt for `/docs` to go live (the docs are
baked into the image); a redeploy follows this merge.

## Next

Stream 2D.5 (cross-client matrix + public example agent) and Stream 2D.6
(launch-artifact drafts).
