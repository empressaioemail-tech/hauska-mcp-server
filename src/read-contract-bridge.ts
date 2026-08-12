// Bridge from MCP read envelopes to @empressaio/atom-contract read-contract (F4).

import {
  createConsequenceAxis,
  createReadContract,
  createThreeAxisConfidence,
  type ModelAttributionStamp,
  type ReadContract,
  READ_CONTRACT_SCHEMA,
} from "@empressaio/atom-contract/read-contract";

export type ReadContractKind =
  | "catalog"
  | "legacy-deterministic"
  | "model-assisted"
  | "empty";

export interface BuildReadContractParams {
  kind: ReadContractKind;
  /** Atoms surfaced in the envelope provenance block. */
  atomCount?: number;
  /** Mean retrieval score when available (catalog search). */
  avgScore?: number;
  modelAttribution?: ModelAttributionStamp;
  assembledAt?: string;
}

const ROUTINE_CONSEQUENCE = {
  derivation: {
    source: "asce7-risk-category" as const,
    asce7RiskCategory: "II" as const,
  },
  stratum: "routine" as const,
  assertedAt: new Date().toISOString(),
};

function widthedForKind(
  kind: ReadContractKind,
  role: "calibrated" | "asserted",
  atomCount: number,
  avgScore?: number,
) {
  if (kind === "empty") {
    return {
      estimate: 0,
      n: 0,
      intervalWidth: 1,
      provenance: "seed" as const,
    };
  }
  if (role === "calibrated") {
    if (avgScore == null) {
      return {
        estimate: 0,
        n: atomCount,
        intervalWidth: 1,
        provenance: "asserted" as const,
      };
    }
    return {
      estimate: avgScore,
      n: kind === "model-assisted" ? Math.max(atomCount, 1) : atomCount,
      intervalWidth: kind === "model-assisted" ? 0.2 : atomCount > 0 ? 0.08 : 0.35,
      provenance:
        kind === "model-assisted"
          ? ("live" as const)
          : atomCount > 0
            ? ("backtest" as const)
            : ("seed" as const),
    };
  }
  return {
    estimate: kind === "catalog" ? 1 : 0.9,
    n: atomCount,
    intervalWidth: atomCount > 0 ? 0 : 0.25,
    provenance: "asserted" as const,
  };
}

/** Assemble a read-contract object for an MCP read response. */
export function buildReadContract(
  params: BuildReadContractParams,
): ReadContract {
  const atomCount = params.atomCount ?? 0;
  const assembledAt = params.assembledAt ?? new Date().toISOString();
  const consequence = createConsequenceAxis({
    ...ROUTINE_CONSEQUENCE,
    assertedAt: assembledAt,
  });
  return createReadContract({
    axes: createThreeAxisConfidence({
      calibratedConfidence: widthedForKind(
        params.kind,
        "calibrated",
        atomCount,
        params.avgScore,
      ),
      assertedConfidence: widthedForKind(
        params.kind,
        "asserted",
        atomCount,
        params.avgScore,
      ),
      consequence,
    }),
    assembledAt,
    modelAttribution: params.modelAttribution,
  });
}

/** Runtime guard for conformance tests. */
export function assertReadContract(value: unknown): asserts value is ReadContract {
  READ_CONTRACT_SCHEMA.parse(value);
}
