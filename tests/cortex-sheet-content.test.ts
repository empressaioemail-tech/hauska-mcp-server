// Group 3 L2 — sheet-content-extraction + attached-document client tests.
//
// Wire conformance for the four L2 legacy-client methods against a
// mocked fetch. The L2 endpoints are an MCP-first contract (built to
// match by cc-agent-C in Lane C.4), so e2e coverage waits on Lane C.4;
// this file is mocked-fetch only.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { lSurfaceProvenance } from "../src/atom-shape.js";
import {
  LegacyHttpError,
  legacyClient,
  type AttachedDocumentAtom,
  type SheetContentExtractionAtom,
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

function extraction(
  overrides: Partial<SheetContentExtractionAtom> = {},
): SheetContentExtractionAtom {
  return {
    entityType: "sheet-content-extraction",
    entityId: "sce-1",
    jurisdictionTenant: "legacy",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "/api/sheets/sheet-1/content-extraction",
    contentHash: "hash-sce",
    sourceSheetId: "sheet-1",
    engagementId: "eng-1",
    pageLabel: "A-101",
    extractedTextSegments: [
      {
        text: "SETBACK 25'",
        boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        sourceConfidence: 0.97,
      },
    ],
    structuredAnnotations: [
      {
        kind: "dimension",
        position: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        content: "25'-0\"",
        sourceConfidence: 0.95,
      },
    ],
    ocrModel: "claude-sonnet-4-5",
    actorId: null,
    ...overrides,
  };
}

function document(
  overrides: Partial<AttachedDocumentAtom> = {},
): AttachedDocumentAtom {
  return {
    entityType: "attached-document",
    entityId: "doc-1",
    jurisdictionTenant: "legacy",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "/api/attached-documents/doc-1",
    contentHash: "hash-doc",
    engagementId: "eng-1",
    title: "Structural Calculations",
    documentType: "calculation",
    extractedText: "Load path summary...",
    originalBlobRef: "blob://doc-1",
    actorId: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------
// sheet-content-extraction
// -----------------------------------------------------------------

test("triggerSheetContentExtraction POSTs to /api/sheets/:id/content-extraction", async () => {
  mockResponse = {
    status: 200,
    body: { sheetContentExtraction: extraction() },
  };
  const res = await legacyClient.triggerSheetContentExtraction({
    sheetId: "sheet-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/sheets/sheet-1/content-extraction");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(res.sheetContentExtraction?.entityId, "sce-1");
  assert.equal(res.sheetContentExtraction?.extractedTextSegments.length, 1);
  assert.equal(res.sheetContentExtraction?.structuredAnnotations[0]?.kind, "dimension");
});

test("fetchSheetContentExtraction GETs the extraction", async () => {
  mockResponse = {
    status: 200,
    body: { sheetContentExtraction: extraction() },
  };
  const res = await legacyClient.fetchSheetContentExtraction({
    sheetId: "sheet-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/sheets/sheet-1/content-extraction");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.sheetContentExtraction?.pageLabel, "A-101");
});

test("fetchSheetContentExtraction returns null when the sheet is not extracted yet", async () => {
  mockResponse = { status: 200, body: { sheetContentExtraction: null } };
  const res = await legacyClient.fetchSheetContentExtraction({
    sheetId: "sheet-unextracted",
  });
  assert.equal(res.sheetContentExtraction, null);
});

test("triggerSheetContentExtraction rethrows a 404 unknown-sheet as LegacyHttpError", async () => {
  mockResponse = { status: 404, body: { error: "sheet_not_found" } };
  await assert.rejects(
    () =>
      legacyClient.triggerSheetContentExtraction({ sheetId: "sheet-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

// -----------------------------------------------------------------
// attached-document
// -----------------------------------------------------------------

test("listAttachedDocuments GETs /api/engagements/:id/attached-documents", async () => {
  mockResponse = {
    status: 200,
    body: { attachedDocuments: [document(), document({ entityId: "doc-2" })] },
  };
  const res = await legacyClient.listAttachedDocuments({
    engagementId: "eng-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/attached-documents");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(url.searchParams.has("documentType"), false);
  assert.equal(res.attachedDocuments.length, 2);
});

test("listAttachedDocuments encodes the optional documentType filter", async () => {
  mockResponse = { status: 200, body: { attachedDocuments: [] } };
  await legacyClient.listAttachedDocuments({
    engagementId: "eng-1",
    documentType: "specification",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("documentType"), "specification");
});

test("fetchAttachedDocument GETs /api/attached-documents/:id", async () => {
  mockResponse = { status: 200, body: { attachedDocument: document() } };
  const res = await legacyClient.fetchAttachedDocument({
    attachedDocumentId: "doc-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/attached-documents/doc-1");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.attachedDocument.documentType, "calculation");
  assert.equal(res.attachedDocument.extractedText, "Load path summary...");
});

test("fetchAttachedDocument rethrows a 404 as LegacyHttpError", async () => {
  mockResponse = { status: 404, body: { error: "attached_document_not_found" } };
  await assert.rejects(
    () =>
      legacyClient.fetchAttachedDocument({ attachedDocumentId: "doc-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

test("L2 methods send the bearer token when LEGACY_BACKEND_API_KEY is set", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "svc-token";
  mockResponse = { status: 200, body: { attachedDocuments: [] } };
  await legacyClient.listAttachedDocuments({ engagementId: "eng-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer svc-token");
});

// -----------------------------------------------------------------
// provenance — L2 atoms carry real DIDs
// -----------------------------------------------------------------

test("lSurfaceProvenance builds a real DID for a sheet-content-extraction atom", () => {
  const entry = lSurfaceProvenance(extraction());
  assert.equal(entry.did, "did:hauska:sheet-content-extraction:sce-1");
  assert.equal(entry.entityType, "sheet-content-extraction");
  assert.equal(entry.contentHash, "hash-sce");
});

test("lSurfaceProvenance builds a real DID for an attached-document atom", () => {
  const entry = lSurfaceProvenance(document());
  assert.equal(entry.did, "did:hauska:attached-document:doc-1");
  assert.equal(entry.entityType, "attached-document");
  assert.equal(entry.contentHash, "hash-doc");
});
