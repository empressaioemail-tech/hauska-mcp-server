// Gate D / Master WDLL 3.11 / I-F — SDK money boundary conformance.
//
// Fails CI if:
//   - @hauska-sdk/metering disappears from package.json dependencies
//   - authorizeCall / McpMeteringGate wiring disappears from src
//   - api.stripe.com returns on the metering money path
//
// Also asserts the tier adapter and that public-free paths do not load the SDK.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  isSdkMeteringEnabled,
  mapMcpTierToSdkTier,
  resetSdkMeteringGateForTests,
  wasSdkMeteringModuleLoaded,
} from "../src/sdk-metering.js";
import { authorizePaidRead, logToolRead } from "../src/read-attribution.js";
import { requestContext } from "../src/request-context.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

test("package.json depends on @hauska-sdk/metering", () => {
  const pkg = JSON.parse(readSrc("package.json")) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(
    pkg.dependencies?.["@hauska-sdk/metering"],
    "@hauska-sdk/metering must be a production dependency (WDLL 3.11 / I-F)",
  );
});

test("source wires McpMeteringGate.authorizeCall", () => {
  const sdk = readSrc("src/sdk-metering.ts");
  const attribution = readSrc("src/read-attribution.ts");
  const tools = readSrc("src/tools.ts");

  assert.match(sdk, /authorizeCall/);
  assert.match(sdk, /McpMeteringGate/);
  assert.match(sdk, /import\(["']@hauska-sdk\/metering["']\)/);
  assert.match(attribution, /authorizePaidRead/);
  assert.match(attribution, /authorizePaidCall/);
  assert.match(tools, /authorizePaidRead/);
});

test("Stripe api.stripe.com metering path is retired", () => {
  const metering = readSrc("src/metering.ts");
  const sdk = readSrc("src/sdk-metering.ts");
  const attribution = readSrc("src/read-attribution.ts");

  for (const [name, src] of [
    ["metering.ts", metering],
    ["sdk-metering.ts", sdk],
    ["read-attribution.ts", attribution],
  ] as const) {
    assert.doesNotMatch(
      src,
      /api\.stripe\.com/,
      `${name} must not call api.stripe.com (Stripe meter retired)`,
    );
    assert.doesNotMatch(
      src,
      /postStripeMeterEvent/,
      `${name} must not define postStripeMeterEvent`,
    );
  }
});

test("no static @hauska-sdk import outside sdk-metering dynamic gate", () => {
  // Public-free path loads read-attribution → must not statically import SDK.
  const attribution = readSrc("src/read-attribution.ts");
  const metering = readSrc("src/metering.ts");
  const tools = readSrc("src/tools.ts");

  for (const [name, src] of [
    ["read-attribution.ts", attribution],
    ["metering.ts", metering],
    ["tools.ts", tools],
  ] as const) {
    assert.doesNotMatch(
      src,
      /from ["']@hauska-sdk\//,
      `${name} must not statically import @hauska-sdk/*`,
    );
    assert.doesNotMatch(
      src,
      /require\(["']@hauska-sdk\//,
      `${name} must not require @hauska-sdk/*`,
    );
  }

  // sdk-metering may only dynamic-import the SDK (no static from-import).
  const sdk = readSrc("src/sdk-metering.ts");
  assert.doesNotMatch(
    sdk,
    /^\s*import\s+(?!type\b)[^;]*from\s+["']@hauska-sdk\//m,
    "sdk-metering.ts must not statically import @hauska-sdk/* value bindings",
  );
  assert.match(sdk, /await import\(["']@hauska-sdk\/metering["']\)/);
});

test("tier adapter maps MCP bands onto SDK Decision B tiers", () => {
  assert.equal(mapMcpTierToSdkTier("free"), "free");
  assert.equal(mapMcpTierToSdkTier("free_anonymous"), "free");
  assert.equal(mapMcpTierToSdkTier("developer_pro"), "builder");
  assert.equal(mapMcpTierToSdkTier("team"), "pro");
  assert.equal(mapMcpTierToSdkTier("embedder"), "pro");
});

test("public-free logToolRead does not load @hauska-sdk/metering", async () => {
  resetSdkMeteringGateForTests();
  const prev = process.env.SDK_METERING;
  process.env.SDK_METERING = "1";
  try {
    assert.equal(isSdkMeteringEnabled(), true);
    assert.equal(wasSdkMeteringModuleLoaded(), false);

    await requestContext.run(
      {
        tier: "free_anonymous",
        product: "public",
        rate_limit_id: "ip:test",
        remaining_rpm: 10,
        remaining_daily: 100,
        request_id: "req-public-sdk-boundary",
      },
      async () => {
        logToolRead(
          { tool: "get_property_atom_chain", tier: "free_anonymous", latency_ms: 1 },
          [],
        );
        const skipped = await authorizePaidRead({
          tool: "get_property_atom_chain",
        });
        assert.equal(skipped.allowed, true);
        assert.ok("skipped" in skipped && skipped.skipped === true);
      },
    );

    assert.equal(
      wasSdkMeteringModuleLoaded(),
      false,
      "public-free path must not dynamically import @hauska-sdk/metering",
    );
  } finally {
    if (prev === undefined) delete process.env.SDK_METERING;
    else process.env.SDK_METERING = prev;
    resetSdkMeteringGateForTests();
  }
});
