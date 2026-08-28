// Property-dossier export tools (engine #174 wiring).
// Sibling of site-plan-export-catalog.test.ts: proves the SAME public-paid
// gate shape, the SAME one-authorizePaidCall-per-request metering discipline,
// VERBATIM body pass-through to the engine, and the format-free download hop.

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
import {
  XRAY_PIPELINE_ABSENT_ERROR,
  XRAY_VERDICT_PLACEHOLDER,
} from "../src/xray-export-gate.js";

const PARCEL = "48029:105129";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VALID_BRIEF = {
  sections: [
    {
      id: "zoning",
      title: "Zoning",
      facts: [{ label: "District", value: "R1" }],
    },
  ],
};

const VALID_DOSSIER_ARGS = {
  verdict_line: "BUILDABLE with conditions",
  brief: VALID_BRIEF,
};

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

const calls: RecordedCall[] = [];
const realFetch = globalThis.fetch;

const refreshFixture = {
  atom: {
    entityType: "parcel-terrain-model",
    atomDid: "pterrain_dossier_test",
    entityId: PARCEL,
    parcelNodeId: PARCEL,
    jurisdictionTenant: "property-spine",
    fetchedAt: "2026-07-29T02:03:08.902Z",
    sourceAdapter: "engine:site-plan-composer",
    accessPolicy: "public-paid",
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance: "Parcel GIS + setback-rule + USGS 3DEP; calibration pending",
    },
  },
  artifacts: {
    "pdf-dossier": {
      format: "pdf-dossier",
      ref: "file:///tmp/pdf-dossier",
      byteCount: 7900,
      pageCount: 6,
    },
  },
  pageCount: 6,
  dossierPageCount: 3,
  sitePlanAppended: true,
  verdictIncluded: true,
  briefSectionCount: 1,
  briefFactCount: 2,
  chatSummaryIncluded: true,
  notesIncluded: true,
  setbackDegenerate: false,
  streetHonestAbsence: true,
  zoningHonestAbsence: false,
  floodZoneHonestUnavailable: true,
};

const statusFixture = {
  atom: refreshFixture.atom,
  artifacts: {
    "pdf-dossier": {
      format: "pdf-dossier",
      ref: "file:///tmp/pdf-dossier",
      byteCount: 7900,
      pageCount: 6,
      verdictIncluded: true,
      briefFactCount: 2,
    },
  },
};

function paidCtx() {
  return {
    tier: "developer_pro" as const,
    product: "public" as const,
    key_id: "key-paid-dossier",
    key_hash: "hash-paid-dossier",
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    jurisdiction_tenant: null,
    platform_internal: false,
    request_id: "req-dossier-wiring",
  };
}

