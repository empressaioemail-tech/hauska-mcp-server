/**
 * Atom store write chokepoint — all new atom writes must pass through here.
 * substrate-req-property-003.
 */

import type { NodeId } from "@empressaio/atom-contract/identity";

import {
  refuseUnlessValidNodeId,
  type WriteRefusalRecord,
  validateNewWriteNodeId,
} from "./write-refusal.js";

export interface AtomStoreWriteInput {
  readonly nodeId: string;
  readonly entityType: string;
  readonly payload: unknown;
}

export type AtomStoreWriteResult =
  | { readonly stored: true; readonly nodeId: NodeId }
  | WriteRefusalRecord;

export interface AtomStorePort {
  write(record: {
    nodeId: NodeId;
    entityType: string;
    payload: unknown;
  }): Promise<void>;
}

/**
 * Store boundary for new writes. Malformed ids are refused before the port runs.
 */
export async function executeAtomStoreWrite(
  input: AtomStoreWriteInput,
  store: AtomStorePort,
): Promise<AtomStoreWriteResult> {
  const outcome = validateNewWriteNodeId(input.nodeId);
  if (outcome.refused) {
    return outcome;
  }
  await store.write({
    nodeId: outcome.nodeId,
    entityType: input.entityType,
    payload: input.payload,
  });
  return { stored: true, nodeId: outcome.nodeId };
}

/** Synchronous guard for write paths that do not use the async port yet. */
export function guardAtomStoreWriteNodeId(candidate: string): NodeId {
  return refuseUnlessValidNodeId(candidate);
}
