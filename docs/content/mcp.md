# Hauska MCP — Texas building code + property workspace reads

**Public claim:** Texas building code MCP + property workspace read API. This is not a
country-scale place dossier; Central TX pilot coverage only for place tools.

| Surface | URL |
|---------|-----|
| Documentation (this site) | https://hauska.dev/mcp |
| MCP transport (Streamable HTTP) | https://mcp.hauska.dev/mcp |
| Capability matrix | [Capability matrix](capability-matrix.html) |
| Central TX coverage | [Coverage](coverage.html) |

## Quickstarts

- [Claude Desktop](quickstart-claude-desktop.html)
- [Claude Code](quickstart-claude-code.html)
- [Cursor](quickstart-cursor.html)
- [SDK agent](quickstart-sdk.html)

## Tool groups

1. **Public catalog** (no key) — `search_atoms`, `get_atom`, `list_jurisdictions`,
   `query_jurisdiction`, `search_permit_atoms`
2. **Place + workspace** (authenticated key) — `resolve_place`, `get_place_layers`,
   `get_place_dossier`, `list_property_workspaces`, `get_property_workspace`,
   `list_workspace_share_edges`
3. **Codex / Cortex** (product keys) — plan review and design accelerator tools; see
   [tool reference](tool-reference.html)

## Policies

- [Attribution](attribution.html) — required on free tier
- [Commercial use](commercial-use.html)
- [Privacy](privacy.html) — includes training-data disclosure
- [Terms](terms.html)

## Example agent

Multi-step flow: `search_atoms` → `get_atom` → `resolve_place` → `get_place_dossier`.

Source: [hauska-mcp-server/examples/place-dossier-agent](https://github.com/empressaioemail-tech/hauska-mcp-server/tree/main/examples/place-dossier-agent)
