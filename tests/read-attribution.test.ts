import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  atomIdsFromProvenance,
  logToolRead,
} from "../src/read-attribution.js";
import { addLogSink, type LogEntry } from "../src/logger.js";
import { requestContext } from "../src/request-context.js";

test("atomIdsFromProvenance dedupes and trims DIDs", () => {
  assert.deepEqual(
    atomIdsFromProvenance([
      { did: " did:hauska:code-section:icc-2021/101.2 " },
      { did: "did:hauska:code-section:icc-2021/101.2" },
      { did: "did:hauska:code-section:icc-2021/102.1" },
      { did: "" },
    ]),
    [
      "did:hauska:code-section:icc-2021/101.2",
      "did:hauska:code-section:icc-2021/102.1",
    ],
  );
});

test("logToolRead emits atom_ids and atom_ids_returned on tool_call", () => {
  const captured: LogEntry[] = [];
  addLogSink((e) => captured.push(e));

  requestContext.run(
    {
      tier: "developer_pro",
      product: "codex",
      rate_limit_id: "key:test",
      remaining_rpm: -1,
      remaining_daily: -1,
      key_hash: "hash-read-attribution",
      request_id: "req-read-attr-1",
    },
    () => {
      logToolRead(
        {
          tool: "codex_findings_fetch",
          submission_id: "00000000-0000-4000-8000-000000000001",
        },
        [
          { did: "did:hauska:code-section:icc-2021/101.2" },
          { did: "did:hauska:code-section:bastrop-tx/udc-2024/5.04" },
        ],
      );
    },
  );

  const e = [...captured]
    .reverse()
    .find((x) => x.event === "tool_call" && x.tool === "codex_findings_fetch");
  assert.ok(e);
  assert.deepEqual(e!.atom_ids, [
    "did:hauska:code-section:icc-2021/101.2",
    "did:hauska:code-section:bastrop-tx/udc-2024/5.04",
  ]);
  assert.equal(e!.atom_ids_returned, 2);
  assert.equal((e as { envelope?: unknown }).envelope, undefined);
});
