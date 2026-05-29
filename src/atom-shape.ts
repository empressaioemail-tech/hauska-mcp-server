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
import type {
  GetPlaceDossierResponse,
  GetPlaceLayersResponse,
  GetPropertyWorkspaceResponse,
  ListPropertyWorkspacesResponse,
  ListWorkspaceShareEdgesResponse,
  ResolvePlaceResponse,
  WorkspaceEvidenceRef,
} from "./legacy-client.js";

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

// -----------------------------------------------------------------
// Codex envelope (Lane B sprint 2).
//
// Codex tools wrap legacy-design-tools endpoints whose responses are
// already-shaped finding / briefing / submission rows. Those rows carry
// row ids (uuids) rather than Hauska atom DIDs at the wire layer today;
// the legacy `submission.atom.ts`, `finding.atom.ts`, and
// `parcel-briefing.atom.ts` registrations exist server-side but the
// HTTP routes return the row form, not the atom form.
//
// We surface a uniform envelope shape: original legacy payload under
// `data`, a single synthetic provenance entry under `atoms` carrying
// the legacy row id and the legacy endpoint URL as the source so agents
// can cite the result, and the standard meta block. Free-tier
// attribution does not apply (codex is Layer 2 paid) but the envelope
// stays consistent for consumer ergonomics.
// -----------------------------------------------------------------

export interface CodexProvenanceParams {
  atomKind:
    | "finding-generation-run"
    | "finding-override"
    | "parcel-briefing"
    | "submission";
  rowId: string;
  jurisdictionTenant: string;
  sourcePath: string;
}

export function codexProvenance(
  params: CodexProvenanceParams,
): AtomProvenanceEntry {
  return {
    did: `legacy:${params.atomKind}:${params.rowId}`,
    entityType: params.atomKind,
    entityId: params.rowId,
    jurisdictionTenant: params.jurisdictionTenant,
    contentHash: null,
    cidNote:
      "Legacy backend row id; canonical Hauska DID materializes when the legacy atom-registry surfaces via the engine retrieval API.",
    source: {
      adapter: "legacy-design-tools",
      url: params.sourcePath,
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function codexEnvelope<T>(
  data: T,
  provenance:
    | AtomProvenanceEntry
    | ReadonlyArray<AtomProvenanceEntry>
    | null,
  options: BuildEnvelopeOptions,
): ToolEnvelope<T> {
  const atoms: AtomProvenanceEntry[] =
    provenance === null
      ? []
      : Array.isArray(provenance)
        ? [...provenance]
        : [provenance as AtomProvenanceEntry];
  return buildEnvelope(data, atoms, options);
}

// -----------------------------------------------------------------
// L-surface provenance (Lane B Group 3).
//
// The L1-L6 Cortex surfaces (response-task, sheet-content-extraction,
// attached-document, deliverable-letter, detail-callout-spec,
// product-spec-reference) carry the full BaseAtomInstance contract:
// a real entityId, contentHash, source adapter/url, and fetched-at.
// So unlike the Codex/Cortex existing-product tools (Groups 1+2),
// which wrap legacy row shapes and use the synthetic `legacy:` did,
// L-surface responses get a real `did:hauska:<entityType>:<entityId>`.
//
// `lSurfaceProvenance` accepts the BaseAtomInstance subset structurally
// so it works against any L-surface atom type without importing the
// engine atom package into the mcp-server build graph.
// -----------------------------------------------------------------

export interface LSurfaceAtomBase {
  entityType: string;
  entityId: string;
  jurisdictionTenant: string;
  contentHash: string;
  sourceAdapter: string;
  sourceUrl: string;
  fetchedAt: string;
}

export function lSurfaceProvenance(
  atom: LSurfaceAtomBase,
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

function provenanceFromWorkspaceEvidence(
  evidence: WorkspaceEvidenceRef,
): AtomProvenanceEntry {
  const did = evidence.atomDid ?? `legacy:evidence:${evidence.refId}`;
  const entityType = evidence.kind;
  const entityId = evidence.refId;
  return {
    did,
    entityType,
    entityId,
    jurisdictionTenant: "brokerage",
    contentHash: null,
    cidNote:
      "Brokerage evidence ref. Use atomDid when present; otherwise this is a stable edge/reference id.",
    source: {
      adapter: "legacy-design-tools",
      url: evidence.sourceUrl ?? null,
      fetchedAt: evidence.observedAt ?? null,
    },
  };
}

export function listPropertyWorkspacesEnvelope(
  response: ListPropertyWorkspacesResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ListPropertyWorkspacesResponse> {
  const atoms = response.workspaces.flatMap((workspace) =>
    (workspace.evidenceRefs ?? []).map(provenanceFromWorkspaceEvidence),
  );
  return buildEnvelope(response, atoms, options);
}

export function getPropertyWorkspaceEnvelope(
  response: GetPropertyWorkspaceResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GetPropertyWorkspaceResponse> {
  const atoms =
    response.workspace?.evidenceRefs?.map(provenanceFromWorkspaceEvidence) ?? [];
  return buildEnvelope(response, atoms, options);
}

export function listWorkspaceShareEdgesEnvelope(
  response: ListWorkspaceShareEdgesResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ListWorkspaceShareEdgesResponse> {
  const atoms = response.edges.flatMap((edge) =>
    (edge.evidenceRefs ?? []).map(provenanceFromWorkspaceEvidence),
  );
  return buildEnvelope(response, atoms, options);
}

export function resolvePlaceEnvelope(
  response: ResolvePlaceResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ResolvePlaceResponse> {
  return buildEnvelope(response, [], options);
}

export function getPlaceLayersEnvelope(
  response: GetPlaceLayersResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GetPlaceLayersResponse> {
  const atoms = response.layers
    .filter((l) => l.atomDid)
    .map((l) => ({
      did: l.atomDid!,
      entityType: l.layerKind,
      entityId: l.layerKind,
      jurisdictionTenant: response.jurisdiction_key,
      contentHash: null,
      cidNote: CID_NOTE,
      source: {
        adapter: (l.provenance?.adapter as string | null) ?? "place-layer",
        url: (l.provenance?.url as string | null) ?? null,
        fetchedAt: l.asOf ?? null,
      },
    }));
  return buildEnvelope(response, atoms, options);
}

export function getPlaceDossierEnvelope(
  response: GetPlaceDossierResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GetPlaceDossierResponse> {
  return buildEnvelope(response, [], options);
}
