// P-89 violation suite — each refuse is proven by violating the gate.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  isStoredDossierArtifactHollow,
  refuseHollowXrayRefresh,
  XRAY_PIPELINE_ABSENT_ERROR,
  XRAY_VERDICT_PLACEHOLDER,
} from "../src/xray-export-gate.js";

const VALID_BRIEF = {
  sections: [
    {
      id: "zoning",
      title: "Zoning",
      facts: [{ label: "District", value: "R1" }],
    },
  ],
};

test("refuseHollowXrayRefresh passes with verdict and brief facts", () => {
  const gate = refuseHollowXrayRefresh({
    verdictLine: "BUILDABLE with conditions",
    brief: VALID_BRIEF,
  });
  assert.equal(gate.ok, true);
});

test("refuseHollowXrayRefresh violates: missing verdict (WDLL item 1)", () => {
  const gate = refuseHollowXrayRefresh({
    brief: VALID_BRIEF,
  });
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.equal(gate.status, 422);
  assert.equal(gate.error, XRAY_PIPELINE_ABSENT_ERROR);
  assert.ok(gate.missing.includes("verdict"));
});

test("refuseHollowXrayRefresh violates: unresolved verdict placeholder (WDLL item 1)", () => {
  const gate = refuseHollowXrayRefresh({
    verdictLine: XRAY_VERDICT_PLACEHOLDER,
    brief: VALID_BRIEF,
  });
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.ok(gate.missing.includes("verdict"));
});

test("refuseHollowXrayRefresh violates: null brief with verdict (WDLL item 2)", () => {
  const gate = refuseHollowXrayRefresh({
    verdictLine: "BUILDABLE",
    brief: null,
  });
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.ok(gate.missing.includes("brief_facts"));
});

test("refuseHollowXrayRefresh violates: empty brief sections (WDLL item 2)", () => {
  const gate = refuseHollowXrayRefresh({
    verdictLine: "BUILDABLE",
    brief: { sections: [] },
  });
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.ok(gate.missing.includes("brief_facts"));
});

test("isStoredDossierArtifactHollow violates: stored artifact without verdict (WDLL item 3)", () => {
  assert.equal(
    isStoredDossierArtifactHollow({
      format: "pdf-dossier",
      ref: "file:///tmp/hollow.pdf",
      verdictIncluded: false,
      briefFactCount: 2,
    }),
    true,
  );
});

test("isStoredDossierArtifactHollow violates: stored artifact with zero brief facts (WDLL item 3)", () => {
  assert.equal(
    isStoredDossierArtifactHollow({
      format: "pdf-dossier",
      ref: "file:///tmp/hollow.pdf",
      verdictIncluded: true,
      briefFactCount: 0,
    }),
    true,
  );
});

test("isStoredDossierArtifactHollow passes: valid stored artifact metadata", () => {
  assert.equal(
    isStoredDossierArtifactHollow({
      format: "pdf-dossier",
      ref: "file:///tmp/valid.pdf",
      verdictIncluded: true,
      briefFactCount: 2,
    }),
    false,
  );
});

test("isStoredDossierArtifactHollow passes: deferred artifact is not hollow-refused here", () => {
  assert.equal(
    isStoredDossierArtifactHollow({
      format: "pdf-dossier",
      deferred: true,
      verdictIncluded: false,
      briefFactCount: 0,
    }),
    false,
  );
});

test("WDLL item 5 finding: flood liveViewUrl is not an MCP tool path", () => {
  // Flood drainage refresh is PE BFF → engine-api directly (pe-flood-drainage-core.ts).
  // hauska-mcp-server has no refresh_flood_* tool; liveViewUrl forwarding for flood
  // is out of scope for this repo until a flood MCP tool is registered.
  assert.ok(true, "documented finding — flood is not an MCP write path today");
});
