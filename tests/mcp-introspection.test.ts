// MCP introspection tests (operator console surface).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import express from "express";

import { adminAuthMiddleware, buildAuthMiddleware } from "../src/auth.js";
import { buildAdminRouter } from "../src/admin.js";
import {
  callIntrospectionTool,
  getIntrospectionTool,
  listIntrospectionTools,
  toolGateMetadata,
} from "../src/mcp-introspection.js";
import {
  cataloguedToolNames,
  IDENTIFIED_CALLER_TOOLS,
  PUBLIC_CATALOG_TOOLS,
} from "../src/product-gates.js";
import { MemoryRateLimitStore } from "../src/rate-limit.js";

test("toolGateMetadata classifies public, reporting, codex, map", () => {
  assert.deepEqual(toolGateMetadata("search_atoms").gate, "access_policy");
  assert.equal(toolGateMetadata("search_atoms").anonymous_ok, true);
  assert.deepEqual(toolGateMetadata("atom_trace").product, "public");
  assert.deepEqual(toolGateMetadata("resolve_place").gate, "product_reporting");
  assert.deepEqual(toolGateMetadata("codex_finding_generation").gate, "product_codex");
  assert.deepEqual(toolGateMetadata("cortex_briefing_emit").gate, "product_reporting");
  assert.deepEqual(toolGateMetadata("assemble_map_layers").gate, "product_map");
  assert.equal(toolGateMetadata("dashboards_list_lenses").gate, "access_policy");
  assert.equal(toolGateMetadata("dashboards_list_lenses").anonymous_ok, true);
  assert.equal(toolGateMetadata("dashboards_get_city_pack").gate, "identified_caller");
  assert.equal(toolGateMetadata("dashboards_get_city_pack").anonymous_ok, false);
  assert.equal(toolGateMetadata("dashboards_get_city_pack").product, "public");
});

test("listIntrospectionTools returns wire-accurate catalog", async () => {
  const catalog = await listIntrospectionTools();
  assert.ok(catalog.total >= 60);
  assert.ok(catalog.tools.some((t) => t.name === "search_atoms"));
  assert.ok(catalog.tools.some((t) => t.name === "atom_trace"));
  assert.ok(catalog.tools.some((t) => t.name === "get_property_atom_chain"));
  assert.ok(catalog.tools.some((t) => t.name === "refresh_parcel_terrain_export"));
  assert.ok(catalog.tools.some((t) => t.name === "refresh_parcel_site_plan_export"));
  assert.ok(catalog.tools.some((t) => t.name === "refresh_parcel_dossier_export"));
  assert.ok(catalog.tools.some((t) => t.name === "dashboards_list_lenses"));
  assert.ok(catalog.tools.some((t) => t.name === "dashboards_get_city_pack"));
  const accessPolicyNames = catalog.tools
    .filter((t) => t.gate === "access_policy")
    .map((t) => t.name)
    .sort();
  const publicAccessPolicy = [...PUBLIC_CATALOG_TOOLS]
    .filter((name) => !IDENTIFIED_CALLER_TOOLS.has(name))
    .sort();
  assert.deepEqual(
    accessPolicyNames,
    publicAccessPolicy,
    "access_policy gate set must equal PUBLIC_CATALOG_TOOLS minus IDENTIFIED_CALLER_TOOLS",
  );
  assert.ok(
    PUBLIC_CATALOG_TOOLS.has("dashboards_get_city_pack"),
    "city-pack must be in PUBLIC_CATALOG_TOOLS (CI four-set union)",
  );
  assert.ok(IDENTIFIED_CALLER_TOOLS.has("dashboards_get_city_pack"));
  const remainder = catalog.tools
    .map((t) => t.name)
    .filter((name) => !cataloguedToolNames().has(name))
    .sort();
  assert.deepEqual(
    remainder,
    [],
    `server.tool names missing from PUBLIC∪CODEX∪MAP∪REPORTING: ${remainder.join(", ")}`,
  );
  assert.equal(
    catalog.by_product.public,
    catalog.tools.filter((t) => t.product === "public").length,
  );
});

test("getIntrospectionTool returns schema for known tool", async () => {
  const tool = await getIntrospectionTool("list_jurisdictions");
  assert.ok(tool);
  assert.match(tool!.description, /jurisdiction/i);
  assert.ok(Array.isArray(tool!.required));
});

test("callIntrospectionTool enforces product gate on codex tool", async () => {
  const anon = await callIntrospectionTool("codex_finding_generation", {}, {
    product: "public",
    tier: "free_anonymous",
  });
  assert.equal(anon.auth.product, "public");
  assert.equal(anon.is_error, true);
  const text = JSON.stringify(anon.result);
  assert.match(text, /codex/);

  const codex = await callIntrospectionTool(
    "codex_finding_generation",
    { submission_id: "00000000-0000-4000-8000-000000000001" },
    { product: "codex", tier: "developer_pro", key_id: "probe-key" },
  );
  assert.equal(codex.auth.product, "codex");
  const codexText = JSON.stringify(codex.result);
  assert.doesNotMatch(
    codexText,
    /requires a "codex"-product API key/,
    "product gate should pass for codex auth",
  );
});

test("admin introspection routes require bootstrap key", async () => {
  const prev = process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY;
  process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY = "test-admin-bootstrap-key-value";
  try {
    const app = express();
    app.use(express.json());
    app.use("/admin", adminAuthMiddleware, buildAdminRouter());

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const noAuth = await fetch(`${base}/admin/introspection/tools`);
    assert.equal(noAuth.status, 401);

    const list = await fetch(`${base}/admin/introspection/tools`, {
      headers: { "X-Hauska-Admin-Key": process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY! },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { total: number; tools: unknown[] };
    assert.ok(body.total >= 60);
    assert.ok(Array.isArray(body.tools));

    const detail = await fetch(`${base}/admin/introspection/tools/search_atoms`, {
      headers: { "X-Hauska-Admin-Key": process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY! },
    });
    assert.equal(detail.status, 200);

    const call = await fetch(
      `${base}/admin/introspection/tools/codex_finding_generation/call`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hauska-Admin-Key": process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY!,
        },
        body: JSON.stringify({
          arguments: {},
          auth: { product: "public", tier: "free_anonymous" },
        }),
      },
    );
    assert.equal(call.status, 200);
    const callBody = (await call.json()) as { is_error: boolean };
    assert.equal(callBody.is_error, true);

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  } finally {
    if (prev === undefined) delete process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY;
    else process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY = prev;
  }
});

test("auth ladder: no key anonymous, malformed 401", async () => {
  const store = new MemoryRateLimitStore();
  const auth = buildAuthMiddleware(store);
  const app = express();
  app.use(express.json());
  app.post("/mcp", auth, (req, res) => {
    res.json({
      tier: req.hauska?.tier,
      product: req.hauska?.product,
    });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/mcp`;

  const anon = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1 }),
  });
  assert.equal(anon.status, 200);
  const anonBody = (await anon.json()) as { product: string; tier: string };
  assert.equal(anonBody.product, "public");
  assert.equal(anonBody.tier, "free_anonymous");

  const bad = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hauska-Key": "not-a-valid-key-shape",
    },
    body: JSON.stringify({ id: 2 }),
  });
  assert.equal(bad.status, 401);
  const badBody = (await bad.json()) as { error: { message: string } };
  assert.match(badBody.error.message, /Invalid API key format/);

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});
