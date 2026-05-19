// Group 3 L5 — product-spec-reference client tests.
//
// Wire conformance for the four L5 legacy-client methods against a
// mocked fetch. The L5 endpoints are an MCP-first contract (built to
// match by cc-agent-C in Lane C.4), so e2e coverage waits on Lane C.4;
// this file is mocked-fetch only.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { lSurfaceProvenance } from "../src/atom-shape.js";
import {
  ESR_NUMBER_RE,
  LegacyHttpError,
  legacyClient,
  type ProductSpecReferenceAtom,
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

function reference(
  overrides: Partial<ProductSpecReferenceAtom> = {},
): ProductSpecReferenceAtom {
  return {
    entityType: "product-spec-reference",
    entityId: "psr-1",
    jurisdictionTenant: "legacy",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "https://icc-es.org/report-listing/ESR-1234/",
    contentHash: "hash-psr",
    product: {
      name: "Strong-Drive SDWS Timber Screw",
      manufacturer: "Simpson Strong-Tie",
    },
    esrNumber: "ESR-1234",
    status: "active",
    lastVerifiedAt: "2026-05-19T00:00:00Z",
    statusHistory: [],
    engagementId: "eng-1",
    findingId: null,
    responseTaskId: null,
    createdAt: "2026-05-19T00:00:00Z",
    actorId: null,
    principalActorId: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------
// ESR number format guard
// -----------------------------------------------------------------

test("ESR_NUMBER_RE matches well-formed ESR numbers and rejects garbage", () => {
  assert.equal(ESR_NUMBER_RE.test("ESR-1234"), true);
  assert.equal(ESR_NUMBER_RE.test("ESR-2929"), true);
  assert.equal(ESR_NUMBER_RE.test("ESR-"), false);
  assert.equal(ESR_NUMBER_RE.test("esr-1234"), false);
  assert.equal(ESR_NUMBER_RE.test("1234"), false);
  assert.equal(ESR_NUMBER_RE.test("ESR-12A4"), false);
});

// -----------------------------------------------------------------
// createProductSpecReference
// -----------------------------------------------------------------

test("createProductSpecReference POSTs to /api/engagements/:id/product-spec-references", async () => {
  mockResponse = { status: 201, body: { productSpecReference: reference() } };
  await legacyClient.createProductSpecReference({
    engagementId: "eng-1",
    product: { name: "SDWS Screw", manufacturer: "Simpson Strong-Tie" },
    esrNumber: "ESR-1234",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/product-spec-references");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.product.name, "SDWS Screw");
  assert.equal(body.product.manufacturer, "Simpson Strong-Tie");
  assert.equal(body.esrNumber, "ESR-1234");
});

test("createProductSpecReference forwards optional provenance fields", async () => {
  mockResponse = { status: 201, body: { productSpecReference: reference() } };
  await legacyClient.createProductSpecReference({
    engagementId: "eng-1",
    product: { name: "P", manufacturer: "M" },
    esrNumber: "ESR-9",
    findingId: "f-4",
    actorId: "actor-2",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.findingId, "f-4");
  assert.equal(body.actorId, "actor-2");
  assert.equal("responseTaskId" in body, false);
});

// -----------------------------------------------------------------
// refreshProductSpecReferenceStatus
// -----------------------------------------------------------------

test("refreshProductSpecReferenceStatus POSTs to the refresh route", async () => {
  mockResponse = {
    status: 200,
    body: {
      productSpecReference: reference({
        status: "withdrawn",
        statusHistory: [
          {
            status: "withdrawn",
            changedAt: "2026-05-19T06:00:00Z",
            sourceUrl: "https://icc-es.org/report-listing/ESR-1234/",
          },
        ],
      }),
    },
  };
  const res = await legacyClient.refreshProductSpecReferenceStatus({
    referenceId: "psr-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/product-spec-references/psr-1/refresh");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(res.productSpecReference.status, "withdrawn");
  assert.equal(res.productSpecReference.statusHistory.length, 1);
});

// -----------------------------------------------------------------
// listProductSpecReferences
// -----------------------------------------------------------------

test("listProductSpecReferences GETs /api/engagements/:id/product-spec-references", async () => {
  mockResponse = {
    status: 200,
    body: {
      productSpecReferences: [reference(), reference({ entityId: "psr-2" })],
    },
  };
  const res = await legacyClient.listProductSpecReferences({
    engagementId: "eng-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/engagements/eng-1/product-spec-references");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(url.searchParams.has("status"), false);
  assert.equal(res.productSpecReferences.length, 2);
});

test("listProductSpecReferences encodes the optional status filter", async () => {
  mockResponse = { status: 200, body: { productSpecReferences: [] } };
  await legacyClient.listProductSpecReferences({
    engagementId: "eng-1",
    status: "expired",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("status"), "expired");
});

// -----------------------------------------------------------------
// getProductSpecReference
// -----------------------------------------------------------------

test("getProductSpecReference GETs /api/product-spec-references/:id", async () => {
  mockResponse = { status: 200, body: { productSpecReference: reference() } };
  const res = await legacyClient.getProductSpecReference({
    referenceId: "psr-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/product-spec-references/psr-1");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.productSpecReference.esrNumber, "ESR-1234");
});

test("getProductSpecReference rethrows a 404 as LegacyHttpError", async () => {
  mockResponse = {
    status: 404,
    body: { error: "product_spec_reference_not_found" },
  };
  await assert.rejects(
    () =>
      legacyClient.getProductSpecReference({ referenceId: "psr-missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});

test("L5 methods send the bearer token when LEGACY_BACKEND_API_KEY is set", async () => {
  process.env.LEGACY_BACKEND_API_KEY = "svc-token";
  mockResponse = { status: 200, body: { productSpecReferences: [] } };
  await legacyClient.listProductSpecReferences({ engagementId: "eng-1" });
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, "Bearer svc-token");
});

// -----------------------------------------------------------------
// provenance — product-spec-reference carries a real DID
// -----------------------------------------------------------------

test("lSurfaceProvenance builds a real DID for a product-spec-reference atom", () => {
  const entry = lSurfaceProvenance(reference());
  assert.equal(entry.did, "did:hauska:product-spec-reference:psr-1");
  assert.equal(entry.entityType, "product-spec-reference");
  assert.equal(entry.contentHash, "hash-psr");
  // sourceUrl carries the ICC-ES listing URL.
  assert.equal(
    entry.source.url,
    "https://icc-es.org/report-listing/ESR-1234/",
  );
});
