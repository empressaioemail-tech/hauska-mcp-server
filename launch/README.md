# Launch artifacts — Hauska MCP Server

Stream 2D.6. Drafts for the public launch of the Hauska MCP Server.

> **These are drafts. Do not publish any of them.** Publishing the
> outward-facing GTM artifacts (Show HN, ProductHunt, social, the blog
> announcement) is an operator action, gated on the GTM working session
> and on the launch corpus being in place. cc-agent-M drafts; the
> operator publishes.

## Files

| File | Artifact | Channel owner |
|---|---|---|
| `mcp-directory-submission.md` | Anthropic MCP directory entry | operator |
| `awesome-mcp-servers-pr.md` | `awesome-mcp-servers` GitHub PR | operator |
| `blog-post.md` | Launch post for `hauska.dev/blog` | operator |
| `show-hn.md` | Show HN post | operator |
| `producthunt.md` | ProductHunt launch package | operator |
| `social.md` | LinkedIn and X posts | operator |
| `proptech-press.md` | PropTech-press outreach list | operator + bizops |

## Open inputs — GTM working session

Several passages depend on decisions from the GTM channel-plan working
session and are marked inline with `[GTM-SESSION]`. They are: the channel
sequence and dates, the precise one-line positioning, and any
launch-moment metrics (jurisdiction count, atoms). The drafts are
structurally complete; those passages get a one-pass fill once the
session lands.

## Honesty constraint

Per the sprint structural constraints, every draft claims only what is
true. The launch corpus and exact jurisdiction count are placeholders
(`list_jurisdictions` is the live source of truth); no draft hard-codes a
number that is not yet real. The launch naturally aligns with cc-agent-E
Lane E Phase E1 (the Layer 1 model-code base) so the public-free catalog
leads with real coverage.

## Pre-publish checklist (operator)

1. The GTM working session has filled the `[GTM-SESSION]` passages.
2. `mcp.hauska.dev` resolves over managed TLS (domain verification done).
3. `list_jurisdictions` against the live service returns the launch
   corpus; the blog and Show HN copy reflect the real count.
4. The docs site at `mcp.hauska.dev/docs` is reachable.
5. The `examples/catalog-agent` example runs clean against the live
   service.
6. Publish in the channel sequence the GTM session set.
