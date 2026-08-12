/**
 * Property entity types derived from hauska-engine `PROPERTY_ENTITY_TYPES`.
 * Runtime uses a committed mirror; tests prove parity against the engine source file.
 */

import { readFileSync } from "node:fs";

/** Default sibling checkout path (local dev / CI with engine clone). */
export const DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH =
  process.env.HAUSKA_ENGINE_PROPERTY_INSTANCES_PATH ??
  "P:/hauska-engine/packages/atoms/src/property-instances.ts";

/** Entity type intentionally excluded from parcel-node DID chain (roadNodeId-keyed). */
export const PARCEL_CHAIN_EXCLUDED_ENTITY_TYPES = ["road-node"] as const;

/**
 * Parse `export const PROPERTY_ENTITY_TYPES = [ ... ]` from engine source text.
 * Exported for cross-repo drift tests (must not compare MCP-only constants).
 */
export function parsePropertyEntityTypesFromEngineSource(source: string): string[] {
  const block = /export const PROPERTY_ENTITY_TYPES[^=]*=\s*\[([\s\S]*?)\];/.exec(
    source,
  );
  if (!block) {
    throw new Error("PROPERTY_ENTITY_TYPES array not found in engine source");
  }
  const inner = block[1]!;
  const types: string[] = [];
  const re = /"([a-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    types.push(m[1]!);
  }
  if (types.length === 0) {
    throw new Error("PROPERTY_ENTITY_TYPES parsed empty");
  }
  return types;
}

export function loadPropertyEntityTypesFromEngineFile(
  filePath: string = DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH,
): string[] {
  return parsePropertyEntityTypesFromEngineSource(readFileSync(filePath, "utf8"));
}

export function deriveParcelKeyedPropertyEntityTypes(
  engineTypes: readonly string[],
): readonly string[] {
  const excluded = new Set<string>(PARCEL_CHAIN_EXCLUDED_ENTITY_TYPES);
  return engineTypes.filter((t) => !excluded.has(t));
}

/**
 * Committed mirror of engine `PROPERTY_ENTITY_TYPES` (2026-08-12).
 * Cross-repo test fails if engine list diverges - update via engine truth, not hand-extend.
 */
export const ENGINE_PROPERTY_ENTITY_TYPES_MIRROR: readonly string[] = [
  "parcel-node",
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
  "parcel-terrain-model",
  "building-footprint",
  "utility-easement",
  "flood-hazard-fact",
  "cad-parcel-roll",
  "land-use-fact",
  "owner-fact",
  "rail-corridor-fact",
  "well-fact",
  "special-district-fact",
  "road-node",
  "rrc-pipeline-fact",
];

export const PARCEL_KEYED_PROPERTY_ENTITY_TYPES = deriveParcelKeyedPropertyEntityTypes(
  ENGINE_PROPERTY_ENTITY_TYPES_MIRROR,
);

export type ParcelKeyedPropertyEntityType =
  (typeof PARCEL_KEYED_PROPERTY_ENTITY_TYPES)[number];

const parcelKeyedSet = new Set<string>(PARCEL_KEYED_PROPERTY_ENTITY_TYPES);

export function isParcelKeyedPropertyEntityType(
  value: string,
): value is ParcelKeyedPropertyEntityType {
  return parcelKeyedSet.has(value);
}

/** Legacy reasoning-chain triple (camelCase back-compat on `chain`). */
export const LEGACY_REASONING_CHAIN_SLOTS = [
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
] as const;

export type LegacyReasoningChainSlot = (typeof LEGACY_REASONING_CHAIN_SLOTS)[number];

export function isLegacyReasoningChainSlot(
  value: string,
): value is LegacyReasoningChainSlot {
  return (
    value === "zoning-fact" ||
    value === "setback-rule" ||
    value === "buildable-envelope"
  );
}
