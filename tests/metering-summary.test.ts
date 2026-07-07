// /metering/summary endpoint tests (A4c).
//
// Validates the metering summary aggregation endpoint:
// - Auth matrix: anon 401, non-internal 403, internal 200
// - Days parameter validation (0, 32, garbage → 400)
// - Aggregation correctness (zero-fill, byProduct/byTool grouping, billed/unbilled split)

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getPool } from "../src/db.js";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

interface MeteringSummaryResponse {
  windowDays: number;
  totals: {
    layer2Calls: number;
    billed: number;
    unbilled: number;
  };
  days: Array<{
    date: string;
    layer2Calls: number;
    byProduct: Record<string, number>;
    byTool: Record<string, number>;
  }>;
}

// Helper to call the endpoint
async function getMeteringSummary(
  apiKey: string | null,
  days?: number,
): Promise<Response> {
  const url = new URL("/metering/summary", BASE_URL);
  if (days !== undefined) {
    url.searchParams.set("days", String(days));
  }
  const headers: HeadersInit = {};
  if (apiKey) {
    headers["x-hauska-key"] = apiKey;
  }
  return fetch(url, { headers });
}

// Helper to seed metering_events rows (requires DATABASE_URL)
async function seedMeteringEvents(
  events: Array<{
    keyId: string;
    keyHash: string;
    product: string;
    tier: string;
    tool: string;
    requestId: string;
    billed: boolean;
    ts?: string;
  }>,
): Promise<void> {
  const pool = getPool();
  for (const e of events) {
    await pool.query(
      `INSERT INTO metering_events
         (key_id, key_hash, product, tier, tool, request_id, billed, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        e.keyId,
        e.keyHash,
        e.product,
        e.tier,
        e.tool,
        e.requestId,
        e.billed,
        e.ts ?? new Date().toISOString(),
      ],
    );
  }
}

// Helper to clean up test data
async function cleanupMeteringEvents(keyIds: string[]): Promise<void> {
  const pool = getPool();
  for (const keyId of keyIds) {
    await pool.query("DELETE FROM metering_events WHERE key_id = $1", [keyId]);
  }
}

test("GET /metering/summary — anonymous request returns 401", async () => {
  const res = await getMeteringSummary(null);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "authentication_required");
});

test("GET /metering/summary — non-internal key returns 403", async () => {
  // This test requires a test key that is NOT platform_internal.
  // In a real environment, you'd seed one via the admin endpoint.
  // For now, we test the logic with dev mode or skip if DATABASE_URL is unset.
  const testKey = process.env.TEST_NON_INTERNAL_KEY;
  if (!testKey) {
    console.log(
      "Skipping non-internal auth test (TEST_NON_INTERNAL_KEY not set)",
    );
    return;
  }

  const res = await getMeteringSummary(testKey);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "platform_internal_required");
});

test("GET /metering/summary — platform_internal key returns 200", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey) {
    console.log("Skipping internal auth test (TEST_INTERNAL_KEY not set)");
    return;
  }

  const res = await getMeteringSummary(testKey);
  assert.equal(res.status, 200);
  const body: MeteringSummaryResponse = await res.json();
  assert.ok(body.windowDays);
  assert.ok(body.totals);
  assert.ok(Array.isArray(body.days));
});

test("GET /metering/summary — days=0 returns 400", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey) {
    console.log("Skipping days=0 test (TEST_INTERNAL_KEY not set)");
    return;
  }

  const res = await getMeteringSummary(testKey, 0);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_days_parameter");
});

test("GET /metering/summary — days=32 returns 400", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey) {
    console.log("Skipping days=32 test (TEST_INTERNAL_KEY not set)");
    return;
  }

  const res = await getMeteringSummary(testKey, 32);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_days_parameter");
});

test("GET /metering/summary — garbage days param returns 400", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey) {
    console.log("Skipping garbage days test (TEST_INTERNAL_KEY not set)");
    return;
  }

  const url = new URL("/metering/summary", BASE_URL);
  url.searchParams.set("days", "garbage");
  const res = await fetch(url, {
    headers: { "x-hauska-key": testKey },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_days_parameter");
});

test("GET /metering/summary — aggregates billed and unbilled correctly", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey || !process.env.DATABASE_URL) {
    console.log("Skipping aggregation test (TEST_INTERNAL_KEY or DATABASE_URL not set)");
    return;
  }

  // Seed test data: 3 billed, 2 unbilled
  const testKeyId = "test-agg-key";
  const now = new Date();
  await seedMeteringEvents([
    {
      keyId: testKeyId,
      keyHash: "hash1",
      product: "codex",
      tier: "developer_pro",
      tool: "search_atoms",
      requestId: "req-1",
      billed: true,
      ts: new Date(now.getTime() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
    },
    {
      keyId: testKeyId,
      keyHash: "hash1",
      product: "codex",
      tier: "developer_pro",
      tool: "get_atom",
      requestId: "req-2",
      billed: true,
      ts: new Date(now.getTime() - 1000 * 60 * 60 * 24).toISOString(),
    },
    {
      keyId: testKeyId,
      keyHash: "hash1",
      product: "reporting",
      tier: "developer_pro",
      tool: "summarize_land_deal",
      requestId: "req-3",
      billed: true,
      ts: new Date(now.getTime() - 1000 * 60 * 60 * 12).toISOString(), // 12 hours ago
    },
    {
      keyId: testKeyId,
      keyHash: "hash1",
      product: "codex",
      tier: "free",
      tool: "search_atoms",
      requestId: "req-4",
      billed: false,
      ts: new Date(now.getTime() - 1000 * 60 * 60 * 12).toISOString(),
    },
    {
      keyId: testKeyId,
      keyHash: "hash1",
      product: "reporting",
      tier: "free",
      tool: "summarize_land_deal",
      requestId: "req-5",
      billed: false,
      ts: new Date(now.getTime() - 1000 * 60 * 30).toISOString(), // 30 minutes ago
    },
  ]);

  try {
    const res = await getMeteringSummary(testKey, 7);
    assert.equal(res.status, 200);
    const body: MeteringSummaryResponse = await res.json();

    assert.equal(body.windowDays, 7);
    assert.equal(body.totals.layer2Calls, 5);
    assert.equal(body.totals.billed, 3);
    assert.equal(body.totals.unbilled, 2);

    // Verify days array is zero-filled (7 days)
    assert.equal(body.days.length, 7);

    // Check that the days with data have correct aggregations
    const daysWithData = body.days.filter((d) => d.layer2Calls > 0);
    assert.ok(daysWithData.length >= 2, "Should have at least 2 days with data");

    // Find today's data
    const today = now.toISOString().split("T")[0]!;
    const todayData = body.days.find((d) => d.date === today);
    assert.ok(todayData, "Today should have data");
    assert.equal(todayData.layer2Calls, 2); // 2 calls today (12 hours ago + 30 mins ago)
    assert.equal(todayData.byProduct.codex, 1);
    assert.equal(todayData.byProduct.reporting, 1);
    assert.equal(todayData.byTool.search_atoms, 1);
    assert.equal(todayData.byTool.summarize_land_deal, 1);
  } finally {
    await cleanupMeteringEvents([testKeyId]);
  }
});

test("GET /metering/summary — zero-fills empty days", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey || !process.env.DATABASE_URL) {
    console.log("Skipping zero-fill test (TEST_INTERNAL_KEY or DATABASE_URL not set)");
    return;
  }

  // Seed one event 5 days ago
  const testKeyId = "test-zero-fill-key";
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 5);
  await seedMeteringEvents([
    {
      keyId: testKeyId,
      keyHash: "hash2",
      product: "map",
      tier: "developer_pro",
      tool: "search_zoning_ordinances",
      requestId: "req-zero-1",
      billed: true,
      ts: fiveDaysAgo.toISOString(),
    },
  ]);

  try {
    const res = await getMeteringSummary(testKey, 7);
    assert.equal(res.status, 200);
    const body: MeteringSummaryResponse = await res.json();

    assert.equal(body.windowDays, 7);
    assert.equal(body.days.length, 7);

    // Count days with zero calls
    const zeroDays = body.days.filter((d) => d.layer2Calls === 0);
    assert.ok(zeroDays.length >= 6, "Should have at least 6 days with zero calls");

    // Verify the day with data
    const fiveDaysAgoStr = fiveDaysAgo.toISOString().split("T")[0]!;
    const dataDay = body.days.find((d) => d.date === fiveDaysAgoStr);
    assert.ok(dataDay, "5 days ago should have data");
    assert.equal(dataDay.layer2Calls, 1);
    assert.equal(dataDay.byProduct.map, 1);
    assert.equal(dataDay.byTool.search_zoning_ordinances, 1);
  } finally {
    await cleanupMeteringEvents([testKeyId]);
  }
});

test("GET /metering/summary — byProduct groups correctly", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey || !process.env.DATABASE_URL) {
    console.log("Skipping byProduct test (TEST_INTERNAL_KEY or DATABASE_URL not set)");
    return;
  }

  const testKeyId = "test-by-product-key";
  const now = new Date();
  await seedMeteringEvents([
    {
      keyId: testKeyId,
      keyHash: "hash3",
      product: "codex",
      tier: "developer_pro",
      tool: "search_atoms",
      requestId: "req-p-1",
      billed: true,
      ts: now.toISOString(),
    },
    {
      keyId: testKeyId,
      keyHash: "hash3",
      product: "codex",
      tier: "developer_pro",
      tool: "get_atom",
      requestId: "req-p-2",
      billed: true,
      ts: now.toISOString(),
    },
    {
      keyId: testKeyId,
      keyHash: "hash3",
      product: "reporting",
      tier: "developer_pro",
      tool: "summarize_land_deal",
      requestId: "req-p-3",
      billed: true,
      ts: now.toISOString(),
    },
    {
      keyId: testKeyId,
      keyHash: "hash3",
      product: "map",
      tier: "developer_pro",
      tool: "search_zoning_ordinances",
      requestId: "req-p-4",
      billed: false,
      ts: now.toISOString(),
    },
  ]);

  try {
    const res = await getMeteringSummary(testKey, 1);
    assert.equal(res.status, 200);
    const body: MeteringSummaryResponse = await res.json();

    assert.equal(body.totals.layer2Calls, 4);
    const today = now.toISOString().split("T")[0]!;
    const todayData = body.days.find((d) => d.date === today);
    assert.ok(todayData);
    assert.equal(todayData.byProduct.codex, 2);
    assert.equal(todayData.byProduct.reporting, 1);
    assert.equal(todayData.byProduct.map, 1);
  } finally {
    await cleanupMeteringEvents([testKeyId]);
  }
});

test("GET /metering/summary — byTool groups correctly", async () => {
  const testKey = process.env.TEST_INTERNAL_KEY;
  if (!testKey || !process.env.DATABASE_URL) {
    console.log("Skipping byTool test (TEST_INTERNAL_KEY or DATABASE_URL not set)");
    return;
  }

  const testKeyId = "test-by-tool-key";
  const now = new Date();
  await seedMeteringEvents([
    {
      keyId: testKeyId,
      keyHash: "hash4",
      product: "codex",
      tier: "developer_pro",
      tool: "search_atoms",
      requestId: "req-t-1",
      billed: true,
      ts: now.toISOString(),
    },
    {
      keyId: testKeyId,
      keyHash: "hash4",
      product: "codex",
      tier: "developer_pro",
      tool: "search_atoms",
      requestId: "req-t-2",
      billed: true,
      ts: now.toISOString(),
    },
    {
      keyId: testKeyId,
      keyHash: "hash4",
      product: "codex",
      tier: "developer_pro",
      tool: "get_atom",
      requestId: "req-t-3",
      billed: true,
      ts: now.toISOString(),
    },
  ]);

  try {
    const res = await getMeteringSummary(testKey, 1);
    assert.equal(res.status, 200);
    const body: MeteringSummaryResponse = await res.json();

    assert.equal(body.totals.layer2Calls, 3);
    const today = now.toISOString().split("T")[0]!;
    const todayData = body.days.find((d) => d.date === today);
    assert.ok(todayData);
    assert.equal(todayData.byTool.search_atoms, 2);
    assert.equal(todayData.byTool.get_atom, 1);
  } finally {
    await cleanupMeteringEvents([testKeyId]);
  }
});
