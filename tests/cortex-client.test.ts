// Cortex client wire conformance against a mocked fetch.
//
// Validates URL shape, snapshot-secret header path for /snapshots
// routes, multipart construction for IFC ingest, 409
// briefing-generation normalization, and the bearer-vs-snapshot-secret
// branching. Same mocked-fetch strategy as legacy-client.test.ts.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import {
  LegacyHttpError,
  LegacyUnreachableError,
  legacyClient,
} from "../src/legacy-client.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

const calls: RecordedCall[] = [];
let mockResponse: { status: number; body: unknown; throw?: unknown } = {
  status: 200,
  body: {},
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  mockResponse = { status: 200, body: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (mockResponse.throw) throw mockResponse.throw;
    return new Response(JSON.stringify(mockResponse.body), {
      status: mockResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LEGACY_BACKEND_API_KEY;
  delete process.env.LEGACY_BACKEND_URL;
  delete process.env.LEGACY_SNAPSHOT_SECRET;
});

// -----------------------------------------------------------------
// registerSnapshot
// -----------------------------------------------------------------

test("registerSnapshot POSTs to /api/snapshots with engagementId branch", async () => {
  mockResponse = { status: 201, body: { snapshotId: "snap-1" } };
  await legacyClient.registerSnapshot({
    engagementId: "eng-1",
    payload: { sheets: [], address: "123 Main" },
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/snapshots");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.engagementId, "eng-1");
  assert.equal(body.address, "123 Main");
});

test("registerSnapshot POSTs with new-engagement branch (projectName)", async () => {
  mockResponse = { status: 201, body: {} };
  await legacyClient.registerSnapshot({
    projectName: "Test Project",
    revitCentralGuid: "guid-1",
    payload: { sheets: [] },
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.projectName, "Test Project");
  assert.equal(body.revitCentralGuid, "guid-1");
  assert.equal("engagementId" in body, false);
});

test("registerSnapshot uses x-snapshot-secret header, NOT bearer", async () => {
  process.env.LEGACY_SNAPSHOT_SECRET = "snap-secret-abc";
  process.env.LEGACY_BACKEND_API_KEY = "bearer-token-xyz";
  mockResponse = { status: 201, body: {} };
  await legacyClient.registerSnapshot({
    engagementId: "eng-1",
    payload: {},
  });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.["x-snapshot-secret"], "snap-secret-abc");
  assert.equal(headers?.authorization, undefined);
});

test("registerSnapshot omits x-snapshot-secret when env var is empty", async () => {
  delete process.env.LEGACY_SNAPSHOT_SECRET;
  mockResponse = { status: 201, body: {} };
  await legacyClient.registerSnapshot({
    engagementId: "eng-1",
    payload: {},
  });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.["x-snapshot-secret"], undefined);
});

// -----------------------------------------------------------------
// ingestIfc
// -----------------------------------------------------------------

test("ingestIfc POSTs multipart/form-data to /api/snapshots/:id/ifc", async () => {
  mockResponse = { status: 202, body: { jobId: "ifc-job-1" } };
  const bytes = new Uint8Array([0x49, 0x46, 0x43, 0x20]); // "IFC "
  await legacyClient.ingestIfc({
    snapshotId: "snap-1",
    filename: "model.ifc",
    bytes,
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/snapshots/snap-1/ifc");
  assert.equal(calls[0]!.init?.method, "POST");
  // FormData is opaque under fetch mocking; verify content-type is NOT
  // hand-set so fetch's automatic multipart boundary applies. (If we
  // set content-type ourselves, the boundary param is lost and busboy
  // on the legacy side fails to parse.)
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.["content-type"], undefined);
  // The body is a FormData; check that it is at least non-string.
  assert.ok(calls[0]!.init?.body instanceof FormData);
});

test("ingestIfc uses x-snapshot-secret header", async () => {
  process.env.LEGACY_SNAPSHOT_SECRET = "secret-xyz";
  mockResponse = { status: 202, body: {} };
  await legacyClient.ingestIfc({
    snapshotId: "snap-1",
    filename: "m.ifc",
    bytes: new Uint8Array([1, 2, 3]),
  });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.["x-snapshot-secret"], "secret-xyz");
});

test("ingestIfc rethrows 404 snapshot_not_found as LegacyHttpError", async () => {
  mockResponse = { status: 404, body: { error: "snapshot_not_found" } };
  await assert.rejects(
    () =>
      legacyClient.ingestIfc({
        snapshotId: "snap-missing",
        filename: "m.ifc",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

// -----------------------------------------------------------------
// queryBimModel
// -----------------------------------------------------------------

test("queryBimModel GETs /api/engagements/:id/bim-model", async () => {
  mockResponse = {
    status: 200,
    body: { bimModel: { id: "bm-1", materializableElements: [] } },
  };
  const res = await legacyClient.queryBimModel({ engagementId: "eng-1" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/bim-model");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(
    (res.bimModel as Record<string, unknown> | null)?.id,
    "bm-1",
  );
});

test("queryBimModel passes through null bimModel when none uploaded", async () => {
  mockResponse = { status: 200, body: { bimModel: null } };
  const res = await legacyClient.queryBimModel({ engagementId: "eng-empty" });
  assert.equal(res.bimModel, null);
});

test("queryBimModel uses bearer header (not snapshot-secret)", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "bearer-abc";
  process.env.LEGACY_SNAPSHOT_SECRET = "snap-xyz";
  mockResponse = { status: 200, body: { bimModel: null } };
  await legacyClient.queryBimModel({ engagementId: "eng-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer bearer-abc");
  assert.equal(headers?.["x-snapshot-secret"], undefined);
});

// -----------------------------------------------------------------
// emitBriefing
// -----------------------------------------------------------------

test("emitBriefing POSTs to /api/engagements/:id/briefing/generate with regenerate flag", async () => {
  mockResponse = {
    status: 202,
    body: { generationId: "br-gen-1", state: "pending" },
  };
  await legacyClient.emitBriefing({
    engagementId: "eng-1",
    regenerate: true,
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/briefing/generate");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.regenerate, true);
});

test("emitBriefing defaults regenerate to false when omitted", async () => {
  mockResponse = {
    status: 202,
    body: { generationId: "br-gen-2", state: "pending" },
  };
  await legacyClient.emitBriefing({ engagementId: "eng-1" });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.regenerate, false);
});

test("emitBriefing normalizes 409 already-in-flight into alreadyInFlight=true", async () => {
  mockResponse = {
    status: 409,
    body: {
      error: "briefing_generation_already_in_flight",
      generationId: "br-existing",
    },
  };
  const res = await legacyClient.emitBriefing({ engagementId: "eng-1" });
  assert.equal(res.alreadyInFlight, true);
  assert.equal(res.generationId, "br-existing");
  assert.equal(res.state, "running");
});

test("emitBriefing rethrows 400 no_briefing_sources_for_engagement", async () => {
  mockResponse = {
    status: 400,
    body: { error: "no_briefing_sources_for_engagement" },
  };
  await assert.rejects(
    () => legacyClient.emitBriefing({ engagementId: "eng-bare" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 400,
  );
});

test("emitBriefing surfaces LegacyUnreachableError on network failure", async () => {
  mockResponse = {
    status: 0,
    body: {},
    throw: new TypeError("fetch failed"),
  };
  await assert.rejects(
    () => legacyClient.emitBriefing({ engagementId: "eng-1" }),
    (err: unknown) => err instanceof LegacyUnreachableError,
  );
});
