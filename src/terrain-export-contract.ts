// Terrain-export spine contract (Gate Y catalog path).
// Mirrors engine-api /v1/property-nodes/:id/terrain-export/* payloads.

export const TERRAIN_EXPORT_PACKAGE_ID = "terrain-export";

export const TERRAIN_EXPORT_FORMATS = [
  "glb",
  "ifc",
  "dxf-3dface",
  "dxf-contour",
  "landxml-tin",
] as const;

export type TerrainExportFormat = (typeof TERRAIN_EXPORT_FORMATS)[number];

export interface TerrainExportArtifactEntry {
  format: TerrainExportFormat | string;
  ref?: string;
  byteCount?: number;
  vertexCount?: number;
  triangleCount?: number;
  contourIntervalMeters?: number;
  contourPolylineCount?: number;
  deferred?: boolean;
  deferredReason?: string;
}

export interface TerrainExportRefreshRequest {
  resolutionMeters?: number;
  contourIntervalMeters?: number;
}

export interface TerrainExportRefreshResponse {
  atom: Record<string, unknown>;
  artifacts: Record<string, TerrainExportArtifactEntry>;
}

export interface TerrainExportDownloadInline {
  format: TerrainExportFormat;
  contentType: string;
  base64: string;
  byteCount: number;
}

export interface TerrainExportDownloadRef {
  format: TerrainExportFormat;
  contentType: string;
  ref: string;
  byteCount: number;
  downloadPath: string;
}

export type TerrainExportDownloadPayload =
  | TerrainExportDownloadInline
  | TerrainExportDownloadRef;

export interface ParcelTerrainExportToolData {
  parcelNodeId: string;
  atom: Record<string, unknown>;
  artifacts: Record<string, TerrainExportArtifactEntry>;
  download?: TerrainExportDownloadPayload;
}

/** Inline base64 cap — larger CAD meshes return ref + download path instead. */
export const TERRAIN_EXPORT_MAX_INLINE_BYTES = 256 * 1024;

export function terrainExportContentType(format: TerrainExportFormat): string {
  switch (format) {
    case "glb":
      return "model/gltf-binary";
    case "ifc":
      return "application/x-step";
    case "dxf-3dface":
    case "dxf-contour":
      return "application/dxf";
    case "landxml-tin":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

export function terrainExportDownloadPath(
  parcelNodeId: string,
  format: TerrainExportFormat,
): string {
  const encoded = encodeURIComponent(parcelNodeId);
  return `/v1/property-nodes/${encoded}/terrain-export/download?format=${encodeURIComponent(format)}`;
}

export function isTerrainExportFormatDeferred(
  artifacts: Record<string, TerrainExportArtifactEntry>,
  format: TerrainExportFormat,
): boolean {
  const entry = artifacts[format];
  if (!entry) return true;
  if (entry.deferred === true) return true;
  if (typeof entry.ref === "string" && entry.ref.startsWith("deferred:")) {
    return true;
  }
  return false;
}
