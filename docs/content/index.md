# Hauska MCP Server

The verified ground-truth layer for AI agents that operate on buildings,
land, permits, code, and zoning.

Hauska MCP Server is a public Model Context Protocol (MCP) endpoint. Any
MCP-capable agent can call it to get jurisdiction-grounded answers about
municipal building codes and zoning, with a source citation on every
result. It is built for agent builders: developers and teams shipping
construction-tech, permitting, real-estate-diligence, and civic agents
that need answers traceable to the actual code text.

## Endpoint

```
https://mcp.hauska.dev/mcp
```

Transport is Streamable HTTP, the MCP transport for remote servers. No
account is needed to start: the public catalog is free and works with no
API key.

## The public catalog

Five Layer 1 tools, free, open to every caller:

- **`search_atoms`** — free-text search across the ingested code corpus.
- **`get_atom`** — fetch one code atom by its DID, with full provenance.
- **`list_jurisdictions`** — discover which jurisdictions are loaded.
- **`query_jurisdiction`** — a per-jurisdiction status snapshot.
- **`search_permit_atoms`** — find permit-tagged code for a project type.

Every result is an *atom*: a unit of code with a stable identifier (DID),
a content hash, and the source document and adapter it came from. Agents
cite the atom, not a paraphrase. See the [tool reference](tool-reference.html)
for the full schema of every tool.

## Get started

1. Point your MCP client at `https://mcp.hauska.dev/mcp`.
2. Call `list_jurisdictions` to see what is loaded.
3. Call `search_atoms` with a topic and a jurisdiction.

The [quickstarts](quickstart-claude-desktop.html) cover Claude Desktop,
Claude Code, Cursor, and a custom SDK agent. The
[example queries](examples.html) page shows a full search-to-citation
flow.

## Tiers

The public catalog is free, with a generous per-IP and per-key call
allowance. Higher-volume tiers are for production agents and embedders.
See [Tiers and limits](tiers.html) and [Pricing](pricing.html).

Free-tier responses carry a short attribution line; see
[Attribution](attribution.html).
