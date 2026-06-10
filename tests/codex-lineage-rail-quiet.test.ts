// Rail-quiet: calibration grade fields must not appear in codex_findings_fetch data.status.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { codexEnvelope } from "../src/atom-shape.js";

test("codex_findings_fetch status projection omits calibration grade fields", () => {
  const statusPublic = {
    generationId: "run-1",
    state: "succeeded",
    startedAt: "2026-06-09T00:00:00.000Z",
    completedAt: "2026-06-09T00:01:00.000Z",
    error: null,
  };
  const env = codexEnvelope(
    {
      findings: [],
      status: statusPublic,
    },
    [],
    { tier: "developer_pro" },
  );
  const status = (env.data as { status?: Record<string, unknown> }).status;
  assert.ok(status);
  assert.equal("invalidCitationCount" in status, false);
  assert.equal("invalidCitations" in status, false);
  assert.equal("discardedFindingCount" in status, false);
  assert.equal("calibrationGrade" in status, false);
});
