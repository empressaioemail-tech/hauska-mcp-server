-- 008: sdk_metering_usage — durable Layer 2 usage counters for @hauska-sdk/metering.
--
-- Implements MeteringStore for McpMeteringGate.authorizeCall (Gate D / WDLL 3.11).
-- Period is YYYY-MM (UTC), matching currentBillingPeriod() in the SDK.
--
-- Stripe meter events are retired; this table is the money-path usage store.
-- metering_events (007) remains the append-only observability log.

CREATE TABLE IF NOT EXISTS sdk_metering_usage (
  key_id       TEXT NOT NULL,
  period       TEXT NOT NULL,
  layer2_count INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_id, period)
);

CREATE INDEX IF NOT EXISTS idx_sdk_metering_usage_period
  ON sdk_metering_usage (period);
