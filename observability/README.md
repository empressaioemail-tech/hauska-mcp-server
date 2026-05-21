# Observability — Hauska MCP Server

Stream 2C.3. The metrics, alerts, dashboards, and queries over the
structured log stream that Streams 2C.1 and 2C.2 produce.

## Two layers

Observability splits into an operational layer and an analytical layer,
because the two answer different questions with different latency needs.

**Operational (Cloud Monitoring, real-time).** "Is the service healthy
right now." Built on Cloud Logging log-based metrics extracted from the
structured logs, plus alert policies and a dashboard. Apply with
`apply.sh`.

**Analytical (Looker Studio over Postgres).** "What is the traffic doing
over days and weeks." Built on the `request_log` table (migration 003),
which the log sink populates one row per request. The queries in
`queries/dashboards.sql` each back one panel. No data export step:
Looker Studio's native PostgreSQL connector reads `request_log`
directly.

The in-process `/health` endpoint (Stream 2C.1) is the third, lightest
layer: liveness, recent latency, and dependency reachability for one
instance, with no backend round-trip.

## Layout

```
observability/
  README.md                  this file
  apply.sh                   applies the operational layer to a GCP project
  log-metrics/latency.yaml    distribution-metric config for request latency
  alert-policies/
    error-rate.json           alert: error rate > 1%
    p99-latency.json          alert: p99 latency > 1500ms
  monitoring-dashboard.json   Cloud Monitoring operations dashboard
  queries/
    dashboards.sql            analytical dashboard panels (Looker Studio)
    training_export.sql       anonymized training-data export
    cost_attribution.sql      per-tier cost attribution
  COST_MONITORING.md          cost methodology + free-vs-paid dashboard spec
```

## Operational layer — apply

Run after the `hauska-mcp-server` Cloud Run service exists (Stream 2D.3):

```
PROJECT_ID=<project> \
SERVICE=hauska-mcp-server \
NOTIFICATION_CHANNEL=projects/<project>/notificationChannels/<id> \
./apply.sh
```

This creates three log-based metrics (`mcp_requests_total`,
`mcp_request_errors`, `mcp_request_latency`), two alert policies, and the
operations dashboard. Without `NOTIFICATION_CHANNEL` the alert policies
are skipped; the script prints how to create an email channel.

Log-based metrics only count log lines written *after* the metric
exists, so apply this as part of the deploy, not weeks later.

The `error-rate.json` alert uses a Monitoring Query Language ratio
(errors / total). MQL ratio syntax is finicky across Monitoring API
versions; verify the policy evaluates after `apply.sh` runs (Monitoring >
Alerting > the policy > the condition preview) and adjust if the API
rejects the query shape. The `p99-latency.json` alert uses a plain
threshold condition and needs no such check.

Thresholds (error rate 1%, p99 1500ms) are v1 defaults. Tune them
against the first week of real traffic.

## Analytical layer — wire Looker Studio

1. In Looker Studio, add a data source: PostgreSQL connector pointed at
   the `hauska_mcp` database (host, the `request_log`-bearing Neon
   instance; read-only credentials recommended).
2. For each panel, add a "custom query" data source and paste the
   matching statement from `queries/dashboards.sql`.
3. Panels: calls/day by tool, by jurisdiction, by tier; top tools; top
   jurisdictions; daily error rate; latency p50/p95/p99; new free-tier
   IPs; high-volume free-tier IPs; per-key usage.

Share the dashboard read-only with Nick and the planner per the Stream
2C hand-off.

## Training-data export

`queries/training_export.sql` emits an anonymized, structured slice of
`request_log` for fine-tuning and eval ingest (raw IP and key hash
dropped; a salted `caller_anon` preserves per-caller sequence structure).
The fuller lossless record is the GCS NDJSON archive (Stream 2C.2).

## Cost monitoring

See `COST_MONITORING.md`: per-tier cost attribution by request share,
the free-cost-versus-paid-revenue dashboard (paid side empty until Wave
2), and the GCP billing-budget alert.

## Known follow-up

`request_log.atom_ids_returned` is wired through the sink and the schema
but stays null until the per-handler `tool_call` logs emit an `atom_ids`
field. None of the dashboard panels above depend on it; it matters for
the training corpus. Tracked as a fast-follow.
