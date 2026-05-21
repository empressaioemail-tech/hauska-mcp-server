-- Hauska MCP Server — training-data export query (Stream 2C.3).
--
-- Anonymized export of the request_log index, shaped for fine-tuning and
-- eval-harness ingest. The fuller, lossless record (including full
-- request payloads) lives in the GCS NDJSON archive; this query is the
-- structured, queryable, privacy-reduced slice.
--
-- Anonymization:
--   - Raw `ip` and `key_hash` are dropped.
--   - `caller_anon` is a salted hash of the caller identity (key_hash,
--     or ip when anonymous). It lets per-caller call SEQUENCES be
--     reconstructed for sequence-modeling without exposing the caller.
--   - Replace :salt with a stable secret salt before running. Keep the
--     same salt across exports so sequences stitch; rotate it to break
--     linkage between export generations.
--
-- "Per-tool call sequences": order by (caller_anon, ts). Consecutive
-- rows sharing a caller_anon within a short gap form one agent session.

SELECT
  request_id,
  ts,
  md5(coalesce(key_hash, ip, 'unknown') || :'salt') AS caller_anon,
  method,
  tool,
  jurisdiction,
  tier,
  params,
  atom_ids_returned,
  response_status,
  latency_ms,
  is_error
FROM request_log
WHERE tool IS NOT NULL              -- tool calls only; drop initialize / tools-list
  AND ts >= :'since'                -- e.g. '2026-05-01'
ORDER BY caller_anon, ts;

-- psql usage:
--   psql "$DATABASE_URL" \
--     -v salt="<stable-secret-salt>" \
--     -v since="2026-05-01" \
--     -A -F',' --csv -f training_export.sql > mcp_training_export.csv
