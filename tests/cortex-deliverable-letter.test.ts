// Group 3 L3 — deliverable-letter client tests.
//
// Wire conformance for the five L3 legacy-client methods against a
// mocked fetch. The L3 endpoints are an MCP-first contract (built to
// match by cc-agent-C in Lane C.4), so e2e coverage waits on Lane C.4;
// this file is mocked-fetch only.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { lSurfaceProvenance } from "../src/atom-shape.js";
import {
  LegacyHttpError,
  legacyClient,
  type DeliverableLetterAtom,
  type LetterSection,
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

function section(kind: LetterSection["kind"]): LetterSection {
  return {
    kind,
    heading: `${kind} heading`,
    content: `${kind} content`,
    provenance: {
      responseTaskIds: [],
      sheetContentExtractionIds: [],
      findingIds: [],
      adjudicationStateIds: [],
    },
  };
}

function letter(
  overrides: Partial<DeliverableLetterAtom> = {},
): DeliverableLetterAtom {
  return {
    entityType: "deliverable-letter",
    entityId: "dl-1",
    jurisdictionTenant: "legacy",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "/api/deliverable-letters/dl-1",
    contentHash: "hash-dl",
    engagementId: "eng-1",
    title: "Comment Response Letter",
    status: "draft",
    recipientActorId: null,
    sections: [],
    createdAt: "2026-05-19T00:00:00Z",
    sentAt: null,
    actorId: null,
    principalActorId: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------
// createDeliverableLetter
// -----------------------------------------------------------------

test("createDeliverableLetter POSTs to /api/engagements/:id/deliverable-letters", async () => {
  mockResponse = { status: 201, body: { deliverableLetter: letter() } };
  await legacyClient.createDeliverableLetter({
    engagementId: "eng-1",
    title: "Comment Response Letter",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/deliverable-letters");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.title, "Comment Response Letter");
  assert.equal("sections" in body, false);
});

test("createDeliverableLetter forwards optional initial sections", async () => {
  mockResponse = {
    status: 201,
    body: { deliverableLetter: letter({ sections: [section("cover")] }) },
  };
  await legacyClient.createDeliverableLetter({
    engagementId: "eng-1",
    title: "L",
    sections: [{ kind: "cover", heading: "Cover", content: "..." }],
    recipientActorId: "client-3",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.sections.length, 1);
  assert.equal(body.sections[0].kind, "cover");
  assert.equal(body.recipientActorId, "client-3");
});

// -----------------------------------------------------------------
// updateDeliverableLetterSection
// -----------------------------------------------------------------

test("updateDeliverableLetterSection POSTs the section upsert by index", async () => {
  mockResponse = {
    status: 200,
    body: { deliverableLetter: letter({ sections: [section("intro")] }) },
  };
  await legacyClient.updateDeliverableLetterSection({
    letterId: "dl-1",
    sectionIndex: 0,
    kind: "intro",
    heading: "Introduction",
    content: "This letter responds to...",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/deliverable-letters/dl-1/sections");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.sectionIndex, 0);
  assert.equal(body.kind, "intro");
  assert.equal(body.heading, "Introduction");
});

// -----------------------------------------------------------------
// attachDeliverableLetterProvenance
// -----------------------------------------------------------------

test("attachDeliverableLetterProvenance POSTs to the section provenance route", async () => {
  mockResponse = { status: 200, body: { deliverableLetter: letter() } };
  await legacyClient.attachDeliverableLetterProvenance({
    letterId: "dl-1",
    sectionIndex: 2,
    findingIds: ["f-1", "f-2"],
    responseTaskIds: ["rt-9"],
  });
  const url = new URL(calls[0]!.url);
  assert.equal(
    url.pathname,
    "/api/deliverable-letters/dl-1/sections/2/provenance",
  );
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(body.findingIds, ["f-1", "f-2"]);
  assert.deepEqual(body.responseTaskIds, ["rt-9"]);
  assert.equal("sheetContentExtractionIds" in body, false);
  assert.equal("adjudicationStateIds" in body, false);
});

// -----------------------------------------------------------------
// checkDeliverableLetterCompleteness
// -----------------------------------------------------------------

test("checkDeliverableLetterCompleteness GETs the completeness route", async () => {
  mockResponse = {
    status: 200,
    body: { complete: false, missing: ["cover", "signature"] },
  };
  const res = await legacyClient.checkDeliverableLetterCompleteness({
    letterId: "dl-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/deliverable-letters/dl-1/completeness");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.complete, false);
  assert.deepEqual(res.missing, ["cover", "signature"]);
});

test("checkDeliverableLetterCompleteness reports a complete letter", async () => {
  mockResponse = { status: 200, body: { complete: true, missing: [] } };
  const res = await legacyClient.checkDeliverableLetterCompleteness({
    letterId: "dl-2",
  });
  assert.equal(res.complete, true);
  assert.equal(res.missing.length, 0);
});

// -----------------------------------------------------------------
// sendDeliverableLetter
// -----------------------------------------------------------------

test("sendDeliverableLetter POSTs to the send route and returns the sent letter", async () => {
  mockResponse = {
    status: 200,
    body: {
      deliverableLetter: letter({
        status: "sent",
        sentAt: "2026-05-19T12:00:00Z",
      }),
    },
  };
  const res = await legacyClient.sendDeliverableLetter({ letterId: "dl-1" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/deliverable-letters/dl-1/send");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(res.deliverableLetter.status, "sent");
  assert.equal(res.deliverableLetter.sentAt, "2026-05-19T12:00:00Z");
});

test("sendDeliverableLetter rethrows the 409 incomplete-letter conflict", async () => {
  mockResponse = {
    status: 409,
    body: {
      error: "deliverable_letter_incomplete",
      missing: ["cover", "signature"],
    },
  };
  await assert.rejects(
    () => legacyClient.sendDeliverableLetter({ letterId: "dl-1" }),
    (err: unknown) => {
      if (!(err instanceof LegacyHttpError) || err.status !== 409) return false;
      const parsed = JSON.parse(err.body) as { missing?: string[] };
      assert.deepEqual(parsed.missing, ["cover", "signature"]);
      return true;
    },
  );
});

test("L3 methods send the bearer token when LEGACY_BACKEND_API_KEY is set", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "svc-token";
  mockResponse = { status: 200, body: { complete: true, missing: [] } };
  await legacyClient.checkDeliverableLetterCompleteness({ letterId: "dl-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer svc-token");
});

// -----------------------------------------------------------------
// provenance — deliverable-letter carries a real DID
// -----------------------------------------------------------------

test("lSurfaceProvenance builds a real DID for a deliverable-letter atom", () => {
  const entry = lSurfaceProvenance(letter());
  assert.equal(entry.did, "did:hauska:deliverable-letter:dl-1");
  assert.equal(entry.entityType, "deliverable-letter");
  assert.equal(entry.contentHash, "hash-dl");
});
