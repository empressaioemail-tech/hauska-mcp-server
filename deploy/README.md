# Deploy — Hauska MCP Server

Stream 2D. How the server is containerized and deployed to Cloud Run at
`mcp.hauska.dev`.

## Target

- **Project:** `hauska-prod-497015` (display name `hauska-prod`; the
  dedicated Hauska commercial-layer project per ADR-008). Shared with
  cc-agent-E's hauska-engine retrieval API.
- **Service:** `hauska-mcp-server`, Cloud Run, region `us-central1`.
- **Image:** Artifact Registry,
  `us-central1-docker.pkg.dev/hauska-prod-497015/hauska-mcp/hauska-mcp-server`.
- **Domain:** `mcp.hauska.dev`, managed TLS.

## Status — deployed 2026-05-21

The service is **live** at `https://hauska-mcp-server-h7gvu7rgcq-uc.a.run.app`
(revision `hauska-mcp-server-00001-fgd`, 100% traffic, min-instances 1).
`deploy/setup.sh` provisioned the project, the six secrets are seeded,
migration 003 is applied, and observability is live (three log-based
metrics, two alert policies, the operations dashboard, an email
notification channel). A `tools/list` round-trip returns the 40-tool
surface and the `request_log` index has confirmed rows.

Two items remain operator-gated:

1. **`mcp.hauska.dev` custom domain.** `hauska.dev` is not yet verified
   for this GCP account (`gcloud beta run domain-mappings create` reports
   only `smartcityos.io` verified). The operator runs
   `gcloud domains verify hauska.dev` (adds a TXT record at the
   `hauska.dev` registrar), then re-runs the domain-mapping command in
   step 7 and adds the CNAME it prints. Until then the service is reached
   at the `run.app` URL above, which is correct and expected pre-GTM.

2. **Secret rotation.** `LEGACY_BACKEND_API_KEY` and the `DATABASE_URL`
   password were seeded from the workstation `.env`; the cutover runbook
   flagged both as exposed. Rotate per `deploy/secrets.md` as post-launch
   hardening (a no-downtime add-version plus new-revision operation).
   `HAUSKA_ADMIN_BOOTSTRAP_KEY` was generated fresh during the deploy and
   lives only in Secret Manager.

`HAUSKA_BACKEND_URL` and `HAUSKA_ENGINE_API_KEY` carry placeholders; they
are wired to cc-agent-E's hauska-engine retrieval endpoint once Lane E
Phase E0 deploys it into this project.

## Files

```
Dockerfile              multi-stage build (Stream 2D.1)
.dockerignore
cloudbuild-mcp.yaml     build + push + deploy pipeline
deploy/setup.sh         one-time project setup (APIs, AR, SA, secrets)
deploy/secrets.md       the six Secret Manager secrets
deploy/README.md        this file
```

## First deploy

1. **Operator: create the project and link billing.**
   `gcloud projects create hauska-prod`, then link a billing account.

2. **One-time setup.** `PROJECT_ID=hauska-prod ./deploy/setup.sh` enables
   the APIs and creates the Artifact Registry repo, the
   `hauska-mcp-runtime` service account, the `hauska-mcp-logs` GCS
   bucket, and the six (empty) Secret Manager secrets with IAM.

3. **Seed secrets.** Add a version to each of the six secrets per
   `deploy/secrets.md`. Use freshly rotated values, not the workstation
   `.env` copies.

4. **Migrate the database.** `DATABASE_URL='<value>' npm run migrate`
   applies `001_api_keys`, `002_api_keys_product`, `003_request_log`.

5. **Deploy.**
   ```
   gcloud builds submit --project=hauska-prod --config=cloudbuild-mcp.yaml \
     --substitutions=_HAUSKA_BACKEND_URL=<engine-url>,_UPSTASH_REDIS_REST_URL=<upstash-url>,_GCS_LOG_BUCKET=hauska-mcp-logs
   ```
   `_HAUSKA_BACKEND_URL` is cc-agent-E's deployed retrieval API; until
   Lane E Phase E0 lands it can stay a placeholder (the public catalog
   tools fail gracefully).

