// Property-node reasoning-chain catalog resolution (Phase 1c).
//
// Serves all parcel-keyed property entity types (derived from engine
// PROPERTY_ENTITY_TYPES minus road-node) via the CATALOG-TOOL path
// (per-atom accessPolicy post-fetch), not the map/reporting package tier path.

import type { AccessPolicy } from "@empressaio/atom-contract";

import {
  canReadAccessTarget,
  effectiveAccessPolicy,
  logAccessDenied,
  type AccessSubject,
} from "./access-policy.js";
import {
  EngineHttpError,
  type AtomInstanceBase,
  type GetAtomResponse,
  type PropertyAtomChainWireResponse,
  hauskaClient,
} from "./hauska-client.js";
import {
  LEGACY_REASONING_CHAIN_SLOTS,
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
  type LegacyReasoningChainSlot,
  type ParcelKeyedPropertyEntityType,
  isParcelKeyedPropertyEntityType,
} from "./property-entity-types.js";

export {
  LEGACY_REASONING_CHAIN_SLOTS,
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
  type LegacyReasoningChainSlot,
  type ParcelKeyedPropertyEntityType,
};

/** @deprecated use PARCEL_KEYED_PROPERTY_ENTITY_TYPES */
export const PROPERTY_CHAIN_ENTITY_TYPES = PARCEL_KEYED_PROPERTY_ENTITY_TYPES;

export type PropertyChainEntityType = ParcelKeyedPropertyEntityType;

/** @deprecated use LEGACY_REASONING_CHAIN_SLOTS */
export const PROPERTY_CHAIN_SLOT_TYPES = LEGACY_REASONING_CHAIN_SLOTS;

export type PropertyChainSlot = LegacyReasoningChainSlot;

/** G6 canonical id shape - must match PE `PARCEL_NODE_ID_SOURCE` (F1b). */
export const PARCEL_NODE_ID_SOURCE = String.raw`^\d{5}:[^/\s]+$`;
export const PARCEL_NODE_ID_REGEX = new RegExp(PARCEL_NODE_ID_SOURCE);

/** Prefix extract for entityIds that extend past bare parcelNodeId (e.g. owner-fact tax year). */
const PARCEL_NODE_ID_PREFIX = /^(\d{5}:[^:/\s]+)/;

export type PropertyAtomChainStatus =
  | "ready"
  | "partial"
  | "atom_path_pending"
  | "not_ready";

export interface PropertyChainAtomSlot {
  slot: PropertyChainEntityType;
  atomDid: string;
  atom: AtomInstanceBase | null;
  /** True when the atom exists upstream but the caller lacks accessPolicy entitlement. */
  withheld?: boolean;
  accessPolicy?: AccessPolicy;
}

export interface PropertyAtomChainData {
  parcelNodeId: string;
  status: PropertyAtomChainStatus;
  /** All parcel-keyed property types (engine PROPERTY_ENTITY_TYPES minus road-node). */
  slots: Record<PropertyChainEntityType, PropertyChainAtomSlot>;
  /** Legacy triple for consumers that still read camelCase keys. */
  chain: {
    zoningFact: PropertyChainAtomSlot;
    setbackRule: PropertyChainAtomSlot;
    buildableEnvelope: PropertyChainAtomSlot;
  };
  /** Slots with no corpus row yet (honest pending, not fabrication). */
  pendingSlots: PropertyChainEntityType[];
  /** Slots withheld by accessPolicy (exist but not readable). */
  withheldSlots: PropertyChainEntityType[];
}

export interface ResolvePropertyAtomChainInput {
  parcelNodeId?: string;
  atomDid?: string;
}

function legacyChainKey(
  slot: LegacyReasoningChainSlot,
): keyof PropertyAtomChainData["chain"] {
  switch (slot) {
    case "zoning-fact":
      return "zoningFact";
    case "setback-rule":
      return "setbackRule";
    case "buildable-envelope":
      return "buildableEnvelope";
  }
}

/** Canonical DID for a parcel-keyed property atom (bare parcelNodeId suffix). */
export function propertyChainAtomDid(
  parcelNodeId: string,
  entityType: PropertyChainEntityType,
): string {
  return `did:hauska:${entityType}:${parcelNodeId}`;
}

