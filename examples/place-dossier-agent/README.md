# Place dossier example agent

Public example for GTM sprint exit **E11**: multi-step MCP flow

`search_atoms` → `get_atom` → `resolve_place` → `get_place_dossier`

## Run

```bash
export HAUSKA_KEY=your-cortex-or-brokerage-key
export PLACE_API_ENABLED=true   # on MCP server deployment
npm install
npm start
```

Pilot address default: Bastrop, TX. Override with `PILOT_ADDRESS`.

Repository path:
https://github.com/empressaioemail-tech/hauska-mcp-server/tree/main/examples/place-dossier-agent