6. **Observability.** Run `observability/apply.sh` (see
   `observability/README.md`).

7. **Custom domain.** Map `mcp.hauska.dev`:
   ```
   gcloud beta run domain-mappings create --service=hauska-mcp-server \
     --domain=mcp.hauska.dev --region=us-central1 --project=hauska-prod
   ```
   Add the CNAME the command prints at the `hauska.dev` registrar; wait
   for managed-TLS provisioning (5 to 15 min typical).

8. **Verify.** `curl https://mcp.hauska.dev/health` returns the health
   report; a `tools/list` round-trip against `/mcp` returns the 40-tool
   surface. Run the six-probe pattern from the cutover runbook.

## Subsequent deploys

Re-run step 5. `gcloud run deploy` keeps the previous revision; a bad
deploy rolls back with
`gcloud run services update-traffic hauska-mcp-server --to-revisions=<prev>=100`.

## Environment variable trace

Every env var the code reads, and where production sets it. No silent
drops (the cutover env-var bind discipline).

| Env var | Read by | Production source | If unset |
|---|---|---|---|
| `PORT` | index.ts | Cloud Run injects (8080) | code default 3000 |
| `HAUSKA_ENV` | index, logger, health | `--set-env-vars=production` | `development` |
| `HAUSKA_TRUST_PROXY` | index.ts | `--set-env-vars=1` | 1 |
| `HAUSKA_BACKEND_URL` | hauska-client, health | `--set-env-vars` (`_HAUSKA_BACKEND_URL`) | `localhost:8080` |
| `HAUSKA_ENGINE_API_KEY` | hauska-client | Secret Manager | empty (no auth header) |
| `LEGACY_BACKEND_URL` | legacy-client, health | `--set-env-vars` (`_LEGACY_BACKEND_URL`) | `localhost:5000` |
| `LEGACY_BACKEND_API_KEY` | legacy-client | Secret Manager | empty |
| `LEGACY_SNAPSHOT_SECRET` | legacy-client | Secret Manager | empty |
| `DATABASE_URL` | db.ts | Secret Manager | pool init throws |
| `DATABASE_POOL_MAX` | db.ts | not set | 10 |
| `UPSTASH_REDIS_REST_URL` | rate-limit, health | `--set-env-vars` (`_UPSTASH_REDIS_REST_URL`) | startup throws |
| `UPSTASH_REDIS_REST_TOKEN` | rate-limit | Secret Manager | startup throws |
| `HAUSKA_ADMIN_BOOTSTRAP_KEY` | auth.ts | Secret Manager | `/admin` returns 503 |
| `HAUSKA_DEV_MODE` | index.ts | NOT set | production auth path |
| `GCS_LOG_BUCKET` | index.ts | `--set-env-vars` (`_GCS_LOG_BUCKET`) | GCS archive off, Postgres sink only |
| `HAUSKA_LOG_DESTINATION` | logger.ts | not set | `stdout` (vestigial since 2C.2 sinks) |
| `HAUSKA_FREE_IP_RPM` and the other tier caps | tiers.ts | not set | code defaults (match `.env.example`) |

`HAUSKA_DEV_MODE` must stay unset in production. Set, it disables auth
and rate limiting and treats every request as free anonymous.

## Cloud Armor / WAF

Cloud Run is fronted by Google's edge. A v1 Cloud Armor policy (basic
rate-based ban on abusive IPs, plus the standard OWASP preconfigured
rules) is applied at the load-balancer tier; the MCP server's own
per-IP and per-key rate limiting is the primary control. The Cloud Armor
policy is attached during step 7 when the domain mapping creates the
serving path. v1 keeps it minimal: a rate-based rule far above the
free-tier app limit, so it catches volumetric abuse without interfering
with legitimate burst traffic.

## Not wired — Wave 2

A `STRIPE_KEYS` secret binding is named in `deploy/secrets.md` as a
placeholder only. Payment and the paid Layer 2 tier are Wave 2.
