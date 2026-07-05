// Gate-signed tenant context (Tenancy T1) tests.
//
// Validates sign/verify round-trip, expiry rejection, tampered-payload
// rejection, tampered-signature rejection, and clock injection. The
// gate-context module is the producer; consumer services (cortex-api,
// engine-api) copy verifySignedGateContext() to verify contexts they
// receive.

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import {
  buildSignedGateContext,
  verifySignedGateContext,
  GateContextVerificationError,
  setNowFn,
  resetNowFn,
  type GateContext,
} from "../src/gate-context.js";

const TEST_KEY = "test-signing-key-32-bytes-long!!";

let mockNow = Date.now();

beforeEach(() => {
  mockNow = Date.now();
  setNowFn(() => mockNow);
});

afterEach(() => {
  resetNowFn();
});

test("buildSignedGateContext produces a base64url payload and hex signature", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "acme-corp",
      product: "codex",
      tier: "developer_pro",
      keyId: "key-abc",
      platformInternal: false,
    },
    TEST_KEY,
  );

  assert.match(payload, /^[A-Za-z0-9_-]+$/);
  assert.match(signature, /^[0-9a-f]{64}$/);
});

test("sign/verify round-trip succeeds for valid context", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "tenant-123",
      product: "cortex",
      tier: "team",
      keyId: "key-xyz",
      platformInternal: false,
    },
    TEST_KEY,
  );

  const ctx = verifySignedGateContext(payload, signature, TEST_KEY, mockNow);

  assert.equal(ctx.v, 1);
  assert.equal(ctx.tenant, "tenant-123");
  assert.equal(ctx.product, "cortex");
  assert.equal(ctx.tier, "team");
  assert.equal(ctx.keyId, "key-xyz");
  assert.equal(ctx.platformInternal, false);
  assert.equal(typeof ctx.iat, "number");
  assert.equal(typeof ctx.exp, "number");
  assert.ok(ctx.exp > ctx.iat);
});

test("sign/verify round-trip succeeds for anonymous caller (tenant=null, keyId=null)", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: null,
      product: "public",
      tier: "free_anonymous",
      keyId: null,
      platformInternal: false,
    },
    TEST_KEY,
  );

  const ctx = verifySignedGateContext(payload, signature, TEST_KEY, mockNow);

  assert.equal(ctx.tenant, null);
  assert.equal(ctx.keyId, null);
  assert.equal(ctx.product, "public");
  assert.equal(ctx.tier, "free_anonymous");
});

test("sign/verify round-trip succeeds for platform-internal context", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "hauska-internal",
      product: "codex",
      tier: "embedder",
      keyId: "internal-key",
      platformInternal: true,
    },
    TEST_KEY,
  );

  const ctx = verifySignedGateContext(payload, signature, TEST_KEY, mockNow);

  assert.equal(ctx.platformInternal, true);
  assert.equal(ctx.tenant, "hauska-internal");
});

test("verifySignedGateContext rejects expired context", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "tenant-abc",
      product: "cortex",
      tier: "team",
      keyId: "key-1",
      platformInternal: false,
    },
    TEST_KEY,
  );

  // Advance time 301 seconds (TTL is 300s).
  const futureMs = mockNow + 301_000;

  assert.throws(
    () => verifySignedGateContext(payload, signature, TEST_KEY, futureMs),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "CONTEXT_EXPIRED",
  );
});

test("verifySignedGateContext accepts context within TTL", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "tenant-def",
      product: "codex",
      tier: "free",
      keyId: null,
      platformInternal: false,
    },
    TEST_KEY,
  );

  // Advance time 299 seconds (still within 300s TTL).
  const futureMs = mockNow + 299_000;

  const ctx = verifySignedGateContext(payload, signature, TEST_KEY, futureMs);
  assert.equal(ctx.tenant, "tenant-def");
});

test("verifySignedGateContext rejects tampered payload", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "original-tenant",
      product: "cortex",
      tier: "team",
      keyId: "key-2",
      platformInternal: false,
    },
    TEST_KEY,
  );

  // Tamper with the payload by changing one character.
  const tamperedPayload = payload.slice(0, -1) + "X";

  assert.throws(
    () =>
      verifySignedGateContext(tamperedPayload, signature, TEST_KEY, mockNow),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "SIGNATURE_INVALID",
  );
});

test("verifySignedGateContext rejects tampered signature", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "tenant-ghi",
      product: "codex",
      tier: "developer_pro",
      keyId: "key-3",
      platformInternal: false,
    },
    TEST_KEY,
  );

  // Tamper with the signature by changing one hex digit.
  const tamperedSig = signature.slice(0, -1) + "f";

  assert.throws(
    () => verifySignedGateContext(payload, tamperedSig, TEST_KEY, mockNow),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "SIGNATURE_INVALID",
  );
});

