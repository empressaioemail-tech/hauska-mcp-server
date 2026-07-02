import assert from "node:assert/strict";
import { test } from "node:test";

import type { TileCapability } from "../src/legacy-client.js";
import {
  composeWorkspace,
  isSatisfied,
  pickLayout,
  selectTiles,
  tokenizeIntent,
} from "../src/compose-workspace.js";

// -----------------------------------------------------------------
// Fixture registry (hand-built; no network).
// -----------------------------------------------------------------

function tile(overrides: Partial<TileCapability> & Pick<TileCapability, "id" | "label">): TileCapability {
  return {
    category: "general",
    status: "live",
    requires: {},
    produces: {},
    modes: ["full"],
    mcpTools: [],
    ...overrides,
  };
}

const REGISTRY: TileCapability[] = [
  tile({ id: "map", label: "Map", category: "spatial", requires: {} }),
  tile({
    id: "compliance-run",
    label: "Compliance Run",
    category: "review",
    requires: { engagementId: true, uploadedDocuments: true },
    mcpTools: ["run_compliance"],
  }),
  tile({
    id: "hazard",
    label: "Hazard Profile",
    category: "risk",
    requires: {},
    mcpTools: ["get_hazard_profile"],
  }),
  tile({
    id: "future-tile",
    label: "Future Tile",
    category: "review",
    status: "planned",
  }),
];

// -----------------------------------------------------------------
// pickLayout
// -----------------------------------------------------------------

const VALID_LAYOUTS = new Set(["1", "2h", "2v", "3l", "3r", "4", "6"]);

test("pickLayout maps counts to valid layout keys", () => {
  assert.equal(pickLayout(0), "1");
  assert.equal(pickLayout(1), "1");
  assert.equal(pickLayout(2), "2h");
  assert.equal(pickLayout(3), "3l");
  assert.equal(pickLayout(4), "4");
  assert.equal(pickLayout(5), "6");
  assert.equal(pickLayout(6), "6");
  for (const n of [-3, 0, 1, 2, 3, 4, 5, 6, 99]) {
    assert.ok(VALID_LAYOUTS.has(pickLayout(n)), `layout for ${n} must be valid`);
  }
});

// -----------------------------------------------------------------
// isSatisfied
// -----------------------------------------------------------------

test("isSatisfied: no requirements is always satisfied", () => {
  assert.equal(isSatisfied({}, {}), true);
});

test("isSatisfied: missing engagement id fails", () => {
  assert.equal(isSatisfied({ engagementId: true }, {}), false);
  assert.equal(isSatisfied({ engagementId: true }, { id: "e1" }), true);
});

test("isSatisfied: missing uploaded documents fails", () => {
  assert.equal(
    isSatisfied(
      { engagementId: true, uploadedDocuments: true },
      { id: "e1", hasDocuments: false },
    ),
    false,
  );
  assert.equal(
    isSatisfied(
      { engagementId: true, uploadedDocuments: true },
      { id: "e1", hasDocuments: true },
    ),
    true,
  );
});

test("isSatisfied: apn / jurisdiction / findings gates", () => {
  assert.equal(isSatisfied({ apn: true }, {}), false);
  assert.equal(isSatisfied({ jurisdiction: true }, {}), false);
  assert.equal(isSatisfied({ completedFindings: true }, {}), false);
  assert.equal(
    isSatisfied(
      { apn: true, jurisdiction: true, completedFindings: true },
      { apn: true, jurisdiction: true, hasFindings: true },
    ),
    true,
  );
});

// -----------------------------------------------------------------
// selectTiles
// -----------------------------------------------------------------

test("selectTiles ranks compliance and hazard for their intent", () => {
  const live = REGISTRY.filter((t) => t.status === "live");
  const selected = selectTiles("compliance and hazard", live, 4);
  const ids = selected.map((t) => t.id);
  assert.ok(ids.includes("compliance-run"), "compliance-run selected");
  assert.ok(ids.includes("hazard"), "hazard selected");
});

