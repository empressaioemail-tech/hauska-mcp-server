/**
 * G6 — MCP parcel_node_id regex matches PE contract (F1b).
 * Runs under `pnpm test` (node --test + tsx).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PARCEL_NODE_ID_SOURCE,
  PARCEL_NODE_ID_REGEX,
  normalizeParcelNodeId,
} from "../src/property-atom-chain.ts";

/** Mirrored from hauska-map apps/property-explorer/api/_lib/parcel-node-id.ts */
const PE_PARCEL_NODE_ID_SOURCE = String.raw`^\d{5}:[^/\s]+$`;

describe("G6 parcel-node-id (MCP ↔ PE)", () => {
  it("matches the PE BFF source string (no digits-only drift)", () => {
    assert.equal(PARCEL_NODE_ID_SOURCE, PE_PARCEL_NODE_ID_SOURCE);
    assert.notEqual(PARCEL_NODE_ID_SOURCE, String.raw`^\d{5}:\d+$`);
  });

  it("accepts numeric and non-slash propIds", () => {
    assert.equal(PARCEL_NODE_ID_REGEX.test("48209:156346"), true);
    assert.equal(PARCEL_NODE_ID_REGEX.test("48453:R123"), true);
    assert.equal(normalizeParcelNodeId("48021:27303"), "48021:27303");
  });

  it("rejects path injection", () => {
    assert.equal(PARCEL_NODE_ID_REGEX.test("48209:156/346"), false);
  });
});