test("verifySignedGateContext rejects signature from different key", () => {
  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "tenant-jkl",
      product: "cortex",
      tier: "team",
      keyId: "key-4",
      platformInternal: false,
    },
    TEST_KEY,
  );

  const wrongKey = "different-key-32-bytes-long!!!";

  assert.throws(
    () => verifySignedGateContext(payload, signature, wrongKey, mockNow),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "SIGNATURE_INVALID",
  );
});

test("verifySignedGateContext rejects malformed base64url payload", () => {
  const malformedPayload = "not-valid-base64url!!!";
  // Sign the malformed payload so signature verification passes,
  // then decoding fails.
  const hmac = createHmac("sha256", TEST_KEY);
  hmac.update(malformedPayload);
  const signature = hmac.digest("hex");

  assert.throws(
    () =>
      verifySignedGateContext(malformedPayload, signature, TEST_KEY, mockNow),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "PAYLOAD_MALFORMED",
  );
});

test("verifySignedGateContext rejects payload with wrong version", () => {
  const badCtx = {
    v: 2,
    tenant: "tenant-mno",
    product: "cortex",
    tier: "team",
    keyId: "key-5",
    platformInternal: false,
    iat: Math.floor(mockNow / 1000),
    exp: Math.floor(mockNow / 1000) + 300,
  };

  const json = JSON.stringify(badCtx);
  const buf = Buffer.from(json, "utf8");
  const payload = buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  // Sign it with the test key (so signature is valid, but version is wrong).
  const hmac = createHmac("sha256", TEST_KEY);
  hmac.update(payload);
  const signature = hmac.digest("hex");

  assert.throws(
    () => verifySignedGateContext(payload, signature, TEST_KEY, mockNow),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "VERSION_UNSUPPORTED",
  );
});

test("verifySignedGateContext rejects payload with missing fields", () => {
  const incompleteCtx = {
    v: 1,
    tenant: "tenant-pqr",
    // Missing product, tier, etc.
    iat: Math.floor(mockNow / 1000),
    exp: Math.floor(mockNow / 1000) + 300,
  };

  const json = JSON.stringify(incompleteCtx);
  const buf = Buffer.from(json, "utf8");
  const payload = buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const hmac = createHmac("sha256", TEST_KEY);
  hmac.update(payload);
  const signature = hmac.digest("hex");

  assert.throws(
    () => verifySignedGateContext(payload, signature, TEST_KEY, mockNow),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "PAYLOAD_MALFORMED",
  );
});

test("clock injection allows tests to control time", () => {
  const t0 = 1000000000000;
  setNowFn(() => t0);

  const { payload, signature } = buildSignedGateContext(
    {
      tenant: "tenant-stu",
      product: "codex",
      tier: "free",
      keyId: null,
      platformInternal: false,
    },
    TEST_KEY,
  );

  const ctx = verifySignedGateContext(payload, signature, TEST_KEY, t0);
  assert.equal(ctx.iat, Math.floor(t0 / 1000));
  assert.equal(ctx.exp, Math.floor(t0 / 1000) + 300);

  // Verify at t0+200s: still valid.
  const t1 = t0 + 200_000;
  const ctx2 = verifySignedGateContext(payload, signature, TEST_KEY, t1);
  assert.equal(ctx2.tenant, "tenant-stu");

  // Verify at t0+301s: expired.
  const t2 = t0 + 301_000;
  assert.throws(
    () => verifySignedGateContext(payload, signature, TEST_KEY, t2),
    (err: unknown) =>
      err instanceof GateContextVerificationError &&
      err.code === "CONTEXT_EXPIRED",
  );
});

test("signature is deterministic for same input and key", () => {
  const opts = {
    tenant: "tenant-vwx",
    product: "cortex",
    tier: "team",
    keyId: "key-6",
    platformInternal: false,
  };

  const { payload: p1, signature: s1 } = buildSignedGateContext(opts, TEST_KEY);
  const { payload: p2, signature: s2 } = buildSignedGateContext(opts, TEST_KEY);

  assert.equal(p1, p2);
  assert.equal(s1, s2);
});

test("different tenants produce different signatures", () => {
  const opts1 = {
    tenant: "tenant-a",
    product: "cortex",
    tier: "team",
    keyId: "key-7",
    platformInternal: false,
  };
  const opts2 = {
    tenant: "tenant-b",
    product: "cortex",
    tier: "team",
    keyId: "key-7",
    platformInternal: false,
  };

  const { signature: s1 } = buildSignedGateContext(opts1, TEST_KEY);
  const { signature: s2 } = buildSignedGateContext(opts2, TEST_KEY);

  assert.notEqual(s1, s2);
});
