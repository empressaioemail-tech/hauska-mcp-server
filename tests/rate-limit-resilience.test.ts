// Rate-limit store resilience tests.
//
// Verifies that when the primary rate-limit store (Upstash) fails, the
// system degrades gracefully to an in-memory fallback and recovers
// automatically via circuit-breaker retry logic.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ResilientRateLimitStore,
  checkRateLimit,
  type RateLimitStore,
} from "../src/rate-limit.js";

class FailingStore implements RateLimitStore {
  private counters = new Map<string, number>();

  constructor(public shouldFail = true) {}

  async incrWithTtl(key: string, _ttlSeconds: number): Promise<number> {
    if (this.shouldFail) {
      throw new Error("Simulated backend failure");
    }
    const current = this.counters.get(key) ?? 0;
    const next = current + 1;
    this.counters.set(key, next);
    return next;
  }

  reset(): void {
    this.counters.clear();
  }
}

function makeMockLogger() {
  const events: Array<{ event: string; data: any }> = [];
  return {
    logger: {
      error: (event: string, data: any) => {
        events.push({ event, data });
      },
    },
    events,
  };
}

test("primary store throwing -> falls back to memory store and logs degraded event", async () => {
  const failing = new FailingStore(true);
  const { logger, events } = makeMockLogger();
  const resilient = new ResilientRateLimitStore(failing, logger);

  const limits = { rpm: 5, daily: 100 };
  const decision = await checkRateLimit(resilient, "key:test", limits);

  assert.equal(decision.allowed, true, "request should be allowed (fail-degraded)");
  assert.equal(events.length, 1, "should log one degraded event");
  assert.equal(events[0].event, "rate_limit_store_degraded");
  assert.ok(events[0].data.error.includes("Simulated backend failure"));
});

test("circuit stays open and uses memory store without retry within window", async () => {
  const failing = new FailingStore(true);
  const { logger, events } = makeMockLogger();
  const resilient = new ResilientRateLimitStore(failing, logger);

  const limits = { rpm: 2, daily: 100 };
  const now = 1_700_000_000_000;

  const d1 = await checkRateLimit(resilient, "key:a", limits, now);
  assert.equal(d1.allowed, true);
  assert.equal(events.length, 1, "first call logs degraded");

  const d2 = await checkRateLimit(resilient, "key:a", limits, now + 1000);
  assert.equal(d2.allowed, true);
  assert.equal(events.length, 1, "second call does not log again");

  const d3 = await checkRateLimit(resilient, "key:a", limits, now + 2000);
  assert.equal(d3.allowed, false, "third request should trip memory store limit");
  assert.equal(d3.reason, "rpm");
  assert.equal(events.length, 1, "rate limit still only logged degraded once");
});

test("recovery after retry window when primary becomes healthy", async () => {
  const failing = new FailingStore(true);
  const { logger, events } = makeMockLogger();
  const resilient = new ResilientRateLimitStore(failing, logger);

  const limits = { rpm: 5, daily: 100 };
  const state = { now: 1_700_000_000_000 };
  resilient.setClock(() => state.now);

  const d1 = await checkRateLimit(resilient, "key:b", limits, state.now);
  assert.equal(d1.allowed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "rate_limit_store_degraded");

  state.now += 1000;
  await checkRateLimit(resilient, "key:b", limits, state.now);
  assert.equal(events.length, 1, "still degraded, no retry yet");

  state.now += 60_000;
  failing.shouldFail = false;

  const d3 = await checkRateLimit(resilient, "key:b", limits, state.now);
  assert.equal(d3.allowed, true);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "rate_limit_store_recovered");
});

test("genuine over-limit still returns 429 shape after recovery", async () => {
  const failing = new FailingStore(true);
  const { logger, events } = makeMockLogger();
  const resilient = new ResilientRateLimitStore(failing, logger);

  const limits = { rpm: 1, daily: 100 };
  const state = { now: 1_700_000_000_000 };
  resilient.setClock(() => state.now);

  await checkRateLimit(resilient, "key:c", limits, state.now);
  assert.equal(events.length, 1, "should degrade initially");

  state.now += 61_000;
  failing.shouldFail = false;
  failing.reset();

  const d1 = await checkRateLimit(resilient, "key:c", limits, state.now);
  assert.equal(d1.allowed, true);
  assert.equal(events.length, 2, "should recover");

  const d2 = await checkRateLimit(resilient, "key:c", limits, state.now);
  assert.equal(d2.allowed, false);
  assert.equal(d2.reason, "rpm");
  assert.equal(d2.remaining_rpm, 0);
});

test("circuit re-closes on subsequent failure after recovery attempt", async () => {
  const failing = new FailingStore(true);
  const { logger, events } = makeMockLogger();
  const resilient = new ResilientRateLimitStore(failing, logger);

  const limits = { rpm: 10, daily: 100 };
  const state = { now: 1_700_000_000_000 };
  resilient.setClock(() => state.now);

  await checkRateLimit(resilient, "key:d", limits, state.now);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "rate_limit_store_degraded");

  state.now += 61_000;

  await checkRateLimit(resilient, "key:d", limits, state.now);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "rate_limit_store_degraded", "retry failed, still degraded");

  state.now += 1000;
  await checkRateLimit(resilient, "key:d", limits, state.now);
  assert.equal(events.length, 2, "should not spam logs");
});
