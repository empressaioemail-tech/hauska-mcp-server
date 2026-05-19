// Group 3 L6 — deliverable-letter-render client tests.
//
// Wire conformance for the two L6 legacy-client methods against a
// mocked fetch. The L6 endpoints are an MCP-first contract (built to
// match by cc-agent-C in Lane C.4), so e2e coverage waits on Lane C.4;
// this file is mocked-fetch only. L6 closes Group 3.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { lSurfaceProvenance } from "../src/atom-shape.js";
import {
  LegacyHttpError,
  legacyClient,
  type DeliverableLetterRenderAtom,
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

function render(
  overrides: Partial<DeliverableLetterRenderAtom> = {},
): DeliverableLetterRenderAtom {
  return {
    entityType: "deliverable-letter-render",
    entityId: "dlr-1",
    jurisdictionTenant: "legacy",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "/api/deliverable-letters/dl-1/renders/dlr-1",
    contentHash: "hash-dlr",
    sourceLetterRef: "did:hauska:deliverable-letter:dl-1",
    sourceLetterVersion: "letter-hash-v1",
    format: "pdf",
    blobRef: "blob://renders/dlr-1.pdf",
    renderedAt: "2026-05-19T12:00:00Z",
    renderedByActorId: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------
// renderDeliverableLetter
// -----------------------------------------------------------------

test("renderDeliverableLetter POSTs to /api/deliverable-letters/:id/renders", async () => {
  mockResponse = {
    status: 201,
    body: { render: render(), downloadUrl: "https://signed.example/dlr-1.pdf" },
  };
  const res = await legacyClient.renderDeliverableLetter({
    letterId: "dl-1",
    format: "pdf",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/deliverable-letters/dl-1/renders");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.format, "pdf");
  assert.equal(res.render.entityId, "dlr-1");
  assert.equal(res.downloadUrl, "https://signed.example/dlr-1.pdf");
});

test("renderDeliverableLetter forwards the optional renderedByActorId", async () => {
  mockResponse = { status: 201, body: { render: render({ format: "docx" }) } };
  await legacyClient.renderDeliverableLetter({
    letterId: "dl-1",
    format: "docx",
    renderedByActorId: "actor-5",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.format, "docx");
  assert.equal(body.renderedByActorId, "actor-5");
});

test("renderDeliverableLetter omits renderedByActorId when not supplied", async () => {
  mockResponse = { status: 201, body: { render: render() } };
  await legacyClient.renderDeliverableLetter({
    letterId: "dl-1",
    format: "pdf",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal("renderedByActorId" in body, false);
});

test("renderDeliverableLetter rethrows the 409 incomplete-letter conflict", async () => {
  mockResponse = {
    status: 409,
    body: {
      error: "deliverable_letter_incomplete",
      missing: ["signature"],
    },
  };
  await assert.rejects(
    () =>
      legacyClient.renderDeliverableLetter({
        letterId: "dl-1",
        format: "pdf",
      }),
    (err: unknown) => {
      if (!(err instanceof LegacyHttpError) || err.status !== 409) return false;
      const parsed = JSON.parse(err.body) as { missing?: string[] };
      assert.deepEqual(parsed.missing, ["signature"]);
      return true;
    },
  );
});

// -----------------------------------------------------------------
// listDeliverableLetterRenders
// -----------------------------------------------------------------

test("listDeliverableLetterRenders GETs /api/deliverable-letters/:id/renders", async () => {
  mockResponse = {
    status: 200,
    body: {
      renders: [
        render(),
        render({ entityId: "dlr-2", format: "docx" }),
      ],
    },
  };
  const res = await legacyClient.listDeliverableLetterRenders({
    letterId: "dl-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/deliverable-letters/dl-1/renders");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.renders.length, 2);
  assert.equal(res.renders[1]?.format, "docx");
});

test("listDeliverableLetterRenders rethrows a 404 as LegacyHttpError", async () => {
  mockResponse = {
    status: 404,
    body: { error: "deliverable_letter_not_found" },
  };
  await assert.rejects(
    () =>
      legacyClient.listDeliverableLetterRenders({ letterId: "dl-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

test("L6 methods send the bearer token when LEGACY_BACKEND_API_KEY is set", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "svc-token";
  mockResponse = { status: 200, body: { renders: [] } };
  await legacyClient.listDeliverableLetterRenders({ letterId: "dl-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer svc-token");
});

// -----------------------------------------------------------------
// provenance — deliverable-letter-render carries a real DID
// -----------------------------------------------------------------

test("lSurfaceProvenance builds a real DID for a deliverable-letter-render atom", () => {
  const entry = lSurfaceProvenance(render());
  assert.equal(entry.did, "did:hauska:deliverable-letter-render:dlr-1");
  assert.equal(entry.entityType, "deliverable-letter-render");
  assert.equal(entry.contentHash, "hash-dlr");
});
