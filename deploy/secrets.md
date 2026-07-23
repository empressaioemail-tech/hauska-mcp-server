# Secret Manager inventory — Hauska MCP Server

The secrets the production service binds from Secret Manager, what
each is, and where the value comes from. `deploy/setup.sh` creates them
empty and grants the runtime service account `secretAccessor`; the
operator adds a version to each before the first deploy (or before the
binding is required).

Add a version:

```
printf '%s' '<value>' | gcloud secrets versions add <NAME> \
  --project=hauska-prod-497015 --data-file=-
```

| Secret name | Bound to env var | Value |
|---|---|---|
| `HAUSKA_ENGINE_API_KEY` | `HAUSKA_ENGINE_API_KEY` | Bearer token for cc-agent-E's hauska-engine retrieval API. May be empty until Lane E Phase E0 deploys the engine; the public catalog tools fail gracefully until then. |
| `LEGACY_BACKEND_API_KEY` | `LEGACY_BACKEND_API_KEY` | Must equal `SERVICE_API_KEY` in `legacy-design-tools-prod` (the cutover runbook Amendment 8 bearer path). The Codex tools and the bearer-path Cortex tools use it. |
| `LEGACY_SNAPSHOT_SECRET` | `LEGACY_SNAPSHOT_SECRET` | The `x-snapshot-secret` cortex-api accepts on `/api/snapshots`. Used by `cortex_snapshot_register` and `cortex_ifc_ingest`. |
| `DATABASE_URL` | `DATABASE_URL` | Postgres connection string for the `hauska_mcp` database (api_keys + request_log + metering + source_obligation_ledger). |
| `UPSTASH_REDIS_REST_TOKEN` | `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token for the rate limiter. |
| `HAUSKA_ADMIN_BOOTSTRAP_KEY` | `HAUSKA_ADMIN_BOOTSTRAP_KEY` | Gates `/admin/keys`. Generate fresh: `openssl rand -base64 48`. |
| `GATE_CONTEXT_SIGNING_KEY` | `GATE_CONTEXT_SIGNING_KEY` | HMAC key for gate-context tokens (cutover path). |
| `CIRCLE_API_KEY` | `CIRCLE_API_KEY` | Circle API key for overage checkout + RevenueRouter settlement (Gate D / I-F outbound). **Nick-only seed.** Until seeded, runtime logs `sdk_metering_circle_absent` and overage honest-degrades. |
| `CIRCLE_MERCHANT_WALLET_ID` | `CIRCLE_MERCHANT_WALLET_ID` | Circle merchant wallet id for payouts. **Nick-only seed.** |
| `HAUSKA_CHECKOUT_BASE_URL` | `HAUSKA_CHECKOUT_BASE_URL` | Public checkout base URL returned on overage (e.g. `https://pay.hauska.dev`). **Nick-only seed.** |
| `CIRCLE_API_URL` | `CIRCLE_API_URL` | Optional Circle API base override (sandbox vs prod). Omit or leave unset to use SDK default. |

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

## Circle / settlement (PARTIAL until Nick seeds)

Do **not** invent Circle secret values in agents or CI. Nick must seed
`CIRCLE_API_KEY`, `CIRCLE_MERCHANT_WALLET_ID`, and
`HAUSKA_CHECKOUT_BASE_URL` in `hauska-prod-497015`, then redeploy so the
revision picks up `:latest`. Until then:

- within-bundle `McpMeteringGate.authorizeCall` still runs
- overage checkout and RevenueRouter ICC cut honest-degrade
  (`sdk_metering_circle_absent`)
- inbound I-K source-obligation ledger does **not** depend on Circle

Placeholder Secret Manager versions (literal `absent`) keep Cloud Run
bindings valid without enabling Circle; `sdk-metering` treats those as unset.

## Retired — do not create

`STRIPE_SECRET_KEY` / Stripe meter secrets are retired from the money
path (Gate D). Do not create or bind Stripe billing secrets for metering.
