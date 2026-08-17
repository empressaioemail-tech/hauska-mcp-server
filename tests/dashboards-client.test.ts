import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import {
  dashboardsBackendUrl,
  dashboardsClient,
} from "../src/dashboards-client.js";
import { PRODUCTS } from "../src/products.js";
import {
  cataloguedToolNames,
  IDENTIFIED_CALLER_TOOLS,
  PUBLIC_CATALOG_TOOLS,
  requiredProductForTool,
  toolGateMetadata,
} from "../src/product-gates.js";

const calls: { url: string; auth?: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  delete process.env.DASHBOARDS_BACKEND_URL;
  delete process.env.DASHBOARDS_API_KEY;
  delete process.env.LEGACY_BACKEND_URL;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get("authorization") ?? undefined,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DASHBOARDS_BACKEND_URL;
  delete process.env.DASHBOARDS_API_KEY;
  delete process.env.LEGACY_BACKEND_URL;
});

test("DASHBOARDS_BACKEND_URL is required at call time", () => {
  assert.throws(() => dashboardsBackendUrl(), /DASHBOARDS_BACKEND_URL is required/);
  process.env.DASHBOARDS_BACKEND_URL = "";
  assert.throws(() => dashboardsBackendUrl(), /DASHBOARDS_BACKEND_URL is required/);
});

const REFUSED = [
  "https://cortex-api-tds7av26va-uc.a.run.app",
  "https://legacy-design-tools-xyz.a.run.app",
  "https://fancy-fire-example.a.run.app",
  "https://smartcity-os-prod-abc.a.run.app",
  "https://tiny-art-xyz.a.run.app",
  "https://smartcityos.io",
  "postgres://user:pass@db.example/hauska",
  "https://ep-example.neon.tech/neondb",
];

for (const url of REFUSED) {
  test(`refuses forbidden backend URL ${url}`, () => {
    process.env.DASHBOARDS_BACKEND_URL = url;
    assert.throws(() => dashboardsBackendUrl(), /refuses/);
  });
}

test("accepts a Dashboards product host and strips trailing slash", () => {
  process.env.DASHBOARDS_BACKEND_URL = "https://dashboards.example.test/";
  assert.equal(dashboardsBackendUrl(), "https://dashboards.example.test");
});

test("does not follow LEGACY_BACKEND_URL even when set", async () => {
  process.env.LEGACY_BACKEND_URL = "https://cortex-api-tds7av26va-uc.a.run.app";
  process.env.DASHBOARDS_BACKEND_URL = "https://dashboards.example.test";
  await dashboardsClient.listLenses();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://dashboards.example.test/api/lenses");
  assert.doesNotMatch(calls[0]!.url, /cortex-api/);
});

test("sends DASHBOARDS_API_KEY as Bearer", async () => {
  process.env.DASHBOARDS_BACKEND_URL = "https://dashboards.example.test";
  process.env.DASHBOARDS_API_KEY = "test-token";
  await dashboardsClient.getCityPack("template-city");
  assert.equal(calls[0]!.auth, "Bearer test-token");
  assert.equal(
    calls[0]!.url,
    "https://dashboards.example.test/api/city-packs/template-city",
  );
});

test("dashboards_list_lenses is public catalog anonymous_ok", () => {
  const meta = toolGateMetadata("dashboards_list_lenses");
  assert.equal(meta.product, "public");
  assert.equal(meta.gate, "access_policy");
  assert.equal(meta.anonymous_ok, true);
  assert.equal(requiredProductForTool("dashboards_list_lenses"), undefined);
});

test("dashboards_get_city_pack is identified_caller not anonymous", () => {
  const meta = toolGateMetadata("dashboards_get_city_pack");
  assert.equal(meta.product, "public");
  assert.equal(meta.gate, "identified_caller");
  assert.equal(meta.anonymous_ok, false);
  assert.equal(requiredProductForTool("dashboards_get_city_pack"), undefined);
  assert.ok(PUBLIC_CATALOG_TOOLS.has("dashboards_get_city_pack"));
  assert.ok(IDENTIFIED_CALLER_TOOLS.has("dashboards_get_city_pack"));
});

test("dashboards tools are catalogued and are not a fifth Product", () => {
  assert.deepEqual([...PRODUCTS], ["public", "codex", "reporting", "map"]);
  assert.equal(PRODUCTS.includes("dashboards" as (typeof PRODUCTS)[number]), false);
  assert.ok(cataloguedToolNames().has("dashboards_list_lenses"));
  assert.ok(cataloguedToolNames().has("dashboards_get_city_pack"));
});
