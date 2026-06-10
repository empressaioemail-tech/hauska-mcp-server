// ADR-005 open-decision input: measure accessPolicy check overhead.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { canReadAccessTarget } from "../src/access-policy.js";

const ITERATIONS = 50_000;

test("accessPolicy enforcement latency baseline", () => {
  const subject = {
    tier: "developer_pro" as const,
    jurisdictionTenant: "mox-living",
    platformInternal: false,
  };
  const target = {
    accessPolicy: "tenant-private" as const,
    jurisdictionTenant: "mox-living",
  };

  const warmupStart = performance.now();
  for (let i = 0; i < 1_000; i++) {
    canReadAccessTarget(subject, target);
  }
  const warmupMs = performance.now() - warmupStart;

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    canReadAccessTarget(subject, target);
  }
  const elapsedMs = performance.now() - start;
  const perCheckNs = (elapsedMs / ITERATIONS) * 1_000_000;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: "access_policy_latency_baseline",
      iterations: ITERATIONS,
      warmup_ms: Number(warmupMs.toFixed(3)),
      elapsed_ms: Number(elapsedMs.toFixed(3)),
      per_check_ns: Number(perCheckNs.toFixed(1)),
      per_check_us: Number((perCheckNs / 1000).toFixed(3)),
    }),
  );

  assert.ok(perCheckNs < 50_000, `per-check latency too high: ${perCheckNs}ns`);
});
