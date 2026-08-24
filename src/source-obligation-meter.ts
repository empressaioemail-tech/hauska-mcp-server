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
import {
  ICC_ACTOR_DID,
  ICC_SOURCED_ATOM_DID_ALLOWLIST,
  identityFromHint,
  isIccContent,
} from "./icc-content.js";
import { logger } from "./logger.js";
import type { AtomProvenanceEntry } from "./atom-shape.js";
import type { Product } from "./products.js";

export { ICC_ACTOR_DID, ICC_SOURCED_ATOM_DID_ALLOWLIST };

/** Fixture obligation shape (license-reference-royalty + owedToActorDid). */
export const ICC_LICENSE_REFERENCE_OBLIGATION =
  ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE;

export interface SourceObligationAtomHint {
  did: string;
  sourceActorDid?: string | null;
  sourceCitation?: string | null;
  /** Adapter / corpus stamp that marks ICC provenance. */
  sourceAdapter?: string | null;
  /** Unmeasured vs known. Null adapter is unmeasured, not "not ICC". */
  adapterStatus?: "known" | "unmeasured";
  /** Explicit stamp (atom.iccSourced / licensing stamp). */
  iccSourced?: boolean | null;
  /** Setback (or derived) cite of a code-section atom DID. */
  citedAtomDid?: string | null;
  entityType?: string | null;
  jurisdictionTenant?: string | null;
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
  const adapterStatus =
    entry.adapterStatus ??
    entry.source?.adapterStatus ??
    (entry.source?.adapter == null && entry.sourceAdapter == null
      ? "unmeasured"
      : "known");
  return {
    did: entry.did,
    sourceActorDid: entry.sourceActorDid ?? null,
    sourceCitation: entry.sourceCitation ?? null,
    sourceAdapter: entry.source?.adapter ?? entry.sourceAdapter ?? null,
    adapterStatus,
    iccSourced: entry.iccSourced ?? null,
    citedAtomDid: entry.citedAtomDid ?? null,
    entityType: entry.entityType ?? null,
    jurisdictionTenant: entry.jurisdictionTenant ?? null,
  };
}

/**
 * Resolve owed source-actor DID for one returned atom, or null if not
 * a licensed-source reference (v1: ICC only).
 *
 * Verdict comes from isIccContent — the same function the gate calls.
 */
export function resolveSourceActorDid(
  hint: SourceObligationAtomHint | AtomProvenanceEntry | string,
): string | null {
  const h = toHint(hint);
  const did = normalizeDid(h.did);
  if (!did) return null;
  if (isIccContent(identityFromHint(h))) return ICC_ACTOR_DID;
  const cited = normalizeDid(h.citedAtomDid ?? undefined);
  if (cited && isIccContent(identityFromHint({ did: cited }))) {
    return ICC_ACTOR_DID;
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
export interface SourceObligationLedgerRow {
  id: number;
  createdAt: string;
  sourceActorDid: string;
  atomDid: string;
  tool: string;
  product: string;
  tier: string;
  requestId: string;
  obligationType: string;
  amountMinor: number | null;
  currency: string | null;
  graceTerms: string | null;
  note: string | null;
}

type LedgerSelect = (opts: {
  sourceActorDid?: string;
  requestId?: string;
  limit?: number;
}) => Promise<SourceObligationLedgerRow[]>;

let selectOverride: LedgerSelect | null = null;

export function setSourceObligationSelectForTests(
  fn: LedgerSelect | null,
): void {
  selectOverride = fn;
}

/**
 * Reader for source_obligation_ledger. A ledger nothing reads is dormant.
 */
export async function listSourceObligationLedger(opts: {
  sourceActorDid?: string;
  requestId?: string;
  limit?: number;
} = {}): Promise<SourceObligationLedgerRow[]> {
  if (selectOverride) return selectOverride(opts);
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("listSourceObligationLedger: limit must be 1..1000");
  }
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (opts.sourceActorDid) {
    values.push(opts.sourceActorDid);
    clauses.push(`source_actor_did = $${values.length}`);
  }
  if (opts.requestId) {
    values.push(opts.requestId);
    clauses.push(`request_id = $${values.length}`);
  }
  values.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await getPool().query<{
    id: number;
    created_at: Date;
    source_actor_did: string;
    atom_did: string;
    tool: string;
    product: string;
    tier: string;
    request_id: string;
    obligation_type: string;
    amount_minor: number | null;
    currency: string | null;
    grace_terms: string | null;
    note: string | null;
  }>(
    `SELECT id, created_at, source_actor_did, atom_did, tool, product, tier,
            request_id, obligation_type, amount_minor, currency, grace_terms, note
       FROM source_obligation_ledger
       ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    sourceActorDid: r.source_actor_did,
    atomDid: r.atom_did,
    tool: r.tool,
    product: r.product,
    tier: r.tier,
    requestId: r.request_id,
    obligationType: r.obligation_type,
    amountMinor: r.amount_minor,
    currency: r.currency,
    graceTerms: r.grace_terms,
    note: r.note,
  }));
}

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
