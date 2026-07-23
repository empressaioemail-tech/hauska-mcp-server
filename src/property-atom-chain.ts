// Property-node reasoning-chain catalog resolution (Phase 1c).
//
// Serves zoning-fact -> setback-rule -> buildable-envelope via the
// CATALOG-TOOL path (per-atom accessPolicy post-fetch), not the
// map/reporting package tier path.

import type { AccessPolicy } from "@hauska/atom-contract";

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
  hauskaClient,
} from "./hauska-client.js";

/** Property reasoning-chain entity types (Phase 1 atom family). */
export const PROPERTY_CHAIN_ENTITY_TYPES = [
  "parcel-node",
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
] as const;

export type PropertyChainEntityType = (typeof PROPERTY_CHAIN_ENTITY_TYPES)[number];

export const PROPERTY_CHAIN_SLOT_TYPES = [
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
] as const;

export type PropertyChainSlot = (typeof PROPERTY_CHAIN_SLOT_TYPES)[number];

export const PARCEL_NODE_ID_REGEX = /^\d{5}:\d+$/;

export type PropertyAtomChainStatus =
  | "ready"
  | "partial"
  | "atom_path_pending"
  | "not_ready";

export interface PropertyChainAtomSlot {
  slot: PropertyChainSlot;
  atomDid: string;
  atom: AtomInstanceBase | null;
  /** True when the atom exists upstream but the caller lacks accessPolicy entitlement. */
  withheld?: boolean;
  accessPolicy?: AccessPolicy;
}

export interface PropertyAtomChainData {
  parcelNodeId: string;
  status: PropertyAtomChainStatus;
  chain: {
    zoningFact: PropertyChainAtomSlot;
    setbackRule: PropertyChainAtomSlot;
    buildableEnvelope: PropertyChainAtomSlot;
  };
  /** Slots with no corpus row yet (honest pending, not fabrication). */
  pendingSlots: PropertyChainSlot[];
  /** Slots withheld by accessPolicy (exist but not readable). */
  withheldSlots: PropertyChainSlot[];
}

export interface ResolvePropertyAtomChainInput {
  parcelNodeId?: string;
  atomDid?: string;
}

function slotKey(slot: PropertyChainSlot): keyof PropertyAtomChainData["chain"] {
  switch (slot) {
    case "zoning-fact":
      return "zoningFact";
    case "setback-rule":
      return "setbackRule";
    case "buildable-envelope":
      return "buildableEnvelope";
  }
}

/** Canonical DID for a parcel-node anchor and each chain slot. */
export function propertyChainAtomDid(
  parcelNodeId: string,
  entityType: PropertyChainEntityType,
): string {
  return `did:hauska:${entityType}:${parcelNodeId}`;
}

/** Extract parcelNodeId from a property-chain atom DID, if shaped correctly. */
export function parcelNodeIdFromAtomDid(atomDid: string): string | null {
  const match = /^did:hauska:(?:parcel-node|zoning-fact|setback-rule|buildable-envelope):(\d{5}:\d+)$/.exec(
    atomDid,
  );
  return match?.[1] ?? null;
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
  slot: PropertyChainSlot,
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
  slot: PropertyChainSlot,
  parcelNodeId: string,
): PropertyChainAtomSlot {
  return {
    slot,
    atomDid: propertyChainAtomDid(parcelNodeId, slot),
    atom: null,
  };
}

function buildChainData(
  parcelNodeId: string,
  slots: Record<PropertyChainSlot, PropertyChainAtomSlot>,
): PropertyAtomChainData {
  const pendingSlots = PROPERTY_CHAIN_SLOT_TYPES.filter((s) => {
    const row = slots[s];
    return row.atom === null && !row.withheld;
  });
  const withheldSlots = PROPERTY_CHAIN_SLOT_TYPES.filter((s) => slots[s].withheld);
  const presentCount = PROPERTY_CHAIN_SLOT_TYPES.filter(
    (s) => slots[s].atom !== null,
  ).length;

  let status: PropertyAtomChainStatus;
  if (presentCount === 0 && pendingSlots.length === PROPERTY_CHAIN_SLOT_TYPES.length) {
    status = "atom_path_pending";
  } else if (presentCount === 0) {
    status = "not_ready";
  } else if (pendingSlots.length > 0 || withheldSlots.length > 0) {
    status = "partial";
  } else {
    status = "ready";
  }

  return {
    parcelNodeId,
    status,
    chain: {
      zoningFact: slots["zoning-fact"],
      setbackRule: slots["setback-rule"],
      buildableEnvelope: slots["buildable-envelope"],
    },
    pendingSlots,
    withheldSlots,
  };
}

async function fetchSlotAtom(atomDid: string): Promise<GetAtomResponse> {
  return hauskaClient.getAtom({ atomDid });
}

/** Try engine chain endpoint; returns null when route is not deployed. */
async function fetchEnginePropertyChain(
  parcelNodeId: string,
): Promise<Record<PropertyChainSlot, AtomInstanceBase | null> | null> {
  try {
    const wire = await hauskaClient.getPropertyAtomChain({ parcelNodeId });
    if (!wire) return null;
    return {
      "zoning-fact": wire.zoningFact,
      "setback-rule": wire.setbackRule,
      "buildable-envelope": wire.buildableEnvelope,
    };
  } catch (err) {
    if (err instanceof EngineHttpError && (err.status === 404 || err.status === 501)) {
      return null;
    }
    throw err;
  }
}

async function fetchSlotsByDid(
  parcelNodeId: string,
): Promise<Record<PropertyChainSlot, AtomInstanceBase | null>> {
  const entries = await Promise.all(
    PROPERTY_CHAIN_SLOT_TYPES.map(async (slot) => {
      const atomDid = propertyChainAtomDid(parcelNodeId, slot);
      const res = await fetchSlotAtom(atomDid);
      return [slot, res.atom] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<
    PropertyChainSlot,
    AtomInstanceBase | null
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
        `atom_did must be a property-chain DID (parcel-node|zoning-fact|setback-rule|buildable-envelope); got "${input.atomDid}".`,
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

  const slots = {} as Record<PropertyChainSlot, PropertyChainAtomSlot>;
  for (const slot of PROPERTY_CHAIN_SLOT_TYPES) {
    const atomDid = propertyChainAtomDid(parcelNodeId, slot);
    const raw = upstream[slot];
    if (!raw) {
      slots[slot] = emptySlot(slot, parcelNodeId);
      continue;
    }
    slots[slot] = applyAccessPolicyToAtom(subject, tool, raw, atomDid, slot);
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
        "Status atom_path_pending — no values fabricated."
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

/** Atoms present in the envelope provenance list (readable slots only). */
export function readableChainAtoms(
  data: PropertyAtomChainData,
): AtomInstanceBase[] {
  const out: AtomInstanceBase[] = [];
  for (const slot of PROPERTY_CHAIN_SLOT_TYPES) {
    const row = data.chain[slotKey(slot)];
    if (row.atom) out.push(row.atom);
  }
  return out;
}
