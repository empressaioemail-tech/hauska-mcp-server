import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { smartFilesBackendUrl, smartFilesClient } from "../src/smart-files-client.js";

const calls: { url: string; auth?: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  delete process.env.SMART_FILES_BACKEND_URL;
  delete process.env.SMART_FILES_API_KEY;
  delete process.env.LEGACY_BACKEND_URL;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("authorization") ?? undefined });
    return new Response(
      JSON.stringify({
        folders: [],
        servedAt: "2026-08-15T00:00:00.000Z",
        status: "held",
        document: {},
        placements: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SMART_FILES_BACKEND_URL;
  delete process.env.SMART_FILES_API_KEY;
  delete process.env.LEGACY_BACKEND_URL;
});

test("refuses a cortex-api base URL", () => {
  process.env.SMART_FILES_BACKEND_URL = "https://cortex-api-tds7av26va-uc.a.run.app";
  assert.throws(() => smartFilesBackendUrl(), /refuses cortex-api/);
});

test("does not follow LEGACY_BACKEND_URL even when set", async () => {
  process.env.LEGACY_BACKEND_URL = "https://cortex-api-tds7av26va-uc.a.run.app";
  process.env.SMART_FILES_BACKEND_URL = "https://smart-files.example.test";
  await smartFilesClient.listFolders("tenant", "g58-probe");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /^https:\/\/smart-files\.example\.test\/api\/smart-files\/folders/);
  assert.doesNotMatch(calls[0]!.url, /cortex-api/);
});

test("sends SMART_FILES_API_KEY as Bearer", async () => {
  process.env.SMART_FILES_BACKEND_URL = "https://smart-files.example.test";
  process.env.SMART_FILES_API_KEY = "test-token";
  await smartFilesClient.readFile("smartfile:tenant:g58-probe:isolation-note");
  assert.equal(calls[0]!.auth, "Bearer test-token");
});
