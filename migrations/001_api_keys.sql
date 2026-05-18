-- 001: api_keys table for Stream 2B (substrate v1).
-- Field list per the cc-agent-M dispatch:
--   key_id, key_hash, tier, owner_email, owner_name,
--   created_at, last_used_at, status, notes
--
-- Tier band canonical set from doc_repo/29_mcp_surface_tier_model.md:
--   free, developer_pro, team, embedder.
-- Status band canonical set:
--   active, revoked, past_due, canceled.

CREATE TABLE IF NOT EXISTS api_keys (
  key_id        UUID PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  tier          TEXT NOT NULL
                CHECK (tier IN ('free', 'developer_pro', 'team', 'embedder')),
  owner_email   TEXT NOT NULL,
  owner_name    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'revoked', 'past_due', 'canceled')),
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys (status);
CREATE INDEX IF NOT EXISTS idx_api_keys_tier   ON api_keys (tier);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner  ON api_keys (owner_email);
