-- 005: split legacy cortex product into reporting + map gates.
--
-- Existing cortex keys backfill to reporting (property intel + L-surface).
-- Operators mint new map-product keys for spatial / hydrology / assemble_map_layers.

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_product_check;

UPDATE api_keys SET product = 'reporting' WHERE product = 'cortex';

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_product_check
  CHECK (product IN ('public', 'codex', 'reporting', 'map'));
