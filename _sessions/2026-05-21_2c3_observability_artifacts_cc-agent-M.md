---
id: 2026-05-21_2c3_observability_artifacts
title: cc-agent-M session — Stream 2C.3 observability artifacts
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_2c2_log_persistence]
---

# Stream 2C.3 — observability artifacts

Third unit of Lane M, closing Stream 2C. Adds the metrics, alerts,
dashboards, training export, and cost monitoring over the log stream
that 2C.1 and 2C.2 produce. Branch `feat/2c3-observability-artifacts`.

## What shipped

A new `observability/` directory, config and SQL artifacts only (no
application code changed):

Operational layer (Cloud Monitoring). Three log-based metric definitions
(`mcp_requests_total`, `mcp_request_errors`, distribution
`mcp_request_latency`), two alert policies (error rate > 1%, p99 latency
> 1500ms), an operations dashboard, and `apply.sh` to create them all in
a GCP project. The error-rate alert is an MQL ratio; the latency alert
is a plain threshold on the distribution metric's 99th percentile.

Analytical layer (Looker Studio over Postgres). `queries/dashboards.sql`:
one statement per panel over the `request_log` table, covering calls/day
by tool / jurisdiction / tier, top tools, top jurisdictions, daily error
rate, latency p50/p95/p99, new free-tier IPs, high-volume free-tier IPs
(the commercial-use signal), and per-key usage.

Training-data export (`queries/training_export.sql`). Anonymized
structured slice of `request_log` for fine-tuning and eval ingest: raw
IP and key hash dropped, a salted `caller_anon` hash preserving
per-caller call-sequence structure.

Cost monitoring (`queries/cost_attribution.sql` + `COST_MONITORING.md`).
Per-tier cost attribution by request share, the free-cost-versus-paid-
revenue dashboard spec (paid side empty until Wave 2), and the GCP
billing-budget alert command.

## Decisions (decide-and-document)

Two-layer split: Cloud Monitoring for operational, Looker Studio over
Postgres for analytical. The dispatch named BigQuery + Looker Studio as a
candidate. BigQuery would mean a second copy of the data and an export
job. `request_log` already is the columnar index; Looker Studio's native
PostgreSQL connector reads it directly. No BigQuery, no export pipeline,
one source of truth. The Cloud Monitoring layer stays for the things
that need real-time alerting (error rate, latency), which Looker Studio
does not do.

Dashboards delivered as SQL plus a wiring guide, not as a Looker Studio
artifact. A Looker Studio report is not a file in a repo; it is built in
the Looker UI against a live database. The reviewable, version-controlled
deliverable is the set of SQL queries plus the README wiring steps. The
report itself is assembled when `request_log` has data, at deploy.

apply.sh applied at deploy, not now. Log-based metrics only count log
lines written after the metric exists, and creating them needs the GCP
project and the deployed service name. `apply.sh` is written and
syntax-checked now; it runs as a step of Stream 2D.3.

## Verification

`apply.sh` passes `bash -n`. All three JSON artifacts parse. No
application code changed, so the typecheck and the 218-test suite are
unaffected (CI confirms on the PR). The metrics, alerts, and dashboards
are exercised for real when `apply.sh` runs against the deployed service
in Stream 2D.3; the MQL error-rate query in particular is verified there
(MQL ratio syntax is finicky and is flagged in the README for an
apply-time check).

## Known follow-up (unchanged from 2C.2)

`request_log.atom_ids_returned` stays null until the per-handler
`tool_call` logs emit `atom_ids`. No dashboard panel depends on it.
Tracked as a fast-follow.

## Stream 2C status

Closed. 2C.1 (logging spine, correlation, metrics, health, CI), 2C.2
(Postgres index + GCS archive), 2C.3 (metrics, alerts, dashboards,
training export, cost) all merged. The operational artifacts apply
during the Stream 2D deploy.

## Next

Stream 2D.1: Dockerfile and containerization.
