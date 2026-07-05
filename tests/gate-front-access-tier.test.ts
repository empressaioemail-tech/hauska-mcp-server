// resolveGateAccessTier — access-tier resolution for the engine-api gate-front
// seam (ADR-017 / map-layers-contract). Guards the free-tier escalation bug:
// an authenticated free-tier caller must resolve to "public-free", never
// "public-paid".

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AuthContext } from "../src/auth.js";
import {
  GATE_FRONT_ACCESS_TIERS,
  resolveGateAccessTier,
} from "../src/gate-front.js";

function ctx(partial: Partial<AuthContext> & Pick<AuthContext, "tier">): AuthContext {
  return {
    product: "public",
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    jurisdiction_tenant: null,
    platform_internal: false,
    ...partial,
  };
}

test("resolveGateAccessTier: free tier resolves to public-free, not public-paid", () => {
  assert.equal(resolveGateAccessTier(ctx({ tier: "free" })), "public-free");
});

test("resolveGateAccessTier: paid tier (developer_pro) resolves to public-paid", () => {
  assert.equal(
    resolveGateAccessTier(ctx({ tier: "developer_pro" })),
    "public-paid",
  );
});

test("resolveGateAccessTier: anonymous resolves to null", () => {
  assert.equal(resolveGateAccessTier(ctx({ tier: "free_anonymous" })), null);
  assert.equal(resolveGateAccessTier(undefined), null);
});

test("resolveGateAccessTier: platform_internal wins over tier", () => {
  assert.equal(
    resolveGateAccessTier(ctx({ tier: "free", platform_internal: true })),
    "platform-internal",
  );
});

test("resolveGateAccessTier: jurisdiction tenant resolves to tenant-private", () => {
  assert.equal(
    resolveGateAccessTier(
      ctx({ tier: "team", jurisdiction_tenant: "bastrop-tx" }),
    ),
    "tenant-private",
  );
});

test("GATE_FRONT_ACCESS_TIERS is the full five-value union including tenant-shared", () => {
  assert.deepEqual(
    [...GATE_FRONT_ACCESS_TIERS].sort(),
    [
      "platform-internal",
      "public-free",
      "public-paid",
      "tenant-private",
      "tenant-shared",
    ],
  );
});
