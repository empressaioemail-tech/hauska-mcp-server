---
id: 2026-05-21_2c1_observability_foundations
title: cc-agent-M session — Stream 2C.1 observability foundations
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_hauska_commercialization_sprint, 51_substrate_v1_sprint]
---

# Stream 2C.1 — observability foundations

First unit of Lane M. Establishes the structured-logging spine, per-request
correlation, in-process metrics, an enriched health endpoint, and a CI gate.
Branch `feat/2c-observability-foundations` off `origin/main`.

## What shipped

Canonical structured logger (`src/logger.ts`). Line-delimited JSON, every
line carrying a Google Cloud Logging `severity` field (INFO / WARNING /
ERROR) so Cloud Run ingestion classifies correctly. `info` and `warn` go to
stdout, `error` to stderr. The logger is now sink-pluggable: `addLogSink()`
lets Stream 2C.2 register the Postgres-index plus GCS-payload sink without
touching the 40 tool call sites.

Per-request correlation. A `request_id` (UUID) is generated in `index.ts`
before auth runs and bound into the AsyncLocalStorage context
(`src/request-context.ts`, new `getCurrentRequestId()`). The logger
auto-injects it, so every line emitted while handling a `/mcp` request is
correlated, including the existing per-handler `tool_call` logs, with no
per-handler edit.

Canonical log shape, split across three events. `request_received` (entry:
`request_id`, `method`, bounded `params`, `ip`, `key_hash`, `tier`,
`product`); `request_completed` (response: `response_status`, `latency_ms`);
and the existing per-handler `tool_call` logs (`tool`, `jurisdiction`,
counts). Together they cover the dispatch's canonical field set.

In-process metrics (`src/metrics.ts`). Bounded latency ring buffer plus
running counters: total requests, errors, error rate, p50/p95/p99/max
latency, last-successful-call timestamp, per-tool call counts.

Enriched health endpoint (`src/health.ts`). `GET /health` now returns the
metrics snapshot plus the reachability of each downstream dependency
(engine retrieval API, cortex-api, Postgres, Upstash). Probes are bounded
(2s) and cached 15s. HTTP status stays 200 while the process is alive so the
Cloud Run liveness probe stays green; the body `status` reflects the
dependency rollup so observability still sees `degraded`.

CI gate (`.github/workflows/ci.yml`). Typecheck plus test on every PR and
on push to `main`. Makes the dispatch's "self-merge when CI is green" rule
concrete.

## Decisions (decide-and-document)

Pluggable log sinks over a hard-coded destination switch. The old
`HAUSKA_LOG_DESTINATION` if/else had three TODO branches that all did the
same thing. A sink array with `addLogSink()` is the clean seam for 2C.2.

request_id via AsyncLocalStorage auto-injection, not handler threading.
Editing 40 tool handlers to pass a correlation id is churn and drift risk;
ALS injection is one edit and covers every log line in the request.

params bounded to 2KB in the structured entry log. A verbatim `params` log
would dump base64 IFC uploads into the index. Full payloads belong in the
GCS raw-payload sink (2C.2); the structured index keeps a bounded preview.

Health endpoint returns 200 always. Liveness and dependency health are
different questions. A downstream outage must not flap the Cloud Run
liveness probe, so dependency state lives in the body, not the HTTP status.

## Verification

Typecheck (`tsc --noEmit`) clean. Test suite 211 pass, 0 fail (200 prior +
11 new across logger, metrics, health). Server boots; `server_started`
emits as structured JSON. `POST /mcp` `tools/list` round-trip returns the
40-tool surface and emits `request_received` + `request_completed` with a
matching `request_id` and the full canonical field set. `GET /health`
returns the metrics snapshot and per-dependency health.

## Environment note (flagged for the deploy unit)

Outbound HTTPS to the deployed cortex-api Cloud Run URL fails from this
workstation: `curl` exits 35 (SSL connect error), Node reports
`fetch failed`. github.com is reachable (git fetch and push work). The
health probe correctly and honestly reports cortex-api `down` under this
condition; this is a local egress/TLS artifact, not a code defect, and does
not affect the probe running from inside Cloud Run. Carried into Stream 2D
(deploy and cross-client testing) where real outbound reachability matters.

## Next

Stream 2C.2: Postgres `request_log` index (migration 003) plus the GCS
raw-payload sink, registered via `addLogSink()`.
