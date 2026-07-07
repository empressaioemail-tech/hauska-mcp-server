-- 007: metering_events — append-only layer2_call event log.
--
-- Records every Layer 2 call (successful product-gated tool call by a
-- keyed caller) with billing state. This is the native truth for revenue
-- reporting and the command center's metering summary panel.
--
-- A Layer 2 call is metered when:
--   - product != "public" (product-gated tool)
--   - caller is authenticated (key_id present)
--   - tool call succeeds (no error thrown)
--
-- The `billed` flag records whether the call posted to Stripe (true if
-- STRIPE_SECRET_KEY is set AND the key row has a stripe_customer_id).
--
-- This table is written by recordLayer2Call in src/metering.ts, which
-- fires asynchronously at the logToolRead choke point. Writes never block
-- the tool path.

CREATE TABLE IF NOT EXISTS metering_events (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  key_id     TEXT NOT NULL,
  key_hash   TEXT NOT NULL,
  product    TEXT NOT NULL,
  tier       TEXT NOT NULL,
  tool       TEXT NOT NULL,
  request_id TEXT NOT NULL,
  billed     BOOLEAN NOT NULL
);

-- Query indexes for the /metering/summary aggregations.
CREATE INDEX IF NOT EXISTS idx_metering_events_ts ON metering_events (ts);
CREATE INDEX IF NOT EXISTS idx_metering_events_tool ON metering_events (tool);
CREATE INDEX IF NOT EXISTS idx_metering_events_product ON metering_events (product);
CREATE INDEX IF NOT EXISTS idx_metering_events_billed ON metering_events (billed);