export function parcelNodeIdFromEntityIdSuffix(entityIdSuffix: string): string | null {
  const trimmed = entityIdSuffix.trim();
  const match = PARCEL_NODE_ID_PREFIX.exec(trimmed);
  if (!match) return null;
  const candidate = match[1]!;
  return PARCEL_NODE_ID_REGEX.test(candidate) ? candidate : null;
}

export interface ParsedPropertyAtomDid {
  entityType: PropertyChainEntityType;
  entityIdSuffix: string;
}

/** Structural Hauska DID parse + parcel-keyed entity type validation. */
export function parsePropertyAtomDid(atomDid: string): ParsedPropertyAtomDid | null {
  const trimmed = atomDid.trim();
  const match = /^did:hauska:([a-z0-9-]+):(.+)$/.exec(trimmed);
  if (!match) return null;
  const entityType = match[1]!;
  if (!isParcelKeyedPropertyEntityType(entityType)) return null;
  const entityIdSuffix = match[2]!;
  if (!parcelNodeIdFromEntityIdSuffix(entityIdSuffix)) return null;
  return { entityType, entityIdSuffix };
}

/** Extract parcelNodeId from any parcel-keyed property atom DID. */
export function parcelNodeIdFromAtomDid(atomDid: string): string | null {
  const parsed = parsePropertyAtomDid(atomDid);
  if (!parsed) return null;
  return parcelNodeIdFromEntityIdSuffix(parsed.entityIdSuffix);
}

export function normalizeParcelNodeId(raw: string): string | null {
  const trimmed = raw.trim();
  return PARCEL_NODE_ID_REGEX.test(trimmed) ? trimmed : null;
}

function atomAccessTarget(atom: AtomInstanceBase) {
  const accessPolicy =
    typeof atom.accessPolicy === "string"
      ? (atom.accessPolicy as AccessPolicy)
      : undefined;
  return {
    accessPolicy,
    jurisdictionTenant: atom.jurisdictionTenant,
  };
}

function applyAccessPolicyToAtom(
  subject: AccessSubject,
  tool: string,
  atom: AtomInstanceBase,
  atomDid: string,
  slot: PropertyChainEntityType,
): PropertyChainAtomSlot {
  const target = atomAccessTarget(atom);
  if (canReadAccessTarget(subject, target)) {
    return { slot, atomDid, atom };
  }
  logAccessDenied({
    tool,
    policy: effectiveAccessPolicy(target),
    atomJurisdiction: target.jurisdictionTenant,
    subjectTenant: subject.jurisdictionTenant,
    platformInternal: subject.platformInternal,
    reason: "property_chain_slot",
  });
  return {
    slot,
    atomDid,
    atom: null,
    withheld: true,
    accessPolicy: effectiveAccessPolicy(target),
  };
}

function emptySlot(
  slot: PropertyChainEntityType,
  parcelNodeId: string,
): PropertyChainAtomSlot {
  return {
    slot,
    atomDid: propertyChainAtomDid(parcelNodeId, slot),
    atom: null,
  };
}

function legacyChainFromSlots(
  slots: Record<PropertyChainEntityType, PropertyChainAtomSlot>,
): PropertyAtomChainData["chain"] {
  return {
    zoningFact: slots["zoning-fact"],
    setbackRule: slots["setback-rule"],
    buildableEnvelope: slots["buildable-envelope"],
  };
}

