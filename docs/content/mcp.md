# Hauska MCP — Texas building code + accessibility-standards + site reasoning

**Public claim:** Texas building code + accessibility-standards MCP + property/site reasoning
(Layer 2). Central TX pilot for place tools; not a country-scale dossier.

| Surface | URL |
|---------|-----|
| Documentation (this site) | https://hauska.dev/mcp |
| MCP transport (Streamable HTTP) | https://mcp.hauska.dev/mcp |
| Capability matrix | [Capability matrix](capability-matrix.html) |
| Data packages | [Data packages](data-packages.html) |
| Central TX coverage | [Coverage](coverage.html) |

## Tool surface (46 shipped)

The deployed MCP registry exposes **46 tools**, gated at call time by `X-Hauska-Key`
(no header → public tier; bad key → 401). `tools/list` returns all 46 to every caller;
product gates fire on invocation, not on listing.

| Group | Count | API key |
|-------|------:|---------|
| Public catalog + place/workspace reads | 11 | none for catalog (5); cortex/brokerage for place (6) |
| Codex (plan review) | 4 | codex |
| Cortex (design accelerator + Layer 2 reasoning) | 31 | cortex |

See the [tool reference](tool-reference.html) for every schema. Codex and Cortex tools
are documented in the matrix but excluded from public registry marketing claims.

## Corpus honesty

External copy never uses a bare headline atom count. The split:

- **Public-free Layer 1:** ~478 atoms across 2 jurisdictions (Bastrop 193 on the B3
  edition, Grand County/Moab 285) plus the `federal-accessibility-standards` tenant
  (ADA 2010 + FHA Design Manual, public-free).
- **Platform-internal:** 32 of 34 ingested jurisdictions; never marketed as public-free.
- **Confidence:** cited scores are the raw LLM emission; calibration is in progress
  (arrow-two mechanism not yet landed). Message confidence as a cited score only.

`list_jurisdictions` (Path A): anonymous callers see public-free tenants only.

## Data packages

Sellable surface is organized by composable data package — each Layer 2 package sells
**reasoning over the domain**, cited; raw national/federal baselines stay Layer 1 free.
Full package copy: [Data packages](data-packages.html).

| Package | Reasoning verb | What stays Layer 1 free |
|---------|----------------|-------------------------|
| Subsurface | assess subsurface risk | SSURGO map units + USGS geology rasters |
| Hydrology / flood | simulate drainage / flood | FEMA flood-zone lookup + NOAA design-storm tables |
| Parcel / property | reason a parcel brief | Regrid parcel geometry + public-records baseline |
| Code / plan-review | reconcile precedence | ADA/FHA + public-free city code text |
| Environmental | (roadmap — EJ context only today) | EPA EJScreen federal data |

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
