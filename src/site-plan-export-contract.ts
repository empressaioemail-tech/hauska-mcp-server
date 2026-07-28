// Site-plan-export spine contract (Wave 3 pay-gate extension, WDLL items 7-8).
// Mirrors engine-api /v1/property-nodes/:id/site-plan-export/* payloads.
// Sibling of terrain-export-contract.ts: SAME parcel-terrain-model atom,
// SAME public-paid access policy, SAME authorizePaidCall metering helper —
// only the format set and the engine route differ. See
// refresh_parcel_site_plan_export in tools.ts for the tool wiring, and
// _inbox/2026-07-25_site_plan_export_STATUS.md (Wave 3) for the
// sibling-tool-vs-extend-existing-tool decision record.

export const SITE_PLAN_EXPORT_PACKAGE_ID = "site-plan-export";

export const SITE_PLAN_EXPORT_FORMATS = [
  "dxf-site-plan",
  "ifc-site-plan",
  "pdf-site-plan",
] as const;

export type SitePlanExportFormat = (typeof SITE_PLAN_EXPORT_FORMATS)[number];

export interface SitePlanExportArtifactEntry {
  format: SitePlanExportFormat | string;
  ref?: string;
  byteCount?: number;
  pageCount?: number;
  annotationCount?: number;
  deferred?: boolean;
  deferredReason?: string;
}

export interface SitePlanExportRefreshRequest {
  resolutionMeters?: number;
  contourIntervalMeters?: number;
  address?: string;
  countyName?: string;
}

export interface SitePlanExportRefreshResponse {
  atom: Record<string, unknown>;
  artifacts: Record<string, SitePlanExportArtifactEntry>;
  setbackDegenerate?: boolean;
  setbackDegenerateReason?: string;
  /** No setback-rule atom on file — exported honest-absent, not an error. */
  setbackHonestAbsence?: boolean;
  setbackHonestAbsenceReason?: string;
  streetHonestAbsence?: boolean;
  zoningHonestAbsence?: boolean;
  floodZoneHonestUnavailable?: boolean;
}

export interface SitePlanExportDownloadInline {
  format: SitePlanExportFormat;
  contentType: string;
  base64: string;
  byteCount: number;
}

export interface SitePlanExportDownloadRef {
  format: SitePlanExportFormat;
  contentType: string;
  ref: string;
  byteCount: number;
  downloadPath: string;
}

export type SitePlanExportDownloadPayload =
  | SitePlanExportDownloadInline
  | SitePlanExportDownloadRef;

export interface ParcelSitePlanExportToolData {
  parcelNodeId: string;
  atom: Record<string, unknown>;
  artifacts: Record<string, SitePlanExportArtifactEntry>;
  download?: SitePlanExportDownloadPayload;
  setbackDegenerate?: boolean;
  setbackDegenerateReason?: string;
  /** No setback-rule atom on file — exported honest-absent, not an error. */
  setbackHonestAbsence?: boolean;
  setbackHonestAbsenceReason?: string;
  streetHonestAbsence?: boolean;
  zoningHonestAbsence?: boolean;
  floodZoneHonestUnavailable?: boolean;
}

/** Inline base64 cap — larger CAD/PDF artifacts return ref + download path instead. */
export const SITE_PLAN_EXPORT_MAX_INLINE_BYTES = 256 * 1024;

export function sitePlanExportContentType(format: SitePlanExportFormat): string {
  switch (format) {
    case "dxf-site-plan":
      return "application/dxf";
    case "ifc-site-plan":
      return "application/x-step";
    case "pdf-site-plan":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export function sitePlanExportDownloadPath(
  parcelNodeId: string,
  format: SitePlanExportFormat,
): string {
  const encoded = encodeURIComponent(parcelNodeId);
  return `/v1/property-nodes/${encoded}/site-plan-export/download?format=${encodeURIComponent(format)}`;
}

export function isSitePlanExportFormatDeferred(
  artifacts: Record<string, SitePlanExportArtifactEntry>,
  format: SitePlanExportFormat,
): boolean {
  const entry = artifacts[format];
  if (!entry) return true;
  if (entry.deferred === true) return true;
  if (typeof entry.ref === "string" && entry.ref.startsWith("deferred:")) {
    return true;
  }
  return false;
}
