/**
 * Write-refusal probe 3.1 — substrate-req-property-003.
 *
 * Violation run: malformed id refused; minted id accepted at store boundary.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mint } from "@empressaio/atom-contract/identity";

import {
  executeAtomStoreWrite,
  type AtomStorePort,
} from "../src/atom-store-write-boundary.ts";
import {
  WRITE_REFUSAL_HTTP_STATUS,
  validateNewWriteNodeId,
} from "../src/write-refusal.ts";

function mockStore(written: Array<{ nodeId: string; entityType: string }>): AtomStorePort {
  return {
    async write(record) {
      written.push({
        nodeId: String(record.nodeId),
        entityType: record.entityType,
      });
    },
  };
}

test("probe 3.1 — malformed node id refused at store boundary", async () => {
  const written: Array<{ nodeId: string; entityType: string }> = [];
  const result = await executeAtomStoreWrite(
    {
      nodeId: "48209:156346",
      entityType: "parcel-node",
      payload: { source: "cama" },
    },
    mockStore(written),
  );

  assert.equal(result.refused, true);
  if (!result.refused) {
    throw new Error("expected refusal");
  }
  assert.equal(result.code, "malformed_node_id");
  assert.equal(result.httpStatus, WRITE_REFUSAL_HTTP_STATUS);
  assert.equal(written.length, 0);
});

test("probe 3.1 — minted node id passes store boundary", async () => {
  const goodId = mint();
  const written: Array<{ nodeId: string; entityType: string }> = [];
  const result = await executeAtomStoreWrite(
    {
      nodeId: String(goodId),
      entityType: "parcel-node",
      payload: { source: "cama" },
    },
    mockStore(written),
  );

  assert.equal(result.stored, true);
  if (!("stored" in result) || !result.stored) {
    throw new Error("expected stored");
  }
  assert.equal(String(result.nodeId), String(goodId));
  assert.equal(written.length, 1);
  assert.equal(written[0]!.nodeId, String(goodId));
});

test("probe 3.1 — violation fixture: natural key would pass without boundary", () => {
  const naturalKey = "48439:R123456";
  const direct = validateNewWriteNodeId(naturalKey);
  assert.equal(direct.refused, true);
  assert.match(direct.refused ? direct.message : "", /NodeId must match/);
});

test("probe 3.1 — validateNewWriteNodeId accepts minted id", () => {
  const goodId = mint();
  const outcome = validateNewWriteNodeId(String(goodId));
  assert.equal(outcome.refused, false);
  if (outcome.refused) {
    throw new Error("expected accept");
  }
  assert.equal(String(outcome.nodeId), String(goodId));
});
