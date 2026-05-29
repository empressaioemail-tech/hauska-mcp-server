import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  isExternalCaller,
  logToolInvocation,
  placeApiEnabled,
} from "../src/gtm-observability.js";
import { addLogSink, type LogEntry } from "../src/logger.js";
import { requestContext } from "../src/request-context.js";

const captured: LogEntry[] = [];
addLogSink((e) => captured.push(e));

test("isExternalCaller treats unlisted hashes as external", () => {
  const prev = process.env.HAUSKA_INTERNAL_KEY_HASHES;
  process.env.HAUSKA_INTERNAL_KEY_HASHES = "internal-hash-abc";
  try {
    assert.equal(isExternalCaller(undefined), true);
    assert.equal(isExternalCaller("internal-hash-abc"), false);
    assert.equal(isExternalCaller("external-hash-xyz"), true);
  } finally {
    if (prev === undefined) delete process.env.HAUSKA_INTERNAL_KEY_HASHES;
    else process.env.HAUSKA_INTERNAL_KEY_HASHES = prev;
  }
});

test("logToolInvocation adds key_hash and is_external", () => {
  requestContext.run(
    {
      tier: "free",
      product: "public",
      rate_limit_id: "key:test",
      remaining_rpm: -1,
      remaining_daily: -1,
      key_hash: "hash-test-1",
      request_id: "req-gtm-1",
    },
    () => {
      logToolInvocation({
        tool: "search_atoms",
        jurisdiction_key: "bastrop-tx",
        atom_ids_returned: 2,
      });
    },
  );
  const e = [...captured]
    .reverse()
    .find((x) => x.event === "tool_call" && x.tool === "search_atoms");
  assert.ok(e);
  assert.equal(e!.key_hash, "hash-test-1");
  assert.equal(e!.is_external, true);
  assert.equal(e!.jurisdiction_key, "bastrop-tx");
  assert.equal(e!.atom_ids_returned, 2);
});

test("placeApiEnabled respects env", () => {
  const prev = process.env.PLACE_API_ENABLED;
  process.env.PLACE_API_ENABLED = "true";
  assert.equal(placeApiEnabled(), true);
  process.env.PLACE_API_ENABLED = "false";
  assert.equal(placeApiEnabled(), false);
  if (prev === undefined) delete process.env.PLACE_API_ENABLED;
  else process.env.PLACE_API_ENABLED = prev;
});
