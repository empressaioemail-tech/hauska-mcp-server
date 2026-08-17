import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AuthContext } from "../src/auth.js";
import { whoamiFromContext } from "../src/auth.js";

function ctx(partial: Partial<AuthContext>): AuthContext {
  return {
    tier: "free_anonymous",
    product: "public",
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    ...partial,
  };
}

test("whoami anonymous has no tenant and no key material", () => {
  const body = whoamiFromContext(ctx({}));
  assert.deepEqual(body, { anonymous: true, jurisdiction_tenant: null });
  assert.equal("presented_key" in body, false);
  assert.equal("key_id" in body, false);
  assert.equal("key_hash" in body, false);
});

test("whoami identified returns jurisdiction_tenant and never key material", () => {
  const body = whoamiFromContext(
    ctx({
      tier: "free",
      key_id: "key-fixture",
      key_hash: "hash-must-not-leak",
      presented_key: "hk_free_secret",
      jurisdiction_tenant: "fixture-city",
    }),
  );
  assert.deepEqual(body, {
    anonymous: false,
    jurisdiction_tenant: "fixture-city",
  });
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /hk_free_secret|hash-must-not-leak|key-fixture/);
});

test("whoami identified without a tenant binding returns null tenant", () => {
  const body = whoamiFromContext(
    ctx({
      tier: "free",
      key_id: "key-open",
      jurisdiction_tenant: "  ",
    }),
  );
  assert.deepEqual(body, { anonymous: false, jurisdiction_tenant: null });
});
