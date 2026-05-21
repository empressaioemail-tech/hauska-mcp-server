# Anthropic MCP directory — submission package

DRAFT. Submission content for the Anthropic MCP server directory.

**Name:** Hauska MCP Server

**Tagline:** Verified municipal building-code and zoning answers for AI
agents, with a source citation on every result.

**Endpoint:** `https://mcp.hauska.dev/mcp`

**Transport:** Streamable HTTP

**Authentication:** None for the public catalog. Optional API key
(`X-Hauska-Key` header) for higher rate tiers.

**Category:** Government / civic data; construction and real estate.

**Short description:**

Hauska MCP Server is a public Model Context Protocol endpoint that gives
agents jurisdiction-grounded answers about municipal building codes and
zoning. Every result is an atom: a unit of code with a stable identifier,
a content hash, and the source document it came from. Agents cite the
atom, not a paraphrase. The public catalog is free.

**Tools (public catalog):** `search_atoms`, `get_atom`,
`list_jurisdictions`, `query_jurisdiction`, `search_permit_atoms`.

**Documentation:** `https://mcp.hauska.dev/docs`

**Maintainer:** Hauska Inc.

**Notes for reviewers:** The server also carries product-keyed tool
surfaces (Codex, Cortex) that are not part of the public catalog and are
gated behind product API keys; an unauthenticated caller sees them listed
but receives a clear product-gate message on call. The free catalog is
the directory-listed surface.

> [GTM-SESSION] Confirm the final tagline and category tags against the
> directory's current taxonomy.
