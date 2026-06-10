# Anthropic MCP directory — submission package

**DRAFT — operator submits. Do not publish from agent.**

**Name:** Hauska MCP Server

**Tagline:** Texas building code + accessibility-standards MCP + property/site reasoning for agents.

**Endpoint:** `https://mcp.hauska.dev/mcp`

**Transport:** Streamable HTTP

**Authentication:** None for the public catalog. `X-Hauska-Key` for product tiers (gates at call time).

**Category:** Government / civic data; construction and real estate.

**Short description:**

Hauska MCP Server exposes jurisdiction-grounded municipal building code, federal
accessibility standards (ADA 2010 + FHA Design Manual, public-free), and Central TX
place/workspace reads to MCP clients. The deployed registry ships 46 tools (11 public
catalog + place/workspace, 4 Codex, 31 Cortex). Public catalog tools return code atoms
with DID + content hash + source document provenance. Layer 2 packages sell reasoning
over the domain, cited — not raw federal baselines.

**Corpus honesty:** ~478 public-free atoms across 2 jurisdictions (Bastrop, Grand
County/Moab) plus the `federal-accessibility-standards` tenant; 32 platform-internal
jurisdictions are never marketed as public-free. Confidence scores are cited raw LLM
emissions; calibration is in progress.

**Tools (public registry marketing):** `search_atoms`, `get_atom`, `list_jurisdictions`,
`query_jurisdiction`, `search_permit_atoms` (free); place/workspace tools with API key.

**Data packages:** Subsurface, hydrology/flood, parcel/property, code/plan-review
(environmental held from headline launch). See https://hauska.dev/mcp/data-packages.html

**Documentation:** https://hauska.dev/mcp

**Maintainer:** Hauska Inc.

**Notes:** Codex/Cortex tools are listed but product-gated and excluded from the public
registry claim. Place dossier is bounded and pilot-scoped — not marketed as
country-scale coverage.
