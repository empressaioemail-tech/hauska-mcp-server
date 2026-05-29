# Public capability matrix

Aligned with `gtm_public_capability_matrix_v1.yaml` (2026-05-28). Path A honesty:
anonymous callers only receive public-free jurisdictions from `list_jurisdictions`.

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

Canonical YAML: [doc_repo catalog](https://github.com/empressaioemail-tech/doc_repo/blob/main/_catalog/ops/gtm_public_capability_matrix_v1.yaml)
