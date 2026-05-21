-- 003: request_log — the queryable index over MCP request traffic.
--
-- One row per /mcp request, composed by the structured-log sink
-- (src/log-sink.ts) from the request_received / tool_call /
-- request_completed events, which all share a request_id. Each event
-- upserts its own columns, so the three writes are order-independent.
--
-- This columnar shape is the index behind the Stream 2C.3 dashboards
-- (calls by tool / jurisdiction / tier, latency, error rate). The full
-- lossless log stream is archived separately to GCS; this table is the
-- query surface, not the system of record.
--
-- Lives in the same database as api_keys (the MCP server's own Postgres,
-- DATABASE_URL). Per ADR-010 the index is Postgres so MCP traffic data
-- can be joined to atom-graph data.

CREATE TABLE IF NOT EXISTS request_log (
  request_id        UUID PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method            TEXT,
  params            JSONB,
  ip                TEXT,
  key_hash          TEXT,
  tier              TEXT,
  product           TEXT,
  tool              TEXT,
  jurisdiction      TEXT,
  atom_ids_returned TEXT[],
  response_status   INTEGER,
  latency_ms        INTEGER,
  is_error          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_request_log_ts           ON request_log (ts);
CREATE INDEX IF NOT EXISTS idx_request_log_tool         ON request_log (tool);
CREATE INDEX IF NOT EXISTS idx_request_log_tier         ON request_log (tier);
CREATE INDEX IF NOT EXISTS idx_request_log_jurisdiction ON request_log (jurisdiction);
CREATE INDEX IF NOT EXISTS idx_request_log_key_hash     ON request_log (key_hash);
CREATE INDEX IF NOT EXISTS idx_request_log_is_error     ON request_log (is_error);
