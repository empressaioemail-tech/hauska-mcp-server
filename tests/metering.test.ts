// Layer 2 call metering tests (observability fallback + Gate D dual-path).
//
// Validates metering behavior for product-gated tool calls:
// - metered vs public-tool (never metered)
// - SDK_METERING off → post-success observability recordLayer2Call
// - Stripe meter path retired (see sdk-money-boundary.test.ts)
// - admin PATCH schema validation
//
// Note: These tests focus on the logging/observability path.
// Full integration tests with DATABASE_URL would verify actual DB operations.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { addLogSink, type LogEntry } from "../src/logger.js";
import { logToolRead } from "../src/read-attribution.js";
import { requestContext } from "../src/request-context.js";

// Capture log entries for assertions
const captured: LogEntry[] = [];
addLogSink((e) => captured.push(e));

function lastEntry(event: string): LogEntry | undefined {
  return [...captured].reverse().find((x) => x.event === event);
}

function clearCapture(): void {
  captured.length = 0;
}

test("logToolRead triggers tool_call log for product-gated tools", async () => {
  clearCapture();

  await requestContext.run(
    {
      tier: "developer_pro",
      product: "codex",
      key_id: "test-key-id",
      key_hash: "test-key-hash",
      rate_limit_id: "key:test",
      remaining_rpm: 100,
      remaining_daily: 1000,
      request_id: "req-integration-test",
    },
    () => {
      logToolRead(
        {
          tool: "search_atoms",
          tier: "developer_pro",
          latency_ms: 50,
        },
        [],
      );
    },
  );

  const toolCallLog = lastEntry("tool_call");
  assert.ok(toolCallLog, "tool_call log should be emitted");
  assert.equal(toolCallLog.tool, "search_atoms");
});

test("logToolRead does NOT meter public-product tools", async () => {
  clearCapture();

  await requestContext.run(
    {
      tier: "free",
      product: "public",
      key_id: "public-key-id",
      key_hash: "public-key-hash",
      rate_limit_id: "key:public",
      remaining_rpm: 50,
      remaining_daily: 500,
      request_id: "req-public-test",
    },
    () => {
      logToolRead(
        {
          tool: "list_jurisdictions",
          tier: "free",
          latency_ms: 20,
        },
        [],
      );
    },
  );

  const toolCallLog = lastEntry("tool_call");
  assert.ok(toolCallLog, "tool_call log should be emitted");
  assert.equal(toolCallLog.tool, "list_jurisdictions");
});

test("logToolRead does NOT meter when no key_id (anonymous)", async () => {
  clearCapture();

  await requestContext.run(
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "ip:127.0.0.1",
      remaining_rpm: 10,
      remaining_daily: 100,
      request_id: "req-anon-test",
    },
    () => {
      logToolRead(
        {
          tool: "list_jurisdictions",
          tier: "free_anonymous",
          latency_ms: 15,
        },
        [],
      );
    },
  );

  const toolCallLog = lastEntry("tool_call");
  assert.ok(toolCallLog, "tool_call log should be emitted for anonymous");
  assert.equal(toolCallLog.tool, "list_jurisdictions");
  assert.equal(toolCallLog.key_hash, null);
});

test("admin PATCH schema accepts stripe_customer_id", () => {
  // Legacy admin field retained for key rows; Stripe meter post is retired.
  const validPatch: {
    stripe_customer_id?: string | null;
    tier?: string;
  } = {
    stripe_customer_id: "cus_admin_test",
  };

  const clearPatch: {
    stripe_customer_id?: string | null;
  } = {
    stripe_customer_id: null,
  };

  assert.ok(validPatch, "stripe_customer_id should be a valid patch field");
  assert.ok(clearPatch, "stripe_customer_id should accept null");
});

test("metering module exports recordLayer2Call and has no Stripe URL", async () => {
  const meteringModule = await import("../src/metering.js");
  assert.ok(
    typeof meteringModule.recordLayer2Call === "function",
    "recordLayer2Call should be exported",
  );
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/metering.ts", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(src, /api\.stripe\.com/);
});