function mockFetchRouter(options?: { hollowStored?: boolean }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if (url.includes("/dossier-export/refresh")) {
      return new Response(JSON.stringify(refreshFixture), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.includes("/dossier-export") &&
      !url.includes("/refresh") &&
      !url.includes("/download")
    ) {
      const artifacts = options?.hollowStored
        ? {
            "pdf-dossier": {
              format: "pdf-dossier",
              ref: "file:///tmp/hollow-dossier",
              byteCount: 100,
              verdictIncluded: false,
              briefFactCount: 0,
            },
          }
        : statusFixture.artifacts;
      return new Response(
        JSON.stringify({ atom: statusFixture.atom, artifacts }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/dossier-export/download")) {
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
  name: string,
  args: Record<string, unknown>,
  ctx: Record<string, unknown> = paidCtx(),
  fetchOptions?: { hollowStored?: boolean },
) {
  mockFetchRouter(fetchOptions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const result = await requestContext.run(ctx as never, () =>
    client.callTool({ name, arguments: args }),
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

test("refresh_parcel_dossier_export denies free anonymous callers", async () => {
  const result = await callTool(
    "refresh_parcel_dossier_export",
    { parcel_node_id: PARCEL },
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "anon",
      remaining_rpm: 10,
      remaining_daily: 100,
      request_id: "req-anon-dossier",
    },
  );

  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /paid X-Hauska-Key|public-paid/i);
  assert.equal(calls.length, 0, "engine-api must not be called for anonymous");
});

test("refresh_parcel_dossier_export denies free tier with key", async () => {
  const result = await callTool(
    "refresh_parcel_dossier_export",
    { parcel_node_id: PARCEL },
    { ...paidCtx(), tier: "free" },
  );
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /paid X-Hauska-Key|public-paid/i);
  assert.equal(calls.length, 0);
});

test("refresh_parcel_dossier_export passes the dossier body through VERBATIM", async () => {
  const brief = {
    sections: [
      {
        id: "zoning",
        title: "Zoning",
        facts: [
          { label: "District", value: "R1", source: "bastrop-tx UDC", vintage: "2026-05" },
          { label: "Front setback", value: "25 ft" },
        ],
      },
    ],
  };
  const chatSummary = {
    summary: "AI research summary text.",
    savedAt: "2026-07-29T00:00:00.000Z",
    disclaimer: "AI-generated; verify independently.",
  };
  const result = await callTool("refresh_parcel_dossier_export", {
    parcel_node_id: PARCEL,
    address: "1127 N Pine St",
    county_name: "Bexar",
    verdict_line: "BUILDABLE with conditions",
    brief,
    chat_summary: chatSummary,
    notes: "Owner notes here.",
  });
  assert.notEqual(result.isError, true);

  const refreshCalls = calls.filter((c) => c.url.includes("/dossier-export/refresh"));
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0]!.method, "POST");
  const sent = JSON.parse(refreshCalls[0]!.body ?? "{}") as Record<string, unknown>;
  assert.equal(sent.address, "1127 N Pine St");
  assert.equal(sent.countyName, "Bexar");
  assert.equal(sent.verdictLine, "BUILDABLE with conditions");
  assert.deepEqual(sent.brief, brief);
  assert.deepEqual(sent.chatSummary, chatSummary);
  assert.equal(sent.notes, "Owner notes here.");

  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const envelope = JSON.parse(text) as {
    data: {
      atom: { accessPolicy: string };
      dossierPageCount?: number;
      sitePlanAppended?: boolean;
    };
  };
  assert.equal(envelope.data.atom.accessPolicy, "public-paid");
  assert.equal(envelope.data.dossierPageCount, 3);
  assert.equal(envelope.data.sitePlanAppended, true);
});

test("refresh_parcel_dossier_export format param downloads pdf-dossier with NO format query", async () => {
  const result = await callTool("refresh_parcel_dossier_export", {
    parcel_node_id: PARCEL,
    format: "pdf-dossier",
    ...VALID_DOSSIER_ARGS,
  });
  assert.notEqual(result.isError, true);

  const refreshCalls = calls.filter((c) => c.url.includes("/dossier-export/refresh"));
  const downloadCalls = calls.filter((c) => c.url.includes("/dossier-export/download"));
  assert.equal(refreshCalls.length, 1);
  assert.equal(downloadCalls.length, 1);
  assert.doesNotMatch(
    downloadCalls[0]!.url,
    /format=/,
    "engine dossier download route takes no format query param",
  );
  assert.match(downloadCalls[0]!.url, /48029%3A105129/);

  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const envelope = JSON.parse(text) as {
    data: { download?: { format: string; contentType: string; base64?: string } };
  };
  assert.equal(envelope.data.download?.format, "pdf-dossier");
  assert.equal(envelope.data.download?.contentType, "application/pdf");
  assert.ok(envelope.data.download?.base64);
});

test("refresh_parcel_dossier_export surfaces engine 422 as an actionable error", async () => {
  mockFetchRouter();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url.includes("/dossier-export/refresh")) {
      return new Response(
        JSON.stringify({
          error: "dossier_export_failed",
          message: "dossier authoring failed for this parcel",
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
      name: "refresh_parcel_dossier_export",
      arguments: { parcel_node_id: PARCEL, ...VALID_DOSSIER_ARGS },
    }),
  );

  await client.close();
  await server.close();

  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /422/);
});

test("refresh_parcel_dossier_export calls authorizePaidCall exactly once in handler", () => {
  const toolsSrc = readFileSync(resolve(ROOT, "src/tools.ts"), "utf8");
  const start = toolsSrc.indexOf('"refresh_parcel_dossier_export"');
  assert.ok(start > 0);
  const nextTool = toolsSrc.indexOf("server.tool(", start + 1);
  const handler = toolsSrc.slice(start, nextTool > start ? nextTool : start + 8000);
  assert.equal(
    (handler.match(/authorizePaidCall/g) ?? []).length,
    1,
    "handler must call authorizePaidCall once (one meter per export request)",
  );
  assert.doesNotMatch(
    handler,
    /authorizePaidRead/,
    "paid catalog export must use authorizePaidCall, not authorizePaidRead",
  );
});

test("refresh_parcel_dossier_export invokes SDK metering gate when SDK_METERING enabled", async () => {
  process.env.SDK_METERING = "1";
  resetSdkMeteringGateForTests();
  assert.equal(wasSdkMeteringModuleLoaded(), false);

  await callTool("refresh_parcel_dossier_export", {
    parcel_node_id: PARCEL,
    ...VALID_DOSSIER_ARGS,
  });
  assert.equal(
    wasSdkMeteringModuleLoaded(),
    true,
    "paid catalog export must dynamically import @hauska-sdk/metering when SDK_METERING is on",
  );
});

test("toolGateMetadata registers refresh_parcel_dossier_export on public catalog with anonymous_ok false", () => {
  const meta = toolGateMetadata("refresh_parcel_dossier_export");
  assert.equal(meta.product, "public");
  assert.equal(meta.gate, "access_policy");
  assert.equal(meta.anonymous_ok, false);
  assert.match(meta.gate_summary, /authorizePaidCall|SDK meter/i);
});

test("download_parcel_dossier_export denies free anonymous callers", async () => {
  const result = await callTool(
    "download_parcel_dossier_export",
    { parcel_node_id: PARCEL },
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "anon",
      remaining_rpm: 10,
      remaining_daily: 100,
      request_id: "req-anon-dossier-dl",
    },
  );
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /paid X-Hauska-Key|public-paid/i);
  assert.equal(calls.length, 0);
});

