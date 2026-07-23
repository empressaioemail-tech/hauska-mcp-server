// Codex tool product-gate + envelope shape tests.
//
// Validates that:
//   1. requireProduct() rejects callers whose AsyncLocalStorage-bound
//      product does not match the expected product.
//   2. requireProduct() allows callers whose product matches.
//   3. codexProvenance() produces the canonical legacy-row provenance
//      shape with the expected DID-ish synthetic identifier.
//   4. codexEnvelope() wraps payloads with the standard atom-shape
//      envelope, including attribution suppression for paid tiers.
//
// Tool-handler integration (the registered MCP tools calling
// legacyClient under various contexts) is covered indirectly by the
// legacy-client unit tests plus the product-gate semantics here.
// End-to-end coverage is engagement integration work coordinated with
// Lane C once the legacy backend grows a bearer-token middleware.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ATTRIBUTION_STRING,
  codexEnvelope,
  codexProvenance,
} from "../src/atom-shape.js";
import type { AuthContext } from "../src/auth.js";
import { requestContext } from "../src/request-context.js";
import { requireProduct } from "../src/tools.js";

function withCtx<T>(ctx: AuthContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

async function withCtxAsync<T>(
  ctx: AuthContext,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContext.run(ctx, fn);
}

test("requireProduct denies when no context is bound (defaults to public)", async () => {
  const result = await requireProduct("codex_finding_generation", "codex");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.content.isError, true);
    const message = result.content.content[0]?.text ?? "";
    assert.match(message, /requires a "codex"-product/);
    assert.match(message, /product "public"/);
  }
});

test("requireProduct denies when bound product is public and expected is codex", async () => {
  await withCtxAsync(
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "test",
      remaining_rpm: -1,
      remaining_daily: -1,
    },
    async () => {
      const result = await requireProduct("codex_override_write", "codex");
      assert.equal(result.ok, false);
    },
  );
});

test("requireProduct allows when bound product matches expected", async () => {
  await withCtxAsync(
    {
      tier: "developer_pro",
      product: "codex",
      key_id: "k-test",
      rate_limit_id: "key:k-test",
      remaining_rpm: 100,
      remaining_daily: 1000,
    },
    async () => {
      const result = await requireProduct("codex_briefing_fetch", "codex");
      assert.equal(result.ok, true);
    },
  );
});

test("requireProduct denies cross-product (reporting key cannot call codex tool)", async () => {
  await withCtxAsync(
    {
      tier: "developer_pro",
      product: "reporting",
      rate_limit_id: "test",
      remaining_rpm: -1,
      remaining_daily: -1,
    },
    async () => {
      const result = await requireProduct("codex_snapshot_ingest", "codex");
      assert.equal(result.ok, false);
    },
  );
});

test("requireProduct allows reporting tool when bound product is reporting", async () => {
  await withCtxAsync(
    {
      tier: "developer_pro",
      product: "reporting",
      rate_limit_id: "test",
      remaining_rpm: -1,
      remaining_daily: -1,
    },
    async () => {
      const result = await requireProduct("cortex_snapshot_register", "reporting");
      assert.equal(result.ok, true);
    },
  );
});

test("requireProduct denies reporting tool when caller is codex-product", async () => {
  await withCtxAsync(
    {
      tier: "developer_pro",
      product: "codex",
      rate_limit_id: "test",
      remaining_rpm: -1,
      remaining_daily: -1,
    },
    async () => {
      const result = await requireProduct("cortex_ifc_ingest", "reporting");
      assert.equal(result.ok, false);
      if (!result.ok) {
        const message = result.content.content[0]?.text ?? "";
        assert.match(message, /requires a "reporting"-product/);
        assert.match(message, /product "codex"/);
      }
    },
  );
});

test("codexProvenance produces a legacy-prefixed DID with canonical fields", () => {
  const entry = codexProvenance({
    atomKind: "finding-generation-run",
    rowId: "gen-abc-123",
    jurisdictionTenant: "legacy",
    sourcePath: "/api/submissions/sub-1/findings/generate",
  });
  assert.equal(entry.did, "legacy:finding-generation-run:gen-abc-123");
  assert.equal(entry.entityType, "finding-generation-run");
  assert.equal(entry.entityId, "gen-abc-123");
  assert.equal(entry.jurisdictionTenant, "legacy");
  assert.equal(entry.source.adapter, "legacy-design-tools");
  assert.equal(entry.source.url, "/api/submissions/sub-1/findings/generate");
  assert.ok(entry.source.fetchedAt);
  assert.equal(entry.contentHash, null);
  assert.match(entry.cidNote, /legacy backend row id/i);
});

test("codexEnvelope wraps data with provenance and meta", () => {
  const provenance = codexProvenance({
    atomKind: "submission",
    rowId: "sub-1",
    jurisdictionTenant: "legacy",
    sourcePath: "/api/engagements/eng-1/submissions",
  });
  const env = codexEnvelope(
    { submission: { id: "sub-1" } },
    provenance,
    { tier: "developer_pro" },
  );
  assert.deepEqual(env.data, { submission: { id: "sub-1" } });
  assert.equal(env.atoms.length, 1);
  assert.equal(env.atoms[0]?.did, "legacy:submission:sub-1");
});

test("codexEnvelope suppresses attribution for paid (codex) tiers", () => {
  const env = codexEnvelope(
    { ok: true },
    codexProvenance({
      atomKind: "submission",
      rowId: "x",
      jurisdictionTenant: "legacy",
      sourcePath: "/x",
    }),
    { tier: "developer_pro" },
  );
  assert.equal(env.meta.attribution, undefined);
});

test("codexEnvelope surfaces attribution for free-tier callers (per envelope helper)", () => {
  // A free-anonymous caller could in principle hit a codex tool via the
  // product gate (it would be denied), but the envelope helper itself
  // is tier-driven and should surface attribution in any free shape.
  // This guards against the attribution rule drifting if the helper is
  // reused elsewhere.
  const env = codexEnvelope(
    { ok: true },
    null,
    { tier: "free_anonymous" },
  );
  assert.equal(env.meta.attribution, ATTRIBUTION_STRING);
  assert.equal(env.atoms.length, 0);
});

test("codexEnvelope tolerates null provenance (e.g. briefing not yet uploaded)", () => {
  const env = codexEnvelope(
    { briefing: null },
    null,
    { tier: "developer_pro" },
  );
  assert.equal(env.atoms.length, 0);
  assert.deepEqual(env.data, { briefing: null });
});
