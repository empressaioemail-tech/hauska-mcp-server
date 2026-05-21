# Hauska catalog agent — example

A self-contained example agent for the Hauska MCP Server public catalog.
It runs a full discover-to-citation flow:

1. `list_jurisdictions` — find what is loaded.
2. `search_atoms` — search one jurisdiction's code.
3. `get_atom` with `include_composition` — retrieve the top atom and the
   atoms it cross-references.
4. Print a source-cited answer, every atom named by DID.

## Run

```
npm install
npm start
```

No API key is needed; the public catalog is free.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HAUSKA_MCP_URL` | `https://mcp.hauska.dev/mcp` | The MCP endpoint |
| `HAUSKA_KEY` | (none) | Optional API key for a higher tier |

```
HAUSKA_KEY=hk_your_key npm start
```

## What to take from it

The pattern is the point: every answer terminates in a set of atom DIDs.
The agent does not paraphrase the code; it retrieves atoms and cites
them. That is the contract the Hauska catalog is built to support.

See the [documentation](https://mcp.hauska.dev/docs) for the full tool
reference and quickstarts for Claude Desktop, Claude Code, and Cursor.
