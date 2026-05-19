// Atom-shape response envelope.
//
// Every tool response surfaces atom provenance in a consistent shape so
// agents can cite sources without reasoning over each tool's payload
// individually. The envelope is appended (not nested) so the original
// engine payload remains directly addressable.
//
// Per Stream 2A scope: every response surfaces atom DID, source adapter,
// source URL, and content hash. The engine's retrieval API does not
// currently return CID at the wire layer — content hash maps to CID at
// the storage layer per ADR-010. We pass content hash through and note
// the mapping in `cid_note` rather than fabricating a value.
//
// Free-tier responses additionally carry the attribution string
// "Powered by Hauska Engine — hauska.dev" verbatim per the brand
// convention. The em dash is intentional in this string; internal prose
// stays em-dash-free per CLAUDE.md.

import type {
  AtomInstanceBase,
  AtomSearchResult,
  GetAtomResponse,
  JurisdictionStatusSnapshot,
  ListJurisdictionsResponse,
  QueryJurisdictionResponse,
  SearchResponse,
} from "./hauska-client.js";

export const ATTRIBUTION_STRING = "Powered by Hauska Engine — hauska.dev";

export interface AtomProvenanceEntry {
  did: string;
  entityType: string;
  entityId: string;
  jurisdictionTenant: string;
  contentHash: string | null;
  cidNote: string;
  source: {
    adapter: string | null;
    url: string | null;
    fetchedAt: string | null;
  };
  sectionNumber?: string | null;
  score?: number;
}

const CID_NOTE =
  "content_hash maps to CID at storage time per ADR-010; the retrieval API exposes content_hash directly.";

/**
 * Build a provenance entry for a search result. Search results do not
 * carry the full atom body, so source-adapter and fetched-at are null
 * here — the caller should follow up with `get_atom` to retrieve them.
 */
export function provenanceFromSearchResult(
  result: AtomSearchResult,
): AtomProvenanceEntry {
  return {
    did: result.atomDid,
    entityType: result.entityType,
    entityId: result.entityId,
    jurisdictionTenant: result.jurisdictionTenant,
    contentHash: null,
    cidNote: CID_NOTE,
    source: { adapter: null, url: null, fetchedAt: null },
    sectionNumber: result.sectionNumber,
    score: result.score,
  };
}

/**
 * Build a provenance entry for a full atom instance returned by
 * `GET /atoms/:did`. Every BaseAtomInstance carries adapter, URL, hash,
 * and fetched-at fields by the engine contract.
 */
export function provenanceFromAtom(
  atom: AtomInstanceBase,
): AtomProvenanceEntry {
  return {
    did: `did:hauska:${atom.entityType}:${atom.entityId}`,
    entityType: atom.entityType,
    entityId: atom.entityId,
    jurisdictionTenant: atom.jurisdictionTenant,
    contentHash: atom.contentHash,
    cidNote: CID_NOTE,
    source: {
      adapter: atom.sourceAdapter,
      url: atom.sourceUrl,
      fetchedAt: atom.fetchedAt,
    },
  };
}

/**
 * Envelope shape every tool returns. The original engine payload lives
 * under `data`; provenance lives under `atoms`; attribution lives under
 * `meta.attribution` (free tier only).
 */
export interface ToolEnvelope<T> {
  data: T;
  atoms: AtomProvenanceEntry[];
  meta: {
    attribution?: string;
    note?: string;
  };
}

export interface BuildEnvelopeOptions {
  /** Tier of the caller. Free-tier responses include the attribution string. */
  tier: "free_anonymous" | "free" | "developer_pro" | "team" | "embedder";
  /** Optional human note (e.g. "Bastrop corpus not yet loaded"). */
  note?: string;
}

function isFreeTier(tier: BuildEnvelopeOptions["tier"]): boolean {
  return tier === "free_anonymous" || tier === "free";
}

export function buildEnvelope<T>(
  data: T,
  atoms: AtomProvenanceEntry[],
  options: BuildEnvelopeOptions,
): ToolEnvelope<T> {
  const meta: ToolEnvelope<T>["meta"] = {};
  if (isFreeTier(options.tier)) meta.attribution = ATTRIBUTION_STRING;
  if (options.note) meta.note = options.note;
  return { data, atoms, meta };
}

// -----------------------------------------------------------------
// Per-tool envelope builders.
// -----------------------------------------------------------------

export function searchAtomsEnvelope(
  response: SearchResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<SearchResponse> {
  return buildEnvelope(
    response,
    response.results.map(provenanceFromSearchResult),
    options,
  );
}

export function getAtomEnvelope(
  response: GetAtomResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GetAtomResponse> {
  const atoms: AtomProvenanceEntry[] = [];
  if (response.atom) atoms.push(provenanceFromAtom(response.atom));
  if (response.composition) {
    for (const edge of response.composition) {
      if (edge.atom) atoms.push(provenanceFromAtom(edge.atom));
    }
  }
  return buildEnvelope(response, atoms, options);
}

export function listJurisdictionsEnvelope(
  response: ListJurisdictionsResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ListJurisdictionsResponse> {
  // Jurisdiction snapshots carry `currentEditionDid` not an atom DID per
  // se; we surface those as pseudo-provenance entries so agents can cite
  // the edition that backs each jurisdiction in their answer.
  const atoms: AtomProvenanceEntry[] = response.jurisdictions
    .filter(
      (j): j is JurisdictionStatusSnapshot & { currentEditionDid: string } =>
        j.currentEditionDid !== null,
    )
    .map((j) => ({
      did: j.currentEditionDid,
      entityType: "code-edition",
      entityId: j.currentEditionDid.replace(/^did:hauska:code-edition:/, ""),
      jurisdictionTenant: j.jurisdictionTenant,
      contentHash: null,
      cidNote: CID_NOTE,
      source: { adapter: null, url: null, fetchedAt: j.lastRefreshedAt },
    }));
  return buildEnvelope(response, atoms, options);
}

export function queryJurisdictionEnvelope(
  response: QueryJurisdictionResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<QueryJurisdictionResponse> {
  const atoms: AtomProvenanceEntry[] = [];
  if (response.status?.currentEditionDid) {
    atoms.push({
      did: response.status.currentEditionDid,
      entityType: "code-edition",
      entityId: response.status.currentEditionDid.replace(
        /^did:hauska:code-edition:/,
        "",
      ),
      jurisdictionTenant: response.status.jurisdictionTenant,
      contentHash: null,
      cidNote: CID_NOTE,
      source: {
        adapter: null,
        url: null,
        fetchedAt: response.status.lastRefreshedAt,
      },
    });
  }
  if (response.permitAtoms) {
    for (const p of response.permitAtoms) atoms.push(provenanceFromSearchResult(p));
  }
  return buildEnvelope(response, atoms, options);
}

export function searchPermitAtomsEnvelope(
  response: QueryJurisdictionResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<QueryJurisdictionResponse> {
  return queryJurisdictionEnvelope(response, options);
}
