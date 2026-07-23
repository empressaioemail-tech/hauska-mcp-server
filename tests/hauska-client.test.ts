// hauska-client wire conformance against a mocked fetch.
//
// Validates URL shape, query param encoding, and the 404-to-null fallback
// for get_atom and query_jurisdiction. Does NOT spin up the real engine;
// integration coverage against a live retrieval-api is end-to-end work
// (REPO_NOTES local-dev sequence covers that path).

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import {
  EngineHttpError,
  EngineUnreachableError,
  hauskaClient,
} from "../src/hauska-client.js";

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
  delete process.env.HAUSKA_ENGINE_API_KEY;
  delete process.env.HAUSKA_BACKEND_URL;
});

test("searchAtoms hits GET /search with q + optional jurisdiction + limit", async () => {
  mockResponse = { status: 200, body: { results: [], totalCandidates: 0 } };
  await hauskaClient.searchAtoms({
    query: "setbacks",
    jurisdiction: "bastrop-tx",
    limit: 50,
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "setbacks");
  assert.equal(url.searchParams.get("jurisdiction"), "bastrop-tx");
  assert.equal(url.searchParams.get("limit"), "50");
});

test("searchAtoms omits jurisdiction and entityType when not provided", async () => {
  mockResponse = { status: 200, body: { results: [], totalCandidates: 0 } };
  await hauskaClient.searchAtoms({ query: "lot" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.has("jurisdiction"), false);
  assert.equal(url.searchParams.has("entityType"), false);
  assert.equal(url.searchParams.has("limit"), false);
});

test("getPropertyAtomChain hits GET /property-nodes/:id/atom-chain and 404 returns null", async () => {
  mockResponse = { status: 404, body: { error: "not found" } };
  const res = await hauskaClient.getPropertyAtomChain({ parcelNodeId: "48209:156346" });
  assert.equal(res, null);
  const url = new URL(calls[0]!.url);
  assert.ok(url.pathname.includes("/property-nodes/48209%3A156346/atom-chain"));
});

test("getPropertyAtomChain returns wire body on 200", async () => {
  mockResponse = {
    status: 200,
    body: {
      parcelNodeId: "48209:156346",
      zoningFact: null,
      setbackRule: null,
      buildableEnvelope: null,
    },
  };
  const res = await hauskaClient.getPropertyAtomChain({ parcelNodeId: "48209:156346" });
  assert.equal(res?.parcelNodeId, "48209:156346");
});

test("getAtom URL-encodes the DID and includeComposition", async () => {
  mockResponse = { status: 200, body: { atom: null } };
  await hauskaClient.getAtom({
    atomDid: "did:hauska:code-section:bastrop-tx/udc-2024/5.04",
    includeComposition: true,
  });
  const url = new URL(calls[0]!.url);
  // encodeURIComponent percent-encodes "/" and ":" in the DID body
  assert.ok(
    url.pathname.startsWith("/atoms/did%3Ahauska%3Acode-section%3A"),
    `unexpected path: ${url.pathname}`,
  );
  assert.equal(url.searchParams.get("includeComposition"), "true");
});

test("getAtom returns {atom: null} when the engine 404s instead of throwing", async () => {
  mockResponse = { status: 404, body: { error: "atom not found" } };
  const res = await hauskaClient.getAtom({
    atomDid: "did:hauska:code-section:nope",
  });
  assert.deepEqual(res, { atom: null });
});

test("getAtom rethrows non-404 HTTP errors as EngineHttpError", async () => {
  mockResponse = { status: 500, body: { error: "internal" } };
  await assert.rejects(
    () => hauskaClient.getAtom({ atomDid: "did:hauska:code-section:x" }),
    (err: unknown) => err instanceof EngineHttpError && err.status === 500,
  );
});

test("listJurisdictions appends qualityBarOnly only when truthy", async () => {
  mockResponse = { status: 200, body: { jurisdictions: [] } };
  await hauskaClient.listJurisdictions();
  let url = new URL(calls[0]!.url);
  assert.equal(url.search, "");
  await hauskaClient.listJurisdictions({ qualityBarOnly: true });
  url = new URL(calls[1]!.url);
  assert.equal(url.searchParams.get("qualityBarOnly"), "true");
});

test("queryJurisdiction returns {status: null} on 404", async () => {
  mockResponse = { status: 404, body: { error: "jurisdiction not found" } };
  const res = await hauskaClient.queryJurisdiction({ jurisdiction: "nope" });
  assert.deepEqual(res, { status: null });
});

test("searchPermitAtoms requires projectType and hits the /permits route", async () => {
  mockResponse = {
    status: 200,
    body: { status: null, permitAtoms: [] },
  };
  await hauskaClient.searchPermitAtoms({
    jurisdiction: "bastrop-tx",
    projectType: "single-family residence",
  });
  const url = new URL(calls[0]!.url);
  assert.ok(url.pathname.endsWith("/permits"), url.pathname);
  assert.equal(url.searchParams.get("projectType"), "single-family residence");
});

test("Bearer token header is sent when HAUSKA_ENGINE_API_KEY is set", async () => {
  process.env.HAUSKA_ENGINE_API_KEY = "secret-token";
  mockResponse = { status: 200, body: { results: [], totalCandidates: 0 } };
  await hauskaClient.searchAtoms({ query: "x" });
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer secret-token");
});

test("No Authorization header when HAUSKA_ENGINE_API_KEY is empty", async () => {
  delete process.env.HAUSKA_ENGINE_API_KEY;
  mockResponse = { status: 200, body: { results: [], totalCandidates: 0 } };
  await hauskaClient.searchAtoms({ query: "x" });
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers["authorization"], undefined);
});

test("Network failure raises EngineUnreachableError with the URL", async () => {
  mockResponse = {
    status: 0,
    body: null,
    throw: new TypeError("fetch failed"),
  };
  await assert.rejects(
    () => hauskaClient.searchAtoms({ query: "x" }),
    (err: unknown) =>
      err instanceof EngineUnreachableError &&
      err.url.endsWith("/search?q=x"),
  );
});

test("HAUSKA_BACKEND_URL override changes the base URL", async () => {
  process.env.HAUSKA_BACKEND_URL = "https://engine.example.com";
  mockResponse = { status: 200, body: { jurisdictions: [] } };
  await hauskaClient.listJurisdictions();
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin, "https://engine.example.com");
});
