// Tenant isolation through substrate tool post-filters (ADR-005 Layer A).

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import type { AccessPolicy } from "@hauska/atom-contract";

import type { AuthContext } from "../src/auth.js";
import { hauskaClient } from "../src/hauska-client.js";
import { requestContext } from "../src/request-context.js";
import { accessPoliciesForTier } from "../src/tools.js";

interface RecordedCall {
  url: string;
}

const calls: RecordedCall[] = [];
let mockBody: unknown = { results: [] };

const realFetch = globalThis.fetch;

function withCtx<T>(ctx: AuthContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

function authCtx(partial: Partial<AuthContext> & Pick<AuthContext, "tier" | "product">): AuthContext {
  return {
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    jurisdiction_tenant: null,
    platform_internal: false,
    ...partial,
  };
}

beforeEach(() => {
  calls.length = 0;
  mockBody = { results: [] };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return new Response(JSON.stringify(mockBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function searchRow(
  id: string,
  tenant: string,
  accessPolicy?: AccessPolicy,
) {
  return {
    atomDid: `did:hauska:code-section:${id}`,
    entityType: "code-section" as const,
    entityId: id,
    jurisdictionTenant: tenant,
    sectionNumber: "101",
    snippet: "test",
    score: 0.9,
    ...(accessPolicy !== undefined ? { accessPolicy } : {}),
  };
}

test("anonymous regression: accessPoliciesForTier still public-free only", () => {
  assert.deepEqual(accessPoliciesForTier("free_anonymous"), ["public-free"]);
});

test("tenant isolation: tenant-B key does not receive tenant-A private search hit", async () => {
  mockBody = {
    results: [
      searchRow("priv-a", "mox-living", "tenant-private"),
      searchRow("pub-b", "bastrop-tx", "public-free"),
    ],
    totalCandidates: 2,
  };

  const tenantBKey = authCtx({
    tier: "developer_pro",
    product: "public",
    key_id: "key-b",
    jurisdiction_tenant: "bastrop-tx",
  });

  await withCtx(tenantBKey, async () => {
    const { filterByAccessPolicy } = await import("../src/access-policy.js");
    const { getCurrentAccessSubject } = await import("../src/request-context.js");
    const raw = await hauskaClient.searchAtoms({ query: "setback", limit: 25 });
    const filtered = filterByAccessPolicy(
      raw.results,
      getCurrentAccessSubject(),
      (r) => ({
        accessPolicy: r.accessPolicy,
        jurisdictionTenant: r.jurisdictionTenant,
      }),
      { tool: "search_atoms" },
    );
    assert.deepEqual(filtered.map((r) => r.entityId), ["pub-b"]);
  });
});

test("tenant isolation: tenant-A key receives its own tenant-private atom", async () => {
  mockBody = {
    results: [searchRow("priv-a", "mox-living", "tenant-private")],
    totalCandidates: 1,
  };

  const tenantAKey = authCtx({
    tier: "developer_pro",
    product: "public",
    key_id: "key-a",
    jurisdiction_tenant: "mox-living",
  });

  await withCtx(tenantAKey, async () => {
    const { filterByAccessPolicy } = await import("../src/access-policy.js");
    const { getCurrentAccessSubject } = await import("../src/request-context.js");
    const raw = await hauskaClient.searchAtoms({ query: "setback", limit: 25 });
    const filtered = filterByAccessPolicy(
      raw.results,
      getCurrentAccessSubject(),
      (r) => ({
        accessPolicy: r.accessPolicy,
        jurisdictionTenant: r.jurisdictionTenant,
      }),
      { tool: "search_atoms" },
    );
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.entityId, "priv-a");
  });
});

test("Hauska internal key receives tenant-private atom from any tenant", async () => {
  mockBody = {
    results: [searchRow("priv-a", "mox-living", "tenant-private")],
    totalCandidates: 1,
  };

  const internalKey = authCtx({
    tier: "team",
    product: "public",
    key_id: "key-internal",
    platform_internal: true,
  });

  await withCtx(internalKey, async () => {
    const { filterByAccessPolicy } = await import("../src/access-policy.js");
    const { getCurrentAccessSubject } = await import("../src/request-context.js");
    const raw = await hauskaClient.searchAtoms({ query: "setback", limit: 25 });
    const filtered = filterByAccessPolicy(
      raw.results,
      getCurrentAccessSubject(),
      (r) => ({
        accessPolicy: r.accessPolicy,
        jurisdictionTenant: r.jurisdictionTenant,
      }),
      { tool: "search_atoms" },
    );
    assert.equal(filtered.length, 1);
  });
});
