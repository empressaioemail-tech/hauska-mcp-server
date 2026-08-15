import { strict as assert } from "node:assert";
import { test } from "node:test";

import { canReadAccessTarget } from "../src/access-policy.js";

test("denies anonymous on tenant-private seed atom", () => {
  assert.equal(
    canReadAccessTarget(
      { tier: "free_anonymous", jurisdictionTenant: null, platformInternal: false },
      { accessPolicy: "tenant-private", jurisdictionTenant: "bastrop-tx" },
    ),
    false,
  );
});

test("allows platform-internal operator on platform-internal seed", () => {
  assert.equal(
    canReadAccessTarget(
      { tier: "team", jurisdictionTenant: null, platformInternal: true },
      { accessPolicy: "platform-internal", jurisdictionTenant: "" },
    ),
    true,
  );
});
