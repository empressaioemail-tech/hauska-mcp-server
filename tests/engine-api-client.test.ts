// engine-api-client gate-front header forwarding for map-layers assemble.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import type { AuthContext } from "../src/auth.js";
import { GATE_FRONT_HEADERS } from "../src/gate-front.js";
import { engineApiClient } from "../src/engine-api-client.js";
import { requestContext } from "../src/request-context.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

const calls: RecordedCall[] = [];
const realFetch = globalThis.fetch;

function requestHeaders(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (raw instanceof Headers) {
    const out: Record<string, string> = {};
    raw.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return (raw as Record<string, string> | undefined) ?? {};
}

beforeEach(() => {
  calls.length = 0;
  delete process.env.HAUSKA_ENGINE_API_URL;
  delete process.env.HAUSKA_ENGINE_API_GATE_TOKEN;
  delete process.env.HAUSKA_ENGINE_API_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        payload: {
          parcelKey: "austin-demo-1",
          place: { latitude: 30.2672, longitude: -97.7431 },
          tenantScope: "tenant-map-1",
          layers: [],
          assembledAt: "2026-06-17T12:00:00.000Z",
        },
        confidence: { value: 1, kind: "deterministic" },
        dataVintage: null,
        coverage: { degraded: false },
        source: { adapter: "map-layers:assemble" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("assembleMapLayers POSTs /v1/map-layers/assemble with gate-front headers", async () => {
  process.env.HAUSKA_ENGINE_API_URL = "http://engine-api.test";
  process.env.HAUSKA_ENGINE_API_GATE_TOKEN = "gate-secret";

  const ctx: AuthContext = {
    tier: "team",
    product: "map",
    key_id: "key-map",
    jurisdiction_tenant: "tenant-map-1",
    rate_limit_id: "test",
    remaining_rpm: -1,
    remaining_daily: -1,
    request_id: "req-assemble-1",
  };

  await requestContext.run(ctx, () =>
    engineApiClient.assembleMapLayers(
      {
        parcel: {
          latitude: 30.2672,
          longitude: -97.7431,
          parcelKey: "austin-demo-1",
        },
        jurisdiction: { stateKey: "texas", localKey: null },
      },
      {
        gateProduct: "cortex",
        accessTier: "tenant-private",
        tenantId: "tenant-map-1",
        gateCredentialId: "key-map",
        requestId: "req-assemble-1",
      },
    ),
  );

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, "http://engine-api.test/v1/map-layers/assemble");
  assert.equal(calls[0]!.init?.method, "POST");

  const headers = requestHeaders(calls[0]!.init);
  assert.equal(headers.authorization, "Bearer gate-secret");
  assert.equal(headers[GATE_FRONT_HEADERS.product], "cortex");
  assert.equal(headers[GATE_FRONT_HEADERS.tenantId], "tenant-map-1");
  assert.equal(headers[GATE_FRONT_HEADERS.packageId], "map-layers");
  assert.equal(headers[GATE_FRONT_HEADERS.accessTier], "tenant-private");
  assert.equal(headers[GATE_FRONT_HEADERS.credentialId], "key-map");
  assert.equal(headers[GATE_FRONT_HEADERS.requestId], "req-assemble-1");
});
