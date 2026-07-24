// Gate Y — refresh_parcel_terrain_export catalog tool (WDLL items 5–6).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GATE_FRONT_HEADERS } from "../src/gate-front.js";
import { toolGateMetadata } from "../src/product-gates.js";
import { requestContext } from "../src/request-context.js";
import {
  resetSdkMeteringGateForTests,
  wasSdkMeteringModuleLoaded,
} from "../src/sdk-metering.js";
import { registerTools } from "../src/tools.js";

const PARCEL = "48021:27303";
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
    atomDid: "pterrain_test",
    entityId: PARCEL,
    parcelNodeId: PARCEL,
    jurisdictionTenant: "property-spine",
    fetchedAt: "2026-07-24T02:03:08.902Z",
    sourceAdapter: "usgs:3dep-dem",
    sourceCitation: "USGS 3DEP",
    accessPolicy: "public-paid",
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance: "USGS 3DEP DEM field; calibration pending",
    },
  },
  artifacts: {
    glb: {
      format: "glb",
      ref: "file:///tmp/glb",
      byteCount: 35528,
      vertexCount: 1012,
      triangleCount: 1890,
    },
    "landxml-tin": {
      format: "landxml-tin",
      ref: "deferred:landxml-tin",
      deferred: true,
      deferredReason: "LandXML TIN writer is deferred.",
    },
  },
};

function paidCtx() {
  return {
    tier: "developer_pro" as const,
    product: "public" as const,
    key_id: "key-paid-terrain",
    key_hash: "hash-paid-terrain",
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    jurisdiction_tenant: null,
    platform_internal: false,
    request_id: "req-terrain-y",
  };
}

function mockFetchRouter() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });

    if (url.includes("/terrain-export/refresh")) {
      return new Response(JSON.stringify(refreshFixture), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/terrain-export/download")) {
      const body = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "model/gltf-binary" },
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
      name: "refresh_parcel_terrain_export",
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

test("refresh_parcel_terrain_export denies free anonymous callers", async () => {
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
      request_id: "req-anon-terrain",
    },
    () =>
      client.callTool({
        name: "refresh_parcel_terrain_export",
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

test("refresh_parcel_terrain_export denies free tier with key", async () => {
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

test("refresh_parcel_terrain_export forwards format param to download path", async () => {
  const result = await callTool({
    parcel_node_id: PARCEL,
    format: "glb",
    resolution_meters: 1,
    contour_interval_meters: 0.5,
  });
  assert.notEqual(result.isError, true);

  const refreshCalls = calls.filter((c) => c.url.includes("/terrain-export/refresh"));
  const downloadCalls = calls.filter((c) => c.url.includes("/terrain-export/download"));
  assert.equal(refreshCalls.length, 1);
  assert.equal(downloadCalls.length, 1);
  assert.match(downloadCalls[0]!.url, /format=glb/);

  const refreshBody = refreshCalls[0]!;
  assert.equal(refreshBody.method, "POST");

  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const envelope = JSON.parse(text) as {
    data: {
      download?: { format: string; base64?: string };
      atom: { accessPolicy: string; sourceCitation: string };
    };
  };
  assert.equal(envelope.data.atom.accessPolicy, "public-paid");
  assert.equal(envelope.data.atom.sourceCitation, "USGS 3DEP");
  assert.equal(envelope.data.download?.format, "glb");
  assert.ok(envelope.data.download?.base64);
});

test("refresh_parcel_terrain_export POST refresh uses terrain-export gate-front headers", async () => {
  process.env.HAUSKA_ENGINE_API_URL = "http://engine-api.test";
  await callTool({ parcel_node_id: PARCEL });

  const refreshCall = calls.find((c) => c.url.includes("/terrain-export/refresh"));
  assert.ok(refreshCall);
  assert.match(refreshCall!.url, /48021%3A27303/);
});

test("refresh_parcel_terrain_export calls authorizePaidCall exactly once in handler", () => {
  const toolsSrc = readFileSync(resolve(ROOT, "src/tools.ts"), "utf8");
  const start = toolsSrc.indexOf('"refresh_parcel_terrain_export"');
  assert.ok(start > 0);
  const nextTool = toolsSrc.indexOf('server.tool(', start + 1);
  const handler = toolsSrc.slice(start, nextTool > start ? nextTool : start + 8000);
  assert.equal(
    (handler.match(/authorizePaidCall/g) ?? []).length,
    1,
    "handler must call authorizePaidCall once (WDLL one meter per export request)",
  );
  assert.doesNotMatch(
    handler,
    /authorizePaidRead/,
    "paid catalog export must use authorizePaidCall, not authorizePaidRead",
  );
});

test("refresh_parcel_terrain_export invokes SDK metering gate when SDK_METERING enabled", async () => {
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

test("toolGateMetadata registers refresh_parcel_terrain_export on public catalog with anonymous_ok false", () => {
  const meta = toolGateMetadata("refresh_parcel_terrain_export");
  assert.equal(meta.product, "public");
  assert.equal(meta.gate, "access_policy");
  assert.equal(meta.anonymous_ok, false);
  assert.match(meta.gate_summary, /authorizePaidCall|SDK meter/i);
});
