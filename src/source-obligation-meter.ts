// Inbound source-obligation meter (I-K / Master WDLL 2.5.4).
//
// Every successful tool read that returns an ICC-sourced atom DID accrues
// to ICC's inbound meter — free_anonymous included. Does NOT load
// @hauska-sdk/* (money-OUT ledger only; outbound RevenueRouter is Gate D).
//
// Detection v1: allowlist / stamp / sourceActorDid / citation → ICC DID;
// property setbacks that cite an ICC-or-proof code atom also accrue.
// Rates unset → amount null + graceTerms pending-rate (countable, never silent zero).

import {
  ICC_ACTOR_RECORD_FIXTURE,
  ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE,
} from "@empressaio/atom-contract/reasoning";

import { getPool } from "./db.js";
import { logger } from "./logger.js";
import type { AtomProvenanceEntry } from "./atom-shape.js";
import type { Product } from "./products.js";

/** ICC licensed-source actor DID from shipped contract fixture. */
export const ICC_ACTOR_DID = ICC_ACTOR_RECORD_FIXTURE.actorId;

/** Fixture obligation shape (license-reference-royalty + owedToActorDid). */
export const ICC_LICENSE_REFERENCE_OBLIGATION =
  ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE;

/**
 * v1 allowlist of atom DIDs treated as ICC-sourced for inbound meter.
 * Includes the honest contract fixture anchor DID and the live StoragePort
 * proof code-section (tagged ICC-test for Phase-1 demo until corpus stamps
 * sourceActorDid on every ICC row).
 */
export const ICC_SOURCED_ATOM_DID_ALLOWLIST: ReadonlySet<string> = new Set([
  ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.anchorDid,
  "did:hauska:code-section:storage-port-proof/phase-1a",
  "did:hauska:atom:code-section:storage-port-proof/phase-1a",
]);

const ICC_CITATION_RE =
  /\b(ICC|International Code Council|IBC\b|IRC\b|IFC\b|Code Connect)\b/i;

export interface SourceObligationAtomHint {
  did: string;
  sourceActorDid?: string | null;
  sourceCitation?: string | null;
  /** Adapter / corpus stamp that marks ICC provenance. */
  sourceAdapter?: string | null;
  /** Explicit stamp (atom.iccSourced / licensing stamp). */
  iccSourced?: boolean | null;
  /** Setback (or derived) cite of a code-section atom DID. */
  citedAtomDid?: string | null;
  entityType?: string | null;
}

export interface SourceObligationAccrual {
  sourceActorDid: string;
  atomDid: string;
  tool: string;
  product: string;
  tier: string;
  requestId: string;
  obligationType: "license-reference-royalty";
  amountMinor: number | null;
  currency: string | null;
  graceTerms: string | null;
  note: string | null;
}

export interface AccrueSourceObligationsParams {
  tool: string;
  product: Product | string;
  tier: string;
  requestId: string;
  atoms: ReadonlyArray<SourceObligationAtomHint | AtomProvenanceEntry | string>;
}

type LedgerInsert = (row: SourceObligationAccrual) => Promise<void>;

let insertOverride: LedgerInsert | null = null;
/** In-memory rows captured when insertOverride is set (tests). */
const testCaptures: SourceObligationAccrual[] = [];

/** Test hook: replace Postgres insert; pass null to restore. */
export function setSourceObligationInsertForTests(
  fn: LedgerInsert | null,
): void {
  insertOverride = fn;
  testCaptures.length = 0;
}

export function getSourceObligationTestCaptures(): ReadonlyArray<SourceObligationAccrual> {
  return testCaptures;
}

function normalizeDid(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const did = raw.trim();
  return did.length > 0 ? did : null;
}

/** Extract a cited code-section DID from setback-shaped atom fields. */
export function extractCitedAtomDid(atom: Record<string, unknown>): string | null {
  const ref = atom.sourceCodeAtomRef ?? atom.citedAtomRef ?? atom.sourceAtomRef;
  if (typeof ref === "string") return normalizeDid(ref);
  if (ref && typeof ref === "object") {
    const obj = ref as Record<string, unknown>;
    for (const key of ["atomDid", "did", "atom_did", "ref"]) {
      const v = obj[key];
      if (typeof v === "string") {
        const did = normalizeDid(v);
        if (did) return did;
      }
    }
  }
  return null;
}

