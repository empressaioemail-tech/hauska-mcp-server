// DB-free unit tests for GET /obligations/source-ledger (G-111, gap 2).
//
// The handler's auth and scope-validation branches return before any DB
// access, so they are tested by invoking the handler directly with a
// stubbed req/res, the same pattern tests/metering-summary.test.ts uses for
// its sibling endpoint. validateLedgerQuery is exported precisely so the
// "at least one scope" refusal -- the whole point of this endpoint not
// being a table dump -- is directly testable.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  getSourceObligationLedger,
  validateLedgerQuery,
} from "../src/source-obligation-reader.js";

function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      if (captured.status === undefined) captured.status = 200;
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

function fakeReq(opts: {
  hauska?: Record<string, unknown> | undefined;
  query?: Record<string, string>;
}): Request {
  return {
    hauska: opts.hauska,
    query: opts.query ?? {},
  } as unknown as Request;
}

const INTERNAL_CTX = {
  key_id: "test-key",
  key_hash: "hash",
  tier: "team",
  product: "reporting",
  platform_internal: true,
};

test("anonymous request returns 401", async () => {
  const { res, captured } = fakeRes();
  await getSourceObligationLedger(fakeReq({ hauska: undefined }), res);
  assert.equal(captured.status, 401);
  assert.deepEqual(captured.body, { error: "authentication_required" });
});

test("non-internal key returns 403", async () => {
  const { res, captured } = fakeRes();
  await getSourceObligationLedger(
    fakeReq({ hauska: { ...INTERNAL_CTX, platform_internal: false } }),
    res,
  );
  assert.equal(captured.status, 403);
  assert.deepEqual(captured.body, { error: "platform_internal_required" });
});

test("an internal caller with neither scope param is refused, not given a dump", async () => {
  const { res, captured } = fakeRes();
  await getSourceObligationLedger(
    fakeReq({ hauska: INTERNAL_CTX, query: {} }),
    res,
  );
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "scope_required");
});

test("whitespace-only params are treated as absent, not as a scope", async () => {
  const { res, captured } = fakeRes();
  await getSourceObligationLedger(
    fakeReq({
      hauska: INTERNAL_CTX,
      query: { request_id: "   ", source_actor_did: "" },
    }),
    res,
  );
  assert.equal(captured.status, 400, "whitespace must not satisfy the scope requirement");
});

// ── pure validator ──────────────────────────────────────────────────

test("validateLedgerQuery: request_id alone is a valid scope", () => {
  const out = validateLedgerQuery({ request_id: "req-1" });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.requestId, "req-1");
    assert.equal(out.value.sourceActorDid, undefined);
  }
});

test("validateLedgerQuery: source_actor_did alone is a valid scope", () => {
  const out = validateLedgerQuery({ source_actor_did: "did:hauska:actor:org:icc" });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.sourceActorDid, "did:hauska:actor:org:icc");
    assert.equal(out.value.requestId, undefined);
  }
});

test("validateLedgerQuery: both scopes together are valid", () => {
  const out = validateLedgerQuery({
    request_id: "req-1",
    source_actor_did: "did:hauska:actor:org:icc",
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.requestId, "req-1");
    assert.equal(out.value.sourceActorDid, "did:hauska:actor:org:icc");
  }
});

test("validateLedgerQuery: neither scope is refused with scope_required", () => {
  const out = validateLedgerQuery({});
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "scope_required");
  }
});

test("validateLedgerQuery: non-string values are treated as absent, not coerced", () => {
  const out = validateLedgerQuery({ request_id: ["req-1"], source_actor_did: 123 });
  assert.equal(out.ok, false, "an array or number query value must not silently become a scope");
});

test("the gate is not vacuous in either direction", () => {
  // One input is refused, one input passes -- guards against a refactor
  // that always refuses (would fail every real reconciliation call) or
  // always passes (would restore the unscoped-dump risk this exists to
  // prevent).
  assert.equal(validateLedgerQuery({}).ok, false);
  assert.equal(validateLedgerQuery({ request_id: "x" }).ok, true);
});
