---
id: 2026-05-21_2d3_deploy
title: cc-agent-M session — Stream 2D.3 Cloud Run deploy
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_2d2_deploy_config]
---

# Stream 2D.3 — Cloud Run deploy

The Hauska MCP Server is deployed to Cloud Run in the new `hauska-prod`
project and verified live.

## What ran

Project id is `hauska-prod-497015` (GCP appended a suffix; display name
`hauska-prod`). The operator created the project and linked billing.

1. `deploy/setup.sh` provisioned the shared project base: enabled the six
   APIs, created the `hauska-mcp` Artifact Registry repo, the
   `hauska-mcp-runtime` service account, the
   `hauska-prod-497015-mcp-logs` GCS bucket, the six (empty) Secret
   Manager secrets with IAM, and the Cloud Build deploy-role grants.
2. Seeded the six secrets. Five from the workstation `.env`
   (`LEGACY_BACKEND_API_KEY`, `LEGACY_SNAPSHOT_SECRET`, `DATABASE_URL`,
   `UPSTASH_REDIS_REST_TOKEN`, plus a placeholder `HAUSKA_ENGINE_API_KEY`);
   `HAUSKA_ADMIN_BOOTSTRAP_KEY` generated fresh and never echoed.
3. Applied database migrations against `DATABASE_URL`: `003_request_log`
   created (001 and 002 already present).
4. `gcloud builds submit` ran `cloudbuild-mcp.yaml`: built the image,
   pushed to Artifact Registry, deployed the Cloud Run service. Build
   `d5668663`, 1m44s, SUCCESS.
5. Applied observability: created an email notification channel, then
   `observability/apply.sh` created the three log-based metrics, both
   alert policies (the MQL error-rate policy was accepted), and the
   operations dashboard.

## Result

Service live: `https://hauska-mcp-server-h7gvu7rgcq-uc.a.run.app`,
revision `hauska-mcp-server-00001-fgd`, 100% traffic, min-instances 1.

Verified: the boot logs carry `server_started` and `log_sink_registered`
(production sink path active, not dev mode); a `tools/list` round-trip
through Cloud Build (an in-GCP curl, since this workstation cannot TLS to
`run.app`) returns the full 40-tool surface; the `request_log` Postgres
index has a confirmed row from that request, so the 2C.2 sink works end
to end in production.

## Fix landed during the deploy

`cloudbuild-mcp.yaml` referenced `$SHORT_SHA` for the image tag.
`$SHORT_SHA` is only populated for trigger-driven builds; a
`gcloud builds submit` from local source leaves it empty, which produced
an invalid image name on the first attempt. Replaced with an explicit
`_TAG` substitution (the git short SHA, passed at submit time).
`observability/apply.sh` had its alert-policy creation made non-fatal so
one policy failing cannot abort the dashboard step.

## Decisions (decide-and-document)

Secrets seeded from `.env`, admin key regenerated. Five secret values
were already valid in the workstation `.env`; reusing them gets the
service live now. `HAUSKA_ADMIN_BOOTSTRAP_KEY` was generated fresh
(`openssl rand`) rather than copied, because it is trivially rotatable
with no cross-system coordination. `LEGACY_BACKEND_API_KEY` and the
`DATABASE_URL` password are the cutover-exposed values; rotating them
touches `legacy-design-tools-prod` and the Neon role, so they are seeded
as-is and flagged for post-launch rotation rather than blocking the
deploy.

Project-scoped GCS bucket name. `hauska-prod-497015-mcp-logs` rather than
`hauska-mcp-logs`, since GCS bucket names are global and a bare name
risks a collision.

Notification channel to the operator email. The alert policies need a
channel to be useful; an email channel to the operator's address was
created. Re-point it later if a shared ops alias is preferred.

## Operator-gated remainder

1. `mcp.hauska.dev` custom domain. `hauska.dev` is not verified for this
   GCP account. The operator runs `gcloud domains verify hauska.dev`
   (TXT record at the registrar), then the domain mapping plus its CNAME
   can be created. The service is fully reachable at the `run.app` URL
   meanwhile, which is correct pre-GTM.
2. Secret rotation for the two cutover-exposed values (see above).

## cc-agent-E coordination

`hauska-prod` is shared. `deploy/setup.sh` stood up the project base
(APIs, Cloud Build deploy roles) which cc-agent-E's Lane E also benefits
from; cc-agent-E adds the retrieval API's own Artifact Registry image,
service account, secrets, and Cloud Run service. No resource-name
collision: every MCP resource is `hauska-mcp-*` named. When cc-agent-E's
retrieval API is live in this project, `HAUSKA_BACKEND_URL` and
`HAUSKA_ENGINE_API_KEY` (currently placeholders) are updated to point at
it; the public catalog tools fail gracefully until then.

## Next

Stream 2D.4 (docs site), 2D.6 (launch-artifact drafts), 2D.5
(cross-client matrix + example agent). The full cross-client pass runs
against the live service.
