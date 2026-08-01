// Health-report tests.
//
// buildHealthReport accepts injected dependency probes so the rollup
// logic is tested without real network or database access.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildHealthReport, type DepHealth } from "../src/health.js";

const okProbe = async (): Promise<DepHealth> => ({ state: "ok", latency_ms: 5 });
const downProbe = async (): Promise<DepHealth> => ({
  state: "down",
  latency_ms: null,
  detail: "connection refused",
});

test("buildHealthReport reports ok when every dependency probe passes", async () => {
  const report = await buildHealthReport({
    engine: okProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    upstash: okProbe,
  });
  assert.equal(report.status, "ok");
  assert.equal(report.service, "hauska-mcp-server");
  assert.equal(report.dependencies.engine_retrieval_api.state, "ok");
  assert.equal(report.dependencies.cortex_api.state, "ok");
  assert.equal(report.dependencies.postgres.state, "ok");
  assert.equal(report.dependencies.upstash.state, "ok");
  assert.ok(report.metrics, "report carries a metrics snapshot");
});

test("buildHealthReport reports degraded when a dependency is down", async () => {
  const report = await buildHealthReport({
    engine: downProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    upstash: okProbe,
  });
  assert.equal(report.status, "degraded");
  assert.equal(report.dependencies.engine_retrieval_api.state, "down");
  assert.equal(
    report.dependencies.engine_retrieval_api.detail,
    "connection refused",
  );
});

// Parked-Upstash honesty: the fluent-magpie instance was decommissioned
// 2026-07-05; the env carries a REPLACE-with placeholder on purpose and
// rate-limiting runs on the ResilientRateLimitStore memory fallback (PR #36).
// probeUpstash must report that parked state as "skipped" (a known, honest,
// non-alarming state), NOT try to reach the placeholder and report "down".
import { probeUpstash } from "../src/health.js";

test("probeUpstash reports parked (skipped) for a REPLACE-with placeholder URL, not down", async () => {
  const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prevDev = process.env.HAUSKA_DEV_MODE;
  process.env.UPSTASH_REDIS_REST_URL = "https://REPLACE-with-upstash-rest-url";
  process.env.UPSTASH_REDIS_REST_TOKEN = "placeholder-token";
  delete process.env.HAUSKA_DEV_MODE;
  try {
    const r = await probeUpstash();
    assert.equal(r.state, "skipped");
    assert.match(r.detail ?? "", /parked|memory fallback/i);
  } finally {
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
    if (prevDev !== undefined) process.env.HAUSKA_DEV_MODE = prevDev;
  }
});
