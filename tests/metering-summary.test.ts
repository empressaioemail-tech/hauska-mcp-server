// DB-free unit tests for GET /metering/summary (A4c).
//
// The handler's auth and param branches return before any DB access, so
// they are tested by invoking the handler directly with a stubbed req/res.
// The aggregation logic is a pure exported function tested on fixture rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  getMeteringSummary,
  aggregateMeteringRows,
} from "../src/metering-summary.js";

function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      if (captured.status === undefined) captured.status = 200;
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

function fakeReq(opts: {
  hauska?: Record<string, unknown> | undefined;
  days?: string;
}): Request {
  return {
    hauska: opts.hauska,
    query: opts.days === undefined ? {} : { days: opts.days },
  } as unknown as Request;
}

const INTERNAL_CTX = {
  key_id: "test-key",
  key_hash: "hash",
  tier: "team",
  product: "reporting",
  platform_internal: true,
};

test("anonymous request returns 401", async () => {
  const { res, captured } = fakeRes();
  await getMeteringSummary(fakeReq({ hauska: undefined }), res);
  assert.equal(captured.status, 401);
  assert.deepEqual(captured.body, { error: "authentication_required" });
});

test("non-internal key returns 403", async () => {
  const { res, captured } = fakeRes();
  await getMeteringSummary(
    fakeReq({ hauska: { ...INTERNAL_CTX, platform_internal: false } }),
    res,
  );
  assert.equal(captured.status, 403);
  assert.deepEqual(captured.body, { error: "platform_internal_required" });
});

for (const bad of ["0", "32", "banana", "-3", "1.5"]) {
  test(`days=${bad} returns 400`, async () => {
    const { res, captured } = fakeRes();
    await getMeteringSummary(
      fakeReq({ hauska: INTERNAL_CTX, days: bad }),
      res,
    );
    assert.equal(captured.status, 400);
    assert.equal(
      (captured.body as { error: string }).error,
      "invalid_days_parameter",
    );
  });
}

// ── pure aggregation ────────────────────────────────────────────────

const NOW = new Date("2026-07-07T15:00:00.000Z");

test("aggregation: totals passthrough with authorized/unauthorized split", () => {
  const out = aggregateMeteringRows(
    { total: "10", authorized: "3", unauthorized: "7" },
    [],
    7,
    NOW,
  );
  assert.deepEqual(out.totals, { layer2Calls: 10, authorized: 3, unauthorized: 7 });
  assert.equal(out.windowDays, 7);
  assert.equal("billed" in out.totals, false);
  assert.equal("unbilled" in out.totals, false);
});

test("authorized calls with no billing record are not a revenue figure", () => {
  const out = aggregateMeteringRows(
    { total: "5", authorized: "5", unauthorized: "0" },
    [],
    7,
    NOW,
  );
  assert.equal(out.totals.authorized, 5);
  const body = JSON.parse(JSON.stringify(out)) as {
    totals: Record<string, number>;
    revenue?: unknown;
    billed?: unknown;
  };
  assert.equal(body.totals.billed, undefined);
  assert.equal(body.revenue, undefined);
  assert.equal(body.billed, undefined);
});

test("aggregation: undefined totals row yields zeros", () => {
  const out = aggregateMeteringRows(undefined, [], 7, NOW);
  assert.deepEqual(out.totals, { layer2Calls: 0, authorized: 0, unauthorized: 0 });
});

test("aggregation: zero-fills the full window ascending", () => {
  const out = aggregateMeteringRows(
    { total: "0", authorized: "0", unauthorized: "0" },
    [],
    3,
    NOW,
  );
  assert.equal(out.days.length, 3);
  assert.deepEqual(
    out.days.map((d) => d.date),
    ["2026-07-05", "2026-07-06", "2026-07-07"],
  );
  for (const d of out.days) {
    assert.equal(d.layer2Calls, 0);
    assert.deepEqual(d.byProduct, {});
    assert.deepEqual(d.byTool, {});
  }
});

test("aggregation: byProduct and byTool group and sum per day", () => {
  const out = aggregateMeteringRows(
    { total: "6", authorized: "0", unauthorized: "6" },
    [
      { date: "2026-07-06", product: "map", tool: "assemble_map_layers", count: "2" },
      { date: "2026-07-06", product: "map", tool: "get_hazard_profile", count: "1" },
      { date: "2026-07-06", product: "reporting", tool: "search_encumbrances", count: "1" },
      { date: "2026-07-07", product: "codex", tool: "codex_finding_generation", count: "2" },
    ],
    3,
    NOW,
  );
  const d6 = out.days.find((d) => d.date === "2026-07-06")!;
  assert.equal(d6.layer2Calls, 4);
  assert.deepEqual(d6.byProduct, { map: 3, reporting: 1 });
  assert.deepEqual(d6.byTool, {
    assemble_map_layers: 2,
    get_hazard_profile: 1,
    search_encumbrances: 1,
  });
  const d7 = out.days.find((d) => d.date === "2026-07-07")!;
  assert.equal(d7.layer2Calls, 2);
  assert.deepEqual(d7.byProduct, { codex: 2 });
  // 2026-07-05 zero-filled
  const d5 = out.days.find((d) => d.date === "2026-07-05")!;
  assert.equal(d5.layer2Calls, 0);
});
