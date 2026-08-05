// /healthz normalized payload tests.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildHealthzReport, revisionFromEnv } from "../src/healthz.js";
import type { DepHealth } from "../src/health.js";

const okProbe = async (): Promise<DepHealth> => ({ state: "ok", latency_ms: 5 });
const downProbe = async (): Promise<DepHealth> => ({
  state: "down",
  latency_ms: null,
  detail: "connection refused",
});

test("buildHealthzReport returns status deps revision shape", async () => {
  const prev = process.env.K_REVISION;
  process.env.K_REVISION = "hauska-mcp-server-test-rev";
  try {
    const report = await buildHealthzReport({
      engine: okProbe,
      cortexApi: okProbe,
      postgres: okProbe,
      rateLimitStore: okProbe,
    });
    assert.equal(report.status, "ok");
    assert.equal(report.deps.retrieval_api, "ok");
    assert.equal(report.deps.legacy_backend, "ok");
    assert.equal(report.revision, "hauska-mcp-server-test-rev");
  } finally {
    if (prev === undefined) delete process.env.K_REVISION;
    else process.env.K_REVISION = prev;
  }
});

test("buildHealthzReport rolls up degraded when retrieval-api is down", async () => {
  const report = await buildHealthzReport({
    engine: downProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    rateLimitStore: okProbe,
  });
  assert.equal(report.status, "degraded");
  assert.equal(report.deps.retrieval_api, "down");
});

test("revisionFromEnv falls back to local", () => {
  const prev = process.env.K_REVISION;
  delete process.env.K_REVISION;
  try {
    assert.equal(revisionFromEnv(), "local");
  } finally {
    if (prev !== undefined) process.env.K_REVISION = prev;
  }
});

