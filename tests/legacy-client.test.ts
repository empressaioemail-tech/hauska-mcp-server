// legacy-client wire conformance against a mocked fetch.
//
// Validates URL shape, body shape, the 409 finding-already-in-flight
// normalization, and the bearer-token header surface. Does NOT spin up
// the real legacy-design-tools backend; end-to-end coverage against
// a live legacy api-server is engagement integration work coordinated
// with Lane C.

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
});

test("generateFindings POSTs to /api/submissions/:id/findings/generate", async () => {
  mockResponse = {
    status: 202,
    body: { generationId: "gen-123", state: "pending" },
  };
  const res = await legacyClient.generateFindings({
    submissionId: "sub-abc",
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/submissions/sub-abc/findings/generate");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(res.generationId, "gen-123");
  assert.equal(res.state, "pending");
  assert.equal(res.alreadyInFlight, undefined);
});

test("generateFindings normalizes 409 already-in-flight into alreadyInFlight=true", async () => {
  mockResponse = {
    status: 409,
    body: {
      error: "finding_generation_already_in_flight",
      generationId: "gen-existing",
    },
  };
  const res = await legacyClient.generateFindings({
    submissionId: "sub-xyz",
  });
  assert.equal(res.alreadyInFlight, true);
  assert.equal(res.generationId, "gen-existing");
  assert.equal(res.state, "running");
});

test("generateFindings rethrows non-409 HTTP errors as LegacyHttpError", async () => {
  mockResponse = { status: 404, body: { error: "submission_not_found" } };
  await assert.rejects(
    () => legacyClient.generateFindings({ submissionId: "sub-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

test("overrideFinding POSTs the override body with severity and category", async () => {
  mockResponse = {
    status: 200,
    body: { finding: { id: "f-1", status: "overridden" } },
  };
  await legacyClient.overrideFinding({
    findingId: "f-1",
    text: "Reviewer note text.",
    severity: "concern",
    category: "setback",
    reviewerComment: "see attached redline",
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/findings/f-1/override");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.text, "Reviewer note text.");
  assert.equal(body.severity, "concern");
  assert.equal(body.category, "setback");
  assert.equal(body.reviewerComment, "see attached redline");
});

test("overrideFinding defaults reviewerComment to empty string when omitted", async () => {
  mockResponse = { status: 200, body: { finding: { id: "f-2" } } };
  await legacyClient.overrideFinding({
    findingId: "f-2",
    text: "x",
    severity: "blocker",
    category: "egress",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.reviewerComment, "");
});

test("fetchBriefing GETs /api/engagements/:id/briefing and passes briefing payload through", async () => {
  mockResponse = {
    status: 200,
    body: {
      briefing: {
        id: "br-1",
        sources: [],
        parcel: { id: "pcl-1" },
      },
    },
  };
  const res = await legacyClient.fetchBriefing({ engagementId: "eng-1" });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/briefing");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.deepEqual(res.briefing, {
    id: "br-1",
    sources: [],
    parcel: { id: "pcl-1" },
  });
});

test("fetchBriefing returns { briefing: null } when backend returns null", async () => {
  mockResponse = { status: 200, body: { briefing: null } };
  const res = await legacyClient.fetchBriefing({ engagementId: "eng-empty" });
  assert.equal(res.briefing, null);
});

test("fetchBriefing rethrows 404 as LegacyHttpError (unknown engagement is an input error)", async () => {
  mockResponse = { status: 404, body: { error: "engagement_not_found" } };
  await assert.rejects(
    () => legacyClient.fetchBriefing({ engagementId: "eng-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

test("createSubmission POSTs note + discipline against /engagements/:id/submissions", async () => {
  mockResponse = {
    status: 201,
    body: { submission: { id: "sub-new", engagementId: "eng-1" } },
  };
  await legacyClient.createSubmission({
    engagementId: "eng-1",
    note: "Permit set v1.",
    discipline: "zoning",
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/submissions");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.note, "Permit set v1.");
  assert.equal(body.discipline, "zoning");
});

test("createSubmission omits note and discipline keys when not supplied", async () => {
  mockResponse = {
    status: 201,
    body: { submission: { id: "sub-bare" } },
  };
  await legacyClient.createSubmission({ engagementId: "eng-2" });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal("note" in body, false);
  assert.equal("discipline" in body, false);
});

test("Bearer token header is sent when LEGACY_BACKEND_API_KEY is set", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "service-token-abc";
  mockResponse = {
    status: 200,
    body: { generationId: "g", state: "pending" },
  };
  await legacyClient.generateFindings({ submissionId: "s" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer service-token-abc");
});

test("No Authorization header when LEGACY_BACKEND_API_KEY is empty", async () => {
  delete process.env.LEGACY_BACKEND_API_KEY;
  mockResponse = {
    status: 200,
    body: { generationId: "g", state: "pending" },
  };
  await legacyClient.generateFindings({ submissionId: "s" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, undefined);
});

test("Network failure raises LegacyUnreachableError with the URL", async () => {
  mockResponse = {
    status: 500,
    body: {},
    throw: new TypeError("fetch failed"),
  };
  await assert.rejects(
    () => legacyClient.fetchBriefing({ engagementId: "eng-1" }),
    (err: unknown) =>
      err instanceof LegacyUnreachableError &&
      err.url.endsWith("/api/engagements/eng-1/briefing"),
  );
});

test("LEGACY_BACKEND_URL override changes the base URL", async () => {
  process.env.LEGACY_BACKEND_URL = "https://codex-backend.example.com";
  mockResponse = { status: 200, body: { briefing: null } };
  await legacyClient.fetchBriefing({ engagementId: "eng-1" });
  assert.equal(
    calls[0]!.url,
    "https://codex-backend.example.com/api/engagements/eng-1/briefing",
  );
});

test("listPropertyWorkspaces sends requester identity and limit", async () => {
  mockResponse = { status: 200, body: { workspaces: [] } };
  await legacyClient.listPropertyWorkspaces({
    requesterKeyId: "k_abc123",
    limit: 10,
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/brokerage/v1/workspaces");
  assert.equal(url.searchParams.get("requesterKeyId"), "k_abc123");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("getPropertyWorkspace sends workspace id + requester identity", async () => {
  mockResponse = { status: 200, body: { workspace: null } };
  await legacyClient.getPropertyWorkspace({
    workspaceId: "ws_123",
    requesterKeyId: "k_abc123",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/brokerage/v1/workspaces/ws_123");
  assert.equal(url.searchParams.get("requesterKeyId"), "k_abc123");
});

test("listWorkspaceShareEdges defaults to caller-specified consent filter", async () => {
  mockResponse = { status: 200, body: { edges: [] } };
  await legacyClient.listWorkspaceShareEdges({
    workspaceId: "ws_123",
    requesterKeyId: "k_abc123",
    consentVisibleOnly: true,
  });
  const url = new URL(calls[0]!.url);
  assert.equal(
    url.pathname,
    "/api/brokerage/v1/workspaces/ws_123/share-edges",
  );
  assert.equal(url.searchParams.get("requesterKeyId"), "k_abc123");
  assert.equal(url.searchParams.get("consentVisibleOnly"), "true");
});
