// Per-tier rate-limit conformance tests.
//
// Uses the in-memory store with an injected clock so tests are
// deterministic and run in milliseconds, not minutes.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  MemoryRateLimitStore,
  checkRateLimit,
} from "../src/rate-limit.js";

function makeStore(initialMs: number) {
  const store = new MemoryRateLimitStore();
  const state = { now: initialMs };
  store.setClock(() => state.now);
  return { store, state };
}

test("under the per-minute cap returns allowed=true with decreasing remainder", async () => {
  const { store } = makeStore(1_700_000_000_000);
  const limits = { rpm: 5, daily: 100 };
  for (let i = 1; i <= 5; i++) {
    const d = await checkRateLimit(store, "key:a", limits, 1_700_000_000_000);
    assert.equal(d.allowed, true, `request ${i} should be allowed`);
    assert.equal(d.remaining_rpm, 5 - i);
  }
});

test("the 6th request in a 5/min window is denied with reason=rpm", async () => {
  const { store } = makeStore(1_700_000_000_000);
  const limits = { rpm: 5, daily: 100 };
  const now = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) {
    await checkRateLimit(store, "key:a", limits, now);
  }
  const sixth = await checkRateLimit(store, "key:a", limits, now);
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.reason, "rpm");
});

test("RPM window rolls over after 60s", async () => {
  const { store, state } = makeStore(1_700_000_000_000);
  const limits = { rpm: 2, daily: 100 };
  // Consume the window.
  await checkRateLimit(store, "key:b", limits, state.now);
  await checkRateLimit(store, "key:b", limits, state.now);
  const blocked = await checkRateLimit(store, "key:b", limits, state.now);
  assert.equal(blocked.allowed, false);
  // Advance into next minute. Use a value past TTL so MemoryRateLimitStore
  // treats the bucket as expired.
  state.now += 61_000;
  const allowed = await checkRateLimit(store, "key:b", limits, state.now);
  assert.equal(allowed.allowed, true);
});

test("daily cap denies with reason=daily even if RPM has room", async () => {
  const { store } = makeStore(1_700_000_000_000);
  const limits = { rpm: 1_000_000, daily: 3 };
  const now = 1_700_000_000_000;
  await checkRateLimit(store, "key:c", limits, now);
  await checkRateLimit(store, "key:c", limits, now);
  await checkRateLimit(store, "key:c", limits, now);
  const fourth = await checkRateLimit(store, "key:c", limits, now);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.reason, "daily");
});

test("rpm=0 and daily=0 short-circuit to allowed for unmetered (Embedder)", async () => {
  const { store } = makeStore(1_700_000_000_000);
  const limits = { rpm: 0, daily: 0 };
  for (let i = 0; i < 1_000; i++) {
    const d = await checkRateLimit(store, "key:emb", limits);
    assert.equal(d.allowed, true);
    assert.equal(d.remaining_rpm, -1);
    assert.equal(d.remaining_daily, -1);
  }
  // No buckets should have been created.
  assert.equal(store.size(), 0);
});

test("different identifiers do not share buckets", async () => {
  const { store } = makeStore(1_700_000_000_000);
  const limits = { rpm: 1, daily: 100 };
  const now = 1_700_000_000_000;
  const a1 = await checkRateLimit(store, "ip:1.2.3.4", limits, now);
  const b1 = await checkRateLimit(store, "ip:5.6.7.8", limits, now);
  assert.equal(a1.allowed, true);
  assert.equal(b1.allowed, true);
  const a2 = await checkRateLimit(store, "ip:1.2.3.4", limits, now);
  assert.equal(a2.allowed, false);
  const b2 = await checkRateLimit(store, "ip:5.6.7.8", limits, now);
  assert.equal(b2.allowed, false);
});

test("conformance: each canonical tier band trips at its configured cap", async () => {
  const bands = [
    { name: "free_ip", rpm: 5, daily: 1000 },
    { name: "free_key", rpm: 5, daily: 10000 },
    { name: "developer_pro", rpm: 5, daily: 50000 },
    { name: "team", rpm: 5, daily: 500000 },
  ];
  for (const band of bands) {
    const { store } = makeStore(1_700_000_000_000);
    const now = 1_700_000_000_000;
    for (let i = 0; i < band.rpm; i++) {
      const d = await checkRateLimit(store, `${band.name}:k`, band, now);
      assert.equal(d.allowed, true, `${band.name} req ${i + 1} should pass`);
    }
    const tripped = await checkRateLimit(store, `${band.name}:k`, band, now);
    assert.equal(tripped.allowed, false, `${band.name} should trip at rpm+1`);
    assert.equal(tripped.reason, "rpm");
  }
});
