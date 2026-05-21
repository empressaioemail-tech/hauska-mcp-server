# Secret Manager inventory — Hauska MCP Server

The six secrets the production service binds from Secret Manager, what
each is, and where the value comes from. `deploy/setup.sh` creates them
empty and grants the runtime service account `secretAccessor`; the
operator adds a version to each before the first deploy.

Add a version:

```
printf '%s' '<value>' | gcloud secrets versions add <NAME> \
  --project=hauska-prod --data-file=-
```

| Secret name | Bound to env var | Value |
|---|---|---|
| `HAUSKA_ENGINE_API_KEY` | `HAUSKA_ENGINE_API_KEY` | Bearer token for cc-agent-E's hauska-engine retrieval API. May be empty until Lane E Phase E0 deploys the engine; the public catalog tools fail gracefully until then. |
| `LEGACY_BACKEND_API_KEY` | `LEGACY_BACKEND_API_KEY` | Must equal `SERVICE_API_KEY` in `legacy-design-tools-prod` (the cutover runbook Amendment 8 bearer path). The Codex tools and the bearer-path Cortex tools use it. |
| `LEGACY_SNAPSHOT_SECRET` | `LEGACY_SNAPSHOT_SECRET` | The `x-snapshot-secret` cortex-api accepts on `/api/snapshots`. Used by `cortex_snapshot_register` and `cortex_ifc_ingest`. |
| `DATABASE_URL` | `DATABASE_URL` | Postgres connection string for the `hauska_mcp` database (api_keys + request_log). |
| `UPSTASH_REDIS_REST_TOKEN` | `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token for the rate limiter. |
| `HAUSKA_ADMIN_BOOTSTRAP_KEY` | `HAUSKA_ADMIN_BOOTSTRAP_KEY` | Gates `/admin/keys`. Generate fresh: `openssl rand -base64 48`. |

## Rotate, do not copy

The values currently in the workstation `.env` were flagged as exposed
in a planner conversation log (cutover runbook Stage 9: `SERVICE_API_KEY`,
the minted MCP keys, the `CutoverTemp2026A` database password). Seed
Secret Manager with **freshly rotated** values, not the workstation copies:

- `LEGACY_BACKEND_API_KEY`: rotate `SERVICE_API_KEY` in
  `legacy-design-tools-prod` (`gcloud secrets versions add` + a new
  cortex-api revision), then seed the matching value here.
- `DATABASE_URL`: rotate the `hauska_mcp` Postgres role password off the
  throwaway `CutoverTemp2026A`, then seed the new connection string.
- `HAUSKA_ADMIN_BOOTSTRAP_KEY`: generate a brand-new key.

## Not created — Wave 2

`STRIPE_KEYS` (or `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`) is named
here as a placeholder only. Payment, Stripe, and the paid Layer 2 tier
are Wave 2 and out of scope for this sprint. Do not create or bind a
Stripe secret now.
