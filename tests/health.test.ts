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

// Fail-loud degraded mode (76j Workstream C1): a REPLACE-with placeholder
// URL, or Upstash env entirely missing, means the process is silently
// running on the ResilientRateLimitStore per-instance memory fallback —
// NOT a benign parked/skipped state. probeUpstash must report "degraded"
// (surfacing in /health status + alerting), never try to reach the
// placeholder host, and never silently report "skipped".
import { probeUpstash } from "../src/health.js";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(prev)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });
}

test("probeUpstash reports degraded (not skipped) for a REPLACE-with placeholder URL", async () => {
  await withEnv(
    {
      UPSTASH_REDIS_REST_URL: "https://REPLACE-with-upstash-rest-url",
      UPSTASH_REDIS_REST_TOKEN: "placeholder-token",
      HAUSKA_DEV_MODE: undefined,
    },
    async () => {
      const r = await probeUpstash();
      assert.equal(r.state, "degraded");
      assert.match(r.detail ?? "", /degraded/i);
      assert.match(r.detail ?? "", /REPLACE-with|memory fallback/i);
    },
  );
});

test("probeUpstash reports degraded (not skipped) when env is entirely unset", async () => {
  await withEnv(
    {
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      HAUSKA_DEV_MODE: undefined,
    },
    async () => {
      const r = await probeUpstash();
      assert.equal(r.state, "degraded");
      assert.match(r.detail ?? "", /not set/i);
    },
  );
});

test("probeUpstash still reports skipped in dev mode regardless of Upstash config", async () => {
  await withEnv(
    {
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      HAUSKA_DEV_MODE: "true",
    },
    async () => {
      const r = await probeUpstash();
      assert.equal(r.state, "skipped");
      assert.match(r.detail ?? "", /dev mode/i);
    },
  );
});

test("buildHealthReport rolls a degraded upstash dependency up into overall degraded status", async () => {
  const report = await buildHealthReport({
    engine: okProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    upstash: async () => ({
      state: "degraded",
      latency_ms: null,
      detail: "degraded — REPLACE-with placeholder URL, rate-limit on per-instance memory fallback",
    }),
  });
  assert.equal(report.status, "degraded");
  assert.equal(report.dependencies.upstash.state, "degraded");
});
