-- 002: add product dimension to api_keys.
--
-- Per the 2026-05-19 Cortex/Codex sprint Lane B dispatch, MCP tools
-- now span three product surfaces:
--   public  — substrate catalog tools (search_atoms, get_atom,
--             list_jurisdictions, query_jurisdiction, search_permit_atoms).
--   codex   — plan-review tools wrapping legacy-design-tools findings,
--             override, briefing, submission ingest.
--   cortex  — design-accelerator tools wrapping legacy-design-tools
--             snapshot, BIM, briefing-emit, IFC ingest.
--
-- Product is orthogonal to tier. A 'codex' key carries its own per-seat
-- tier semantics (per 29_mcp_surface_tier_model.md Codex sections);
-- a 'public' key carries the substrate four-band tier model.
--
-- Existing rows backfill to 'public' which preserves prior behavior.

ALTER TABLE api_keys
  ADD COLUMN product TEXT NOT NULL DEFAULT 'public'
  CHECK (product IN ('public', 'codex', 'cortex'));

CREATE INDEX IF NOT EXISTS idx_api_keys_product ON api_keys (product);
