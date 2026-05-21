# Launch blog post — draft

DRAFT for `hauska.dev/blog`. Do not publish; operator-gated.

---

## Title

Hauska MCP Server: verified ground truth for agents that work on the
built world

## Body

AI agents are starting to do real work on buildings, land, and permits.
They draft zoning analyses, pre-check plans, answer code questions. The
problem is not capability. It is grounding. An agent that paraphrases a
setback rule from memory is guessing. An agent that cites the section is
working.

Today we are opening the Hauska MCP Server: a public Model Context
Protocol endpoint that gives any agent jurisdiction-grounded answers
about municipal building codes and zoning, with a source citation on
every result.

### Atoms, not paraphrases

Every answer from the Hauska catalog is an atom: a unit of code with a
stable identifier, a content hash, and the source document and adapter it
came from. When an agent answers a question, it does not summarize from
training data. It retrieves atoms and cites them by DID. A person reading
the answer can follow that DID straight back to the code text.

That is the whole design. Sell the reasoning and the citation, not a
black box.

### Free, and built for agent builders

The public catalog is free. No account to start: point an MCP client at
`https://mcp.hauska.dev/mcp` and call `list_jurisdictions`. Five tools
cover search, retrieval, jurisdiction status, and permit-relevant code.
Quickstarts for Claude Desktop, Claude Code, Cursor, and custom SDK
agents are in the docs.

It is built for the agent builder: the developer or small team shipping
construction-tech, permitting, real-estate-diligence, or civic agents who
needs answers traceable to the actual code.

### What is in the catalog

> [GTM-SESSION] State the launch jurisdiction coverage here from the live
> `list_jurisdictions` count. Lead with the partnered and public-free
> jurisdictions; describe the catalog as growing through the ingestion
> pipeline. Do not claim coverage that is not loaded.

### Where this goes

The catalog is Layer 1: open retrieval substrate. The reasoning products
that build on it are a separate layer. The substrate is open because
broad agent access is the point.

Try it: `https://mcp.hauska.dev` — docs at `https://mcp.hauska.dev/docs`.

---

> [GTM-SESSION] Final positioning line, the coverage paragraph, and the
> call-to-action sequence are filled from the GTM working session.
