// Fail-closed X-ray (property dossier) export gate — P-89.
// Mirrors PE refuseHollowXrayExport (pe-dossier-export-core.ts) so raw MCP
// callers cannot bypass the PE BFF refuse.

import type { DossierExportArtifactEntry } from "./dossier-export-contract.js";

export const XRAY_PIPELINE_ABSENT_ERROR = "pipeline_output_absent" as const;

export const XRAY_PIPELINE_ABSENT_MESSAGE =
  "X-ray cannot be generated: the verdict and cited brief facts were not produced. Open the property brief and try again. A hollow report will not be downloaded.";

/** Same sentence as VERDICT_UNRESOLVED.line in PE sheet-verdict.ts. */
export const XRAY_VERDICT_PLACEHOLDER =
  "This property has not resolved a fact sheet yet.";

export const XRAY_STORED_HOLLOW_MESSAGE =
  "Stored X-ray artifact is hollow (missing verdict or brief facts) and cannot be downloaded. Refresh with a resolved brief first.";

export type HollowXrayMissing = "verdict" | "brief_facts";

export type HollowXrayRefuse = {
  ok: false;
  status: 422;
  error: typeof XRAY_PIPELINE_ABSENT_ERROR;
  message: string;
  missing: HollowXrayMissing[];
};

export type DossierRefreshGateInput = {
  verdictLine?: string | null;
  brief?: { sections: Array<{ facts: unknown[] }> } | null;
};

/**
 * Fail-closed gate for refresh_parcel_dossier_export. Pipeline output (verdict
 * line + at least one brief fact) must be present or the export is refused — no
 * engine call, no PDF bytes, no stored artifact.
 */
export function refuseHollowXrayRefresh(
  input: DossierRefreshGateInput,
): { ok: true } | HollowXrayRefuse {
  const missing: HollowXrayMissing[] = [];
  const verdict = input.verdictLine?.trim();
  if (!verdict || verdict === XRAY_VERDICT_PLACEHOLDER) {
    missing.push("verdict");
  }
  const factCount = (input.brief?.sections ?? []).reduce(
    (n, section) => n + section.facts.length,
    0,
  );
  if (factCount === 0) {
    missing.push("brief_facts");
  }
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    status: 422,
    error: XRAY_PIPELINE_ABSENT_ERROR,
    message: XRAY_PIPELINE_ABSENT_MESSAGE,
    missing,
  };
}

/**
 * Stored pdf-dossier artifact metadata from a prior refresh. Refuse download
 * when the engine recorded a hollow export (verdict or brief facts absent).
 */
export function isStoredDossierArtifactHollow(
  artifact: DossierExportArtifactEntry | undefined,
): boolean {
  if (!artifact || artifact.deferred === true) return false;
  if (typeof artifact.ref === "string" && artifact.ref.startsWith("deferred:")) {
    return false;
  }
  const verdictIncluded =
    "verdictIncluded" in artifact && artifact.verdictIncluded === true;
  const briefFactCount =
    "briefFactCount" in artifact && typeof artifact.briefFactCount === "number"
      ? artifact.briefFactCount
      : 0;
  return !verdictIncluded || briefFactCount === 0;
}

export function formatHollowXrayRefuse(refuse: HollowXrayRefuse): string {
  return JSON.stringify({
    status: refuse.status,
    error: refuse.error,
    message: refuse.message,
    missing: refuse.missing,
  });
}

export function formatStoredHollowRefuse(): string {
  return JSON.stringify({
    status: 422,
    error: XRAY_PIPELINE_ABSENT_ERROR,
    message: XRAY_STORED_HOLLOW_MESSAGE,
    missing: ["verdict", "brief_facts"] as HollowXrayMissing[],
  });
}
