-- 009: source_obligation_ledger — append-only inbound royalty accruals (I-K / Master 2.5.4).
--
-- Every successful gate read that returns an ICC-sourced (or other licensed-source)
-- atom DID accrues a row here — free tier and anonymous included. Amount may be
-- null with grace_terms = 'pending-rate' until commercial rates are set.
--
-- Distinct from metering_events (007, Layer-2 money-IN observability) and
-- sdk_metering_usage (008, SDK Layer-2 counters). This ledger is money-OUT
-- liability to the licensed source (ICC test account first).

CREATE TABLE IF NOT EXISTS source_obligation_ledger (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_actor_did TEXT NOT NULL,
  atom_did         TEXT NOT NULL,
  tool             TEXT NOT NULL,
  product          TEXT NOT NULL,
  tier             TEXT NOT NULL,
  request_id       TEXT NOT NULL,
  obligation_type  TEXT NOT NULL DEFAULT 'license-reference-royalty',
  amount_minor     INTEGER NULL,
  currency         TEXT NULL,
  grace_terms      TEXT NULL,
  note             TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_obligation_ledger_created_at
  ON source_obligation_ledger (created_at);
CREATE INDEX IF NOT EXISTS idx_source_obligation_ledger_source_actor
  ON source_obligation_ledger (source_actor_did);
CREATE INDEX IF NOT EXISTS idx_source_obligation_ledger_atom
  ON source_obligation_ledger (atom_did);
CREATE INDEX IF NOT EXISTS idx_source_obligation_ledger_request
  ON source_obligation_ledger (request_id);
