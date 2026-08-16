// ADR-005 Layer A accessPolicy enforcement unit tests.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  canReadAccessTarget,
  effectiveAccessPolicy,
  filterByAccessPolicy,
  type AccessSubject,
} from "../src/access-policy.js";

const tenantA: AccessSubject = {
  tier: "developer_pro",
  jurisdictionTenant: "mox-living",
  platformInternal: false,
};

const tenantB: AccessSubject = {
  tier: "developer_pro",
  jurisdictionTenant: "bastrop-tx",
  platformInternal: false,
};

const hauskaInternal: AccessSubject = {
  tier: "team",
  jurisdictionTenant: null,
  platformInternal: true,
};

const anonymous: AccessSubject = {
  tier: "free_anonymous",
  jurisdictionTenant: null,
  platformInternal: false,
};

test("effectiveAccessPolicy defaults unset to tenant-private when jurisdiction present", () => {
  assert.equal(
    effectiveAccessPolicy({ jurisdictionTenant: "mox-living" }),
    "tenant-private",
  );
});

test("effectiveAccessPolicy defaults unset without jurisdiction to public-free", () => {
  assert.equal(effectiveAccessPolicy({ jurisdictionTenant: "" }), "public-free");
});

test("tenant-private: owner tenant can read, other tenant cannot", () => {
  const target = {
    accessPolicy: "tenant-private" as const,
    jurisdictionTenant: "mox-living",
  };
  assert.equal(canReadAccessTarget(tenantA, target), true);
  assert.equal(canReadAccessTarget(tenantB, target), false);
});

test("tenant-private: Hauska internal can read any tenant-private atom", () => {
  assert.equal(
    canReadAccessTarget(hauskaInternal, {
      accessPolicy: "tenant-private",
      jurisdictionTenant: "mox-living",
    }),
    true,
  );
});

test("tenant-private: anonymous caller cannot read", () => {
  assert.equal(
    canReadAccessTarget(anonymous, {
      accessPolicy: "tenant-private",
      jurisdictionTenant: "mox-living",
    }),
    false,
  );
});

test("public-free: readable by anonymous and all tenants", () => {
  const target = {
    accessPolicy: "public-free" as const,
    jurisdictionTenant: "bastrop-tx",
  };
  assert.equal(canReadAccessTarget(anonymous, target), true);
  assert.equal(canReadAccessTarget(tenantA, target), true);
  assert.equal(canReadAccessTarget(tenantB, target), true);
});

test("public-paid: requires paid tier", () => {
  const target = {
    accessPolicy: "public-paid" as const,
    jurisdictionTenant: "bastrop-tx",
  };
  assert.equal(canReadAccessTarget(anonymous, target), false);
  assert.equal(
    canReadAccessTarget({ ...tenantA, tier: "free" }, target),
    false,
  );
  assert.equal(canReadAccessTarget(tenantA, target), true);
});

test("platform-internal: only Hauska internal keys", () => {
  const target = {
    accessPolicy: "platform-internal" as const,
    jurisdictionTenant: "elgin-tx",
  };
  assert.equal(canReadAccessTarget(tenantA, target), false);
  assert.equal(canReadAccessTarget(hauskaInternal, target), true);
});

test("tenant-shared: shared-with list grants cross-tenant read", () => {
  const target = {
    accessPolicy: "tenant-shared" as const,
    jurisdictionTenant: "mox-living",
    sharedWithTenants: ["bastrop-tx"],
  };
  assert.equal(canReadAccessTarget(tenantA, target), true);
  assert.equal(canReadAccessTarget(tenantB, target), true);
});

test("ICC public-free is withheld from anonymous and free catalog callers", () => {
  const icc = {
    accessPolicy: "public-free" as const,
    jurisdictionTenant: "icc-model-code",
  };
  assert.equal(canReadAccessTarget(anonymous, icc), false);
  assert.equal(
    canReadAccessTarget({ ...anonymous, tier: "free" }, icc),
    false,
  );
  assert.equal(canReadAccessTarget(tenantA, icc), true);
  assert.equal(canReadAccessTarget(hauskaInternal, icc), true);
});

test("ICC sourceAdapter withhold does not depend on tenant string", () => {
  const icc = {
    accessPolicy: "public-free" as const,
    jurisdictionTenant: "unknown",
    sourceAdapter: "icc-code-connect",
  };
  assert.equal(canReadAccessTarget(anonymous, icc), false);
  assert.equal(canReadAccessTarget(tenantA, icc), true);
});

test("non-ICC public-free stays readable to anonymous", () => {
  assert.equal(
    canReadAccessTarget(anonymous, {
      accessPolicy: "public-free",
      jurisdictionTenant: "bastrop-tx",
    }),
    true,
  );
});

test("filterByAccessPolicy drops ICC from anonymous list_jurisdictions", () => {
  const rows = [
    {
      id: "bastrop",
      accessPolicy: "public-free" as const,
      jurisdictionTenant: "bastrop-tx",
    },
    {
      id: "icc",
      accessPolicy: "public-free" as const,
      jurisdictionTenant: "icc-model-code",
    },
  ];
  const kept = filterByAccessPolicy(
    rows,
    anonymous,
    (r) => ({
      accessPolicy: r.accessPolicy,
      jurisdictionTenant: r.jurisdictionTenant,
    }),
    { tool: "list_jurisdictions" },
  );
  assert.deepEqual(kept.map((r) => r.id), ["bastrop"]);
});

test("filterByAccessPolicy drops tenant-B-invisible rows", () => {
  const rows = [
    {
      id: "a1",
      accessPolicy: "tenant-private" as const,
      jurisdictionTenant: "mox-living",
    },
    {
      id: "a2",
      accessPolicy: "public-free" as const,
      jurisdictionTenant: "bastrop-tx",
    },
  ];
  const kept = filterByAccessPolicy(
    rows,
    tenantB,
    (r) => ({
      accessPolicy: r.accessPolicy,
      jurisdictionTenant: r.jurisdictionTenant,
    }),
    { tool: "search_atoms" },
  );
  assert.deepEqual(kept.map((r) => r.id), ["a2"]);
});
