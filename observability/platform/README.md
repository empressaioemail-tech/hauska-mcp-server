# Platform observability — hauska-prod-497015 (76e)

Native Cloud Monitoring uptime checks and alert policies for both
`hauska-mcp-server` and `hauska-retrieval-api` in `hauska-prod-497015`.

## Apply

After deploying `/healthz` on both services:

```bash
PROJECT_ID=hauska-prod-497015 \
REGION=us-central1 \
NOTIFICATION_CHANNEL=projects/hauska-prod-497015/notificationChannels/<id> \
./observability/platform/apply-platform.sh
```

The script:

1. Creates uptime URL checks for `/healthz` on both services (hosts
   auto-resolved from Cloud Run if not passed).
2. Creates alert policies for 5xx rate, p95 latency, and stale-revision
   traffic drift.
3. Enables the Cloud Scheduler API on the project (pre-fire gate).

Without `NOTIFICATION_CHANNEL`, alert policies are skipped; uptime checks
and Scheduler API enable still run.

## Gate probe (scheduled)

Run the synthetic gate probe on a schedule (Cloud Scheduler → Cloud Run
job or operator cron):

```bash
GATE_PROBE_BASE_URL=https://<mcp-host> \
GATE_PROBE_CODEX_KEY=hk_pro_... \
npx tsx scripts/gate-probe.ts
```

Mint a dedicated codex-product probe key via `/admin/keys` and store it
in Secret Manager as `GATE_PROBE_CODEX_KEY` for production runs.

## Signal emit contract

Both `/healthz` and `scripts/gate-probe.ts` emit one structured Cloud
Logging line per check with `jsonPayload.hauska_health=true`. The
cc-agent-C hub filters on that field; emitters do not call the hub.

## Layout

```
observability/platform/
  README.md
  apply-platform.sh
  alert-policies/
    cloud-run-5xx-rate.json
    cloud-run-p95-latency.json
    revision-traffic-drift.json
```
