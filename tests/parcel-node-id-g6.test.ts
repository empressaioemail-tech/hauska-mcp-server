/**
 * G6 — MCP parcel_node_id regex is not the retired digits-only propId pattern.
 * Runs under `pnpm test` (node --test + tsx).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PARCEL_NODE_ID_SOURCE,
  PARCEL_NODE_ID_REGEX,
  normalizeParcelNodeId,
} from "../src/property-atom-chain.ts";

describe("G6 parcel-node-id (MCP ↔ PE)", () => {
  it("is not the retired digits-only propId pattern", () => {
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
