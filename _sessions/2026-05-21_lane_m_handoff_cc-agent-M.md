---
id: 2026-05-21_lane_m_handoff
title: cc-agent-M — Lane M final hand-off (Hauska MCP Server public launch)
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_hauska_commercialization_sprint, 16_commercialization_roadmap]
---

# Lane M — final hand-off

Lane M of the Hauska commercialization sprint. The Hauska MCP Server is
deployed, observable, documented, and verified. Everything cc-agent-M can
build autonomously is done. This summary names what shipped, what remains
for the operator, and the one cross-lane dependency.

## Shipped — eight PRs, all CI-green, self-merged

| PR | Unit |
|----|------|
| #14 | 2C.1 — structured logger, request_id correlation, metrics, `/health`, CI gate |
| #15 | 2C.2 — `request_log` Postgres index (migration 003) + GCS log archive sink |
| #16 | 2C.3 — log-based metrics, alert policies, dashboard SQL, training export, cost monitoring |
| #17 | 2D.1 — multi-stage Dockerfile |
| #18 | 2D.2 — `cloudbuild-mcp.yaml`, `deploy/setup.sh`, secret bind plan |
| #19 | 2D.3 — Cloud Run deploy + deploy fixes |
| #20 | 2D.4 — docs site, auto-generated tool reference |
| #21 | 2D.5 / 2D.6 — example agent, cross-client matrix, launch drafts |

Test suite 218 green; typecheck clean throughout.

## Live endpoints

Service: `https://hauska-mcp-server-h7gvu7rgcq-uc.a.run.app`
(Cloud Run, project `hauska-prod-497015`, region `us-central1`,
revision `hauska-mcp-server-00002-4sl`, 100% traffic, min-instances 1).

- `/mcp` — the MCP Streamable HTTP endpoint. Verified: `tools/list`
  returns the full 40-tool surface.
- `/health` — liveness, metrics snapshot, dependency health.
- `/docs` — the documentation site. Verified live (HTTP 200).
- `/admin/keys` — key issuance, gated by the admin bootstrap key.

## Observability

- Three Cloud Logging log-based metrics: `mcp_requests_total`,
  `mcp_request_errors`, `mcp_request_latency`.
- Two alert policies: error rate > 1%, p99 latency > 1500ms. Email
  notification channel created.
- The Cloud Monitoring **operations dashboard** is created and returns
  data as traffic flows.
- The **analytical dashboard** is a documented wire-up: connect Looker
  Studio to the `hauska_mcp` Postgres with the queries in
  `observability/queries/dashboards.sql` (see `observability/README.md`).
  The `request_log` index is populating (confirmed rows in production).
- Training-data export query and cost-attribution query are in
  `observability/queries/`.

## Documentation

`https://hauska-mcp-server-h7gvu7rgcq-uc.a.run.app/docs` (and
`mcp.hauska.dev/docs` once the domain is mapped). Twelve pages: overview,
example queries, the auto-generated 40-tool reference, four client
quickstarts, tiers, pricing, attribution, Terms of Service, privacy.

## Launch artifacts (drafts — do not publish)

`launch/` — eight drafts: Anthropic MCP directory submission,
`awesome-mcp-servers` PR, blog post, Show HN, ProductHunt, social,
PropTech-press list. `launch/README.md` carries the operator pre-publish
checklist. Passages that depend on the GTM working session are marked
`[GTM-SESSION]`. Publication is operator-gated per the hard stop.

## What remains — operator

1. **`mcp.hauska.dev` custom domain.** `hauska.dev` is not verified for
   this GCP account. Run `gcloud domains verify hauska.dev` (adds a TXT
   record at the `hauska.dev` registrar), then:
   ```
   gcloud beta run domain-mappings create --service=hauska-mcp-server \
     --domain=mcp.hauska.dev --region=us-central1 --project=hauska-prod-497015
   ```
   Add the CNAME it prints at the registrar; managed TLS provisions in
   5 to 15 minutes.

2. **Secret rotation.** `LEGACY_BACKEND_API_KEY` and the `DATABASE_URL`
   password were seeded from the cutover-exposed workstation values.
   Rotate per `deploy/secrets.md` (a no-downtime add-version plus
   new-revision operation). `HAUSKA_ADMIN_BOOTSTRAP_KEY` was generated
   fresh and lives only in Secret Manager; retrieve it with
   `gcloud secrets versions access latest --secret=HAUSKA_ADMIN_BOOTSTRAP_KEY --project=hauska-prod-497015`.

3. **GTM publication.** After the GTM channel-plan working session fills
   the `[GTM-SESSION]` passages, publish the `launch/` artifacts in the
   chosen sequence. The cross-client GUI click-through (MCP Inspector,
   Claude Desktop, Cursor) is a short verification step to bundle here.

4. **Analytical dashboard.** Wire Looker Studio to the `hauska_mcp`
   Postgres per `observability/README.md` and share it read-only.

## What remains — cross-lane (cc-agent-E)

The five public catalog tools call the hauska-engine retrieval API.
`HAUSKA_BACKEND_URL` and `HAUSKA_ENGINE_API_KEY` carry placeholders; the
catalog tools fail gracefully until they are wired. cc-agent-E deploys
the retrieval API into the shared `hauska-prod-497015` project (Lane E
Phase E0). When that service is live, wire it:

```
# 1. Seed the real engine key.
printf '%s' '<engine-api-key>' | gcloud secrets versions add HAUSKA_ENGINE_API_KEY \
  --project=hauska-prod-497015 --data-file=-

# 2. Redeploy with the real engine URL.
TAG=$(git rev-parse --short HEAD)
gcloud builds submit --project=hauska-prod-497015 --config=cloudbuild-mcp.yaml \
  --substitutions=_HAUSKA_BACKEND_URL=<engine-url>,_UPSTASH_REDIS_REST_URL=https://fluent-magpie-131764.upstash.io,_GCS_LOG_BUCKET=hauska-prod-497015-mcp-logs,_TAG=$TAG
```

After that, the full cross-client catalog pass (per
`_research/2026-05-21_cross_client_matrix.md`) can run green.

`deploy/setup.sh` already stood up the shared project base (APIs, Cloud
Build deploy roles); cc-agent-E adds the retrieval API's own Artifact
Registry image, service account, and secrets. No resource-name
collision: every MCP resource is `hauska-mcp-*` named.

## Close criteria status

| Lane M close criterion | Status |
|---|---|
| Deployed to Cloud Run | done |
| Over managed TLS at `mcp.hauska.dev` | service deployed; domain mapping operator-gated on `hauska.dev` verification |
| Stream 2C observability live | done; analytical dashboard a documented wire-up |
| Docs site live | done (`/docs`) |
| Cross-client matrix passes the deployed surface | protocol verified; catalog pass gated on the engine wiring |
| Public catalog wired to cc-agent-E's retrieval API | gated on Lane E Phase E0 |
| Launch artifacts drafted | done |

Lane M's cc-agent-M scope is complete. The residual items are an operator
DNS verification, an operator hardening pass, the operator-led GTM
publication, and one cross-lane wiring step that activates the moment
cc-agent-E's retrieval API is live.
