// Map layers wire contract — mirrored from
// hauska-engine/packages/engine-core/src/map-layers/contract.ts.
// Re-mirror when the engine contract changes.

import { z } from "zod";

export const MAP_LAYER_KEYS = [
  "parcel-polygon",
  "flood-zone",
  "floodway",
  "dem",
  "topography",
  "opportunity-zone-tract",
  "zoning",
] as const;

export type MapLayerKey = (typeof MAP_LAYER_KEYS)[number];

export const MAP_LAYERS_PACKAGE_ID = "map-layers" as const;

/** Wired adapter slots — available on any paid cortex map-layers call. */
export const MAP_LAYER_BASIC_KEYS = [
  "parcel-polygon",
  "flood-zone",
  "zoning",
] as const satisfies readonly MapLayerKey[];

/** Wave-3 / rich geometry slots — Max-tier entitlement at the gate. */
export const MAP_LAYER_RICH_KEYS = [
  "floodway",
  "dem",
  "topography",
  "opportunity-zone-tract",
] as const satisfies readonly MapLayerKey[];

export const mapLayerKeySchema = z.enum(MAP_LAYER_KEYS);

export const mapLayersParcelSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().nullable().optional(),
  parcelKey: z.string().min(1).optional(),
});

export const mapLayersJurisdictionSchema = z.object({
  stateKey: z.enum(["utah", "idaho", "texas"]).nullable(),
  localKey: z
    .enum(["grand-county-ut", "lemhi-county-id", "bastrop-tx"])
    .nullable(),
  partnerCity: z.boolean().optional(),
});

export const mapLayersBboxSchema = z.object({
  westLng: z.number(),
  southLat: z.number(),
  eastLng: z.number(),
  northLat: z.number(),
});

export const mapLayersAssembleRequestSchema = z.object({
  parcel: mapLayersParcelSchema,
  jurisdiction: mapLayersJurisdictionSchema,
  layers: z.array(mapLayerKeySchema).optional(),
  forceRefresh: z.boolean().optional(),
  bbox: mapLayersBboxSchema.optional(),
});

export type MapLayersAssembleRequest = z.infer<
  typeof mapLayersAssembleRequestSchema
>;

export type MapLayersJurisdiction = z.infer<typeof mapLayersJurisdictionSchema>;

export interface MapLayersAssemblePayload {
  parcelKey: string;
  place: {
    latitude: number;
    longitude: number;
    formattedAddress?: string | null;
  };
  tenantScope: string;
  layers: Array<{
    layerKey: MapLayerKey;
    status: string;
    envelope: unknown;
    adapterKey?: string;
    pendingReason?: string;
    error?: { code: string; message: string };
  }>;
  assembledAt: string;
}

export interface MapLayersAssembleEngineEnvelope {
  payload: MapLayersAssemblePayload;
  confidence: unknown;
  dataVintage: string | null;
  coverage: { degraded: boolean; reason?: string };
  source: { adapter: string; citationIds?: string[] };
}
