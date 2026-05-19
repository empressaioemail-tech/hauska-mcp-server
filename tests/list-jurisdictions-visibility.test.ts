// list_jurisdictions visibility filter (Group 5).
//
// Validates that the `list_jurisdictions` tool filters out jurisdictions
// tagged with non-public access policies for unauthenticated callers,
// while authenticated callers see all jurisdictions including the
// `platform-internal` partnership-pending ones.
//
// Per ADR-017 via @hauska/atom-contract v1.1.0:
//   accessPolicy: "public-free" | "public-paid" | "platform-internal" | "tenant-private"
//
// The filter rule:
//   - tier === "free_anonymous"           → only public-free + absent (treated as public-free)
//   - any authenticated tier              → all jurisdictions
//
// This test file exercises the engine-side filter behavior end-to-end
// through the hauskaClient + the in-handler filter via direct
// invocation of the listJurisdictions client method (since the tool
// handler is registered inline and exercising the full McpServer round
// trip is out of scope here). The filter logic itself lives in
// tools.ts:list_jurisdictions; we mirror it here to validate the
// expected partition behavior.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import type { AccessPolicy } from "@hauska/atom-contract";

import {
  hauskaClient,
  type JurisdictionStatusSnapshot,
} from "../src/hauska-client.js";

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

beforeEach(() => {
  calls.length = 0;
  mockResponse = { status: 200, body: { jurisdictions: [] } };
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
});

function snap(
  tenant: string,
  accessPolicy?: AccessPolicy,
): JurisdictionStatusSnapshot {
  return {
    jurisdictionTenant: tenant,
    jurisdictionName: tenant,
    currentEditionDid: `did:hauska:code-edition:${tenant}/2024`,
    qualityBar: "passing",
    top3Score: 0.9,
    sectionNumScore: 1.0,
    crossRefScore: 1.0,
    atomCount: 100,
    lastRefreshedAt: "2026-05-19T00:00:00Z",
    driftStatus: "clean",
    ...(accessPolicy !== undefined ? { accessPolicy } : {}),
  };
}

// Mirror of the filter rule in tools.ts:list_jurisdictions.
function applyVisibilityFilter(
  isPublicCaller: boolean,
  jurisdictions: JurisdictionStatusSnapshot[],
): JurisdictionStatusSnapshot[] {
  return isPublicCaller
    ? jurisdictions.filter(
        (j) =>
          j.accessPolicy === undefined || j.accessPolicy === "public-free",
      )
    : jurisdictions;
}

test("AccessPolicy import resolves from @hauska/atom-contract", () => {
  // Compile-time check via assignment to the type-narrowed value below
  // would already fail the lint step if AccessPolicy were not exported.
  // This runtime assertion is here for human readers.
  const tag: AccessPolicy = "public-free";
  assert.equal(tag, "public-free");
});

test("hauskaClient.listJurisdictions passes accessPolicy through unchanged", async () => {
  mockResponse = {
    status: 200,
    body: {
      jurisdictions: [
        snap("bastrop-tx", "public-free"),
        snap("smithville-tx", "platform-internal"),
      ],
    },
  };
  const res = await hauskaClient.listJurisdictions();
  assert.equal(res.jurisdictions.length, 2);
  assert.equal(res.jurisdictions[0]!.accessPolicy, "public-free");
  assert.equal(res.jurisdictions[1]!.accessPolicy, "platform-internal");
});

test("hauskaClient.listJurisdictions tolerates absent accessPolicy field", async () => {
  // Pre-1.1.0 engine builds may not surface the field. The wire type
  // marks it optional and consumers must default to public-free.
  mockResponse = {
    status: 200,
    body: { jurisdictions: [snap("legacy-tx")] },
  };
  const res = await hauskaClient.listJurisdictions();
  assert.equal(res.jurisdictions[0]!.accessPolicy, undefined);
});

test("Visibility filter: public caller sees only public-free entries", () => {
  const all = [
    snap("bastrop-tx", "public-free"),
    snap("grand-county-co"), // absent ⇒ treat as public
    snap("smithville-tx", "platform-internal"),
    snap("elgin-tx", "platform-internal"),
    snap("bastrop-county-tx", "platform-internal"),
  ];
  const filtered = applyVisibilityFilter(true, all);
  const tenants = filtered.map((j) => j.jurisdictionTenant);
  assert.deepEqual(tenants, ["bastrop-tx", "grand-county-co"]);
});

test("Visibility filter: authenticated caller sees all jurisdictions", () => {
  const all = [
    snap("bastrop-tx", "public-free"),
    snap("smithville-tx", "platform-internal"),
    snap("elgin-tx", "platform-internal"),
    snap("bastrop-county-tx", "platform-internal"),
    snap("grand-county-co"),
  ];
  const filtered = applyVisibilityFilter(false, all);
  assert.equal(filtered.length, 5);
});

test("Visibility filter: absent accessPolicy field defaults to public-free", () => {
  // The engine docstring is explicit: absent ⇒ public-free. A pre-1.1.0
  // engine build (or any jurisdiction that wasn't tagged at ingest)
  // surfaces without the field; public callers must still see those
  // entries so the filter doesn't break backward compatibility.
  const all = [
    snap("untagged-1"),
    snap("untagged-2"),
    snap("public-1", "public-free"),
  ];
  const filtered = applyVisibilityFilter(true, all);
  assert.equal(filtered.length, 3);
});

test("Visibility filter: public-paid is NOT visible to public callers", () => {
  // public-paid is a Layer 2 tier in the canonical access-policy model.
  // The conservative rule: only `public-free` (or absent) surfaces
  // anonymously. public-paid surfacing requires an authenticated key
  // even though its name contains "public" — the "paid" half is the
  // gate.
  const all = [
    snap("free-1", "public-free"),
    snap("paid-1", "public-paid"),
  ];
  const filtered = applyVisibilityFilter(true, all);
  const tenants = filtered.map((j) => j.jurisdictionTenant);
  assert.deepEqual(tenants, ["free-1"]);
});

test("Visibility filter: Sync 4.5 scenario", () => {
  // The dispatch test plan: unauthenticated call returns Bastrop UDC +
  // Grand County; platform-internal call returns all four Sync 4.5
  // jurisdictions plus Grand County (5 total).
  const sync45 = [
    snap("bastrop-tx", "public-free"), // Bastrop UDC; partnership-confirmed
    snap("grand-county-co", "public-free"), // already loaded; public
    snap("bastrop-county-tx", "platform-internal"), // partnership-pending
    snap("smithville-tx", "platform-internal"),
    snap("elgin-tx", "platform-internal"),
  ];

  const publicView = applyVisibilityFilter(true, sync45);
  assert.deepEqual(
    publicView.map((j) => j.jurisdictionTenant).sort(),
    ["bastrop-tx", "grand-county-co"].sort(),
  );

  const internalView = applyVisibilityFilter(false, sync45);
  assert.equal(internalView.length, 5);
});
