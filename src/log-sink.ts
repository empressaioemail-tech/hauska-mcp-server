// Structured-log sink: Postgres request_log index + GCS payload archive.
//
// Registered via addLogSink() at startup (production only; dev mode keeps
// the console sink alone). Two destinations:
//
//   - Postgres request_log: one row per /mcp request, composed from the
//     request_received / tool_call / request_completed events. Each event
//     upserts its own columns keyed on request_id, so the writes are
//     order-independent and race-free. This is the queryable index behind
//     the Stream 2C.3 dashboards.
//
//   - GCS: the full structured-log stream, batched as newline-delimited
//     JSON objects. This is the lossless archive and training corpus.
//
// Both destinations are fire-and-forget. A sink failure must never break
// request handling, so every write swallows its own error after emitting
// one console line. The sink does NOT call logger.* on failure: that
// would re-enter this sink and could loop.

import { randomUUID } from "node:crypto";

import { getPool } from "./db.js";
import type { LogEntry, LogSink } from "./logger.js";

// --- GCS writer abstraction -------------------------------------------
// The concrete implementation (src/gcs-writer.ts) is loaded only when GCS
// logging is enabled, so @google-cloud/storage stays out of the default
// import graph and out of the unit tests.

export interface GcsWriter {
  write(objectPath: string, body: string, contentType: string): Promise<void>;
}

// --- Postgres request_log index ---------------------------------------

export type QueryFn = (text: string, values?: unknown[]) => Promise<unknown>;

function defaultQuery(): QueryFn {
  return (text, values) =>
    getPool().query(text, (values ?? []) as unknown[]);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : null;
}

// True for the three events that compose a request_log row.
function isRequestEvent(event: string): boolean {
  return (
    event === "request_received" ||
    event === "tool_call" ||
    event === "request_completed"
  );
}

/**
 * Upsert the request_log columns owned by a single log event. Exported
 * for direct unit testing of the SQL composition. Each event touches a
 * disjoint column set, so concurrent upserts for one request_id never
 * clobber each other.
 */
export async function writeRequestLog(
  query: QueryFn,
  entry: LogEntry,
): Promise<void> {
  const requestId = entry.request_id;
  if (typeof requestId !== "string") return;

  if (entry.event === "request_received") {
    await query(
      `INSERT INTO request_log
         (request_id, ts, method, params, ip, key_hash, tier, product)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (request_id) DO UPDATE SET
         ts = EXCLUDED.ts, method = EXCLUDED.method, params = EXCLUDED.params,
         ip = EXCLUDED.ip, key_hash = EXCLUDED.key_hash,
         tier = EXCLUDED.tier, product = EXCLUDED.product`,
      [
        requestId,
        asString(entry.ts) ?? new Date().toISOString(),
        asString(entry.method),
        asJson(entry.params),
        asString(entry.ip),
        asString(entry.key_hash),
        asString(entry.tier),
        asString(entry.product),
      ],
    );
    return;
  }

  if (entry.event === "tool_call") {
    await query(
      `INSERT INTO request_log
         (request_id, tool, jurisdiction, atom_ids_returned)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_id) DO UPDATE SET
         tool = COALESCE(EXCLUDED.tool, request_log.tool),
         jurisdiction =
           COALESCE(EXCLUDED.jurisdiction, request_log.jurisdiction),
         atom_ids_returned =
           COALESCE(EXCLUDED.atom_ids_returned, request_log.atom_ids_returned)`,
      [
        requestId,
        asString(entry.tool),
        asString(entry.jurisdiction),
        asStringArray(entry.atom_ids),
      ],
    );
    return;
  }

  if (entry.event === "request_completed") {
    const status = asNumber(entry.response_status);
    await query(
      `INSERT INTO request_log
         (request_id, response_status, latency_ms, is_error)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_id) DO UPDATE SET
         response_status = EXCLUDED.response_status,
         latency_ms = EXCLUDED.latency_ms,
         is_error = EXCLUDED.is_error`,
      [requestId, status, asNumber(entry.latency_ms), status !== null && status >= 500],
    );
  }
}

// --- GCS object naming ------------------------------------------------

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

// Hour-partitioned object path so the archive is cheap to scan by time
// window and to apply a GCS lifecycle rule against.
function gcsObjectPath(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `mcp-logs/${yyyy}/${mm}/${dd}/${hh}/${stamp}-${randomUUID().slice(0, 8)}.ndjson`;
}

function sinkError(event: string, err: unknown): void {
  // Direct console write, NOT logger.* — calling the logger here would
  // re-enter this sink.
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      severity: "ERROR",
      level: "error",
      event,
      error: String(err).slice(0, 300),
    }),
  );
}

// --- Sink factory -----------------------------------------------------

export interface LogSinkConfig {
  /** Postgres query function. Defaults to the shared pg pool. */
  query?: QueryFn;
  /** GCS writer. Null (default) disables the GCS archive. */
  gcs?: GcsWriter | null;
  /** Flush the GCS buffer once it reaches this many entries. */
  batchSize?: number;
  /** Periodic GCS flush interval. 0 disables the timer (tests). */
  flushIntervalMs?: number;
}

export interface LogSinkHandle {
  sink: LogSink;
  /** Flush the pending GCS batch now. */
  flush: () => Promise<void>;
  /** Resolve once every in-flight Postgres write has settled (tests). */
  drain: () => Promise<void>;
  /** Stop the periodic flush timer. */
  stop: () => void;
}

export function createLogSink(config: LogSinkConfig = {}): LogSinkHandle {
  const query = config.query ?? defaultQuery();
  const gcs = config.gcs ?? null;
  const batchSize = config.batchSize ?? 100;
  const flushIntervalMs = config.flushIntervalMs ?? 30_000;

  const buffer: LogEntry[] = [];
  const pending: Promise<void>[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  async function flush(): Promise<void> {
    if (!gcs || buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const ndjson = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    try {
      await gcs.write(
        gcsObjectPath(new Date()),
        ndjson,
        "application/x-ndjson",
      );
    } catch (err) {
      sinkError("log_sink_gcs_error", err);
    }
  }

  const sink: LogSink = (entry) => {
    // Postgres index: only the three request-shaped events.
    if (isRequestEvent(entry.event)) {
      const p = writeRequestLog(query, entry).catch((err) =>
        sinkError("log_sink_pg_error", err),
      );
      pending.push(p);
      // Keep the pending list bounded; settled promises can be dropped.
      if (pending.length > 1_000) pending.splice(0, pending.length - 1_000);
    }
    // GCS archive: every entry.
    if (gcs) {
      buffer.push(entry);
      if (buffer.length >= batchSize) void flush();
    }
  };

  if (gcs && flushIntervalMs > 0) {
    timer = setInterval(() => void flush(), flushIntervalMs);
    timer.unref?.();
  }

  return {
    sink,
    flush,
    drain: async () => {
      await Promise.allSettled(pending);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
