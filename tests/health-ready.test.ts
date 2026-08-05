import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test } from "node:test";

import express, { type RequestHandler } from "express";

import {
  buildReadinessReport,
  readinessHttpStatus,
} from "../src/health-ready.js";
import {
  createHealthHandler,
  createReadinessHandler,
} from "../src/health-routes.js";
import type { DepHealth, HealthReport } from "../src/health.js";

const okProbe = async (): Promise<DepHealth> => ({ state: "ok", latency_ms: 5 });
const downProbe = async (): Promise<DepHealth> => ({
  state: "down",
  latency_ms: null,
  detail: "connection refused",
});
const skippedProbe = async (): Promise<DepHealth> => ({
  state: "skipped",
  latency_ms: null,
  detail: "parked",
});
const degradedProbe = async (): Promise<DepHealth> => ({
  state: "degraded",
  latency_ms: 5,
  detail: "HTTP 503",
});

async function getRoute(
  path: string,
  handler: RequestHandler,
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.get(path, handler);
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("GET /health/ready returns 503 when engine/retrieval is down", async () => {
  const report = await buildReadinessReport({
    engine: downProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    rateLimitStore: okProbe,
  });
  const response = await getRoute(
    "/health/ready",
    createReadinessHandler(async () => report),
  );

  assert.equal(report.status, "not_ready");
  assert.equal(readinessHttpStatus(report), 503);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, report);
});

test("GET /health/ready returns 503 when Postgres is down", async () => {
  const report = await buildReadinessReport({
    engine: okProbe,
    cortexApi: okProbe,
    postgres: downProbe,
    rateLimitStore: okProbe,
  });
  const response = await getRoute(
    "/health/ready",
    createReadinessHandler(async () => report),
  );

  assert.equal(report.status, "not_ready");
  assert.equal(response.status, 503);
});

test("GET /health/ready returns 200 when only rate_limit_store is skipped", async () => {
  const report = await buildReadinessReport({
    engine: okProbe,
    cortexApi: okProbe,
    postgres: okProbe,
    rateLimitStore: skippedProbe,
  });
  const response = await getRoute(
    "/health/ready",
    createReadinessHandler(async () => report),
  );

  assert.equal(report.status, "ready");
  assert.equal(readinessHttpStatus(report), 200);
  assert.equal(response.status, 200);
});

test("GET /health/ready stays 200 for degraded or non-critical dependencies", async () => {
  const report = await buildReadinessReport({
    engine: degradedProbe,
    cortexApi: downProbe,
    postgres: okProbe,
    rateLimitStore: skippedProbe,
  });
  const response = await getRoute(
    "/health/ready",
    createReadinessHandler(async () => report),
  );

  assert.equal(report.status, "ready");
  assert.equal(response.status, 200);
});

test("GET /health remains HTTP 200 when its body is degraded", async () => {
  const degradedReport: HealthReport = {
    status: "degraded",
    service: "hauska-mcp-server",
    version: "0.1.0",
    env: "test",
    metrics: {
      started_at: "2026-08-01T00:00:00.000Z",
      uptime_s: 0,
      total_requests: 0,
      total_errors: 0,
      error_rate: 0,
      last_successful_call: null,
      latency: {
        count: 0,
        p50_ms: null,
        p95_ms: null,
        p99_ms: null,
        max_ms: null,
      },
      tool_calls: {},
    },
    dependencies: {
      engine_retrieval_api: await downProbe(),
      cortex_api: await okProbe(),
      postgres: await okProbe(),
      rateLimitStore: await skippedProbe(),
    },
  };
  const response = await getRoute(
    "/health",
    createHealthHandler(async () => degradedReport),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, degradedReport);
});


