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
    rateLimitStore: okProbe,
  });
  assert.equal(report.status, "ok");
  assert.equal(report.service, "hauska-mcp-server");
  assert.equal(report.dependencies.engine_retrieval_api.state, "ok");
  assert.equal(report.dependencies.cortex_api.state, "ok");
  assert.equal(report.dependencies.postgres.state, "ok");
  assert.equal(report.dependencies.rate_limit_store.state, "ok");
  assert.ok(report.metrics, "report carries a metrics snapshot");
});

test("buildHealthReport reports degraded when a dependency is down", async () => {
  const report = await buildHealthReport({
    engine: downProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    rateLimitStore: okProbe,
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
// running on the ResilientRateLimitStore per-instance memory fallback â€”
// NOT a benign parked/skipped state. probeUpstash must report "degraded"
// (surfacing in /health status + alerting), never try to reach the
// placeholder host, and never silently report "skipped".
import { probeRateLimitStore } from "../src/health.js";
import {
  getRateLimitRuntimeState,
  setRateLimitRuntimeState,
  type RateLimitRuntimeState,
} from "../src/rate-limit.js";

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

function withRuntime(state: RateLimitRuntimeState, fn: () => Promise<void>): Promise<void> {
  const prev = { ...getRateLimitRuntimeState() };
  setRateLimitRuntimeState(state);
  return fn().finally(() => setRateLimitRuntimeState(prev));
}

test("probeRateLimitStore reports degraded when runtime is on memory fallback", async () => {
  await withEnv({ HAUSKA_DEV_MODE: undefined }, async () => {
    await withRuntime(
      { primaryKind: "memory", memoryFallback: true },
      async () => {
        const r = await probeRateLimitStore();
        assert.equal(r.state, "degraded");
        assert.match(r.detail ?? "", /memory fallback/i);
      },
    );
  });
});

test("probeRateLimitStore still reports skipped in dev mode", async () => {
  await withEnv({ HAUSKA_DEV_MODE: "true" }, async () => {
    const r = await probeRateLimitStore();
    assert.equal(r.state, "skipped");
    assert.match(r.detail ?? "", /dev mode/i);
  });
});

test("buildHealthReport rolls a degraded rate_limit_store dependency up into overall degraded status", async () => {
  const report = await buildHealthReport({
    engine: okProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    rateLimitStore: async () => ({
      state: "degraded",
      latency_ms: null,
      detail: "degraded â€” REPLACE-with placeholder URL, rate-limit on per-instance memory fallback",
    }),
  });
  assert.equal(report.status, "degraded");
  assert.equal(report.dependencies.rate_limit_store.state, "degraded");
});

