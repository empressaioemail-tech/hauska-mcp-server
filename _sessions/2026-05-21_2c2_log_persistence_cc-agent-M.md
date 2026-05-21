---
id: 2026-05-21_2c2_log_persistence
title: cc-agent-M session — Stream 2C.2 log persistence (Postgres index + GCS archive)
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_2c1_observability_foundations]
---

# Stream 2C.2 — log persistence

Second unit of Lane M. Routes the structured log stream to two durable
destinations: a queryable Postgres index and a lossless GCS archive.
Branch `feat/2c2-log-persistence` off `origin/main`.

## What shipped

`request_log` table (`migrations/003_request_log.sql`). One row per /mcp
request: request_id, ts, method, params, ip, key_hash, tier, product,
tool, jurisdiction, atom_ids_returned, response_status, latency_ms,
is_error. Indexed on ts, tool, tier, jurisdiction, key_hash, is_error.
This is the columnar index behind the Stream 2C.3 dashboards. It lives in
the MCP server's own Postgres (the same database as `api_keys`), picked
up automatically by the existing migration runner.

Log sink (`src/log-sink.ts`). Registered via `addLogSink()`. Two
destinations, both fire-and-forget so a sink failure can never break
request handling:

- Postgres: the three request-shaped events (request_received,
  tool_call, request_completed) each upsert their own disjoint column set
  on `request_log`, keyed on request_id. Because the column sets are
  disjoint and every write is an `ON CONFLICT DO UPDATE`, the three async
  writes are order-independent and race-free.
- GCS: every structured entry is buffered and flushed as
  newline-delimited JSON to hour-partitioned objects
  (`mcp-logs/YYYY/MM/DD/HH/...ndjson`). This is the lossless archive and
  training corpus.

GCS writer (`src/gcs-writer.ts`). The concrete `@google-cloud/storage`
implementation, isolated in its own module and dynamic-imported by
index.ts only when `GCS_LOG_BUCKET` is set, so the package stays out of
the default import graph and the unit tests. Auth is ADC, the same path
cortex-api uses for object storage.

Wiring (`src/index.ts`). Production registers the sink at startup
(Postgres always; GCS when `GCS_LOG_BUCKET` is set). Dev mode keeps the
console sink alone. A SIGTERM handler flushes the pending GCS batch so
the tail of the archive survives a Cloud Run instance stop.

## Decisions (decide-and-document)

Upsert-everywhere over insert-then-update. The three request events fire
as independent async writes; an UPDATE that lost the race with its INSERT
would silently drop data. Making every event an `ON CONFLICT DO UPDATE`
over a disjoint column set removes the ordering assumption entirely.

GCS archive = the structured-entry stream, not raw binary bodies. The
entry-level `params` is bounded to 2KB (set in 2C.1) so base64 IFC
uploads never enter the index or the archive. Training data does not want
megabyte base64 blobs; the bounded archive is the honest, useful corpus.
Full-binary-body capture is deliberately out of scope.

GCS package isolated and lazy. `@google-cloud/storage` is a heavy
dependency; confining it to `gcs-writer.ts` behind a dynamic import keeps
it off the hot path and out of every test.

## Verification

Typecheck clean. Test suite 218 pass, 0 fail (211 prior + 7 new): the
`writeRequestLog` SQL composition for all three events, the request-id
guard, the sink's event filtering (only request events reach Postgres),
and the GCS NDJSON batching and auto-flush, all against injected fakes.
Dev-mode boot smoke clean: log-sink module loads, server starts, sink
correctly not registered in dev mode.

Real Postgres and GCS writes are verified at deploy time (Stream 2D),
when `request_log` is migrated into the production database and
`GCS_LOG_BUCKET` is bound. The unit tests cover the composition logic;
the integration is a deploy-phase probe.

## Known follow-up

`request_log.atom_ids_returned` is wired end to end but stays null until
the per-handler `tool_call` logs carry an `atom_ids` field (today they
log `tool`, `jurisdiction`, and a `count`). A focused enrichment of the
five public-catalog handlers' logs is queued for Stream 2C.3, where the
dashboard work makes the atom-id dimension load-bearing.

## Next

Stream 2C.3: Cloud Logging log-based metrics and alert policies, the
dashboard definitions over `request_log`, the training-data export query,
and cost monitoring.
