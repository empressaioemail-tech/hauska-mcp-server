// Property-dossier export contract (2026-07-29, engine #174 wiring).
// Mirrors engine-api /v1/property-nodes/:id/dossier-export/* payloads.
// Sibling of site-plan-export-contract.ts: SAME parcel-terrain-model atom,
// SAME public-paid access policy, SAME authorizePaidCall metering helper —
// only the engine route and the single-format artifact set differ. The
// dossier is ONE hand-to-client PDF: Standard-styled cover (verbatim
// labeled verdict) + cited brief facts + AI chat summary + owner notes,
// with the parcel's site-plan sheets appended and renumbered. The engine
// renders exactly what the request carries and honest-degrades on anything
// absent — never fabricates.

export const DOSSIER_EXPORT_PACKAGE_ID = "dossier-export";

/**
 * The dossier ships exactly one artifact format. The engine's download
 * route (GET .../dossier-export/download) takes NO format query param —
 * it always serves the pdf-dossier artifact as application/pdf. The
 * constant exists so tool schemas and BFF callers speak the same key the
 * engine records on the parcel-terrain-model atom's artifacts map.
 */
export const DOSSIER_EXPORT_FORMATS = ["pdf-dossier"] as const;

export type DossierExportFormat = (typeof DOSSIER_EXPORT_FORMATS)[number];

export interface DossierExportArtifactEntry {
  format: DossierExportFormat | string;
  ref?: string;
  byteCount?: number;
  pageCount?: number;
  deferred?: boolean;
  deferredReason?: string;
}

/** Caller-supplied brief fact — rendered verbatim with source · vintage. */
export interface DossierBriefFact {
  label: string;
  value?: string;
  source?: string;
  vintage?: string;
}

export interface DossierBriefSection {
  id: string;
  title: string;
  facts: DossierBriefFact[];
}

export interface DossierChatSummary {
  summary: string;
  savedAt: string;
  disclaimer?: string;
}

/**
 * Refresh request — passed through to the engine VERBATIM. Everything is
 * optional and caller-supplied; server-side zod caps (DOSSIER_CAPS) and the
 * assembler's sanitizer are the engine's, not re-implemented here.
 */
export interface DossierExportRefreshRequest {
  address?: string;
  countyName?: string;
  verdictLine?: string;
  brief?: { sections: DossierBriefSection[] };
  chatSummary?: DossierChatSummary;
  notes?: string;
}

export interface DossierExportRefreshResponse {
  atom: Record<string, unknown>;
  artifacts: Record<string, DossierExportArtifactEntry>;
  pageCount?: number;
  dossierPageCount?: number;
  sitePlanAppended?: boolean;
  sitePlanUnavailableReason?: string;
  verdictIncluded?: boolean;
  briefSectionCount?: number;
  briefFactCount?: number;
  chatSummaryIncluded?: boolean;
  notesIncluded?: boolean;
  setbackDegenerate?: boolean;
  setbackHonestAbsence?: boolean;
  streetHonestAbsence?: boolean;
  zoningHonestAbsence?: boolean;
  floodZoneHonestUnavailable?: boolean;
}

export interface DossierExportDownloadInline {
  format: DossierExportFormat;
  contentType: string;
  base64: string;
  byteCount: number;
}

export interface DossierExportDownloadRef {
  format: DossierExportFormat;
  contentType: string;
  ref: string;
  byteCount: number;
  downloadPath: string;
}

export type DossierExportDownloadPayload =
  | DossierExportDownloadInline
  | DossierExportDownloadRef;

export interface ParcelDossierExportToolData {
  parcelNodeId: string;
  atom: Record<string, unknown>;
  artifacts: Record<string, DossierExportArtifactEntry>;
  download?: DossierExportDownloadPayload;
  pageCount?: number;
  dossierPageCount?: number;
  sitePlanAppended?: boolean;
  sitePlanUnavailableReason?: string;
  verdictIncluded?: boolean;
  briefSectionCount?: number;
  briefFactCount?: number;
  chatSummaryIncluded?: boolean;
  notesIncluded?: boolean;
  setbackDegenerate?: boolean;
  setbackHonestAbsence?: boolean;
  streetHonestAbsence?: boolean;
  zoningHonestAbsence?: boolean;
  floodZoneHonestUnavailable?: boolean;
}

/** Inline base64 cap — a multi-sheet dossier PDF returns ref + download path instead. */
export const DOSSIER_EXPORT_MAX_INLINE_BYTES = 256 * 1024;

export const DOSSIER_EXPORT_CONTENT_TYPE = "application/pdf";

/**
 * Engine download path. NO format query param — the engine route serves
 * the single pdf-dossier artifact unconditionally (confirmed against
 * services/engine-api/src/routes/parcel-terrain.ts on engine main, #174).
 */
export function dossierExportDownloadPath(parcelNodeId: string): string {
  const encoded = encodeURIComponent(parcelNodeId);
  return `/v1/property-nodes/${encoded}/dossier-export/download`;
}

export function isDossierExportArtifactDeferred(
  artifacts: Record<string, DossierExportArtifactEntry>,
): boolean {
  const entry = artifacts["pdf-dossier"];
  if (!entry) return true;
  if (entry.deferred === true) return true;
  if (typeof entry.ref === "string" && entry.ref.startsWith("deferred:")) {
    return true;
  }
  return false;
}
