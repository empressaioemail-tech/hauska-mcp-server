---
id: 2026-05-21_2d5_2d6_examples_launch
title: cc-agent-M session — Stream 2D.5 (cross-client + example) and 2D.6 (launch drafts)
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_2d4_docs_site]
---

# Stream 2D.5 and 2D.6 — example agent, cross-client matrix, launch drafts

The last two project-independent units of Lane M, in one branch since
both are example and draft material, no server code. Branch
`feat/2d5-2d6-examples-and-launch`.

## 2D.5 — cross-client and the example agent

`examples/catalog-agent/` — a self-contained, runnable example agent. It
connects to the public catalog over Streamable HTTP and runs the full
discover-to-citation flow: `list_jurisdictions`, then `search_atoms`,
then `get_atom` with composition, then a source-cited report. Its own
`package.json` and `tsconfig.json`; no API key needed. Typechecks clean
against the MCP SDK.

Decision: the example lives in `examples/` in this (public) repo rather
than a new standalone repo. The dispatch said "public repo or gist"; the
`hauska-mcp-server` repo is already public, so `examples/` satisfies it
without creating and maintaining a separate repo.

`_research/2026-05-21_cross_client_matrix.md` — the cross-client
verification matrix. It separates the two layers of a pass: the protocol
layer (handshake plus `tools/list`) is verified now against the deployed
service; the catalog-execution layer is gated on cc-agent-E's retrieval
API being wired in. The four GUI clients (MCP Inspector, Claude Desktop,
Claude Code, Cursor) have their configs documented in the docs-site
quickstarts; the click-through against the live service is a short
operator step bundled with the launch verification window. The matrix
records this honestly rather than claiming a green full pass.

## 2D.6 — launch-artifact drafts

`launch/` — eight files, all drafts, none published. The hard stop holds:
cc-agent-M drafts the outward-facing GTM artifacts; the operator
publishes.

- `README.md` — index, the operator pre-publish checklist, the honesty
  constraint, and the `[GTM-SESSION]` markers for passages that depend on
  the GTM channel-plan working session.
- `mcp-directory-submission.md` — the Anthropic MCP directory entry.
- `awesome-mcp-servers-pr.md` — the list entry plus PR text.
- `blog-post.md` — the `hauska.dev/blog` launch post.
- `show-hn.md` — the Show HN post.
- `producthunt.md` — the ProductHunt package.
- `social.md` — X and LinkedIn posts.
- `proptech-press.md` — the PropTech and AEC-tech outreach list.

Every draft claims only what is true. No draft hard-codes a jurisdiction
count; `list_jurisdictions` is the live source of truth, and the
coverage passages are `[GTM-SESSION]` placeholders to be filled from the
real launch corpus. This satisfies the sprint honesty constraint and the
Path A clause (non-partnered jurisdictions are never described as
partnered).

## Verification

The example agent typechecks clean. No server code changed, so the main
typecheck and the 218-test suite are unaffected (CI confirms). The
example's full end-to-end run is gated on the engine wiring, the same gate
as the cross-client catalog pass.

## Lane M status

Streams 2C and 2D are built. The remaining items are not cc-agent-M
build work: the engine wiring (waits on cc-agent-E), the `mcp.hauska.dev`
domain (waits on operator domain verification), and the GTM publication
(operator). The final hand-off summary enumerates them.
