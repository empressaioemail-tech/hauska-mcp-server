// list_jurisdictions visibility filter (Group 5).
//
// The visibility partition is applied ENGINE-SIDE at the storage layer:
// the MCP server forwards an `accessPolicies` query param to the engine
// retrieval API; the engine returns only the matching jurisdictions.
// (Earlier the MCP server did this filter client-side; the engine
// retrieval API gained the `accessPolicies` query param in
// hauska-engine PR #7, so the consumer now just selects the right
// filter per caller tier.)
//
// Per ADR-017 via @hauska/atom-contract v1.1.0:
//   accessPolicy: "public-free" | "public-paid" | "platform-internal" | "tenant-private"
//
// The rule (accessPoliciesForTier in tools.ts):
//   - tier === "free_anonymous"  → ["public-free"]  (engine filters)
//   - any authenticated tier     → undefined        (no filter, all shown)
//
// This file validates two things:
//   1. accessPoliciesForTier picks the right allow-list per tier.
//   2. hauskaClient.listJurisdictions encodes the accessPolicies param
//      onto the engine request URL correctly.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import type { AccessPolicy } from "@hauska/atom-contract";

import {
  hauskaClient,
  type JurisdictionStatusSnapshot,
} from "../src/hauska-client.js";
import { accessPoliciesForTier } from "../src/tools.js";

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

// -----------------------------------------------------------------
// accessPoliciesForTier — the per-tier filter-selection rule.
// -----------------------------------------------------------------

test("AccessPolicy import resolves from @hauska/atom-contract", () => {
  const tag: AccessPolicy = "public-free";
  assert.equal(tag, "public-free");
});

test("accessPoliciesForTier: free_anonymous gets the public-free allow-list", () => {
  assert.deepEqual(accessPoliciesForTier("free_anonymous"), ["public-free"]);
});

test("accessPoliciesForTier: every authenticated tier gets undefined (no filter)", () => {
  assert.equal(accessPoliciesForTier("free"), undefined);
  assert.equal(accessPoliciesForTier("developer_pro"), undefined);
  assert.equal(accessPoliciesForTier("team"), undefined);
  assert.equal(accessPoliciesForTier("embedder"), undefined);
});

// -----------------------------------------------------------------
// hauskaClient.listJurisdictions — accessPolicies query encoding.
// -----------------------------------------------------------------

test("listJurisdictions encodes a single accessPolicies value on the URL", async () => {
  await hauskaClient.listJurisdictions({ accessPolicies: ["public-free"] });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/jurisdictions");
  assert.equal(url.searchParams.get("accessPolicies"), "public-free");
});

test("listJurisdictions encodes multiple accessPolicies comma-separated", async () => {
  await hauskaClient.listJurisdictions({
    accessPolicies: ["public-free", "platform-internal"],
  });
  const url = new URL(calls[0]!.url);
  assert.equal(
    url.searchParams.get("accessPolicies"),
    "public-free,platform-internal",
  );
});

test("listJurisdictions omits accessPolicies param when not provided", async () => {
  await hauskaClient.listJurisdictions();
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.has("accessPolicies"), false);
});

test("listJurisdictions omits accessPolicies param when the array is empty", async () => {
  await hauskaClient.listJurisdictions({ accessPolicies: [] });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.has("accessPolicies"), false);
});

test("listJurisdictions composes accessPolicies with qualityBarOnly", async () => {
  await hauskaClient.listJurisdictions({
    qualityBarOnly: true,
    accessPolicies: ["public-free"],
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("qualityBarOnly"), "true");
  assert.equal(url.searchParams.get("accessPolicies"), "public-free");
});

test("listJurisdictions passes accessPolicy through on the response unchanged", async () => {
  mockResponse = {
    status: 200,
    body: {
      jurisdictions: [
        snap("bastrop-tx", "public-free"),
        snap("elgin-tx", "platform-internal"),
      ],
    },
  };
  const res = await hauskaClient.listJurisdictions();
  assert.equal(res.jurisdictions[0]!.accessPolicy, "public-free");
  assert.equal(res.jurisdictions[1]!.accessPolicy, "platform-internal");
});

test("listJurisdictions tolerates absent accessPolicy field on the response", async () => {
  mockResponse = {
    status: 200,
    body: { jurisdictions: [snap("legacy-tx")] },
  };
  const res = await hauskaClient.listJurisdictions();
  assert.equal(res.jurisdictions[0]!.accessPolicy, undefined);
});

// -----------------------------------------------------------------
// End-to-end shape: the Sync 4.5 scenario.
//
// With the engine-side filter, the MCP server trusts the engine to
// return the already-filtered set. These tests assert the request the
// MCP server WOULD make for each caller class, paired with the engine
// response the engine WOULD return for that request.
// -----------------------------------------------------------------

test("Sync 4.5 scenario: free_anonymous caller requests public-free, engine returns 2", async () => {
  // Engine, given accessPolicies=public-free, returns only the
  // partnership-confirmed jurisdictions.
  mockResponse = {
    status: 200,
    body: {
      jurisdictions: [
        snap("bastrop-tx", "public-free"),
        snap("grand-county-co", "public-free"),
      ],
    },
  };
  const accessPolicies = accessPoliciesForTier("free_anonymous");
  const res = await hauskaClient.listJurisdictions({
    ...(accessPolicies !== undefined ? { accessPolicies } : {}),
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("accessPolicies"), "public-free");
  assert.deepEqual(
    res.jurisdictions.map((j) => j.jurisdictionTenant).sort(),
    ["bastrop-tx", "grand-county-co"],
  );
});

test("Sync 4.5 scenario: authenticated caller sends no filter, engine returns all", async () => {
  mockResponse = {
    status: 200,
    body: {
      jurisdictions: [
        snap("bastrop-tx", "public-free"),
        snap("grand-county-co", "public-free"),
        snap("bastrop-county-tx", "platform-internal"),
        snap("elgin-tx", "platform-internal"),
      ],
    },
  };
  const accessPolicies = accessPoliciesForTier("developer_pro");
  const res = await hauskaClient.listJurisdictions({
    ...(accessPolicies !== undefined ? { accessPolicies } : {}),
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.has("accessPolicies"), false);
  assert.equal(res.jurisdictions.length, 4);
});
