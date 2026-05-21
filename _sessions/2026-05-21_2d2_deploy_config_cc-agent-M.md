---
id: 2026-05-21_2d2_deploy_config
title: cc-agent-M session — Stream 2D.2 deploy config
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_2d1_containerization]
---

# Stream 2D.2 — deploy config

Second unit of Stream 2D. The Cloud Build pipeline, the Cloud Run service
spec, and the Secret Manager bind plan, targeting the new `hauska-prod`
project (operator decision this session). Branch `feat/2d2-deploy-config`.

## What shipped

`cloudbuild-mcp.yaml`. Three steps: docker build, push to Artifact
Registry, `gcloud run deploy`. The deploy step carries the full Cloud Run
service spec: `min-instances=1` (no cold start on the first agent call),
`max-instances=10`, `cpu=1`, `memory=512Mi`, `concurrency=80`, port 8080,
`allow-unauthenticated`, a dedicated runtime service account, the
non-secret env vars inline, and the six secrets bound from Secret
Manager. Non-secret runtime config (backend URLs, GCS bucket) is exposed
as build substitutions, never the secrets.

`deploy/setup.sh`. One-time `hauska-prod` setup: enables the six APIs,
creates the Artifact Registry repo, the `hauska-mcp-runtime` service
account, the `hauska-mcp-logs` GCS bucket with IAM, and the six Secret
Manager secrets (empty, with `secretAccessor` granted to the runtime SA),
and grants the Cloud Build SA its deploy roles.

`deploy/secrets.md`. The six-secret inventory: name, bound env var, value
source. Explicit instruction to seed with freshly rotated values, not the
workstation `.env` copies, because the cutover runbook flagged several as
exposed. `STRIPE_KEYS` named as a Wave 2 placeholder only, not created.

`deploy/README.md`. The deploy runbook (first deploy, subsequent
deploys, rollback) and the full environment-variable trace table: every
env var the code reads, its production source, and its unset behavior.
That table is the cutover env-var bind discipline applied here, so there
are no silent drops.

## Decisions (decide-and-document)

Env var names follow the code, not the dispatch shorthand. The dispatch
listed `BACKEND_URL`, `BACKEND_KEY`, `REDIS_URL`, `CORTEX_API_URL` and so
on; the code actually reads `HAUSKA_BACKEND_URL`, `HAUSKA_ENGINE_API_KEY`,
`LEGACY_BACKEND_URL`, `LEGACY_BACKEND_API_KEY`, `LEGACY_SNAPSHOT_SECRET`,
`UPSTASH_REDIS_REST_URL`/`_TOKEN`, `DATABASE_URL`,
`HAUSKA_ADMIN_BOOTSTRAP_KEY`, `GCS_LOG_BUCKET`. The deploy config binds
the real names; the dispatch list was shorthand. The trace table in
`deploy/README.md` is the reconciliation.

Six secrets, not seven. `HAUSKA_ENGINE_API_KEY`, `LEGACY_BACKEND_API_KEY`,
`LEGACY_SNAPSHOT_SECRET`, `DATABASE_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`HAUSKA_ADMIN_BOOTSTRAP_KEY` are secrets. The backend URLs and the
Upstash REST URL are not sensitive (a URL without its token is inert) and
ride as plain env vars. Stripe is not wired.

Dedicated runtime service account. `hauska-mcp-runtime`, not the default
compute SA, so the secret-accessor and bucket-writer grants are scoped to
exactly this service. Matches the cortex-api `api-server-runtime` pattern.

## Verification

`deploy/setup.sh` passes `bash -n`. `cloudbuild-mcp.yaml` structure
verified. The pipeline and the Dockerfile (2D.1) get their authoritative
verification when `gcloud builds submit` runs the first real build in
Stream 2D.3.

## Status — 2D.3 gated on operator

Stream 2D.3 (the actual deploy plus the `mcp.hauska.dev` mapping) waits
on the operator creating the `hauska-prod` project and linking billing.
Once that is done, `deploy/setup.sh` and the cloudbuild pipeline run
autonomously. Everything project-independent continues meanwhile: the
docs site (2D.4) and the launch-artifact drafts (2D.6) are next.

## Next

Stream 2D.4: the docs site (schema reference, quickstarts, tier / ToS /
privacy / attribution pages).