function buildChainData(
  parcelNodeId: string,
  slots: Record<PropertyChainEntityType, PropertyChainAtomSlot>,
): PropertyAtomChainData {
  const allTypes = PARCEL_KEYED_PROPERTY_ENTITY_TYPES;
  const pendingSlots = allTypes.filter((s) => {
    const row = slots[s];
    return row.atom === null && !row.withheld;
  });
  const withheldSlots = allTypes.filter((s) => slots[s].withheld);

  const statusTypes = LEGACY_REASONING_CHAIN_SLOTS;
  const legacyPending = statusTypes.filter((s) => {
    const row = slots[s];
    return row.atom === null && !row.withheld;
  });
  const legacyWithheld = statusTypes.filter((s) => slots[s].withheld);
  const legacyPresent = statusTypes.filter((s) => slots[s].atom !== null).length;
  const allAbsent = allTypes.every((s) => slots[s].atom === null && !slots[s].withheld);

  let status: PropertyAtomChainStatus;
  if (legacyPresent === 0 && allAbsent) {
    status = "atom_path_pending";
  } else if (legacyPresent === 0) {
    status = "not_ready";
  } else if (legacyPending.length > 0 || legacyWithheld.length > 0) {
    status = "partial";
  } else {
    status = "ready";
  }

  return {
    parcelNodeId,
    status,
    slots,
    chain: legacyChainFromSlots(slots),
    pendingSlots,
    withheldSlots,
  };
}

async function fetchSlotAtom(atomDid: string): Promise<GetAtomResponse> {
  return hauskaClient.getAtom({ atomDid });
}

function atomFromWireEntry(entry: unknown): AtomInstanceBase | null {
  if (!entry || typeof entry !== "object") return null;
  const row = entry as Record<string, unknown>;
  if (row.payload && typeof row.payload === "object") {
    return row.payload as AtomInstanceBase;
  }
  return row as AtomInstanceBase;
}

function mergeUpstreamAtom(
  target: Partial<Record<PropertyChainEntityType, AtomInstanceBase | null>>,
  entityType: PropertyChainEntityType,
  atom: AtomInstanceBase | null | undefined,
): void {
  if (atom) {
    target[entityType] = atom;
  } else if (!(entityType in target)) {
    target[entityType] = null;
  }
}

/** Normalize engine chain wire (legacy camelCase, atoms[], optional atomsByType). */
export function upstreamAtomsFromEngineWire(
  wire: PropertyAtomChainWireResponse,
): Partial<Record<PropertyChainEntityType, AtomInstanceBase | null>> {
  const out: Partial<Record<PropertyChainEntityType, AtomInstanceBase | null>> = {};

  if (wire.atomsByType) {
    for (const entityType of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
      mergeUpstreamAtom(out, entityType, wire.atomsByType[entityType] ?? null);
    }
  }

  mergeUpstreamAtom(out, "zoning-fact", wire.zoningFact);
  mergeUpstreamAtom(out, "setback-rule", wire.setbackRule);
  mergeUpstreamAtom(out, "buildable-envelope", wire.buildableEnvelope);

  if (wire.atoms) {
    for (const entry of wire.atoms) {
      const entityTypeRaw =
        (typeof entry.type === "string" && entry.type) ||
        (entry.payload &&
          typeof entry.payload === "object" &&
          typeof (entry.payload as AtomInstanceBase).entityType === "string" &&
          (entry.payload as AtomInstanceBase).entityType) ||
        null;
      if (!entityTypeRaw || !isParcelKeyedPropertyEntityType(entityTypeRaw)) {
        continue;
      }
      mergeUpstreamAtom(out, entityTypeRaw, atomFromWireEntry(entry));
    }
  }

  for (const entityType of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
    if (!(entityType in out)) {
      out[entityType] = null;
    }
  }

  return out;
}

/** Try engine chain endpoint; returns null when route is not deployed. */
async function fetchEnginePropertyChain(
  parcelNodeId: string,
): Promise<Partial<Record<PropertyChainEntityType, AtomInstanceBase | null>> | null> {
  try {
    const wire = await hauskaClient.getPropertyAtomChain({ parcelNodeId });
    if (!wire) return null;
    return upstreamAtomsFromEngineWire(wire);
  } catch (err) {
    if (err instanceof EngineHttpError && (err.status === 404 || err.status === 501)) {
      return null;
    }
    throw err;
  }
}

async function fetchSlotsByDid(
  parcelNodeId: string,
): Promise<Partial<Record<PropertyChainEntityType, AtomInstanceBase | null>>> {
  const entries = await Promise.all(
    PARCEL_KEYED_PROPERTY_ENTITY_TYPES.map(async (entityType) => {
      const atomDid = propertyChainAtomDid(parcelNodeId, entityType);
      const res = await fetchSlotAtom(atomDid);
      return [entityType, res.atom] as const;
    }),
  );
  return Object.fromEntries(entries) as Partial<
    Record<PropertyChainEntityType, AtomInstanceBase | null>
  >;
}

