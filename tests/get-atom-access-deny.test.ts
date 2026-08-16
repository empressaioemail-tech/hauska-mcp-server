// SF-41: get_atom must not report access-deny as a corpus miss.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuthContext } from "../src/auth.js";
import { requestContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";

const DID = "did:hauska:owner-fact:48021:27303";
const ICC_DID = "did:hauska:code-section:icc-model-code/IBC2018P6/R311.7";

const realFetch = globalThis.fetch;
let mockAtom: unknown = null;

function anonCtx(): AuthContext {
  return {
    tier: "free_anonymous",
    product: "public",
    rate_limit_id: "anon",
    remaining_rpm: 10,
    remaining_daily: 100,
    jurisdiction_tenant: null,
    platform_internal: false,
    request_id: "req-sf41-anon",
  };
}

function paidCtx(): AuthContext {
  return {
    tier: "developer_pro",
    product: "public",
    key_id: "key-sf41-paid",
    key_hash: "hash-sf41-paid",
    rate_limit_id: "key:sf41",
    remaining_rpm: -1,
    remaining_daily: -1,
    jurisdiction_tenant: null,
    platform_internal: false,
    request_id: "req-sf41-paid",
  };
}

async function callGetAtom(ctx: AuthContext, atomId = DID) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await requestContext.run(ctx, () =>
    client.callTool({
      name: "get_atom",
      arguments: { atom_id: atomId },
    }),
  );
  await client.close();
  await server.close();
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { result, text };
}

beforeEach(() => {
  mockAtom = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/atoms/")) {
      return new Response(JSON.stringify({ atom: mockAtom }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("SF-41: access-deny is not reported as No atom found at DID", async () => {
  mockAtom = {
    entityType: "owner-fact",
    entityId: "48021:27303",
    atomDid: DID,
    jurisdictionTenant: "bastrop-tx",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "https://example.test/owner",
    contentHash: "abc123",
    accessPolicy: "public-paid",
  };

  const { result, text } = await callGetAtom(anonCtx());
  assert.doesNotMatch(
    text,
    /No atom found at DID/,
    "access-deny must not masquerade as a corpus miss",
  );
  assert.match(
    text,
    /not readable|accessPolicy|access.denied|not-readable/i,
    "deny path must name access / not-readable distinctly",
  );
  assert.equal(
    result.isError,
    true,
    "access-deny is an error, not an empty-success miss envelope",
  );
});

test("true corpus miss still says No atom found at DID", async () => {
  mockAtom = null;
  const { result, text } = await callGetAtom(anonCtx());
  assert.match(text, /No atom found at DID/);
  assert.notEqual(result.isError, true);
});

test("paid caller receives public-paid atom", async () => {
  mockAtom = {
    entityType: "owner-fact",
    entityId: "48021:27303",
    atomDid: DID,
    jurisdictionTenant: "bastrop-tx",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "https://example.test/owner",
    contentHash: "abc123",
    accessPolicy: "public-paid",
  };
  const { result, text } = await callGetAtom(paidCtx());
  assert.notEqual(result.isError, true);
  assert.doesNotMatch(text, /No atom found at DID/);
  assert.match(text, /owner-fact/);
});

test("G-60: anon get_atom on ICC public-free holds the body (not a corpus miss)", async () => {
  mockAtom = {
    entityType: "code-section",
    entityId: "IBC2018P6/R311.7",
    atomDid: "did:hauska:code-section:icc-model-code/IBC2018P6/R311.7",
    jurisdictionTenant: "icc-model-code",
    fetchedAt: "2026-08-16T00:00:00.000Z",
    sourceAdapter: "icc-code-connect",
    sourceUrl: "https://codes.iccsafe.org/content/IBC2018P6/R311.7",
    contentHash: "icc-fixture",
    accessPolicy: "public-free",
    bodyText: "VERBATIM ICC BODY MUST NOT LEAK",
  };
  const { result, text } = await callGetAtom(anonCtx(), ICC_DID);
  assert.equal(result.isError, true);
  assert.doesNotMatch(text, /No atom found at DID/);
  assert.doesNotMatch(text, /VERBATIM ICC BODY MUST NOT LEAK/);
  assert.match(text, /not readable|accessPolicy|access.denied|not-readable/i);
});

test("G-60: paid caller still reads ICC while store stamp lags", async () => {
  mockAtom = {
    entityType: "code-section",
    entityId: "IBC2018P6/R311.7",
    atomDid: "did:hauska:code-section:icc-model-code/IBC2018P6/R311.7",
    jurisdictionTenant: "icc-model-code",
    fetchedAt: "2026-08-16T00:00:00.000Z",
    sourceAdapter: "icc-code-connect",
    sourceUrl: "https://codes.iccsafe.org/content/IBC2018P6/R311.7",
    contentHash: "icc-fixture",
    accessPolicy: "public-free",
    bodyText: "VERBATIM ICC BODY KEYED PATH",
  };
  const { result, text } = await callGetAtom(paidCtx(), ICC_DID);
  assert.notEqual(result.isError, true);
  assert.match(text, /code-section/);
});
