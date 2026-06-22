// Map-layers package gate — Max-tier entitlement + cross-tenant denial.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { accessSubjectFromContext } from "../src/access-policy.js";
import type { AuthContext } from "../src/auth.js";
import {
  assertJurisdictionTenantScope,
  assertMapLayersPackageGate,
  assertResponseTenantScope,
  filterLayersForEntitlement,
  hasMaxTierEntitlement,
} from "../src/gate-packages.js";
import { requestContext } from "../src/request-context.js";

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

function withCtx<T>(ctx: AuthContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

test("hasMaxTierEntitlement: developer_pro is not Max tier", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "developer_pro",
      product: "map",
      key_id: "key-pro",
      jurisdiction_tenant: "bastrop-tx",
    }),
  );
  assert.equal(hasMaxTierEntitlement(subject), false);
});

test("hasMaxTierEntitlement: team tier is Max tier", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "team",
      product: "map",
      key_id: "key-team",
      jurisdiction_tenant: "bastrop-tx",
    }),
  );
  assert.equal(hasMaxTierEntitlement(subject), true);
});

test("filterLayersForEntitlement denies rich layers on developer_pro", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "developer_pro",
      product: "map",
      key_id: "key-pro",
      jurisdiction_tenant: "bastrop-tx",
    }),
  );
  const result = filterLayersForEntitlement(
    ["parcel-polygon", "dem", "zoning"],
    subject,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /Max-tier/);
    assert.match(result.message, /dem/);
  }
});

test("filterLayersForEntitlement allows basic layers on developer_pro", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "developer_pro",
      product: "map",
      key_id: "key-pro",
      jurisdiction_tenant: "bastrop-tx",
    }),
  );
  const result = filterLayersForEntitlement(
    ["parcel-polygon", "flood-zone", "zoning"],
    subject,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.layers, ["parcel-polygon", "flood-zone", "zoning"]);
  }
});

test("filterLayersForEntitlement allows rich layers on team (Max tier)", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "team",
      product: "map",
      key_id: "key-team",
      jurisdiction_tenant: "bastrop-tx",
    }),
  );
  const result = filterLayersForEntitlement(
    ["parcel-polygon", "topography"],
    subject,
  );
  assert.equal(result.ok, true);
});

test("cross-tenant denial: localKey bastrop-tx denied for mox-living key", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "developer_pro",
      product: "map",
      key_id: "key-mox",
      jurisdiction_tenant: "mox-living",
    }),
  );
  const result = assertJurisdictionTenantScope(
    "assemble_map_layers",
    { stateKey: "texas", localKey: "bastrop-tx" },
    subject,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /Cross-tenant denial/);
    assert.match(result.message, /bastrop-tx/);
    assert.match(result.message, /mox-living/);
  }
});

test("cross-tenant denial: matching localKey allowed for tenant-bound key", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "developer_pro",
      product: "map",
      key_id: "key-bastrop",
      jurisdiction_tenant: "bastrop-tx",
    }),
  );
  const result = assertJurisdictionTenantScope(
    "assemble_map_layers",
    { stateKey: "texas", localKey: "bastrop-tx" },
    subject,
  );
  assert.equal(result.ok, true);
});

test("cross-tenant denial: response tenantScope mismatch rejected", () => {
  const subject = accessSubjectFromContext(
    authCtx({
      tier: "developer_pro",
      product: "map",
      key_id: "key-bastrop",
      jurisdiction_tenant: "bastrop-tx",
    }),
  );
  const result = assertResponseTenantScope(
    "assemble_map_layers",
    "tenant-map-1",
    subject,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /Cross-tenant denial/);
  }
});

test("assertMapLayersPackageGate denies public product key", () => {
  const result = withCtx(
    authCtx({ tier: "developer_pro", product: "public", key_id: "key-pub" }),
    () => assertMapLayersPackageGate("assemble_map_layers"),
  );
  assert.equal(result.ok, false);
});

test("assertMapLayersPackageGate denies reporting key without tenant binding", () => {
  const result = withCtx(
    authCtx({ tier: "developer_pro", product: "reporting", key_id: "key-reporting" }),
    () => assertMapLayersPackageGate("assemble_map_layers"),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /tenant-bound/);
  }
});

test("assertMapLayersPackageGate allows tenant-bound map key", () => {
  const result = withCtx(
    authCtx({
      tier: "developer_pro",
      product: "map",
      key_id: "key-map",
      jurisdiction_tenant: "tenant-map-1",
    }),
    () => assertMapLayersPackageGate("assemble_map_layers"),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.gateProduct, "cortex");
    assert.equal(result.accessTier, "tenant-private");
    assert.equal(result.tenantId, "tenant-map-1");
    assert.equal(result.gateCredentialId, "key-map");
  }
});
