# Anthropic MCP directory — submission package

**DRAFT — operator submits. Do not publish from agent.**

**Name:** Hauska MCP Server

**Tagline:** Texas building code MCP + property workspace read API for agents.

**Endpoint:** `https://mcp.hauska.dev/mcp`

**Transport:** Streamable HTTP

**Authentication:** None for the public catalog. `X-Hauska-Key` for product tiers.

**Category:** Government / civic data; construction and real estate.

**Short description:**

Hauska MCP Server exposes jurisdiction-grounded municipal building code and
Central TX place/workspace reads to MCP clients. Public catalog tools return
code atoms with DID + content hash + source document provenance. Product tools
require an API key.

**Tools (public catalog):** `search_atoms`, `get_atom`, `list_jurisdictions`,
`query_jurisdiction`, `search_permit_atoms`.

**Documentation:** https://hauska.dev/mcp

**Maintainer:** Hauska Inc.

**Notes:** Codex/Cortex tools are listed but product-gated. Place dossier is
bounded and pilot-scoped — not marketed as country-scale coverage.
