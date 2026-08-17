// Structured logger.
//
// Every MCP request, response, and tool call is logged here. The log
// stream is two things at once: the Cloud Logging operational record and
// the training-data corpus over time. Treat it as a first-class asset.
//
// Output is line-delimited JSON. Each line carries a `severity` field so
// Google Cloud Logging classifies it correctly when Cloud Run ingests
// the container's stdout/stderr. `info` and `warn` go to stdout; `error`
// goes to stderr.
//
// `request_id` is auto-injected from the request-scoped
// AsyncLocalStorage context, so every line emitted while handling a
// /mcp request is correlated without each call site threading the id.
//
// Sinks are pluggable. The default sink is the console (stdout/stderr).
// Stream 2C.2 registers an additional Postgres-index + GCS-payload sink
// at startup via addLogSink().

import { getCurrentRequestId } from "./request-context.js";

const ENV = process.env.HAUSKA_ENV ?? "development";

export type LogLevel = "info" | "warn" | "error";

// Maps our level to a Google Cloud Logging LogSeverity string. Cloud
// Logging honors a `severity` field embedded in the JSON payload.
const SEVERITY: Record<LogLevel, string> = {
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

export interface LogEntry {
  ts: string;
  severity: string;
  level: LogLevel;
  event: string;
  env: string;
  request_id?: string;
  [key: string]: unknown;
}

// A sink receives every emitted entry. Sinks must not throw; emit()
// guards them anyway as a last backstop.
export type LogSink = (entry: LogEntry) => void;

function consoleSink(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

const sinks: LogSink[] = [consoleSink];

/**
 * Register an additional log sink. Called once at startup by the
 * Postgres + GCS log sink (Stream 2C.2). Idempotent registration is the
 * caller's responsibility.
 */
export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

function withoutPresentedKey(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(fields, "presented_key")) {
    return fields;
  }
  const rest = { ...fields };
  delete rest.presented_key;
  return rest;
}

function emit(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
): void {
  const requestId = getCurrentRequestId();
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    severity: SEVERITY[level],
    level,
    event,
    env: ENV,
    ...(requestId ? { request_id: requestId } : {}),
    ...withoutPresentedKey(fields),
  };
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // A sink failure must never break request handling. The console
      // sink is synchronous and effectively cannot throw; a remote sink
      // is expected to swallow its own errors. This is the last backstop.
    }
  }
}

export const logger = {
  info(event: string, fields: Record<string, unknown> = {}): void {
    emit("info", event, fields);
  },
  warn(event: string, fields: Record<string, unknown> = {}): void {
    emit("warn", event, fields);
  },
  error(event: string, fields: Record<string, unknown> = {}): void {
    emit("error", event, fields);
  },
};
