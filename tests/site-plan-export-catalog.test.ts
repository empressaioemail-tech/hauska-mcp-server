// Wave 3 — refresh_parcel_site_plan_export catalog tool (WDLL items 7-8).
// Sibling of terrain-export-catalog.test.ts: proves the SAME public-paid
// gate shape and the SAME one-authorizePaidCall-per-request metering
// discipline on the site-plan export path.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toolGateMetadata } from "../src/product-gates.js";
import { requestContext } from "../src/request-context.js";
import {
  resetSdkMeteringGateForTests,
  wasSdkMeteringModuleLoaded,
} from "../src/sdk-metering.js";
import { registerTools } from "../src/tools.js";

const PARCEL = "48029:105129";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RecordedCall {
  url: string;
  method: string;
}

const calls: RecordedCall[] = [];
const realFetch = globalThis.fetch;

const refreshFixture = {
  atom: {
    entityType: "parcel-terrain-model",
    atomDid: "pterrain_site_plan_test",
    entityId: PARCEL,
    parcelNodeId: PARCEL,
    jurisdictionTenant: "property-spine",
    fetchedAt: "2026-07-25T02:03:08.902Z",
    sourceAdapter: "engine:site-plan-composer",
    accessPolicy: "public-paid",
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance: "Parcel GIS + setback-rule + USGS 3DEP; calibration pending",
    },
  },
  artifacts: {
    "dxf-site-plan": {
      format: "dxf-site-plan",
      ref: "file:///tmp/dxf-site-plan",
      byteCount: 12345,
    },
    "ifc-site-plan": {
      format: "ifc-site-plan",
      ref: "file:///tmp/ifc-site-plan",
      byteCount: 54321,
    },
    "pdf-site-plan": {
      format: "pdf-site-plan",
      ref: "file:///tmp/pdf-site-plan",
      byteCount: 7900,
      pageCount: 2,
    },
  },
  setbackDegenerate: false,
  streetHonestAbsence: true,
  zoningHonestAbsence: false,
  floodZoneHonestUnavailable: true,
};

function paidCtx() {
  return {
    tier: "developer_pro" as const,
    product: "public" as const,
    key_id: "key-paid-site-plan",
    key_hash: "hash-paid-site-plan",
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    jurisdiction_tenant: null,
    platform_internal: false,
    request_id: "req-site-plan-wave3",
  };
}

function mockFetchRouter() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });

    if (url.includes("/site-plan-export/refresh")) {
      return new Response(JSON.stringify(refreshFixture), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/site-plan-export/download")) {
      const body = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;
}

async function callTool(
  args: Record<string, unknown>,
  ctx = paidCtx(),
) {
  mockFetchRouter();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const result = await requestContext.run(ctx, () =>
    client.callTool({
      name: "refresh_parcel_site_plan_export",
      arguments: args,
    }),
  );

  await client.close();
  await server.close();
  return result;
}

beforeEach(() => {
  calls.length = 0;
  delete process.env.SDK_METERING;
  resetSdkMeteringGateForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SDK_METERING;
  resetSdkMeteringGateForTests();
});

test("refresh_parcel_site_plan_export denies free anonymous callers", async () => {
  mockFetchRouter();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const result = await requestContext.run(
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "anon",
      remaining_rpm: 10,
      remaining_daily: 100,
      request_id: "req-anon-site-plan",
    },
    () =>
      client.callTool({
        name: "refresh_parcel_site_plan_export",
        arguments: { parcel_node_id: PARCEL },
      }),
  );

  await client.close();
  await server.close();

  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /paid X-Hauska-Key|public-paid/i);
  assert.equal(calls.length, 0, "engine-api must not be called for anonymous");
});

test("refresh_parcel_site_plan_export denies free tier with key", async () => {
  const result = await callTool(
    { parcel_node_id: PARCEL },
    {
      ...paidCtx(),
      tier: "free",
    },
  );
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /paid X-Hauska-Key|public-paid/i);
  assert.equal(calls.length, 0);
});

