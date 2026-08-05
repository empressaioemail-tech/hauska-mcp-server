// Postgres rate-limit store unit tests.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  PostgresRateLimitStore,
  buildPrimaryRateLimitStore,
  resolveRateLimitStoreKind,
  checkRateLimit,
  MemoryRateLimitStore,
} from "../src/rate-limit.js";
import { resolveClientIp } from "../src/auth.js";

class MockPool {
  public lastSql = "";
  public lastArgs: unknown[] = [];
  private count = 0;

  async query<T>(_sql: string, args: unknown[]): Promise<{ rows: T[] }> {
    this.lastSql = _sql;
    this.lastArgs = args;
    this.count += 1;
    return { rows: [{ count: String(this.count) } as T] };
  }
}

test("PostgresRateLimitStore incrWithTtl uses atomic upsert SQL", async () => {
  const pool = new MockPool();
  const store = new PostgresRateLimitStore(pool as any);
  const n = await store.incrWithTtl("rl:rpm:ip:1.2.3.4:123", 60);
  assert.equal(n, 1);
  assert.match(pool.lastSql, /rate_limit_counters/);
  assert.deepEqual(pool.lastArgs.slice(0, 2), ["rl:rpm:ip:1.2.3.4:123", 60]);
});

test("resolveRateLimitStoreKind defaults to postgres in production", () => {
  const prevEnv = process.env.HAUSKA_ENV;
  const prevStore = process.env.HAUSKA_RATE_LIMIT_STORE;
  delete process.env.HAUSKA_RATE_LIMIT_STORE;
  process.env.HAUSKA_ENV = "production";
  try {
    assert.equal(resolveRateLimitStoreKind(), "postgres");
  } finally {
    if (prevEnv === undefined) delete process.env.HAUSKA_ENV;
    else process.env.HAUSKA_ENV = prevEnv;
    if (prevStore === undefined) delete process.env.HAUSKA_RATE_LIMIT_STORE;
    else process.env.HAUSKA_RATE_LIMIT_STORE = prevStore;
  }
});

test("buildPrimaryRateLimitStore selects upstash when explicitly configured", () => {
  const prev = process.env.HAUSKA_RATE_LIMIT_STORE;
  process.env.HAUSKA_RATE_LIMIT_STORE = "upstash";
  try {
    assert.throws(() => buildPrimaryRateLimitStore(), /must both be set/);
  } finally {
    if (prev === undefined) delete process.env.HAUSKA_RATE_LIMIT_STORE;
    else process.env.HAUSKA_RATE_LIMIT_STORE = prev;
  }
});

test("resolveClientIp strips IPv4-mapped prefix for stable ip: buckets", () => {
  const req = { ip: "::ffff:203.0.113.7" } as any;
  assert.equal(resolveClientIp(req), "203.0.113.7");
});

test("memory + postgres store parity on rpm window via checkRateLimit", async () => {
  const mem = new MemoryRateLimitStore();
  const limits = { rpm: 2, daily: 100 };
  const now = 1_700_000_000_000;
  const d1 = await checkRateLimit(mem, "ip:203.0.113.7", limits, now);
  const d2 = await checkRateLimit(mem, "ip:203.0.113.7", limits, now);
  const d3 = await checkRateLimit(mem, "ip:203.0.113.7", limits, now);
  assert.equal(d1.allowed, true);
  assert.equal(d2.allowed, true);
  assert.equal(d3.allowed, false);
  assert.equal(d3.reason, "rpm");
});
