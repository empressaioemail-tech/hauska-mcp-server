// Gate-signed tenant context headers on legacy-client and engine-api-client (Tenancy T1).
//
// Validates that signed context headers are attached when
// GATE_CONTEXT_SIGNING_KEY is set, and that they are absent when the key
// is unset. Complements gate-context.test.ts (which tests the
// sign/verify primitives).

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import type { AuthContext } from "../src/auth.js";
import { legacyClient } from "../src/legacy-client.js";
import { engineApiClient } from "../src/engine-api-client.js";
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
  delete process.env.GATE_CONTEXT_SIGNING_KEY;
});

test("legacy-client: signed headers are attached when GATE_CONTEXT_SIGNING_KEY is set", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "test-signing-key-32-bytes-long!!";
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
  // Plain forwarded headers (backward compat).
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], "bastrop-tx");
  // Signed gate context (T1).
  assert.ok(headers["X-Hauska-Gate-Context"]);
  assert.ok(headers["X-Hauska-Gate-Signature"]);
  assert.match(headers["X-Hauska-Gate-Context"], /^[A-Za-z0-9_-]+$/);
  assert.match(headers["X-Hauska-Gate-Signature"], /^[0-9a-f]{64}$/);
});

test("legacy-client: signed headers are absent when GATE_CONTEXT_SIGNING_KEY is unset", async () => {
  delete process.env.GATE_CONTEXT_SIGNING_KEY;
  mockResponse = { status: 200, body: { findings: [] } };
  const ctx = authCtx({
    tier: "developer_pro",
    product: "codex",
    key_id: "key-austin",
    jurisdiction_tenant: "austin-tx",
  });

  await withCtx(ctx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-2" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  // Plain forwarded headers still present.
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], "austin-tx");
  // Signed headers absent (key not set).
  assert.equal(headers["X-Hauska-Gate-Context"], undefined);
  assert.equal(headers["X-Hauska-Gate-Signature"], undefined);
});

test("legacy-client: signed headers for anonymous caller (tenant=null)", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "anon-test-key-32-bytes-longggg";
  mockResponse = { status: 200, body: { findings: [] } };
  const ctx = authCtx({
    tier: "free_anonymous",
    product: "public",
    jurisdiction_tenant: null,
  });

  await withCtx(ctx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-3" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  // No plain tenant header (anonymous).
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], undefined);
  // Signed headers present (key is set).
  assert.ok(headers["X-Hauska-Gate-Context"]);
  assert.ok(headers["X-Hauska-Gate-Signature"]);
});

test("legacy-client: signed headers for platform-internal caller", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "internal-key-32-bytes-long!!!!";
  mockResponse = {
    status: 202,
    body: { generationId: "gen-1", state: "pending" },
  };
  const ctx = authCtx({
    tier: "team",
    product: "codex",
    key_id: "key-internal",
    jurisdiction_tenant: "empressa-ops",
    platform_internal: true,
  });

  await withCtx(ctx, () =>
    legacyClient.generateFindings({ submissionId: "sub-4" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  // Plain forwarded headers (backward compat).
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], "empressa-ops");
  assert.equal(headers["X-Hauska-Platform-Internal"], "true");
  // Signed headers present.
  assert.ok(headers["X-Hauska-Gate-Context"]);
  assert.ok(headers["X-Hauska-Gate-Signature"]);
});

test("engine-api-client: signed headers are attached when GATE_CONTEXT_SIGNING_KEY is set", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "engine-test-key-32-bytes-long!";
  mockResponse = {
    status: 200,
    body: { layers: [] },
  };

  await engineApiClient.assembleMapLayers(
    { workspaceDid: "did:hauska:workspace:123", packages: [] },
    {
      gateProduct: "cortex",
      accessTier: "tenant-private",
      tenantId: "tenant-456",
      gateCredentialId: "key-789",
      requestId: "req-001",
    },
  );

  const headers = requestHeaders(calls[0]!.init);
  // Gate-front headers present.
  assert.equal(headers["x-hauska-product"], "cortex");
  assert.equal(headers["x-hauska-tenant-id"], "tenant-456");
  // Signed gate context (T1).
  assert.ok(headers["X-Hauska-Gate-Context"]);
  assert.ok(headers["X-Hauska-Gate-Signature"]);
  assert.match(headers["X-Hauska-Gate-Context"], /^[A-Za-z0-9_-]+$/);
  assert.match(headers["X-Hauska-Gate-Signature"], /^[0-9a-f]{64}$/);
});

test("engine-api-client: signed headers are absent when GATE_CONTEXT_SIGNING_KEY is unset", async () => {
  delete process.env.GATE_CONTEXT_SIGNING_KEY;
  mockResponse = {
    status: 200,
    body: { layers: [] },
  };

  await engineApiClient.assembleMapLayers(
    { workspaceDid: "did:hauska:workspace:456", packages: [] },
    {
      gateProduct: "codex",
      accessTier: "public-paid",
      tenantId: "tenant-789",
      gateCredentialId: "key-abc",
      requestId: "req-002",
    },
  );

  const headers = requestHeaders(calls[0]!.init);
  // Gate-front headers still present.
  assert.equal(headers["x-hauska-product"], "codex");
  // Signed headers absent (key not set).
  assert.equal(headers["X-Hauska-Gate-Context"], undefined);
  assert.equal(headers["X-Hauska-Gate-Signature"], undefined);
});

test("engine-api-client: signed headers for platform-internal tier", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "pi-test-key-32-bytes-longgggg!!";
  mockResponse = {
    status: 200,
    body: { readContract: {}, overlay: {} },
  };

  await engineApiClient.readAtomCalibration(
    "did:hauska:atom:123",
    {
      gateProduct: "cortex",
      accessTier: "platform-internal",
      tenantId: "hauska-internal",
      gateCredentialId: "key-admin",
      requestId: "req-003",
    },
  );

  const headers = requestHeaders(calls[0]!.init);
  // Signed headers present with platform-internal tier.
  assert.ok(headers["X-Hauska-Gate-Context"]);
  assert.ok(headers["X-Hauska-Gate-Signature"]);
});

test("legacy-client: handles signing error gracefully (warns, continues without headers)", async () => {
  // Set an empty key (will cause signing to fail in the try/catch).
  process.env.GATE_CONTEXT_SIGNING_KEY = "";
  mockResponse = { status: 200, body: { findings: [] } };
  const ctx = authCtx({
    tier: "developer_pro",
    product: "codex",
    key_id: "key-test",
    jurisdiction_tenant: "test-tenant",
  });

  await withCtx(ctx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-5" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  // Plain headers still present.
  assert.equal(headers["X-Hauska-Jurisdiction-Tenant"], "test-tenant");
  // Signed headers absent (signing failed).
  assert.equal(headers["X-Hauska-Gate-Context"], undefined);
  assert.equal(headers["X-Hauska-Gate-Signature"], undefined);
});
