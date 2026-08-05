-- Distributed rate-limit counters (T4 postgres store).
-- Atomic upserts via counter_key; expires_at drives window reset.

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  counter_key TEXT PRIMARY KEY,
  count BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limit_counters_expires_at_idx
  ON rate_limit_counters (expires_at);