export async function resolvePropertyAtomChain(
  input: ResolvePropertyAtomChainInput,
  subject: AccessSubject,
  tool = "get_property_atom_chain",
): Promise<PropertyAtomChainData> {
  let parcelNodeId: string | null = null;

  if (input.parcelNodeId) {
    parcelNodeId = normalizeParcelNodeId(input.parcelNodeId);
    if (!parcelNodeId) {
      throw new PropertyAtomChainInputError(
        `parcel_node_id must match county_fips:prop_id (e.g. 48209:156346); got "${input.parcelNodeId}".`,
      );
    }
  } else if (input.atomDid) {
    parcelNodeId = parcelNodeIdFromAtomDid(input.atomDid);
    if (!parcelNodeId) {
      throw new PropertyAtomChainInputError(
        `atom_did must be a parcel-keyed property atom DID (road-node excluded); got "${input.atomDid}".`,
      );
    }
  } else {
    throw new PropertyAtomChainInputError(
      "Provide parcel_node_id (e.g. 48209:156346) or atom_did for a property-chain atom.",
    );
  }

  const upstream =
    (await fetchEnginePropertyChain(parcelNodeId)) ??
    (await fetchSlotsByDid(parcelNodeId));

  const slots = {} as Record<PropertyChainEntityType, PropertyChainAtomSlot>;
  for (const entityType of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
    const raw = upstream[entityType];
    if (!raw) {
      slots[entityType] = emptySlot(entityType, parcelNodeId);
      continue;
    }
    // Prefer the stored DID / entityId - owner/land-use/cad-roll (and
    // similar) append taxYear or other suffixes; bare parcel DID is wrong.
    const atomDid =
      typeof raw.atomDid === "string" && raw.atomDid.startsWith("did:hauska:")
        ? raw.atomDid
        : typeof raw.entityId === "string" && raw.entityId.length > 0
          ? `did:hauska:${entityType}:${raw.entityId}`
          : propertyChainAtomDid(parcelNodeId, entityType);
    slots[entityType] = applyAccessPolicyToAtom(
      subject,
      tool,
      raw,
      atomDid,
      entityType,
    );
  }

  return buildChainData(parcelNodeId, slots);
}

export class PropertyAtomChainInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropertyAtomChainInputError";
  }
}

export function chainStatusNote(data: PropertyAtomChainData): string | undefined {
  switch (data.status) {
    case "ready":
      return undefined;
    case "atom_path_pending":
      return (
        "PROPERTY_ATOM_PATH atoms are not in the retrieval corpus for this parcel yet. " +
        "Status atom_path_pending - no values fabricated."
      );
    case "partial":
      if (data.withheldSlots.length > 0 && data.pendingSlots.length > 0) {
        return (
          `Partial chain: pending slots [${data.pendingSlots.join(", ")}]; ` +
          `withheld by accessPolicy [${data.withheldSlots.join(", ")}].`
        );
      }
      if (data.withheldSlots.length > 0) {
        return `Some chain slots withheld by accessPolicy: [${data.withheldSlots.join(", ")}]. Use an entitled X-Hauska-Key.`;
      }
      return `Partial chain; pending slots: [${data.pendingSlots.join(", ")}].`;
    case "not_ready":
      return "Property atom chain not ready for this parcel.";
  }
}

/** Atoms present in the chain (readable slots only). */
export function readableChainAtoms(
  data: PropertyAtomChainData,
): AtomInstanceBase[] {
  const out: AtomInstanceBase[] = [];
  for (const entityType of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
    const row = data.slots[entityType];
    if (row.atom) out.push(row.atom);
  }
  return out;
}

/** @deprecated use data.slots */
export function slotKey(slot: LegacyReasoningChainSlot): keyof PropertyAtomChainData["chain"] {
  return legacyChainKey(slot);
}