test("download_parcel_dossier_export streams pdf-dossier bytes as base64", async () => {
  const result = await callTool("download_parcel_dossier_export", {
    parcel_node_id: PARCEL,
  });
  assert.notEqual(result.isError, true);

  const downloadCalls = calls.filter((c) => c.url.includes("/dossier-export/download"));
  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0]!.method, "GET");
  assert.doesNotMatch(downloadCalls[0]!.url, /format=/);

  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const envelope = JSON.parse(text) as {
    data: {
      download: { format: string; contentType: string; base64: string; byteCount: number };
    };
  };
  assert.equal(envelope.data.download.format, "pdf-dossier");
  assert.equal(envelope.data.download.contentType, "application/pdf");
  assert.equal(
    Buffer.from(envelope.data.download.base64, "base64").toString("latin1"),
    "%PDF",
  );
  assert.equal(envelope.data.download.byteCount, 4);
});

test("download_parcel_dossier_export surfaces 404 as call-refresh-first", async () => {
  mockFetchRouter();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return new Response(
      JSON.stringify({ error: "artifact_unavailable" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const result = await requestContext.run(paidCtx(), () =>
    client.callTool({
      name: "download_parcel_dossier_export",
      arguments: { parcel_node_id: PARCEL },
    }),
  );

  await client.close();
  await server.close();

  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /404/);
  assert.match(text, /refresh_parcel_dossier_export/);
});

test("P-89: refresh_parcel_dossier_export refuses missing verdict without engine call", async () => {
  const result = await callTool("refresh_parcel_dossier_export", {
    parcel_node_id: PARCEL,
    brief: VALID_BRIEF,
  });
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const parsed = JSON.parse(text) as { status: number; error: string; missing: string[] };
  assert.equal(parsed.status, 422);
  assert.equal(parsed.error, XRAY_PIPELINE_ABSENT_ERROR);
  assert.ok(parsed.missing.includes("verdict"));
  assert.equal(calls.length, 0, "engine-api must not be called when verdict is missing");
});

test("P-89: refresh_parcel_dossier_export refuses unresolved verdict placeholder", async () => {
  const result = await callTool("refresh_parcel_dossier_export", {
    parcel_node_id: PARCEL,
    verdict_line: XRAY_VERDICT_PLACEHOLDER,
    brief: VALID_BRIEF,
  });
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const parsed = JSON.parse(text) as { error: string; missing: string[] };
  assert.equal(parsed.error, XRAY_PIPELINE_ABSENT_ERROR);
  assert.ok(parsed.missing.includes("verdict"));
  assert.equal(calls.length, 0);
});

test("P-89: refresh_parcel_dossier_export refuses verdict with empty brief facts", async () => {
  const result = await callTool("refresh_parcel_dossier_export", {
    parcel_node_id: PARCEL,
    verdict_line: "BUILDABLE",
    brief: null,
  });
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const parsed = JSON.parse(text) as { error: string; missing: string[] };
  assert.equal(parsed.error, XRAY_PIPELINE_ABSENT_ERROR);
  assert.ok(parsed.missing.includes("brief_facts"));
  assert.equal(calls.length, 0);
});

test("P-89: refresh_parcel_dossier_export forwards live_view_url verbatim (WDLL item 4)", async () => {
  const liveUrl = "https://smartsite.cloud/share?g=grant-uuid-test";
  const result = await callTool("refresh_parcel_dossier_export", {
    parcel_node_id: PARCEL,
    live_view_url: liveUrl,
    ...VALID_DOSSIER_ARGS,
  });
  assert.notEqual(result.isError, true);

  const refreshCalls = calls.filter((c) => c.url.includes("/dossier-export/refresh"));
  assert.equal(refreshCalls.length, 1);
  const sent = JSON.parse(refreshCalls[0]!.body ?? "{}") as Record<string, unknown>;
  assert.equal(sent.liveViewUrl, liveUrl);

  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const envelope = JSON.parse(text) as { data: { liveViewUrl?: string } };
  assert.equal(envelope.data.liveViewUrl, liveUrl);
});

test("P-89: download_parcel_dossier_export refuses stored hollow artifact without PDF bytes", async () => {
  const result = await callTool(
    "download_parcel_dossier_export",
    { parcel_node_id: PARCEL },
    paidCtx(),
    { hollowStored: true },
  );
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const parsed = JSON.parse(text) as { status: number; error: string };
  assert.equal(parsed.status, 422);
  assert.equal(parsed.error, XRAY_PIPELINE_ABSENT_ERROR);
  assert.doesNotMatch(text, /%PDF/);

  const downloadCalls = calls.filter((c) => c.url.includes("/dossier-export/download"));
  assert.equal(downloadCalls.length, 0, "byte download must not run for hollow stored artifact");
});
