import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { planReviewBackendUrl, planReviewClient } from "../src/plan-review-client.js";

const calls: { url: string; method?: string; source?: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  delete process.env.PLAN_REVIEW_BACKEND_URL;
  delete process.env.PLAN_REVIEW_API_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      source: headers.get("x-plan-review-source") ?? undefined,
    });
    return new Response(JSON.stringify({ ok: true, stages: [], counts: {}, total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PLAN_REVIEW_BACKEND_URL;
  delete process.env.PLAN_REVIEW_API_KEY;
});

test("refuses cortex-api as the plan-review host", () => {
  process.env.PLAN_REVIEW_BACKEND_URL = "https://cortex-api-tds7av26va-uc.a.run.app";
  assert.throws(() => planReviewBackendUrl(), /refuses cortex-api/);
});

test("queue stamps mcp source header", async () => {
  process.env.PLAN_REVIEW_BACKEND_URL = "https://plan-review-ozx33wafia-ue.a.run.app";
  process.env.PLAN_REVIEW_API_KEY = "test-token";
  await planReviewClient.queue("mcp:codex_findings_fetch");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/plan-review\/queue$/);
  assert.equal(calls[0]!.source, "mcp:codex_findings_fetch");
});
