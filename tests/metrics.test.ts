// In-process metrics tests.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { metrics } from "../src/metrics.js";

test("metrics records requests, errors, and error rate", () => {
  metrics.reset();
  for (let i = 1; i <= 10; i++) metrics.recordRequest(i * 10, i !== 10);
  const s = metrics.snapshot();
  assert.equal(s.total_requests, 10);
  assert.equal(s.total_errors, 1);
  assert.equal(s.error_rate, 0.1);
  assert.ok(s.last_successful_call !== null);
});

test("metrics computes latency percentiles over the ring buffer", () => {
  metrics.reset();
  for (let i = 1; i <= 100; i++) metrics.recordRequest(i, true);
  const s = metrics.snapshot();
  assert.equal(s.latency.count, 100);
  assert.equal(s.latency.max_ms, 100);
  assert.ok(
    s.latency.p50_ms !== null && s.latency.p50_ms >= 40 && s.latency.p50_ms <= 60,
    `p50 ${s.latency.p50_ms} should sit mid-range`,
  );
  assert.ok(
    s.latency.p99_ms !== null && s.latency.p99_ms >= 95,
    `p99 ${s.latency.p99_ms} should sit near the top`,
  );
});

test("metrics latency stats are null before any request", () => {
  metrics.reset();
  const s = metrics.snapshot();
  assert.equal(s.latency.count, 0);
  assert.equal(s.latency.p50_ms, null);
  assert.equal(s.latency.max_ms, null);
  assert.equal(s.error_rate, 0);
  assert.equal(s.last_successful_call, null);
});

test("metrics records tool-call counts by name", () => {
  metrics.reset();
  metrics.recordToolCall("search_atoms");
  metrics.recordToolCall("search_atoms");
  metrics.recordToolCall("get_atom");
  const s = metrics.snapshot();
  assert.equal(s.tool_calls["search_atoms"], 2);
  assert.equal(s.tool_calls["get_atom"], 1);
});
