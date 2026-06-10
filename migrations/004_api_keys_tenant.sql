-- 004: tenant binding on api_keys (ADR-005 Layer A).
--
-- Resolving X-Hauska-Key yields the caller's jurisdiction tenant
-- alongside product. Modeled as a direct column on the api-keys row
-- (ADR-005 open decision: column vs actor-record join — column chosen
-- for v1; actor-record DID can be stored in notes until a join lands).
--
-- platform_internal marks Hauska/Empressa operator keys that may read
-- platform-internal atoms and any tenant-private atom (internal bypass).

ALTER TABLE api_keys
  ADD COLUMN jurisdiction_tenant TEXT,
  ADD COLUMN platform_internal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_api_keys_jurisdiction_tenant
  ON api_keys (jurisdiction_tenant)
  WHERE jurisdiction_tenant IS NOT NULL;