test("selectTiles includes map when a spatial keyword is present", () => {
  const live = REGISTRY.filter((t) => t.status === "live");
  // "parcel" is a spatial keyword; map has score 0 but must be kept.
  const selected = selectTiles("parcel compliance", live, 2);
  const ids = selected.map((t) => t.id);
  assert.ok(ids.includes("map"), "map force-kept for spatial intent");
  assert.ok(selected.length <= 2, "never exceeds maxTiles");
});

test("selectTiles never returns empty when candidates exist", () => {
  const live = REGISTRY.filter((t) => t.status === "live");
  const selected = selectTiles("xyzzy nomatch", live, 3);
  assert.ok(selected.length > 0, "returns zero-score tiles over empty list");
});

test("selectTiles returns empty for no candidates", () => {
  assert.deepEqual(selectTiles("anything", [], 4), []);
});

test("tokenizeIntent drops stop-words and sub-3-char noise", () => {
  // "me", "a", "for" and single letters must not survive — they are
  // substring noise ("a" is in "map", "hazard"; "me" in "document").
  const tokens = tokenizeIntent("show me compliance and hazard for a plan review");
  assert.deepEqual(tokens, ["compliance", "hazard", "plan", "review"]);
});

test("tokenizeIntent matches on word boundaries, not interior substrings", () => {
  // Regression guard for the live-registry crowding bug: with many
  // same-category tiles matching the common term, the tile uniquely
  // matching the rarer named term must still be selected (coverage-first).
  const crowd: TileCapability[] = [
    tile({ id: "c1", label: "Intake", category: "Compliance" }),
    tile({ id: "c2", label: "Intake Queue", category: "Compliance" }),
    tile({ id: "c3", label: "Compliance Run", category: "Compliance" }),
    tile({ id: "c4", label: "Document Viewer", category: "Compliance" }),
    tile({ id: "c5", label: "Findings Library", category: "Compliance" }),
    tile({ id: "hz", label: "Hazard Profile", category: "Property Intel" }),
  ];
  const ids = selectTiles(
    "show me compliance and hazard for a plan review",
    crowd,
    4,
  ).map((t) => t.id);
  assert.ok(ids.includes("hz"), "the uniquely-hazard tile is not crowded out");
  assert.ok(
    ids.some((id) => ["c1", "c2", "c3", "c4", "c5"].includes(id)),
    "a compliance tile is also selected",
  );
});

// -----------------------------------------------------------------
// composeWorkspace end-to-end
// -----------------------------------------------------------------

test("composeWorkspace excludes planned tiles and composes over live/partial", () => {
  const result = composeWorkspace(
    { intent: "compliance and hazard", maxTiles: 4 },
    REGISTRY,
  );
  assert.ok(!result.tiles.includes("future-tile"), "planned tile excluded");
  assert.ok(result.tiles.includes("compliance-run"));
  assert.ok(result.tiles.includes("hazard"));
  assert.equal(result.layoutId, pickLayout(result.tiles.length));
  assert.ok(result.why.includes("compliance and hazard"));
});

test("composeWorkspace filters by engagement context", () => {
  // Without documents, compliance-run (requires uploadedDocuments) drops.
  const result = composeWorkspace(
    { intent: "compliance and hazard", engagementId: "e1", maxTiles: 4 },
    REGISTRY,
    { id: "e1", apn: true, jurisdiction: true, hasDocuments: false, hasFindings: false },
  );
  assert.ok(
    !result.tiles.includes("compliance-run"),
    "compliance-run dropped without documents",
  );
  assert.ok(result.tiles.includes("hazard"), "hazard survives (no requirements)");
  assert.equal(result.engagementId, "e1");
});

test("composeWorkspace honors availableTileIds", () => {
  const result = composeWorkspace(
    { intent: "hazard", availableTileIds: ["hazard"], maxTiles: 4 },
    REGISTRY,
  );
  assert.deepEqual(result.tiles, ["hazard"]);
});

test("composeWorkspace spatial intent includes map", () => {
  const result = composeWorkspace(
    { intent: "show me the parcel on a map", maxTiles: 3 },
    REGISTRY,
  );
  assert.ok(result.tiles.includes("map"));
});
