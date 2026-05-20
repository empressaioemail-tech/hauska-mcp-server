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

// -----------------------------------------------------------------
// downloadDeliverableLetterRender — GET .../renders/:id/file (Amendment 8)
//
// The byte-serve endpoint returns the file itself, not a JSON envelope.
// These tests use a binary-body fetch mock instead of the JSON mock in
// beforeEach (afterEach still restores the real fetch).
// -----------------------------------------------------------------

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("downloadDeliverableLetterRender GETs the byte-serve endpoint and lifts headers", async () => {
  const fileBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(fileBytes, {
      status: 200,
      headers: {
        "content-type": DOCX_MIME,
        "content-disposition": 'attachment; filename="dl-1-2026-05-20.docx"',
      },
    });
  }) as typeof fetch;

  const res = await legacyClient.downloadDeliverableLetterRender({
    renderId: "dlr-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/deliverable-letter-renders/dlr-1/file");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.contentType, DOCX_MIME);
  assert.equal(res.filename, "dl-1-2026-05-20.docx");
  assert.deepEqual(Array.from(res.bytes), [0x50, 0x4b, 0x03, 0x04]);
});

test("downloadDeliverableLetterRender falls back to a default filename", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }) as typeof fetch;

  const res = await legacyClient.downloadDeliverableLetterRender({
    renderId: "dlr-9",
  });
  assert.equal(res.filename, "dlr-9.pdf");
  assert.equal(res.contentType, "application/pdf");
});

test("downloadDeliverableLetterRender sends the bearer token", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "svc-token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(new Uint8Array([0]), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }) as typeof fetch;
  await legacyClient.downloadDeliverableLetterRender({ renderId: "dlr-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer svc-token");
});

test("downloadDeliverableLetterRender rethrows a 404 as LegacyHttpError", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({ error: "deliverable_letter_not_found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  await assert.rejects(
    () =>
      legacyClient.downloadDeliverableLetterRender({ renderId: "dlr-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});