/** Build a detection hint from a full atom instance (entityType/entityId). */
export function hintFromAtomInstance(atom: {
  entityType: string;
  entityId: string;
  [key: string]: unknown;
}): SourceObligationAtomHint {
  const did =
    typeof atom.atomDid === "string" && atom.atomDid.startsWith("did:")
      ? atom.atomDid
      : `did:hauska:${atom.entityType}:${atom.entityId}`;
  const sourceActorDid =
    typeof atom.sourceActorDid === "string"
      ? atom.sourceActorDid
      : typeof atom.owedToActorDid === "string"
        ? atom.owedToActorDid
        : null;
  const sourceCitation =
    typeof atom.sourceCitation === "string" ? atom.sourceCitation : null;
  const sourceAdapter =
    typeof atom.sourceAdapter === "string" ? atom.sourceAdapter : null;
  const iccSourced =
    atom.iccSourced === true ||
    atom.sourceLicensor === "icc" ||
    atom.licensingStamp === "icc";
  return {
    did,
    sourceActorDid,
    sourceCitation,
    sourceAdapter,
    iccSourced,
    citedAtomDid: extractCitedAtomDid(atom),
    entityType: atom.entityType,
  };
}

function toHint(
  input: SourceObligationAtomHint | AtomProvenanceEntry | string,
): SourceObligationAtomHint {
  if (typeof input === "string") {
    return { did: input };
  }
  const entry = input as AtomProvenanceEntry & SourceObligationAtomHint;
  return {
    did: entry.did,
    sourceActorDid: entry.sourceActorDid ?? null,
    sourceCitation: entry.sourceCitation ?? null,
    sourceAdapter: entry.source?.adapter ?? entry.sourceAdapter ?? null,
    iccSourced: entry.iccSourced ?? null,
    citedAtomDid: entry.citedAtomDid ?? null,
    entityType: entry.entityType ?? null,
  };
}

function adapterLooksIcc(adapter: string | null | undefined): boolean {
  if (!adapter) return false;
  const a = adapter.toLowerCase();
  return (
    a.includes("icc") ||
    a.includes("code-connect") ||
    a.includes("code_connect") ||
    a === "ibc" ||
    a === "irc"
  );
}

/**
 * Resolve owed source-actor DID for one returned atom, or null if not
 * a licensed-source reference (v1: ICC only).
 */
export function resolveSourceActorDid(
  hint: SourceObligationAtomHint | AtomProvenanceEntry | string,
): string | null {
  const h = toHint(hint);
  const did = normalizeDid(h.did);
  if (!did) return null;

  const explicit = normalizeDid(h.sourceActorDid ?? undefined);
  if (explicit === ICC_ACTOR_DID) return ICC_ACTOR_DID;

  if (h.iccSourced === true) return ICC_ACTOR_DID;

  if (did === ICC_ACTOR_DID) return ICC_ACTOR_DID;

  if (ICC_SOURCED_ATOM_DID_ALLOWLIST.has(did)) return ICC_ACTOR_DID;

  if (adapterLooksIcc(h.sourceAdapter)) return ICC_ACTOR_DID;

  if (h.sourceCitation && ICC_CITATION_RE.test(h.sourceCitation)) {
    return ICC_ACTOR_DID;
  }

  // Property setback (or derived) citing an ICC-or-proof code atom.
  const cited = normalizeDid(h.citedAtomDid ?? undefined);
  if (cited && ICC_SOURCED_ATOM_DID_ALLOWLIST.has(cited)) {
    return ICC_ACTOR_DID;
  }
  if (cited) {
    // Recurse on cited DID alone (allowlist / fixture path).
    if (resolveSourceActorDid({ did: cited }) === ICC_ACTOR_DID) {
      return ICC_ACTOR_DID;
    }
  }

  return null;
}

