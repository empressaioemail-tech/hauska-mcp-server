// Log-sink tests.
//
// The Postgres request_log composition and the GCS batching are tested
// with injected fakes, so no database or GCS access is needed.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createLogSink,
  writeRequestLog,
  type GcsWriter,
  type QueryFn,
} from "../src/log-sink.js";
import type { LogEntry } from "../src/logger.js";

function entry(event: string, fields: Record<string, unknown>): LogEntry {
  return {
    ts: new Date().toISOString(),
    severity: "INFO",
    level: "info",
    event,
    env: "test",
    ...fields,
  };
}

interface Call {
  text: string;
  values: unknown[];
}

function recordingQuery(): { query: QueryFn; calls: Call[] } {
  const calls: Call[] = [];
  const query: QueryFn = async (text, values) => {
    calls.push({ text, values: values ?? [] });
    return {};
  };
  return { query, calls };
}

test("writeRequestLog upserts request_received columns", async () => {
  const { query, calls } = recordingQuery();
  await writeRequestLog(
    query,
    entry("request_received", {
      request_id: "r1",
      method: "tools/call",
      params: { name: "search_atoms" },
      ip: "1.2.3.4",
      key_hash: "abc",
      tier: "developer_pro",
      product: "public",
    }),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /INSERT INTO request_log/);
  assert.match(calls[0]!.text, /ON CONFLICT \(request_id\) DO UPDATE/);
  assert.equal(calls[0]!.values[0], "r1");
  assert.equal(calls[0]!.values[2], "tools/call");
  assert.equal(calls[0]!.values[3], JSON.stringify({ name: "search_atoms" }));
});

test("writeRequestLog upserts tool_call columns", async () => {
  const { query, calls } = recordingQuery();
  await writeRequestLog(
    query,
    entry("tool_call", {
      request_id: "r2",
      tool: "search_atoms",
      jurisdiction: "bastrop-tx",
      atom_ids: ["did:hauska:code-section:a", "did:hauska:code-section:b"],
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.values[1], "search_atoms");
  assert.equal(calls[0]!.values[2], "bastrop-tx");
  assert.deepEqual(calls[0]!.values[3], [
    "did:hauska:code-section:a",
    "did:hauska:code-section:b",
  ]);
});

test("writeRequestLog flags 5xx responses as errors", async () => {
  const { query, calls } = recordingQuery();
  await writeRequestLog(
    query,
    entry("request_completed", {
      request_id: "r3",
      response_status: 500,
      latency_ms: 42,
    }),
  );
  await writeRequestLog(
    query,
    entry("request_completed", {
      request_id: "r4",
      response_status: 200,
      latency_ms: 10,
    }),
  );
  assert.equal(calls[0]!.values[3], true);
  assert.equal(calls[1]!.values[3], false);
});

test("writeRequestLog ignores entries without a request_id", async () => {
  let called = 0;
  const query: QueryFn = async () => {
    called += 1;
    return {};
  };
  await writeRequestLog(query, entry("request_received", { method: "tools/list" }));
  assert.equal(called, 0);
});

test("the sink writes only request events to Postgres", async () => {
  const { query, calls } = recordingQuery();
  const { sink, drain } = createLogSink({
    query,
    gcs: null,
    flushIntervalMs: 0,
  });
  sink(entry("request_received", { request_id: "r5" }));
  sink(entry("auth_hash_miss", { ip: "9.9.9.9" }));
  sink(entry("tool_call", { request_id: "r5", tool: "get_atom" }));
  await drain();
  assert.equal(calls.length, 2, "only request_received + tool_call hit Postgres");
});

test("the GCS sink batches and flushes every entry as NDJSON", async () => {
  const written: { path: string; body: string }[] = [];
  const gcs: GcsWriter = {
    async write(path, body) {
      written.push({ path, body });
    },
  };
  const { sink, flush } = createLogSink({
    query: async () => ({}),
    gcs,
    batchSize: 100,
    flushIntervalMs: 0,
  });
  sink(entry("request_received", { request_id: "r6" }));
  sink(entry("auth_hash_miss", {}));
  await flush();
  assert.equal(written.length, 1);
  assert.match(
    written[0]!.path,
    /^mcp-logs\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/.+\.ndjson$/,
  );
  const lines = written[0]!.body.trimEnd().split("\n");
  assert.equal(lines.length, 2, "both entries archived");
  assert.equal(JSON.parse(lines[0]!).event, "request_received");
});

test("the GCS sink auto-flushes when the batch is full", async () => {
  const written: string[] = [];
  const gcs: GcsWriter = {
    async write(_path, body) {
      written.push(body);
    },
  };
  const { sink } = createLogSink({
    query: async () => ({}),
    gcs,
    batchSize: 3,
    flushIntervalMs: 0,
  });
  for (let i = 0; i < 3; i++) sink(entry("noise", {}));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(written.length, 1);
});
