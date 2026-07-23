// Tier 1 MCP build-out — legacy-client contract + product gate tests.
//
// Mock-fetch only; e2e against live cortex-api is blocked on cc-agent-C
// service-auth seam for brief + encumbrances.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import {
  credentialPendingEnvelope,
  generateBriefEnvelope,
} from "../src/atom-shape.js";
import type { AuthContext } from "../src/auth.js";
import {
  cotalityCredentialsConfigured,
  legacyClient,
} from "../src/legacy-client.js";
import { requestContext } from "../src/request-context.js";
import { requireProduct } from "../src/tools.js";

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
  delete process.env.LEGACY_MCP_SERVICE_TOKEN;
  delete process.env.COTALITY_CLIENT_ID;
  delete process.env.COTALITY_CLIENT_SECRET;
});

function withCtx<T>(ctx: AuthContext, fn: () => T | Promise<T>): T | Promise<T> {
  return requestContext.run(ctx, fn);
}

test("generateBrief POSTs /api/brokerage/v1/brief with address body", async () => {
  mockResponse = {
    status: 200,
    body: {
      runId: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-06-06T00:00:00.000Z",
      finishedAt: "2026-06-06T00:00:30.000Z",
      jurisdiction: "round-rock-tx",
      corpusStatus: "loaded",
      reasoningSummary: "Reasoning text.",
      laySummary: "Lay text.",
      atoms: {
        workspaceDid: "did:hauska:property-workspace:lk1",
        briefRunDid: "did:hauska:brief-run:11111111-1111-4111-8111-111111111111",
        placeLayers: [],
        citationRefs: [],
        inlineRefs: [
          {
            did: "did:hauska:code-section:round-rock-tx/udc/5.04",
            entityType: "code-section",
            entityId: "round-rock-tx/udc/5.04",
            label: "Setbacks",
            mode: "inline",
          },
        ],
      },
    },
  };

  const res = await legacyClient.generateBrief({
    address: "1904 Heathwood Cir, Round Rock, TX",
    presentationMode: "consumer",
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/brokerage/v1/brief");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.address, "1904 Heathwood Cir, Round Rock, TX");
  assert.equal(body.presentationMode, "consumer");
  assert.equal(res.runId, "11111111-1111-4111-8111-111111111111");
});

test("generateBrief sends x-hauska-mcp-service when LEGACY_MCP_SERVICE_TOKEN is set", async () => {
  process.env.LEGACY_MCP_SERVICE_TOKEN = "svc-token";
  mockResponse = {
    status: 200,
    body: {
      runId: "22222222-2222-4222-8222-222222222222",
      startedAt: "2026-06-06T00:00:00.000Z",
      finishedAt: "2026-06-06T00:00:01.000Z",
      jurisdiction: "bastrop-tx",
      corpusStatus: "loaded",
    },
  };
  await legacyClient.generateBrief({ address: "1 Main St" });
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers["x-hauska-mcp-service"], "svc-token");
});

test("getBriefRun GETs /api/brokerage/v1/brief/:runId", async () => {
  const runId = "33333333-3333-4333-8333-333333333333";
  mockResponse = {
    status: 200,
    body: {
      runId,
      startedAt: "2026-06-06T00:00:00.000Z",
      finishedAt: "2026-06-06T00:00:01.000Z",
      jurisdiction: "bastrop-tx",
      corpusStatus: "loaded",
    },
  };
  await legacyClient.getBriefRun({ runId });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, `/api/brokerage/v1/brief/${runId}`);
  assert.equal(calls[0]!.init?.method, "GET");
});

test("refreshSiteDrainage POSTs site-drainage/refresh", async () => {
  const engagementId = "44444444-4444-4444-8444-444444444444";
  mockResponse = {
    status: 200,
    body: {
      status: "ok",
      materializableElementId: "sd-1",
      flowLineCount: 12,
    },
  };
  await legacyClient.refreshSiteDrainage({
    engagementId,
    manualDepthInches: 4,
  });
  const url = new URL(calls[0]!.url);
  assert.equal(
    url.pathname,
    `/api/engagements/${engagementId}/site-drainage/refresh`,
  );
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.manualDepthInches, 4);
});

test("searchEncumbrances GETs workspace encumbrances with workspaceDid", async () => {
  mockResponse = {
    status: 200,
    body: { instruments: [], clauses: [] },
  };
  await legacyClient.searchEncumbrances({
    workspaceDid: "did:hauska:property-workspace:lk_test",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/brokerage/v1/workspaces/encumbrances");
  assert.equal(
    url.searchParams.get("workspaceDid"),
    "did:hauska:property-workspace:lk_test",
  );
});

test("Cotality adapters return credential-pending without env creds", async () => {
  assert.equal(cotalityCredentialsConfigured(), false);
  const res = await legacyClient.getPropertyDetail({
    address: "1 Main St",
  });
  assert.equal(calls.length, 0);
  assert.equal(res.status, "credential-pending");
  assert.equal(res.adapter, "cotality:property");
});

test("Cotality adapters call backend when creds are configured", async () => {
  process.env.COTALITY_CLIENT_ID = "client-id";
  process.env.COTALITY_CLIENT_SECRET = "client-secret";
  mockResponse = { status: 200, body: { ok: true } };
  await legacyClient.getHazardProfile({ lat: 30.5, lng: -97.7 });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/brokerage/v1/cotality/hazard-profile");
});

test("generateBriefEnvelope surfaces brief-run DID provenance", () => {
  const env = generateBriefEnvelope(
    {
      runId: "55555555-5555-4555-8555-555555555555",
      startedAt: "2026-06-06T00:00:00.000Z",
      finishedAt: "2026-06-06T00:00:01.000Z",
      jurisdiction: "round-rock-tx",
      corpusStatus: "loaded",
      property: { address: "1 Main" },
    },
    { tier: "developer_pro" },
  );
  assert.equal(
    env.atoms[0]!.did,
    "did:hauska:brief-run:55555555-5555-4555-8555-555555555555",
  );
  assert.equal(env.meta.attribution, undefined);
});

test("credentialPendingEnvelope carries operator message in meta.note", () => {
  const env = credentialPendingEnvelope(
    {
      status: "credential-pending",
      adapter: "cotality:parcels",
      message: "OAuth not configured.",
    },
    { tier: "developer_pro" },
  );
  assert.equal(env.data.status, "credential-pending");
  assert.equal(env.meta.note, "OAuth not configured.");
});

test("requireProduct denies public key for generate_property_brief", async () => {
  await withCtx(
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "test",
      remaining_rpm: -1,
      remaining_daily: -1,
    },
    async () => {
      const result = await requireProduct("generate_property_brief", "reporting");
      assert.equal(result.ok, false);
    },
  );
});

test("requireProduct allows reporting key for generate_property_brief", async () => {
  await withCtx(
    {
      tier: "developer_pro",
      product: "reporting",
      key_id: "k-test",
      rate_limit_id: "key:k-test",
      remaining_rpm: 100,
      remaining_daily: 1000,
    },
    async () => {
      const result = await requireProduct("generate_property_brief", "reporting");
      assert.equal(result.ok, true);
    },
  );
});
