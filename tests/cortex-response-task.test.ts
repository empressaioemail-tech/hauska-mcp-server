// Group 3 L1 — response-task client + provenance tests.
//
// Wire conformance for the four L1 legacy-client methods against a
// mocked fetch, plus the lSurfaceProvenance helper and the array-aware
// codexEnvelope. The L1 endpoints are an MCP-first contract (built to
// match by cc-agent-C in Lane C.4), so e2e coverage waits on Lane C.4;
// this file is mocked-fetch only.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import {
  codexEnvelope,
  lSurfaceProvenance,
  type LSurfaceAtomBase,
} from "../src/atom-shape.js";
import {
  LegacyHttpError,
  legacyClient,
  type ResponseTaskAtom,
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
  delete process.env.LEGACY_BACKEND_URL;
  delete process.env.LEGACY_BACKEND_API_KEY;
});

function atom(overrides: Partial<ResponseTaskAtom> = {}): ResponseTaskAtom {
  return {
    entityType: "response-task",
    entityId: "rt-1",
    jurisdictionTenant: "legacy",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "/api/response-tasks/rt-1",
    contentHash: "abc123",
    title: "Resolve setback comment",
    description: "Client flagged the east setback.",
    state: "open",
    createdAt: "2026-05-19T00:00:00Z",
    dueAt: null,
    completedAt: null,
    sourceClientCommentId: null,
    findingId: null,
    engagementId: "eng-1",
    actorId: null,
    principalActorId: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------
// createResponseTask
// -----------------------------------------------------------------

test("createResponseTask POSTs to /api/engagements/:id/response-tasks", async () => {
  mockResponse = { status: 201, body: { responseTask: atom() } };
  await legacyClient.createResponseTask({
    engagementId: "eng-1",
    title: "Resolve setback comment",
    description: "Client flagged the east setback.",
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/response-tasks");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.title, "Resolve setback comment");
  assert.equal(body.description, "Client flagged the east setback.");
});

test("createResponseTask includes optional link + actor fields only when supplied", async () => {
  mockResponse = { status: 201, body: { responseTask: atom() } };
  await legacyClient.createResponseTask({
    engagementId: "eng-1",
    title: "t",
    description: "d",
    sourceClientCommentId: "cc-9",
    findingId: "f-2",
    dueAt: "2026-06-01T00:00:00Z",
    actorId: "actor-7",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.sourceClientCommentId, "cc-9");
  assert.equal(body.findingId, "f-2");
  assert.equal(body.dueAt, "2026-06-01T00:00:00Z");
  assert.equal(body.actorId, "actor-7");
  assert.equal("principalActorId" in body, false);
});

test("createResponseTask omits all optional keys when not supplied", async () => {
  mockResponse = { status: 201, body: { responseTask: atom() } };
  await legacyClient.createResponseTask({
    engagementId: "eng-1",
    title: "t",
    description: "d",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(Object.keys(body).sort(), ["description", "title"]);
});

// -----------------------------------------------------------------
// updateResponseTaskState
// -----------------------------------------------------------------

test("updateResponseTaskState POSTs the new state to /state", async () => {
  mockResponse = {
    status: 200,
    body: { responseTask: atom({ state: "in-progress" }) },
  };
  const res = await legacyClient.updateResponseTaskState({
    responseTaskId: "rt-1",
    state: "in-progress",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/response-tasks/rt-1/state");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.state, "in-progress");
  assert.equal(res.responseTask.state, "in-progress");
});

test("updateResponseTaskState rethrows a 409 forbidden transition as LegacyHttpError", async () => {
  mockResponse = {
    status: 409,
    body: { error: "response_task_transition_forbidden" },
  };
  await assert.rejects(
    () =>
      legacyClient.updateResponseTaskState({
        responseTaskId: "rt-1",
        state: "done",
      }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 409,
  );
});

// -----------------------------------------------------------------
// listResponseTasks
// -----------------------------------------------------------------

test("listResponseTasks GETs /api/engagements/:id/response-tasks", async () => {
  mockResponse = {
    status: 200,
    body: { responseTasks: [atom(), atom({ entityId: "rt-2" })] },
  };
  const res = await legacyClient.listResponseTasks({ engagementId: "eng-1" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/response-tasks");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(url.searchParams.has("state"), false);
  assert.equal(res.responseTasks.length, 2);
});

test("listResponseTasks encodes the optional state filter", async () => {
  mockResponse = { status: 200, body: { responseTasks: [] } };
  await legacyClient.listResponseTasks({
    engagementId: "eng-1",
    state: "done",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("state"), "done");
});

// -----------------------------------------------------------------
// linkResponseTaskFinding
// -----------------------------------------------------------------

test("linkResponseTaskFinding POSTs the findingId to /link-finding", async () => {
  mockResponse = {
    status: 200,
    body: { responseTask: atom({ findingId: "f-42" }) },
  };
  const res = await legacyClient.linkResponseTaskFinding({
    responseTaskId: "rt-1",
    findingId: "f-42",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/response-tasks/rt-1/link-finding");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.findingId, "f-42");
  assert.equal(res.responseTask.findingId, "f-42");
});

test("L1 methods send the bearer token when LEGACY_BACKEND_API_KEY is set", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "svc-token";
  mockResponse = { status: 200, body: { responseTasks: [] } };
  await legacyClient.listResponseTasks({ engagementId: "eng-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer svc-token");
});

// -----------------------------------------------------------------
// lSurfaceProvenance + array-aware codexEnvelope
// -----------------------------------------------------------------

test("lSurfaceProvenance builds a real did:hauska DID from an L-surface atom", () => {
  const base: LSurfaceAtomBase = {
    entityType: "response-task",
    entityId: "rt-7",
    jurisdictionTenant: "legacy",
    contentHash: "hash-7",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "/api/response-tasks/rt-7",
    fetchedAt: "2026-05-19T00:00:00Z",
  };
  const entry = lSurfaceProvenance(base);
  assert.equal(entry.did, "did:hauska:response-task:rt-7");
  assert.equal(entry.entityType, "response-task");
  assert.equal(entry.entityId, "rt-7");
  assert.equal(entry.contentHash, "hash-7");
  assert.equal(entry.source.adapter, "legacy-design-tools");
});

test("codexEnvelope accepts a single provenance entry", () => {
  const env = codexEnvelope(
    { responseTask: atom() },
    lSurfaceProvenance(atom()),
    { tier: "developer_pro" },
  );
  assert.equal(env.atoms.length, 1);
  assert.equal(env.atoms[0]?.did, "did:hauska:response-task:rt-1");
});

test("codexEnvelope accepts an array of provenance entries (list tools)", () => {
  const env = codexEnvelope(
    { responseTasks: [atom(), atom({ entityId: "rt-2" })] },
    [atom(), atom({ entityId: "rt-2" })].map(lSurfaceProvenance),
    { tier: "developer_pro" },
  );
  assert.equal(env.atoms.length, 2);
  assert.deepEqual(
    env.atoms.map((a) => a.entityId),
    ["rt-1", "rt-2"],
  );
});

test("codexEnvelope still accepts null (empty atoms array)", () => {
  const env = codexEnvelope({ responseTasks: [] }, null, {
    tier: "developer_pro",
  });
  assert.equal(env.atoms.length, 0);
});
