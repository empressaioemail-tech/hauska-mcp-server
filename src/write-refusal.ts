/**
 * Write-refusal probe 3.1 — new-write node id validation at store boundary.
 * substrate-req-property-003.
 *
 * Historical rows are untouched; only new writes pass through here.
 */

import {
  NodeIdParseError,
  parse as parseNodeId,
  type NodeId,
} from "@empressaio/atom-contract/identity";

export const WRITE_REFUSAL_HTTP_STATUS = 422 as const;

export type WriteRefusalCode = "malformed_node_id";

export type WriteRefusalRecord = {
  readonly refused: true;
  readonly code: WriteRefusalCode;
  readonly message: string;
  readonly input: string;
  readonly httpStatus: typeof WRITE_REFUSAL_HTTP_STATUS;
};

export type WriteAcceptRecord = {
  readonly refused: false;
  readonly nodeId: NodeId;
};

export type WriteRefusalOutcome = WriteRefusalRecord | WriteAcceptRecord;

/** Fail-closed validation for a candidate node id on a new store write. */
export function validateNewWriteNodeId(candidate: string): WriteRefusalOutcome {
  try {
    const nodeId = parseNodeId(candidate);
    return { refused: false, nodeId };
  } catch (err) {
    if (err instanceof NodeIdParseError) {
      return {
        refused: true,
        code: "malformed_node_id",
        message: err.message,
        input: err.input,
        httpStatus: WRITE_REFUSAL_HTTP_STATUS,
      };
    }
    throw err;
  }
}

export class WriteRefusedError extends Error {
  readonly code = "write_refused" as const;
  readonly httpStatus = WRITE_REFUSAL_HTTP_STATUS;
  readonly refusal: WriteRefusalRecord;

  constructor(refusal: WriteRefusalRecord) {
    super(refusal.message);
    this.name = "WriteRefusedError";
    this.refusal = refusal;
  }
}

/** Throwing boundary for callers that prefer exceptions over discriminated unions. */
export function refuseUnlessValidNodeId(candidate: string): NodeId {
  const outcome = validateNewWriteNodeId(candidate);
  if (outcome.refused) {
    throw new WriteRefusedError(outcome);
  }
  return outcome.nodeId;
}
