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
