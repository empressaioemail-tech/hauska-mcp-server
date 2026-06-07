// Gate-availability synthetic probe tests.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runGateProbe } from "../src/gate-probe.js";

const CODEX_TOOL = "codex_finding_generation";

function productDenied(publicProduct = true): Response {
  const text = publicProduct
    ? `Tool "${CODEX_TOOL}" requires a "codex"-product API key. The caller is on product "public".`
    : `Tool "${CODEX_TOOL}" requires a "codex"-product API key. The caller is on product "cortex".`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "gate-probe",
      result: {
        content: [{ type: "text", text }],
        isError: true,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function auth401(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid API key format." },
      id: "gate-probe",
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function codexBackendError(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "gate-probe",
      result: {
        content: [{ type: "text", text: "engine unreachable" }],
        isError: true,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("runGateProbe passes all three gate cases", async () => {
  const fetchFn = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    const key = headers?.["X-Hauska-Key"];
    if (!key) return productDenied(true);
    if (key === "not-a-valid-key-shape") return auth401();
    if (key === "hk_pro_VALIDKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") {
      return codexBackendError();
    }
    return auth401();
  };

  const result = await runGateProbe({
    baseUrl: "https://probe.test",
    codexProbeKey: "hk_pro_VALIDKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    fetchFn,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.cases.length, 3);
  assert.ok(result.cases.every((c) => c.pass));

  const anon = result.cases.find((c) => c.case === "anonymous_public");
  assert.equal(anon?.header_used, "(none)");
  assert.equal(anon?.http_status, 200);
  assert.equal(anon?.product_resolved, "public");

  const malformed = result.cases.find((c) => c.case === "malformed_key_401");
  assert.match(malformed?.header_used ?? "", /X-Hauska-Key: not-a-valid/);
  assert.equal(malformed?.http_status, 401);

  const valid = result.cases.find((c) => c.case === "valid_key_product");
  assert.match(valid?.header_used ?? "", /X-Hauska-Key:/);
  assert.notEqual(valid?.http_status, 401);
});

test("runGateProbe fails when malformed key is not rejected", async () => {
  const fetchFn = async (): Promise<Response> => productDenied(true);
  const result = await runGateProbe({
    baseUrl: "https://probe.test",
    codexProbeKey: "hk_pro_VALIDKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    fetchFn,
  });
  const malformed = result.cases.find((c) => c.case === "malformed_key_401");
  assert.equal(malformed?.pass, false);
  assert.equal(result.status, "fail");
});

test("runGateProbe flags missing probe key", async () => {
  const fetchFn = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (!headers?.["X-Hauska-Key"]) return productDenied(true);
    return auth401();
  };
  const result = await runGateProbe({
    baseUrl: "https://probe.test",
    fetchFn,
  });
  const valid = result.cases.find((c) => c.case === "valid_key_product");
  assert.equal(valid?.pass, false);
  assert.match(valid?.detail ?? "", /not configured/);
});
