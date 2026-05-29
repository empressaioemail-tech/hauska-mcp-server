# Hauska MCP Server

**Texas building code MCP + property workspace read API** — Central TX pilot for
place tools; not a country-scale dossier.

The verified ground-truth layer for AI agents that operate on buildings,
land, permits, code, and zoning.

**Docs home:** https://hauska.dev/mcp

## Endpoints

| Surface | URL |
|---------|-----|
| MCP transport | `https://mcp.hauska.dev/mcp` |
| Documentation | `https://hauska.dev/mcp` (or `https://mcp.hauska.dev/docs`) |

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

**Product reads** (API key): place tools (`resolve_place`, `get_place_layers`,
`get_place_dossier`) and property workspace tools. See
[capability matrix](capability-matrix.html) and [coverage](coverage.html).

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
