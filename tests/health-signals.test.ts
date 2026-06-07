// Health signal emit contract tests (76e).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { emitHauskaHealthSignal } from "../src/health-signals.js";
import { addLogSink, type LogEntry } from "../src/logger.js";

test("emitHauskaHealthSignal logs hauska_health contract fields", () => {
  const captured: LogEntry[] = [];
  addLogSink((entry) => captured.push(entry));

  const signal = emitHauskaHealthSignal({
    check: "gate_probe",
    service: "hauska-mcp-server",
    status: "ok",
    value: "anonymous_public:pass,malformed_key_401:pass",
    threshold: "all pass",
    source: "test",
  });

  assert.equal(signal.hauska_health, true);
  assert.equal(signal.check, "gate_probe");
  assert.equal(signal.source, "test");
  assert.equal(signal.value, "anonymous_public:pass,malformed_key_401:pass");
  assert.ok(signal.ts);

  const line = captured.find((e) => e.event === "hauska_health_signal");
  assert.ok(line);
  assert.equal(line?.hauska_health, true);
  assert.equal(line?.source, "test");
});
