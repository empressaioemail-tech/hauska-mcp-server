/**
 * One definition of "this is ICC content".
 *
 * The gate (withhold from public) and the meter (accrue a source
 * obligation) MUST call this. Two functions that drift is the defect
 * this module exists to make unrepresentable.
 *
 * Adapter absence is not "not ICC". Absent, zero, and unmeasured are
 * three states. An unmeasured adapter supplies no evidence; it does
 * not vote no.
 */

import {
  ICC_ACTOR_RECORD_FIXTURE,
  ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE,
} from "@empressaio/atom-contract/reasoning";

export const ICC_JURISDICTION_TENANT = "icc-model-code";
export const ICC_SOURCE_ADAPTER = "icc-code-connect";
export const ICC_ACTOR_DID = ICC_ACTOR_RECORD_FIXTURE.actorId;

export const ICC_SOURCED_ATOM_DID_ALLOWLIST: ReadonlySet<string> = new Set([
  ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.anchorDid,
  "did:hauska:code-section:storage-port-proof/phase-1a",
  "did:hauska:atom:code-section:storage-port-proof/phase-1a",
]);

const ICC_CITATION_RE =
  /\b(ICC|International Code Council|IBC\b|IRC\b|IFC\b|Code Connect)\b/i;

export type AdapterMeasurement =
  | { status: "known"; value: string }
  | { status: "unmeasured" };

/**
 * Full atom-identity shape both the gate and the meter read.
 * Optional fields are evidence limbs; omitting one is unmeasured, not no.
 */
export interface IccIdentity {
  did?: string | null;
  jurisdictionTenant?: string | null;
  sourceAdapter?: AdapterMeasurement | string | null;
  sourceActorDid?: string | null;
  sourceCitation?: string | null;
  iccSourced?: boolean | null;
  citedAtomDid?: string | null;
}

function normalizeDid(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const did = raw.trim();
  return did.length > 0 ? did : null;
}

function adapterValue(
  adapter: IccIdentity["sourceAdapter"],
): { measured: boolean; value: string | null } {
  if (adapter == null) {
    return { measured: false, value: null };
  }
  if (typeof adapter === "string") {
    return { measured: true, value: adapter };
  }
  if (adapter.status === "unmeasured") {
    return { measured: false, value: null };
  }
  return { measured: true, value: adapter.value };
}

function adapterLooksIcc(adapter: string): boolean {
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
 * Single ICC verdict. Used by isIccCatalogTarget and resolveSourceActorDid.
 */
export function isIccContent(identity: IccIdentity): boolean {
  if (identity.jurisdictionTenant === ICC_JURISDICTION_TENANT) return true;

  const adapter = adapterValue(identity.sourceAdapter);
  if (adapter.measured && adapter.value === ICC_SOURCE_ADAPTER) return true;
  if (adapter.measured && adapter.value && adapterLooksIcc(adapter.value)) {
    return true;
  }

  const actor = normalizeDid(identity.sourceActorDid ?? undefined);
  if (actor === ICC_ACTOR_DID) return true;

  if (identity.iccSourced === true) return true;

  const did = normalizeDid(identity.did ?? undefined);
  if (did === ICC_ACTOR_DID) return true;
  if (did && ICC_SOURCED_ATOM_DID_ALLOWLIST.has(did)) return true;

  if (identity.sourceCitation && ICC_CITATION_RE.test(identity.sourceCitation)) {
    return true;
  }

  const cited = normalizeDid(identity.citedAtomDid ?? undefined);
  if (cited && ICC_SOURCED_ATOM_DID_ALLOWLIST.has(cited)) return true;
  if (cited && cited === ICC_ACTOR_DID) return true;

  return false;
}

export function identityFromAccessTarget(target: {
  jurisdictionTenant?: string | null;
  sourceAdapter?: string | null;
  sourceActorDid?: string | null;
}): IccIdentity {
  return {
    jurisdictionTenant: target.jurisdictionTenant ?? null,
    sourceAdapter:
      target.sourceAdapter === undefined
        ? { status: "unmeasured" }
        : target.sourceAdapter === null
          ? { status: "unmeasured" }
          : { status: "known", value: target.sourceAdapter },
    sourceActorDid: target.sourceActorDid ?? null,
  };
}

export function identityFromHint(hint: {
  did?: string | null;
  jurisdictionTenant?: string | null;
  sourceAdapter?: string | null;
  adapterStatus?: "known" | "unmeasured";
  sourceActorDid?: string | null;
  sourceCitation?: string | null;
  iccSourced?: boolean | null;
  citedAtomDid?: string | null;
}): IccIdentity {
  const adapterUnmeasured =
    hint.adapterStatus === "unmeasured" || hint.sourceAdapter == null;
  return {
    did: hint.did ?? null,
    jurisdictionTenant: hint.jurisdictionTenant ?? null,
    sourceAdapter: adapterUnmeasured
      ? { status: "unmeasured" }
      : { status: "known", value: hint.sourceAdapter as string },
    sourceActorDid: hint.sourceActorDid ?? null,
    sourceCitation: hint.sourceCitation ?? null,
    iccSourced: hint.iccSourced ?? null,
    citedAtomDid: hint.citedAtomDid ?? null,
  };
}

export interface IccVerdictPair {
  gate: boolean;
  meter: boolean;
  agree: boolean;
}

/**
 * Meaning-shaped check: gate verdict vs meter verdict from independently
 * constructed inputs. One party fabricating both sides cannot satisfy this
 * if the two inputs are built from different sources (access target vs
 * provenance entry).
 */
export function iccVerdictPair(
  gateIdentity: IccIdentity,
  meterIdentity: IccIdentity,
): IccVerdictPair {
  const gate = isIccContent(gateIdentity);
  const meter = isIccContent(meterIdentity);
  return { gate, meter, agree: gate === meter };
}

let disagreementCount = 0;

export function recordIccVerdictDisagreement(pair: IccVerdictPair): void {
  if (!pair.agree) disagreementCount += 1;
}

export function getIccDisagreementCount(): number {
  return disagreementCount;
}

export function resetIccDisagreementCountForTests(): void {
  disagreementCount = 0;
}

/** Compare a gate target (search row) to a meter hint (provenance entry). */
export function checkIccSearchPathAgreement(params: {
  tool: string;
  jurisdictionTenant: string;
  sourceAdapter?: string;
  provenance: {
    did: string;
    jurisdictionTenant?: string | null;
    sourceAdapter?: string | null;
    adapterStatus?: "known" | "unmeasured";
    sourceActorDid?: string | null;
  };
}): IccVerdictPair {
  const pair = iccVerdictPair(
    identityFromAccessTarget({
      jurisdictionTenant: params.jurisdictionTenant,
      sourceAdapter: params.sourceAdapter,
    }),
    identityFromHint({
      did: params.provenance.did,
      jurisdictionTenant: params.provenance.jurisdictionTenant,
      sourceAdapter: params.provenance.sourceAdapter,
      adapterStatus: params.provenance.adapterStatus,
      sourceActorDid: params.provenance.sourceActorDid,
    }),
  );
  recordIccVerdictDisagreement(pair);
  return pair;
}
