import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuthContext } from "../src/auth.js";
import { requestContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";

const calls: { url: string; auth?: string; hauskaKey?: string }[] = [];
const realFetch = globalThis.fetch;
const PRESENTED = "hk_free_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function identified(tenant: string | null): AuthContext {
  return {
    tier: "free",
    product: "public",
    key_id: "key-g11",
    key_hash: "hash-g11",
    presented_key: PRESENTED,
    jurisdiction_tenant: tenant,
    platform_internal: false,
    rate_limit_id: "key:g11",
    remaining_rpm: -1,
    remaining_daily: -1,
    request_id: "req-g11",
  };
}

function anonymous(): AuthContext {
  return {
    tier: "free_anonymous",
    product: "public",
    rate_limit_id: "anon",
    remaining_rpm: 10,
    remaining_daily: 100,
    jurisdiction_tenant: null,
    platform_internal: false,
    request_id: "req-g11-anon",
  };
}

async function callGetCityPack(ctx: AuthContext, cityKey: string) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await requestContext.run(ctx, () =>
    client.callTool({
      name: "dashboards_get_city_pack",
      arguments: { cityKey },
    }),
  );
  await client.close();
  await server.close();
  const text = (result.content as Array<{ type: string; text: string }>)[0]!
    .text;
  return { result, text };
}

beforeEach(() => {
  calls.length = 0;
  process.env.DASHBOARDS_BACKEND_URL = "https://dashboards.example.test";
  process.env.DASHBOARDS_API_KEY = "service-token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get("authorization") ?? undefined,
      hauskaKey: headers.get("x-hauska-key") ?? undefined,
    });
    return new Response(
      JSON.stringify({
        cityPack: { cityKey: "fixture-city", grantedAdapters: [] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DASHBOARDS_BACKEND_URL;
  delete process.env.DASHBOARDS_API_KEY;
});

test("anonymous dashboards_get_city_pack is isError refused", async () => {
  const { result, text } = await callGetCityPack(anonymous(), "fixture-city");
  assert.equal(result.isError, true);
  assert.match(text, /authenticated API key/i);
  assert.equal(calls.length, 0);
});

test("wrong tenant dashboards_get_city_pack is isError refused", async () => {
  const { result, text } = await callGetCityPack(
    identified("other-city"),
    "fixture-city",
  );
  assert.equal(result.isError, true);
  assert.match(text, /Wrong tenant is refused/);
  assert.equal(calls.length, 0);
});

test("matching fixture-city subject forwards X-Hauska-Key and returns the pack", async () => {
  const { result, text } = await callGetCityPack(
    identified("fixture-city"),
    "fixture-city",
  );
  assert.equal(result.isError ?? false, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.hauskaKey, PRESENTED);
  assert.equal(calls[0]!.auth, undefined);
  assert.match(text, /fixture-city/);
});
