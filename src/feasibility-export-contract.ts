// Feasibility-Study export contract (OPS-16 P-120 item 27).
// Mirrors engine-api /v1/property-nodes/:id/feasibility-export/* payloads
// (services/engine-api/src/routes/parcel-terrain.ts on hauska-engine main,
// merged via PR #380 / a58310c "P-32 wave 1 — engine-side assembler (items
// 3-9)", confirmed live on origin/main at 45c540a and canary-verified /
// promoted to 100% / re-verified against production per
// doc_repo/_decisions/2026-09-04_p32_wave1_customer_done.md). Sibling of
// dossier-export-contract.ts: SAME parcel-terrain-model atom, SAME
// public-paid access policy, SAME authorizePaidCall metering helper — only
// the engine route, request shape, and response fields differ. Feasibility
// ships exactly one artifact format (pdf-feasibility) and its refresh
// request reuses the site-plan-export geometry seams (bboxOverride,
// ringOverride, resolutionMeters, contourIntervalMeters, frontEdgeIndex,
// skirtDepthFeet, streetAnchors) plus feasibility-specific fields
// (centroidOverride, floodStudyAvailable, liveViewUrl, narrativeOverride).
// The engine never calls an LLM itself: narrativeOverride is an
// already-generated, caller-supplied narrative; when absent, the engine
// renders its deterministic skeleton fallback (narrativeIsDeterministicSkeleton
// on the response says which happened).

export const FEASIBILITY_EXPORT_PACKAGE_ID = "feasibility-export";

/**
 * The feasibility study ships exactly one artifact format. The engine's
 * download route (GET .../feasibility-export/download) takes NO format
 * query param — it always serves the pdf-feasibility artifact as
 * application/pdf (confirmed against
 * services/engine-api/src/routes/parcel-terrain.ts on feat/p32-feasibility-wave1).
 */
export const FEASIBILITY_EXPORT_FORMATS = ["pdf-feasibility"] as const;

export type FeasibilityExportFormat = (typeof FEASIBILITY_EXPORT_FORMATS)[number];

export interface FeasibilityExportArtifactEntry {
  format: FeasibilityExportFormat | string;
  ref?: string;
  byteCount?: number;
  pageCount?: number;
  deferred?: boolean;
  deferredReason?: string;
}

/** Caller-supplied, already-generated narrative — the engine never calls an LLM itself. */
export interface FeasibilityNarrativeOverride {
  text: string;
  generatedBy: string;
  generatedAt: string;
}

/**
 * Refresh request — passed through to the engine VERBATIM. Everything is
 * optional and caller-supplied; the engine's own zod caps and assembler
 * sanitizer are authoritative, not re-implemented here.
 *
 * The engine's feasibilityRefreshBody also accepts bboxOverride,
 * ringOverride, frontEdgeIndex, skirtDepthFeet, streetAnchors, and
 * centroidOverride — explicit test/operator geometry seams (the engine's own
 * comment: "Same geometry seams as dossier-export/refresh — one composition
 * path"). Deliberately withheld from this MCP-facing contract, matching
 * site-plan-export-contract.ts and dossier-export-contract.ts, neither of
 * which exposes them either — the engine composes geometry from its own
 * resolver by default when these are omitted.
 */
export interface FeasibilityExportRefreshRequest {
  resolutionMeters?: number;
  contourIntervalMeters?: number;
  address?: string;
  countyName?: string;
  floodStudyAvailable?: boolean;
  liveViewUrl?: string;
  narrativeOverride?: FeasibilityNarrativeOverride;
}

export interface FeasibilityExportRefreshResponse {
  atom: Record<string, unknown>;
  artifacts: Record<string, FeasibilityExportArtifactEntry>;
  pageCount?: number;
  feasibilityPageCount?: number;
  sitePlanAppended?: boolean;
  sitePlanUnavailableReason?: string;
  sectionCount?: number;
  openItemCount?: number;
  narrativeIsDeterministicSkeleton?: boolean;
}

export interface FeasibilityExportDownloadInline {
  format: FeasibilityExportFormat;
  contentType: string;
  base64: string;
  byteCount: number;
}

export interface FeasibilityExportDownloadRef {
  format: FeasibilityExportFormat;
  contentType: string;
  ref: string;
  byteCount: number;
  downloadPath: string;
}

export type FeasibilityExportDownloadPayload =
  | FeasibilityExportDownloadInline
  | FeasibilityExportDownloadRef;

export interface ParcelFeasibilityExportToolData {
  parcelNodeId: string;
  atom: Record<string, unknown>;
  artifacts: Record<string, FeasibilityExportArtifactEntry>;
  /** Echo of caller-supplied live_view_url when provided (W2.4 pattern, matches dossier). */
  liveViewUrl?: string;
  download?: FeasibilityExportDownloadPayload;
  pageCount?: number;
  feasibilityPageCount?: number;
  sitePlanAppended?: boolean;
  sitePlanUnavailableReason?: string;
  sectionCount?: number;
  openItemCount?: number;
  narrativeIsDeterministicSkeleton?: boolean;
}

/** Inline base64 cap — a multi-section feasibility PDF returns ref + download path instead. */
export const FEASIBILITY_EXPORT_MAX_INLINE_BYTES = 256 * 1024;

export const FEASIBILITY_EXPORT_CONTENT_TYPE = "application/pdf";

/**
 * Engine download path. NO format query param — the engine route serves
 * the single pdf-feasibility artifact unconditionally (confirmed against
 * services/engine-api/src/routes/parcel-terrain.ts on feat/p32-feasibility-wave1).
 */
export function feasibilityExportDownloadPath(parcelNodeId: string): string {
  const encoded = encodeURIComponent(parcelNodeId);
  return `/v1/property-nodes/${encoded}/feasibility-export/download`;
}

export function isFeasibilityExportArtifactDeferred(
  artifacts: Record<string, FeasibilityExportArtifactEntry>,
): boolean {
  const entry = artifacts["pdf-feasibility"];
  if (!entry) return true;
  if (entry.deferred === true) return true;
  if (typeof entry.ref === "string" && entry.ref.startsWith("deferred:")) {
    return true;
  }
  return false;
}
