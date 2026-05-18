// Structured logger.
//
// Every MCP request and tool call is logged here. The output of this logger
// is the training data corpus over time. Treat it as a first-class data asset.
//
// v1 destination is stdout (good for stdout-collecting platforms like Vercel,
// Cloudflare Workers, or any container runtime forwarding to a log aggregator).
//
// v2 should ship structured logs to a persistent store (Postgres, S3,
// Snowflake, BigQuery) where they can be queried, joined with outcome data,
// and used for fine-tuning or evaluation.

const DESTINATION = process.env.HAUSKA_LOG_DESTINATION ?? "stdout";
const ENV = process.env.HAUSKA_ENV ?? "development";

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  env: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry) {
  const line = JSON.stringify(entry);
  if (DESTINATION === "stdout") {
    // Use stderr so we never collide with stdout-based transports (like stdio).
    // For HTTP transport this also keeps logs out of the response stream.
    console.error(line);
  } else if (DESTINATION === "file") {
    // TODO: replace with a real file appender. For dev only.
    console.error(line);
  } else {
    // TODO: Nick. Plug in your real log destination here (Postgres, S3, etc.).
    console.error(line);
  }
}

export const logger = {
  info(event: string, fields: Record<string, unknown> = {}) {
    emit({ ts: new Date().toISOString(), level: "info", event, env: ENV, ...fields });
  },
  warn(event: string, fields: Record<string, unknown> = {}) {
    emit({ ts: new Date().toISOString(), level: "warn", event, env: ENV, ...fields });
  },
  error(event: string, fields: Record<string, unknown> = {}) {
    emit({ ts: new Date().toISOString(), level: "error", event, env: ENV, ...fields });
  },
};
