// SF-42: do not invent calibrated-looking confidence on miss.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildReadContract } from "../src/read-contract-bridge.js";

const INVENTED = new Set([0.75, 0.95, 0.85]);

test("SF-42: missing avgScore does not invent 0.75 / 0.95 / 0.85 on calibrated axis", () => {
  const catalog = buildReadContract({ kind: "catalog", atomCount: 3 });
  const model = buildReadContract({ kind: "model-assisted", atomCount: 2 });
  const empty = buildReadContract({ kind: "empty", atomCount: 0 });
  const legacy = buildReadContract({ kind: "legacy-deterministic", atomCount: 1 });

  for (const [label, rc] of [
    ["catalog", catalog],
    ["model-assisted", model],
    ["empty", empty],
    ["legacy-deterministic", legacy],
  ] as const) {
    const est = rc.axes.calibratedConfidence.estimate;
    assert.equal(
      INVENTED.has(est),
      false,
      `${label} calibrated estimate ${est} is an invented fallback`,
    );
    assert.ok(
      rc.axes.calibratedConfidence.provenance === "asserted" ||
        rc.axes.calibratedConfidence.provenance === "seed",
      `${label} calibrated provenance must be asserted/seed when unmeasured, got ${rc.axes.calibratedConfidence.provenance}`,
    );
  }
});

test("measured avgScore is used on the calibrated axis", () => {
  const rc = buildReadContract({ kind: "catalog", atomCount: 4, avgScore: 0.42 });
  assert.equal(rc.axes.calibratedConfidence.estimate, 0.42);
  assert.notEqual(rc.axes.calibratedConfidence.provenance, "asserted");
});