test("refresh_parcel_site_plan_export forwards format param to download path", async () => {
  const result = await callTool({
    parcel_node_id: PARCEL,
    format: "pdf-site-plan",
    address: "1127 N Pine St",
    county_name: "Bexar",
  });
  assert.notEqual(result.isError, true);

  const refreshCalls = calls.filter((c) => c.url.includes("/site-plan-export/refresh"));
  const downloadCalls = calls.filter((c) => c.url.includes("/site-plan-export/download"));
  assert.equal(refreshCalls.length, 1);
  assert.equal(downloadCalls.length, 1);
  assert.match(downloadCalls[0]!.url, /format=pdf-site-plan/);

  const refreshBody = refreshCalls[0]!;
  assert.equal(refreshBody.method, "POST");

  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const envelope = JSON.parse(text) as {
    data: {
      download?: { format: string; base64?: string };
      atom: { accessPolicy: string };
    };
  };
  assert.equal(envelope.data.atom.accessPolicy, "public-paid");
  assert.equal(envelope.data.download?.format, "pdf-site-plan");
  assert.ok(envelope.data.download?.base64);
});

test("refresh_parcel_site_plan_export surfaces 422 setback-rule-missing as an actionable error", async () => {
  mockFetchRouter();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url.includes("/site-plan-export/refresh")) {
      return new Response(
        JSON.stringify({
          error: "setback_rule_missing",
          message: `No setback-rule atom for ${PARCEL}; site-plan export refuses to fabricate front/side/rear values.`,
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const result = await requestContext.run(paidCtx(), () =>
    client.callTool({
      name: "refresh_parcel_site_plan_export",
      arguments: { parcel_node_id: PARCEL },
    }),
  );

  await client.close();
  await server.close();

  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /422|setback/i);
});

test("refresh_parcel_site_plan_export POST refresh uses site-plan-export gate-front headers", async () => {
  process.env.HAUSKA_ENGINE_API_URL = "http://engine-api.test";
  await callTool({ parcel_node_id: PARCEL });

  const refreshCall = calls.find((c) => c.url.includes("/site-plan-export/refresh"));
  assert.ok(refreshCall);
  assert.match(refreshCall!.url, /48029%3A105129/);
});

test("refresh_parcel_site_plan_export calls authorizePaidCall exactly once in handler", () => {
  const toolsSrc = readFileSync(resolve(ROOT, "src/tools.ts"), "utf8");
  const start = toolsSrc.indexOf('"refresh_parcel_site_plan_export"');
  assert.ok(start > 0);
  const nextTool = toolsSrc.indexOf('server.tool(', start + 1);
  const handler = toolsSrc.slice(start, nextTool > start ? nextTool : start + 8000);
  assert.equal(
    (handler.match(/authorizePaidCall/g) ?? []).length,
    1,
    "handler must call authorizePaidCall once (WDLL 7: one meter per export request)",
  );
  assert.doesNotMatch(
    handler,
    /authorizePaidRead/,
    "paid catalog export must use authorizePaidCall, not authorizePaidRead",
  );
});

test("refresh_parcel_site_plan_export invokes SDK metering gate when SDK_METERING enabled", async () => {
  process.env.SDK_METERING = "1";
  resetSdkMeteringGateForTests();
  assert.equal(wasSdkMeteringModuleLoaded(), false);

  await callTool({ parcel_node_id: PARCEL });
  assert.equal(
    wasSdkMeteringModuleLoaded(),
    true,
    "paid catalog export must dynamically import @hauska-sdk/metering when SDK_METERING is on",
  );
});

test("toolGateMetadata registers refresh_parcel_site_plan_export on public catalog with anonymous_ok false", () => {
  const meta = toolGateMetadata("refresh_parcel_site_plan_export");
  assert.equal(meta.product, "public");
  assert.equal(meta.gate, "access_policy");
  assert.equal(meta.anonymous_ok, false);
  assert.match(meta.gate_summary, /authorizePaidCall|SDK meter/i);
});
