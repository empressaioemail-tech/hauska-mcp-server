// Structured-logger tests.
//
// Verifies the canonical log shape, Cloud Logging severity mapping, and
// request_id auto-injection from the request-scoped context.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { addLogSink, logger, type LogEntry } from "../src/logger.js";
import { requestContext } from "../src/request-context.js";

// Register a capturing sink once. Each test filters by its own unique
// event name, so accumulation across tests is harmless.
const captured: LogEntry[] = [];
addLogSink((e) => captured.push(e));

function lastEntry(event: string): LogEntry {
  const e = [...captured].reverse().find((x) => x.event === event);
  assert.ok(e, `expected a log entry for event "${event}"`);
  return e;
}

test("logger.info emits a canonical INFO entry", () => {
  logger.info("logger_test_info", { foo: "bar" });
  const e = lastEntry("logger_test_info");
  assert.equal(e.level, "info");
  assert.equal(e.severity, "INFO");
  assert.equal(e.event, "logger_test_info");
  assert.equal(e.foo, "bar");
  assert.ok(typeof e.ts === "string" && e.ts.length > 0);
  assert.ok(typeof e.env === "string" && e.env.length > 0);
});

test("logger.error maps to ERROR severity", () => {
  logger.error("logger_test_error", {});
  assert.equal(lastEntry("logger_test_error").severity, "ERROR");
});

test("logger.warn maps to WARNING severity", () => {
  logger.warn("logger_test_warn", {});
  assert.equal(lastEntry("logger_test_warn").severity, "WARNING");
});

test("request_id is auto-injected from the request context", () => {
  requestContext.run(
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "ip:test",
      remaining_rpm: -1,
      remaining_daily: -1,
      request_id: "req-test-abc",
    },
    () => {
      logger.info("logger_test_with_ctx", {});
    },
  );
  assert.equal(lastEntry("logger_test_with_ctx").request_id, "req-test-abc");
});

test("no request_id field is set outside the request context", () => {
  logger.info("logger_test_no_ctx", {});
  assert.equal(lastEntry("logger_test_no_ctx").request_id, undefined);
});
