// Auth middleware rate-limit degradation tests.
//
// Verifies that when checkRateLimit throws (e.g., Upstash DNS failure),
// the auth middleware logs the error but allows the request (fail-degraded).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import express, { type Request, type Response, type NextFunction } from "express";

import { buildAuthMiddleware } from "../src/auth.js";
import type { RateLimitStore } from "../src/rate-limit.js";

class ThrowingStore implements RateLimitStore {
  async incrWithTtl(_key: string, _ttlSeconds: number): Promise<number> {
    throw new Error("TypeError: fetch failed (DNS NXDOMAIN)");
  }
}

function makeMockLogger() {
  const events: Array<{ level: string; event: string; data: any }> = [];
  return {
    logger: {
      error: (event: string, data: any) => {
        events.push({ level: "error", event, data });
      },
      warn: (event: string, data: any) => {
        events.push({ level: "warn", event, data });
      },
      info: (_event: string, _data: any) => {},
    },
    events,
  };
}

test("free-tier path: store throws -> request allowed with error log", async () => {
  const { logger, events } = makeMockLogger();
  const store = new ThrowingStore();

  const mockReq = {
    headers: {},
    ip: "203.0.113.7",
    body: { id: "test-id" },
  } as Request;

  let nextCalled = false;
  const mockNext = (() => {
    nextCalled = true;
  }) as NextFunction;

  const mockRes = {} as Response;

  const origLogger = (await import("../src/logger.js")).logger;
  Object.assign(origLogger, logger);

  const middleware = buildAuthMiddleware(store);
  await middleware(mockReq, mockRes, mockNext);

  Object.assign(origLogger, {
    error: () => {},
    warn: () => {},
    info: () => {},
  });

  assert.equal(nextCalled, true, "next() should be called (request allowed)");
  const errorLogs = events.filter((e) => e.level === "error");
  assert.equal(errorLogs.length, 1, "should log one error");
  assert.equal(errorLogs[0].event, "rate_limit_store_error");
  assert.equal(errorLogs[0].data.identifier_class, "ip");
  assert.ok(errorLogs[0].data.error.includes("fetch failed"));

  assert.ok(mockReq.hauska, "hauska context should be set");
  assert.equal(mockReq.hauska?.tier, "free_anonymous");
  assert.equal(mockReq.hauska?.remaining_rpm, -1);
  assert.equal(mockReq.hauska?.remaining_daily, -1);
});
