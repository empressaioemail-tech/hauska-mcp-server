// Flood & Drainage export contract (OPS-16 P-120 item 27).
// Mirrors engine-api /v1/property-nodes/:id/flood-drainage/* payloads
// (services/engine-api/src/routes/flood-drainage.ts on hauska-engine main,
// "FLOOD & DRAINAGE routes (2026-07-29, R3 — the first PAID report)" —
// PINNED CONTRACT, live and merged). NOT a sibling of dossier/site-plan's
// response shape: the engine wraps the refresh response in a `data` object,
// returns a SINGLE `artifact` (not an `artifacts` map), and carries a rich
// `study` payload (catchment/drainage/rainfall/flow-line GeoJSON, gradient
// PNG, provenance) that PE's map dock consumes for visualization. The MCP
// leg surfaces the same refresh/download pair the PDF-export tools already
// expose (Site Plan, Dossier); the raw study GeoJSON is passed through
// verbatim under `study` for callers that want it, never re-derived.
//
// Unlike dossier/site-plan/feasibility, the refresh response carries no
// top-level `atom` object — the artifact lives on the same
// parcel-terrain-model atom those routes read (confirmed: the download
// route resolves via `storage.listPropertyAtomsByParcelNodeId(...).find(
// entityType === "parcel-terrain-model")`, same as dossier/site-plan), but
// the refresh response itself does not echo that atom back. The envelope
// builder falls back to the same synthesized
// `did:hauska:parcel-terrain-model:${parcelNodeId}` DID dossier/site-plan
// already use when `atom.atomDid` is absent.

export const FLOOD_DRAINAGE_EXPORT_PACKAGE_ID = "flood-drainage-export";

/**
 * Single artifact format. Unlike dossier/feasibility, the engine's download
 * route DOES require `?format=pdf-flood-drainage` (confirmed: `DOWNLOAD_FORMAT`
 * const enforced in services/engine-api/src/routes/flood-drainage.ts) —
 * baked into the download path helper below so callers never omit it.
 */
export const FLOOD_DRAINAGE_EXPORT_FORMATS = ["pdf-flood-drainage"] as const;

export type FloodDrainageExportFormat =
  (typeof FLOOD_DRAINAGE_EXPORT_FORMATS)[number];

export interface FloodDrainageExportArtifactEntry {
  format: FloodDrainageExportFormat | string;
  ref?: string;
  byteCount?: number;
  pageCount?: number;
  deferred?: boolean;
  deferredReason?: string;
}

export interface FloodDrainageExportBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

/**
 * The engine's refreshBody also accepts bboxOverride, ringOverride, and
 * resolutionMeters — explicit test/operator geometry seams (the engine's
 * own comment: "Test/operator seams — same as the sibling terrain/site-plan
 * routes; explicit, never a hidden county-specific fallback"). Deliberately
 * withheld from this MCP-facing contract, matching
 * site-plan-export-contract.ts and dossier-export-contract.ts, neither of
 * which exposes them either.
 */
export interface FloodDrainageExportRefreshRequest {
  address?: string;
  countyName?: string;
  rainfallDepthInches?: number;
}

/** The gradient water-ramp PNG the PE leg drapes on the map by its WGS84 bbox. */
export interface FloodDrainageGradient {
  pngBase64: string;
  bbox: FloodDrainageExportBbox;
  note: string;
}

export interface FloodDrainageFlowPath {
  coordinates: Array<[number, number]>;
  strength: number;
  kind: "interior" | "exit";
}

export interface FloodDrainageCatchmentSwath {
  coordinates: Array<[number, number]>[];
  strength: number;
  kind: "interior" | "exit";
}

/** Passed through verbatim — the engine owns the shape, this contract does not re-derive it. */
export interface FloodDrainageStudy {
  catchmentGeoJson?: unknown;
  drainageZonesGeoJson?: unknown;
  rainfallResultGeoJson?: unknown;
  flowLinesGeoJson?: unknown;
  rainfallDepthInches?: number;
  rainfallSource?: string;
  demProvenance?: string;
  briefing?: string;
  gradient?: FloodDrainageGradient;
  flowPaths?: FloodDrainageFlowPath[];
  catchmentSwaths?: FloodDrainageCatchmentSwath[];
  flowPathsNote?: string;
  honestEmpty?: boolean;
  [key: string]: unknown;
}

/**
 * Refresh response — matches the engine's real wire shape (data-wrapped,
 * singular `artifact`), NOT the dossier/site-plan/feasibility `{ atom,
 * artifacts }` shape.
 */
export interface FloodDrainageExportRefreshResponse {
  data: {
    parcelNodeId: string;
    study: FloodDrainageStudy;
    artifact: FloodDrainageExportArtifactEntry;
  };
}

export interface FloodDrainageExportDownloadInline {
  format: FloodDrainageExportFormat;
  contentType: string;
  base64: string;
  byteCount: number;
}

export interface FloodDrainageExportDownloadRef {
  format: FloodDrainageExportFormat;
  contentType: string;
  ref: string;
  byteCount: number;
  downloadPath: string;
}

export type FloodDrainageExportDownloadPayload =
  | FloodDrainageExportDownloadInline
  | FloodDrainageExportDownloadRef;

export interface ParcelFloodDrainageExportToolData {
  parcelNodeId: string;
  study: FloodDrainageStudy;
  artifact: FloodDrainageExportArtifactEntry;
  download?: FloodDrainageExportDownloadPayload;
}

/** Inline base64 cap — a flood-drainage PDF with appended exhibits returns ref + download path instead. */
export const FLOOD_DRAINAGE_EXPORT_MAX_INLINE_BYTES = 256 * 1024;

export const FLOOD_DRAINAGE_EXPORT_CONTENT_TYPE = "application/pdf";

const FLOOD_DRAINAGE_DOWNLOAD_FORMAT = "pdf-flood-drainage";

/**
 * Engine download path. REQUIRES `?format=pdf-flood-drainage` (confirmed
 * against services/engine-api/src/routes/flood-drainage.ts — the route 400s
 * on any other value, including a missing param).
 */
export function floodDrainageExportDownloadPath(parcelNodeId: string): string {
  const encoded = encodeURIComponent(parcelNodeId);
  return `/v1/property-nodes/${encoded}/flood-drainage/download?format=${FLOOD_DRAINAGE_DOWNLOAD_FORMAT}`;
}

export function isFloodDrainageExportArtifactDeferred(
  artifact: FloodDrainageExportArtifactEntry | undefined,
): boolean {
  if (!artifact) return true;
  if (artifact.deferred === true) return true;
  if (typeof artifact.ref === "string" && artifact.ref.startsWith("deferred:")) {
    return true;
  }
  return false;
}
