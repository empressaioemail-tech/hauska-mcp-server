// Group 3 L4 — detail-callout-spec client tests.
//
// Wire conformance for the five L4 legacy-client methods against a
// mocked fetch. The L4 endpoints are an MCP-first contract (built to
// match by cc-agent-C in Lane C.4), so e2e coverage waits on Lane C.4;
// this file is mocked-fetch only.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { lSurfaceProvenance } from "../src/atom-shape.js";
import {
  LegacyHttpError,
  legacyClient,
  type DetailCalloutSpecAtom,
} from "../src/legacy-client.js";

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
  mockResponse = { status: 200, body: {} };
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
  delete process.env.LEGACY_BACKEND_API_KEY;
});

function spec(
  overrides: Partial<DetailCalloutSpecAtom> = {},
): DetailCalloutSpecAtom {
  return {
    entityType: "detail-callout-spec",
    entityId: "dcs-1",
    jurisdictionTenant: "legacy",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "/api/detail-callout-specs/dcs-1",
    contentHash: "hash-dcs",
    engagementId: "eng-1",
    spec: { detailType: "wall-type", typeMark: "W1" },
    pushState: "pending",
    apsTaskRef: null,
    findingId: null,
    responseTaskId: null,
    createdAt: "2026-05-19T00:00:00Z",
    pushedAt: null,
    actorId: null,
    principalActorId: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------
// createDetailCalloutSpec
// -----------------------------------------------------------------

test("createDetailCalloutSpec POSTs to /api/engagements/:id/detail-callout-specs", async () => {
  mockResponse = { status: 201, body: { detailCalloutSpec: spec() } };
  await legacyClient.createDetailCalloutSpec({
    engagementId: "eng-1",
    detailType: "wall-type",
    spec: { typeMark: "W1", assemblyLayers: [], fireRating: "1 hr", stcRating: "" },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/detail-callout-specs");
  assert.equal(calls[0]!.init?.method, "POST");
});

test("createDetailCalloutSpec merges detailType into the wire spec payload", async () => {
  mockResponse = { status: 201, body: { detailCalloutSpec: spec() } };
  await legacyClient.createDetailCalloutSpec({
    engagementId: "eng-1",
    detailType: "door-schedule",
    spec: { rows: [{ doorMark: "101" }] },
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  // The wire `spec` carries detailType plus the type-specific fields.
  assert.equal(body.spec.detailType, "door-schedule");
  assert.deepEqual(body.spec.rows, [{ doorMark: "101" }]);
});

test("createDetailCalloutSpec forwards optional provenance + actor fields", async () => {
  mockResponse = { status: 201, body: { detailCalloutSpec: spec() } };
  await legacyClient.createDetailCalloutSpec({
    engagementId: "eng-1",
    detailType: "room-finish",
    spec: { roomName: "Lobby" },
    findingId: "f-3",
    responseTaskId: "rt-8",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.findingId, "f-3");
  assert.equal(body.responseTaskId, "rt-8");
  assert.equal("actorId" in body, false);
});

// -----------------------------------------------------------------
// updateDetailCalloutSpecPushState
// -----------------------------------------------------------------

test("updateDetailCalloutSpecPushState POSTs the new push state", async () => {
  mockResponse = {
    status: 200,
    body: { detailCalloutSpec: spec({ pushState: "pushed" }) },
  };
  const res = await legacyClient.updateDetailCalloutSpecPushState({
    specId: "dcs-1",
    pushState: "pushed",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/detail-callout-specs/dcs-1/push-state");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.pushState, "pushed");
  assert.equal(res.detailCalloutSpec.pushState, "pushed");
});

test("updateDetailCalloutSpecPushState rethrows the 409 illegal-transition conflict", async () => {
  mockResponse = {
    status: 409,
    body: {
      error: "illegal_push_transition",
      from: "applied",
      to: "pending",
      legalNextStates: [],
    },
  };
  await assert.rejects(
    () =>
      legacyClient.updateDetailCalloutSpecPushState({
        specId: "dcs-1",
        pushState: "pending",
      }),
    (err: unknown) => {
      if (!(err instanceof LegacyHttpError) || err.status !== 409) return false;
      const parsed = JSON.parse(err.body) as { from?: string };
      assert.equal(parsed.from, "applied");
      return true;
    },
  );
});

// -----------------------------------------------------------------
// attachDetailCalloutSpecApsRef
// -----------------------------------------------------------------

test("attachDetailCalloutSpecApsRef POSTs the apsTaskRef", async () => {
  mockResponse = {
    status: 200,
    body: { detailCalloutSpec: spec({ apsTaskRef: "aps-wi-99" }) },
  };
  const res = await legacyClient.attachDetailCalloutSpecApsRef({
    specId: "dcs-1",
    apsTaskRef: "aps-wi-99",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/detail-callout-specs/dcs-1/aps-ref");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.apsTaskRef, "aps-wi-99");
  assert.equal(res.detailCalloutSpec.apsTaskRef, "aps-wi-99");
});

// -----------------------------------------------------------------
// listDetailCalloutSpecs
// -----------------------------------------------------------------

test("listDetailCalloutSpecs GETs /api/engagements/:id/detail-callout-specs", async () => {
  mockResponse = {
    status: 200,
    body: { detailCalloutSpecs: [spec(), spec({ entityId: "dcs-2" })] },
  };
  const res = await legacyClient.listDetailCalloutSpecs({
    engagementId: "eng-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/detail-callout-specs");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(url.searchParams.has("pushState"), false);
  assert.equal(res.detailCalloutSpecs.length, 2);
});

test("listDetailCalloutSpecs encodes the optional pushState filter", async () => {
  mockResponse = { status: 200, body: { detailCalloutSpecs: [] } };
  await legacyClient.listDetailCalloutSpecs({
    engagementId: "eng-1",
    pushState: "applied",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("pushState"), "applied");
});

// -----------------------------------------------------------------
// getDetailCalloutSpec
// -----------------------------------------------------------------

test("getDetailCalloutSpec GETs /api/detail-callout-specs/:id", async () => {
  mockResponse = { status: 200, body: { detailCalloutSpec: spec() } };
  const res = await legacyClient.getDetailCalloutSpec({ specId: "dcs-1" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/detail-callout-specs/dcs-1");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.detailCalloutSpec.entityId, "dcs-1");
});

test("getDetailCalloutSpec rethrows a 404 as LegacyHttpError", async () => {
  mockResponse = {
    status: 404,
    body: { error: "detail_callout_spec_not_found" },
  };
  await assert.rejects(
    () => legacyClient.getDetailCalloutSpec({ specId: "dcs-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

test("L4 methods send the bearer token when LEGACY_BACKEND_API_KEY is set", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "svc-token";
  mockResponse = { status: 200, body: { detailCalloutSpecs: [] } };
  await legacyClient.listDetailCalloutSpecs({ engagementId: "eng-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer svc-token");
});

// -----------------------------------------------------------------
// provenance — detail-callout-spec carries a real DID
// -----------------------------------------------------------------

test("lSurfaceProvenance builds a real DID for a detail-callout-spec atom", () => {
  const entry = lSurfaceProvenance(spec());
  assert.equal(entry.did, "did:hauska:detail-callout-spec:dcs-1");
  assert.equal(entry.entityType, "detail-callout-spec");
  assert.equal(entry.contentHash, "hash-dcs");
});
