# Public capability matrix

Aligned with `gtm_public_capability_matrix_v1.yaml` **v1.1** (2026-06-07). Path A honesty:
anonymous callers only receive public-free jurisdictions from `list_jurisdictions`.

**Deployed inventory:** 46 MCP tools (11 public catalog + place/workspace + 4 Codex +
31 Cortex). The prior 40-tool figure is superseded.

## Corpus honesty

| Field | Value |
|-------|-------|
| Public-free Layer 1 | ~478 atoms across 2 jurisdictions (Bastrop 193 on B3, Grand County/Moab 285) + `federal-accessibility-standards` tenant (ADA 2010 + FHA Design Manual) |
| Platform-internal | 32 of 34 jurisdictions; never marketed as public-free |
| Total ingested (not public) | 34 jurisdictions / ~21,126 atoms — internal figure only |
| Confidence | cited scores are the raw LLM emission; calibration is in progress |

## MCP tools

| MCP tool | Tier | API key | Anonymous OK |
|----------|------|---------|--------------|
| search_atoms | public Layer 1 | none | yes |
| get_atom | public Layer 1 | none | yes |
| list_jurisdictions | public Layer 1 | none | yes |
| search_permit_atoms | public Layer 1 | none | yes |
| query_jurisdiction | public Layer 1 | none | yes |
| resolve_place | product read | cortex / brokerage | no |
| get_place_layers | product read | cortex / brokerage | no |
| get_place_dossier | product read | cortex / brokerage | no |
| list_property_workspaces | product read | authenticated | no |
| get_property_workspace | product read | authenticated | no |
| list_workspace_share_edges | product read | authenticated | no |
| codex_* (4 tools) | product Layer 2 | codex | no |
| cortex_* (31 tools) | product Layer 2 | cortex | no |

**Attribution:** Free-tier responses include `Powered by Hauska Engine — hauska.dev`.

**HTTP (not MCP):** `GET /api/brokerage/v1/coverage` — public honesty list for Central TX pilot.

**Data packages:** [Data packages](data-packages.html) — sellable surface by package with
reasoning verbs and Layer 1 free baselines.

Canonical YAML: [doc_repo catalog](https://github.com/empressaioemail-tech/doc_repo/blob/main/_catalog/ops/gtm_public_capability_matrix_v1.yaml)
