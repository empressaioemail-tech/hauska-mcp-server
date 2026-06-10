// Gate-front tenant headers on legacy-client engine entry points (ADR-008 / PR #160).

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import type { AuthContext } from "../src/auth.js";
import { legacyClient } from "../src/legacy-client.js";
import { requestContext } from "../src/request-context.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

const calls: RecordedCall[] = [];
let mockResponse: { status: number; body: unknown } = {
  status: 200,
  body: {},
};

const realFetch = globalThis.fetch;

function withCtx<T>(ctx: AuthContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

function authCtx(
  partial: Partial<AuthContext> & Pick<AuthContext, "tier" | "product">,
): AuthContext {
  return {
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    jurisdiction_tenant: null,
    platform_internal: false,
    ...partial,
  };
}

function requestHeaders(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (raw instanceof Headers) {
    const out: Record<string, string> = {};
    raw.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return (raw as Record<string, string> | undefined) ?? {};
}

beforeEach(() => {
  calls.length = 0;
  mockResponse = { status: 200, body: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(mockResponse.body), {
      status: mockResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("gate-front seam: tenant-scoped fetchSubmissionFindings forwards jurisdiction tenant header", async () => {
  mockResponse = { status: 200, body: { findings: [] } };
  const ctx = authCtx({
    tier: "developer_pro",
    product: "codex",
    key_id: "key-bastrop",
    jurisdiction_tenant: "bastrop-tx",
  });

  await withCtx(ctx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-1" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], "bastrop-tx");
  assert.equal(headers["X-Hauska-Platform-Internal"], undefined);
});

test("gate-front seam: platform_internal forwards bypass header on generateFindings", async () => {
  mockResponse = {
    status: 202,
    body: { generationId: "gen-1", state: "pending" },
  };
  const ctx = authCtx({
    tier: "team",
    product: "codex",
    key_id: "key-internal",
    platform_internal: true,
  });

  await withCtx(ctx, () =>
    legacyClient.generateFindings({ submissionId: "sub-1" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  assert.equal(headers["X-Hauska-Platform-Internal"], "true");
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], undefined);
});

test("gate-front seam: tenant + platform_internal sends both headers on brokerage brief", async () => {
  mockResponse = {
    status: 200,
    body: { runId: "run-1", startedAt: "2026-06-09T00:00:00.000Z", finishedAt: "2026-06-09T00:01:00.000Z" },
  };
  const ctx = authCtx({
    tier: "team",
    product: "cortex",
    key_id: "key-ops",
    jurisdiction_tenant: "mox-living",
    platform_internal: true,
  });

  await withCtx(ctx, () =>
    legacyClient.generateBrief({ address: "123 Main St" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], "mox-living");
  assert.equal(headers["X-Hauska-Platform-Internal"], "true");
});

test("anonymous path: no gate-front tenant headers without AuthContext", async () => {
  mockResponse = { status: 200, body: { findings: [] } };

  await legacyClient.fetchSubmissionFindings({ submissionId: "sub-1" });

  const headers = requestHeaders(calls[0]!.init);
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], undefined);
  assert.equal(headers["X-Hauska-Platform-Internal"], undefined);
});

test("non-gate-front route: fetchBriefing does not send tenant headers", async () => {
  mockResponse = { status: 200, body: { briefing: null } };
  const ctx = authCtx({
    tier: "developer_pro",
    product: "codex",
    key_id: "key-bastrop",
    jurisdiction_tenant: "bastrop-tx",
  });

  await withCtx(ctx, () =>
    legacyClient.fetchBriefing({ engagementId: "eng-1" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], undefined);
  assert.equal(headers["X-Hauska-Platform-Internal"], undefined);
});
