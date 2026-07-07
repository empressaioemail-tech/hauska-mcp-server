-- 006: Add stripe_customer_id to api_keys for Layer 2 metering billing.
--
-- The stripe_customer_id links an API key to a Stripe customer for
-- automated billing meter event posting. Nullable; keys without a mapping
-- emit layer2_call logs but skip Stripe meter events (unbilled).
--
-- Stripe stays in TEST MODE per operator ruling (A4b task context).
-- Test meter: layer2_call (mtr_test_61UzHInRw5N1hYEjh41FjAepSMTX7ItU).

ALTER TABLE api_keys
  ADD COLUMN stripe_customer_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_stripe_customer
  ON api_keys (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