/** Collect unique (sourceActorDid, atomDid) pairs that must accrue. */
export function collectSourceObligationTargets(
  atoms: ReadonlyArray<SourceObligationAtomHint | AtomProvenanceEntry | string>,
): Array<{ sourceActorDid: string; atomDid: string }> {
  const seen = new Set<string>();
  const out: Array<{ sourceActorDid: string; atomDid: string }> = [];
  for (const raw of atoms) {
    const h = toHint(raw);
    const atomDid = normalizeDid(h.did);
    if (!atomDid) continue;
    const sourceActorDid = resolveSourceActorDid(h);
    if (!sourceActorDid) continue;
    // ICC fixture has meterFreeTier: true — accrue on every tier including free.
    // (Future licensed sources with meterFreeTier:false would gate here.)
    const key = `${sourceActorDid}\0${atomDid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceActorDid, atomDid });
  }
  return out;
}

function buildAccrual(
  target: { sourceActorDid: string; atomDid: string },
  params: AccrueSourceObligationsParams,
): SourceObligationAccrual {
  // Rates unset on ICC fixture → countable pending-rate row (I-K).
  const rate =
    target.sourceActorDid === ICC_ACTOR_DID
      ? ICC_ACTOR_RECORD_FIXTURE.sourceLicensing?.perReferenceRateMinor
      : undefined;
  const amountMinor =
    typeof rate === "number" && Number.isFinite(rate) ? rate : null;
  return {
    sourceActorDid: target.sourceActorDid,
    atomDid: target.atomDid,
    tool: params.tool,
    product: String(params.product),
    tier: params.tier,
    requestId: params.requestId,
    obligationType: "license-reference-royalty",
    amountMinor,
    currency:
      amountMinor !== null
        ? ICC_ACTOR_RECORD_FIXTURE.sourceLicensing?.currency ?? "USD"
        : null,
    graceTerms: amountMinor === null ? "pending-rate" : null,
    note:
      target.sourceActorDid === ICC_ACTOR_DID
        ? "icc-inbound-reference"
        : null,
  };
}

async function defaultInsert(row: SourceObligationAccrual): Promise<void> {
  await getPool().query(
    `INSERT INTO source_obligation_ledger
       (source_actor_did, atom_did, tool, product, tier, request_id,
        obligation_type, amount_minor, currency, grace_terms, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.sourceActorDid,
      row.atomDid,
      row.tool,
      row.product,
      row.tier,
      row.requestId,
      row.obligationType,
      row.amountMinor,
      row.currency,
      row.graceTerms,
      row.note,
    ],
  );
}

/**
 * Accrue inbound source obligations for returned atom DIDs.
 * Fire-and-forget from the tool path; never throws to the caller.
 * Safe on free_anonymous — does not import @hauska-sdk.
 */
export function accrueSourceObligations(
  params: AccrueSourceObligationsParams,
): void {
  if (!params.requestId) return;
  const targets = collectSourceObligationTargets(params.atoms);
  if (targets.length === 0) return;

  const rows = targets.map((t) => buildAccrual(t, params));

  void (async () => {
    for (const row of rows) {
      try {
        if (insertOverride) {
          testCaptures.push(row);
          await insertOverride(row);
        } else {
          await defaultInsert(row);
        }
        logger.info("source_obligation_accrual", {
          source_actor_did: row.sourceActorDid,
          atom_did: row.atomDid,
          tool: row.tool,
          product: row.product,
          tier: row.tier,
          request_id: row.requestId,
          obligation_type: row.obligationType,
          amount_minor: row.amountMinor,
          grace_terms: row.graceTerms,
        });
      } catch (err) {
        logger.error("source_obligation_accrual_error", {
          source_actor_did: row.sourceActorDid,
          atom_did: row.atomDid,
          tool: row.tool,
          request_id: row.requestId,
          error: String(err).slice(0, 500),
        });
      }
    }
  })();
}
