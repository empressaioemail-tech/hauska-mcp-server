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

// T1 product-resolution regression tests (PR #XX, fix for T1-fix task).
// Validates that per-request product is correctly threaded into the
// signed gate context, not hardcoded to "public".

test("T1 regression: MAP-key request carries product 'map' in signed context", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "map-test-key-32-bytes-longggg!!";
  mockResponse = { status: 200, body: { findings: [] } };
  const ctx = authCtx({
    tier: "developer_pro",
    product: "map",
    key_id: "key-map-1",
    jurisdiction_tenant: "sf-ca",
  });

  await withCtx(ctx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-map-1" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  assert.ok(headers["X-Hauska-Gate-Context"]);
  assert.ok(headers["X-Hauska-Gate-Signature"]);

  // Decode and verify the signed context carries product: "map".
  const payloadB64 = headers["X-Hauska-Gate-Context"];
  const payloadJson = Buffer.from(
    payloadB64.replace(/-/g, "+").replace(/_/g, "/") + "==",
    "base64",
  ).toString("utf8");
  const payload = JSON.parse(payloadJson);
  assert.equal(payload.product, "map");
  assert.equal(payload.tier, "developer_pro");
  assert.equal(payload.tenant, "sf-ca");
});

test("T1 regression: REPORTING-key request carries product 'reporting' in signed context", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "reporting-key-32-bytes-longggg!";
  mockResponse = { status: 200, body: { findings: [] } };
  const ctx = authCtx({
    tier: "team",
    product: "reporting",
    key_id: "key-reporting-1",
    jurisdiction_tenant: "nyc-ny",
  });

  await withCtx(ctx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-report-1" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  const payloadB64 = headers["X-Hauska-Gate-Context"];
  const payloadJson = Buffer.from(
    payloadB64.replace(/-/g, "+").replace(/_/g, "/") + "==",
    "base64",
  ).toString("utf8");
  const payload = JSON.parse(payloadJson);
  assert.equal(payload.product, "reporting");
  assert.equal(payload.tier, "team");
  assert.equal(payload.tenant, "nyc-ny");
});

test("T1 regression: anonymous caller carries product 'public' in signed context", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "anon-key-32-bytes-longgggggggg!";
  mockResponse = { status: 200, body: { findings: [] } };
  const ctx = authCtx({
    tier: "free_anonymous",
    product: "public",
    jurisdiction_tenant: null,
  });

  await withCtx(ctx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-anon-1" }),
  );

  const headers = requestHeaders(calls[0]!.init);
  const payloadB64 = headers["X-Hauska-Gate-Context"];
  const payloadJson = Buffer.from(
    payloadB64.replace(/-/g, "+").replace(/_/g, "/") + "==",
    "base64",
  ).toString("utf8");
  const payload = JSON.parse(payloadJson);
  assert.equal(payload.product, "public");
  assert.equal(payload.tier, "free_anonymous");
  assert.equal(payload.tenant, null);
});

test("T1 regression: concurrent MAP and REPORTING requests get distinct products", async () => {
  process.env.GATE_CONTEXT_SIGNING_KEY = "concurrent-key-32-bytes-longggg";
  mockResponse = { status: 200, body: { findings: [] } };

  const mapCtx = authCtx({
    tier: "developer_pro",
    product: "map",
    key_id: "key-map-2",
    jurisdiction_tenant: "la-ca",
  });

  const reportingCtx = authCtx({
    tier: "team",
    product: "reporting",
    key_id: "key-reporting-2",
    jurisdiction_tenant: "chicago-il",
  });

  // Simulate interleaved concurrent requests by running both in sequence
  // within their own contexts (AsyncLocalStorage ensures isolation).
  await withCtx(mapCtx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-map-2" }),
  );

  await withCtx(reportingCtx, () =>
    legacyClient.fetchSubmissionFindings({ submissionId: "sub-report-2" }),
  );

  // Verify the first request (MAP) stamped product: "map".
  const mapHeaders = requestHeaders(calls[0]!.init);
  const mapPayloadJson = Buffer.from(
    mapHeaders["X-Hauska-Gate-Context"].replace(/-/g, "+").replace(/_/g, "/") + "==",
    "base64",
  ).toString("utf8");
  const mapPayload = JSON.parse(mapPayloadJson);
  assert.equal(mapPayload.product, "map");
  assert.equal(mapPayload.tenant, "la-ca");

  // Verify the second request (REPORTING) stamped product: "reporting".
  const reportingHeaders = requestHeaders(calls[1]!.init);
  const reportingPayloadJson = Buffer.from(
    reportingHeaders["X-Hauska-Gate-Context"].replace(/-/g, "+").replace(/_/g, "/") +
      "==",
    "base64",
  ).toString("utf8");
  const reportingPayload = JSON.parse(reportingPayloadJson);
  assert.equal(reportingPayload.product, "reporting");
  assert.equal(reportingPayload.tenant, "chicago-il");

  // Ensure they did not contaminate each other.
  assert.notEqual(mapPayload.product, reportingPayload.product);
  assert.notEqual(mapPayload.tenant, reportingPayload.tenant);
});
