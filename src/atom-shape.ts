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
//
// F4 (Calibrated Spine): every read envelope carries a
// @empressaio/atom-contract read-contract object alongside provenance.

import type { ReadContract } from "@empressaio/atom-contract/read-contract";

import {
  buildReadContract,
  type ReadContractKind,
} from "./read-contract-bridge.js";

import type {
  AtomInstanceBase,
  AtomSearchResult,
  GetAtomResponse,
  JurisdictionStatusSnapshot,
  ListJurisdictionsResponse,
  QueryJurisdictionResponse,
  SearchResponse,
} from "./hauska-client.js";
import type { PropertyAtomChainData } from "./property-atom-chain.js";
import type { ParcelTerrainExportToolData } from "./terrain-export-contract.js";
import type { ParcelSitePlanExportToolData } from "./site-plan-export-contract.js";
import type { ParcelDossierExportToolData } from "./dossier-export-contract.js";
import { checkIccSearchPathAgreement } from "./icc-content.js";
import { extractCitedAtomDid } from "./source-obligation-meter.js";
import type {
  GetPlaceDossierResponse,
  GetPlaceLayersResponse,
  GetPropertyWorkspaceResponse,
  GenerateBriefResponse,
  GetBriefRunResponse,
  EncumbrancesListResponse,
  SiteDrainageReadResponse,
  SiteTopographyReadResponse,
  ParcelTerrainModelResponse,
  CredentialPendingResponse,
  ListPropertyWorkspacesResponse,
  ListWorkspaceShareEdgesResponse,
  ResolvePlaceResponse,
  WorkspaceEvidenceRef,
} from "./legacy-client.js";

export const ATTRIBUTION_STRING = "Powered by Hauska Engine — hauska.dev";

const CID_NOTE =
  "content_hash maps to CID at storage time per ADR-010; the retrieval API exposes content_hash directly.";

export type AdapterStatus = "known" | "unmeasured";

export interface AtomProvenanceEntry {
  did: string;
  entityType: string;
  entityId: string;
  jurisdictionTenant: string;
  contentHash: string | null;
  cidNote: string;
  source: {
    adapter: string | null;
    adapterStatus?: AdapterStatus;
    url: string | null;
    fetchedAt: string | null;
  };
  sectionNumber?: string | null;
  score?: number;
  sourceActorDid?: string | null;
  sourceCitation?: string | null;
  iccSourced?: boolean | null;
  citedAtomDid?: string | null;
}

/**
 * Discriminated provenance for buildEnvelope. A bare [] meant both
 * "not built" and "genuinely no atoms". Those are different states.
 */
export type EnvelopeProvenance =
  | { status: "built"; entries: readonly AtomProvenanceEntry[] }
  | { status: "empty"; reason: "no-atoms" | "not-found" | "credential-pending" };

export function builtProvenance(
  entries: readonly AtomProvenanceEntry[],
): EnvelopeProvenance {
  return { status: "built", entries };
}

export function emptyProvenance(
  reason: Extract<EnvelopeProvenance, { status: "empty" }>["reason"],
): EnvelopeProvenance {
  return { status: "empty", reason };
}

function entriesOf(provenance: EnvelopeProvenance): AtomProvenanceEntry[] {
  return provenance.status === "built" ? [...provenance.entries] : [];
}

export type MakeProvenanceInput = {
  did: string;
  entityType: string;
  entityId: string;
  jurisdictionTenant: string;
  contentHash?: string | null;
  cidNote?: string;
  adapter: { status: "known"; value: string } | { status: "unmeasured" };
  url?: string | null;
  fetchedAt?: string | null;
  sectionNumber?: string | null;
  score?: number;
  sourceActorDid: string | null;
  sourceCitation: string | null;
  iccSourced: boolean | null;
  citedAtomDid: string | null;
};

/** Shared constructor. ICC fields are required so a new builder cannot omit them. */
/** Fill ICC fields and adapterStatus on a hand-built entry. Prefer makeProvenanceEntry for new code. */
export function completeProvenance(
  entry: {
    did: string;
    entityType: string;
    entityId: string;
    jurisdictionTenant: string;
    contentHash: string | null;
    cidNote?: string;
    source: {
      adapter: string | null;
      adapterStatus?: AdapterStatus;
      url: string | null;
      fetchedAt: string | null;
    };
    sectionNumber?: string | null;
    score?: number;
    sourceActorDid?: string | null;
    sourceCitation?: string | null;
    iccSourced?: boolean | null;
    citedAtomDid?: string | null;
  },
): AtomProvenanceEntry {
  const adapterUnmeasured =
    entry.source.adapterStatus === "unmeasured" ||
    (entry.source.adapterStatus === undefined && entry.source.adapter == null);
  return makeProvenanceEntry({
    did: entry.did,
    entityType: entry.entityType,
    entityId: entry.entityId,
    jurisdictionTenant: entry.jurisdictionTenant,
    contentHash: entry.contentHash,
    cidNote: entry.cidNote,
    adapter: adapterUnmeasured
      ? { status: "unmeasured" }
      : { status: "known", value: entry.source.adapter as string },
    url: entry.source.url,
    fetchedAt: entry.source.fetchedAt,
    sectionNumber: entry.sectionNumber,
    score: entry.score,
    sourceActorDid: entry.sourceActorDid ?? null,
    sourceCitation: entry.sourceCitation ?? null,
    iccSourced: entry.iccSourced ?? null,
    citedAtomDid: entry.citedAtomDid ?? null,
  });
}

export function makeProvenanceEntry(
  input: MakeProvenanceInput,
): AtomProvenanceEntry {
  const adapterValue =
    input.adapter.status === "known" ? input.adapter.value : null;
  return {
    did: input.did,
    entityType: input.entityType,
    entityId: input.entityId,
    jurisdictionTenant: input.jurisdictionTenant,
    contentHash: input.contentHash ?? null,
    cidNote: input.cidNote ?? CID_NOTE,
    source: {
      adapter: adapterValue,
      adapterStatus: input.adapter.status,
      url: input.url ?? null,
      fetchedAt: input.fetchedAt ?? null,
    },
    sectionNumber: input.sectionNumber,
    score: input.score,
    sourceActorDid: input.sourceActorDid,
    sourceCitation: input.sourceCitation,
    iccSourced: input.iccSourced,
    citedAtomDid: input.citedAtomDid,
  };
}

/**
 * Build a provenance entry for a search result. Search rows do not
 * carry an adapter. That absence is unmeasured, not a measured null.
 */
export function provenanceFromSearchResult(
  result: AtomSearchResult,
): AtomProvenanceEntry {
  return makeProvenanceEntry({
    did: result.atomDid,
    entityType: result.entityType,
    entityId: result.entityId,
    jurisdictionTenant: result.jurisdictionTenant,
    contentHash: null,
    adapter:
      result.sourceAdapter === undefined || result.sourceAdapter === null
        ? { status: "unmeasured" }
        : { status: "known", value: result.sourceAdapter },
    url: null,
    fetchedAt: null,
    sectionNumber: result.sectionNumber,
    score: result.score,
    sourceActorDid:
      typeof result.sourceActorDid === "string" ? result.sourceActorDid : null,
    sourceCitation: null,
    iccSourced: null,
    citedAtomDid: null,
  });
}

/**
 * Build a provenance entry for a full atom instance returned by
 * `GET /atoms/:did`. Every BaseAtomInstance carries adapter, URL, hash,
 * and fetched-at fields by the engine contract.
 */
export function provenanceFromAtom(
  atom: AtomInstanceBase,
): AtomProvenanceEntry {
  const sourceActorDid =
    typeof atom.sourceActorDid === "string" ? atom.sourceActorDid : null;
  const sourceCitation =
    typeof atom.sourceCitation === "string" ? atom.sourceCitation : null;
  const iccSourced =
    atom.iccSourced === true ||
    atom.sourceLicensor === "icc" ||
    atom.licensingStamp === "icc";
  return makeProvenanceEntry({
    did: `did:hauska:${atom.entityType}:${atom.entityId}`,
    entityType: atom.entityType,
    entityId: atom.entityId,
    jurisdictionTenant: atom.jurisdictionTenant,
    contentHash: atom.contentHash,
    adapter: { status: "known", value: atom.sourceAdapter },
    url: atom.sourceUrl,
    fetchedAt: atom.fetchedAt,
    sourceActorDid,
    sourceCitation,
    iccSourced: iccSourced || null,
    citedAtomDid: extractCitedAtomDid(atom),
  });
}

/**
 * Envelope shape every tool returns. The original engine payload lives
 * under `data`; provenance lives under `atoms`; attribution lives under
 * `meta.attribution` (free tier only).
 */
export interface ToolEnvelope<T> {
  data: T;
  atoms: AtomProvenanceEntry[];
  readContract: ReadContract;
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
  /** Read-contract assembly kind (F4). Defaults from atom count. */
  readKind?: ReadContractKind;
  /** Mean retrieval score for catalog reads (search). */
  avgScore?: number;
}

function isFreeTier(tier: BuildEnvelopeOptions["tier"]): boolean {
  return tier === "free_anonymous" || tier === "free";
}

function defaultReadKind(atomCount: number): ReadContractKind {
  return atomCount > 0 ? "catalog" : "empty";
}

export function buildEnvelope<T>(
  data: T,
  provenance: EnvelopeProvenance,
  options: BuildEnvelopeOptions,
): ToolEnvelope<T> {
  const atoms = entriesOf(provenance);
  const meta: ToolEnvelope<T>["meta"] = {};
  if (isFreeTier(options.tier)) meta.attribution = ATTRIBUTION_STRING;
  if (options.note) meta.note = options.note;
  const readKind = options.readKind ?? defaultReadKind(atoms.length);
  const readContract = buildReadContract({
    kind: readKind,
    atomCount: atoms.length,
    avgScore: options.avgScore,
  });
  return { data, atoms, readContract, meta };
}

// -----------------------------------------------------------------
// Per-tool envelope builders.
// -----------------------------------------------------------------

export function searchAtomsEnvelope(
  response: SearchResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<SearchResponse> {
  const atoms = response.results.map((r) => {
    const entry = provenanceFromSearchResult(r);
    checkIccSearchPathAgreement({
      tool: "search_atoms",
      jurisdictionTenant: r.jurisdictionTenant,
      sourceAdapter: r.sourceAdapter,
      provenance: {
        did: entry.did,
        jurisdictionTenant: entry.jurisdictionTenant,
        sourceAdapter: entry.source.adapter,
        adapterStatus: entry.source.adapterStatus,
        sourceActorDid: entry.sourceActorDid,
      },
    });
    return entry;
  });
  const scores = response.results.map((r) => r.score).filter((s) => s > 0);
  const avgScore =
    scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : undefined;
  return buildEnvelope(response, builtProvenance(atoms), {
    ...options,
    readKind: "catalog",
    avgScore,
  });
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
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function propertyAtomChainEnvelope(
  data: PropertyAtomChainData,
  readableAtoms: AtomInstanceBase[],
  options: BuildEnvelopeOptions,
): ToolEnvelope<PropertyAtomChainData> {
  const atoms = readableAtoms.map(provenanceFromAtom);
  const readKind =
    data.status === "atom_path_pending" || data.status === "not_ready"
      ? "empty"
      : atoms.length > 0
        ? "catalog"
        : "empty";
  return buildEnvelope(data, builtProvenance(atoms), { ...options, readKind });
}

export function parcelTerrainExportEnvelope(
  data: ParcelTerrainExportToolData,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ParcelTerrainExportToolData> {
  const atom = data.atom;
  const fetchedAt =
    typeof atom.fetchedAt === "string"
      ? atom.fetchedAt
      : new Date().toISOString();
  const rawDid =
    typeof atom.atomDid === "string"
      ? atom.atomDid
      : `did:hauska:parcel-terrain-model:${data.parcelNodeId}`;
  const did = rawDid.startsWith("did:") ? rawDid : `did:hauska:parcel-terrain-model:${rawDid}`;
  const jurisdictionTenant =
    typeof atom.jurisdictionTenant === "string"
      ? atom.jurisdictionTenant
      : "property-spine";
  const atoms: AtomProvenanceEntry[] = [
    completeProvenance({
      did,
      entityType: "parcel-terrain-model",
      entityId: data.parcelNodeId,
      jurisdictionTenant,
      contentHash:
        typeof atom.contentHash === "string" ? atom.contentHash : null,
      cidNote: CID_NOTE,
      source: {
        adapter:
          typeof atom.sourceAdapter === "string"
            ? atom.sourceAdapter
            : "usgs:3dep-dem",
        url:
          typeof atom.sourceUrl === "string"
            ? atom.sourceUrl
            : "https://elevation.nationalmap.gov/3dep",
        fetchedAt,
      },
      sourceActorDid:
        typeof atom.sourceActorDid === "string" ? atom.sourceActorDid : null,
      sourceCitation:
        typeof atom.sourceCitation === "string" ? atom.sourceCitation : null,
      iccSourced: atom.iccSourced === true ? true : null,
      citedAtomDid: extractCitedAtomDid(atom),
    }),
  ];
  return buildEnvelope(data, builtProvenance(atoms), { ...options, readKind: "catalog" });
}

export function parcelSitePlanExportEnvelope(
  data: ParcelSitePlanExportToolData,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ParcelSitePlanExportToolData> {
  const atom = data.atom;
  const fetchedAt =
    typeof atom.fetchedAt === "string"
      ? atom.fetchedAt
      : new Date().toISOString();
  const rawDid =
    typeof atom.atomDid === "string"
      ? atom.atomDid
      : `did:hauska:parcel-terrain-model:${data.parcelNodeId}`;
  const did = rawDid.startsWith("did:") ? rawDid : `did:hauska:parcel-terrain-model:${rawDid}`;
  const jurisdictionTenant =
    typeof atom.jurisdictionTenant === "string"
      ? atom.jurisdictionTenant
      : "property-spine";
  // Site plan composes parcel ring, setback-rule, terrain mesh, and road
  // anchors into one atom (same parcel-terrain-model entity the terrain
  // export writes) — provenance entry stays on that atom, per-layer
  // citations live in the CAD/PDF provenance panel, not duplicated here.
  const atoms: AtomProvenanceEntry[] = [
    {
      did,
      entityType: "parcel-terrain-model",
      entityId: data.parcelNodeId,
      jurisdictionTenant,
      contentHash:
        typeof atom.contentHash === "string" ? atom.contentHash : null,
      cidNote: CID_NOTE,
      source: {
        adapter:
          typeof atom.sourceAdapter === "string"
            ? atom.sourceAdapter
            : "engine:site-plan-composer",
        url:
          typeof atom.sourceUrl === "string" ? atom.sourceUrl : null,
        fetchedAt,
      },
    },
  ];
  return buildEnvelope(data, builtProvenance(atoms), { ...options, readKind: "catalog" });
}

export function parcelDossierExportEnvelope(
  data: ParcelDossierExportToolData,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ParcelDossierExportToolData> {
  const atom = data.atom;
  const fetchedAt =
    typeof atom.fetchedAt === "string"
      ? atom.fetchedAt
      : new Date().toISOString();
  const rawDid =
    typeof atom.atomDid === "string"
      ? atom.atomDid
      : `did:hauska:parcel-terrain-model:${data.parcelNodeId}`;
  const did = rawDid.startsWith("did:") ? rawDid : `did:hauska:parcel-terrain-model:${rawDid}`;
  const jurisdictionTenant =
    typeof atom.jurisdictionTenant === "string"
      ? atom.jurisdictionTenant
      : "property-spine";
  // The dossier records its pdf-dossier artifact on the SAME
  // parcel-terrain-model atom the site-plan/terrain exports write —
  // provenance entry stays on that atom. Caller-supplied dossier content
  // (verdict, brief facts, chat summary, notes) is rendered verbatim by the
  // engine and never becomes catalog provenance.
  const atoms: AtomProvenanceEntry[] = [
    {
      did,
      entityType: "parcel-terrain-model",
      entityId: data.parcelNodeId,
      jurisdictionTenant,
      contentHash:
        typeof atom.contentHash === "string" ? atom.contentHash : null,
      cidNote: CID_NOTE,
      source: {
        adapter:
          typeof atom.sourceAdapter === "string"
            ? atom.sourceAdapter
            : "engine:site-plan-composer",
        url:
          typeof atom.sourceUrl === "string" ? atom.sourceUrl : null,
        fetchedAt,
      },
    },
  ];
  return buildEnvelope(data, builtProvenance(atoms), { ...options, readKind: "catalog" });
}

export function atomTraceEnvelope(
  trace: import("./hauska-client.js").AtomTraceResponse | null,
  options: BuildEnvelopeOptions,
): ToolEnvelope<import("./hauska-client.js").AtomTraceResponse | null> {
  if (!trace) {
    return buildEnvelope(null, emptyProvenance("not-found"), {
      ...options,
      readKind: "empty",
      note: "No trace found for atom DID.",
    });
  }
  const atoms: AtomProvenanceEntry[] = [provenanceFromAtom(trace.atom)];
  for (const edge of [...trace.outbound, ...trace.inbound]) {
    if (edge.atom) atoms.push(provenanceFromAtom(edge.atom));
  }
  return buildEnvelope(trace, builtProvenance(atoms), {
    ...options,
    readKind: "catalog",
  });
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
  return buildEnvelope(response, builtProvenance(atoms), options);
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
  return buildEnvelope(response, builtProvenance(atoms), options);
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
    | "brief-run"
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
  return buildEnvelope(data, builtProvenance(atoms), {
    ...options,
    readKind: options.readKind ?? "legacy-deterministic",
  });
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
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function getPropertyWorkspaceEnvelope(
  response: GetPropertyWorkspaceResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GetPropertyWorkspaceResponse> {
  const atoms =
    response.workspace?.evidenceRefs?.map(provenanceFromWorkspaceEvidence) ?? [];
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function listWorkspaceShareEdgesEnvelope(
  response: ListWorkspaceShareEdgesResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ListWorkspaceShareEdgesResponse> {
  const atoms = response.edges.flatMap((edge) =>
    (edge.evidenceRefs ?? []).map(provenanceFromWorkspaceEvidence),
  );
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function resolvePlaceEnvelope(
  response: ResolvePlaceResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ResolvePlaceResponse> {
  return buildEnvelope(response, emptyProvenance("no-atoms"), { ...options, readKind: "empty" });
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
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function getPlaceDossierEnvelope(
  response: GetPlaceDossierResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GetPlaceDossierResponse> {
  const atoms: AtomProvenanceEntry[] = [];
  for (const layer of response.layers ?? []) {
    const atomDid =
      typeof layer === "object" &&
      layer !== null &&
      typeof (layer as { atomDid?: unknown }).atomDid === "string"
        ? (layer as { atomDid: string }).atomDid
        : null;
    if (atomDid) {
      atoms.push({
        did: atomDid,
        entityType: "place-layer",
        entityId: atomDid.replace(/^did:hauska:[^:]+:/, ""),
        jurisdictionTenant: response.jurisdiction_key,
        contentHash: null,
        cidNote: CID_NOTE,
        source: { adapter: "place-dossier", url: null, fetchedAt: null },
      });
    }
  }
  for (const ref of response.inlineRefs ?? []) {
    const did =
      typeof ref === "object" &&
      ref !== null &&
      typeof (ref as { did?: unknown }).did === "string"
        ? (ref as { did: string }).did
        : null;
    if (did) {
      atoms.push({
        did,
        entityType: "inline-ref",
        entityId: did.replace(/^did:hauska:[^:]+:/, ""),
        jurisdictionTenant: response.jurisdiction_key,
        contentHash: null,
        cidNote: CID_NOTE,
        source: { adapter: "place-dossier", url: null, fetchedAt: null },
      });
    }
  }
  return buildEnvelope(response, builtProvenance(atoms), {
    ...options,
    readKind: atoms.length > 0 ? "legacy-deterministic" : "empty",
  });
}

// -----------------------------------------------------------------
// Tier 1 Property Brief envelope (Group A).
// -----------------------------------------------------------------

function briefRunProvenanceEntry(
  runId: string,
  fetchedAt: string,
  jurisdictionTenant: string,
): AtomProvenanceEntry {
  return {
    did: `did:hauska:brief-run:${runId}`,
    entityType: "brief-run",
    entityId: runId,
    jurisdictionTenant,
    contentHash: null,
    cidNote: CID_NOTE,
    source: {
      adapter: "legacy-design-tools",
      url: `/api/brokerage/v1/brief`,
      fetchedAt,
    },
  };
}

function provenanceFromBriefInlineRef(
  ref: { did: string; entityType: string; entityId: string },
  fetchedAt: string,
  jurisdictionTenant: string,
): AtomProvenanceEntry {
  return {
    did: ref.did,
    entityType: ref.entityType,
    entityId: ref.entityId,
    jurisdictionTenant,
    contentHash: null,
    cidNote: CID_NOTE,
    source: {
      adapter: "legacy-design-tools",
      url: `/api/brokerage/v1/brief`,
      fetchedAt,
    },
  };
}

export function generateBriefEnvelope(
  response: GenerateBriefResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GenerateBriefResponse> {
  const fetchedAt = response.finishedAt ?? response.startedAt;
  const jurisdiction = response.jurisdiction ?? "brokerage";
  const atoms: AtomProvenanceEntry[] = [
    briefRunProvenanceEntry(response.runId, fetchedAt, jurisdiction),
  ];
  for (const ref of response.atoms?.inlineRefs ?? []) {
    atoms.push(provenanceFromBriefInlineRef(ref, fetchedAt, jurisdiction));
  }
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function getBriefRunEnvelope(
  response: GetBriefRunResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<GetBriefRunResponse> {
  return generateBriefEnvelope(response, options);
}

// -----------------------------------------------------------------
// Tier 1 site-drainage / site-topography envelopes (Group B).
// -----------------------------------------------------------------

export function siteDrainageEnvelope(
  response: SiteDrainageReadResponse,
  engagementId: string,
  options: BuildEnvelopeOptions,
): ToolEnvelope<SiteDrainageReadResponse> {
  const fetchedAt = response.updatedAt ?? response.createdAt ?? new Date().toISOString();
  const entityId = response.materializableElementId ?? engagementId;
  const atoms: AtomProvenanceEntry[] =
    response.status === "ok"
      ? [
          {
            did: `did:hauska:site-drainage:${entityId}`,
            entityType: "site-drainage",
            entityId,
            jurisdictionTenant: "legacy",
            contentHash: null,
            cidNote: CID_NOTE,
            source: {
              adapter: "legacy-design-tools",
              url: `/api/engagements/${engagementId}/site-drainage`,
              fetchedAt,
            },
          },
        ]
      : [];
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function siteTopographyEnvelope(
  response: SiteTopographyReadResponse,
  engagementId: string,
  options: BuildEnvelopeOptions,
): ToolEnvelope<SiteTopographyReadResponse> {
  const fetchedAt = response.updatedAt ?? response.createdAt ?? new Date().toISOString();
  const entityId = response.materializableElementId ?? engagementId;
  const atoms: AtomProvenanceEntry[] =
    response.status === "ok"
      ? [
          {
            did: `did:hauska:site-topography:${entityId}`,
            entityType: "site-topography",
            entityId,
            jurisdictionTenant: "legacy",
            contentHash: null,
            cidNote: CID_NOTE,
            source: {
              adapter: "legacy-design-tools",
              url: `/api/engagements/${engagementId}/site-topography`,
              fetchedAt,
            },
          },
        ]
      : [];
  return buildEnvelope(response, builtProvenance(atoms), options);
}

/**
 * Coverage-honest confidence as it reaches the parcel-terrain-model surface.
 * Mirrors the @empressaio/atom-contract WidthedConfidence shape closely enough
 * for the tile to read { estimate, provenance } without ever seeing a bare
 * number. `provenance` is ALWAYS present.
 */
export interface NormalizedTerrainConfidence {
  estimate: number;
  provenance: string;
  n: number;
  intervalWidth: number;
}

/**
 * Defensively shape a confidence value so a BARE number can never reach the
 * product surface as an unqualified score (commitment 2: never present a
 * bare or unearned number as earned).
 *
 *   - object with a numeric `estimate`  -> pass through, defaulting a missing
 *     `provenance` to "asserted" (the honest floor; we never invent a
 *     calibrated provenance here),
 *   - bare number                        -> wrap as an asserted WidthedConfidence
 *     ({ estimate, provenance: "asserted", n: 0, intervalWidth: 1 }),
 *   - null / undefined / unusable        -> null (tile shows its no-confidence state).
 *
 * Layer 0 constructs a proper WidthedConfidence upstream, so the bare-number
 * branch should not fire in practice; the surface must not DEPEND on that
 * cross-repo invariant to stay honest.
 */
export function normalizeTerrainConfidence(
  confidence: unknown,
): NormalizedTerrainConfidence | null {
  if (confidence == null) return null;
  if (typeof confidence === "number") {
    if (!Number.isFinite(confidence)) return null;
    return {
      estimate: confidence,
      provenance: "asserted",
      n: 0,
      intervalWidth: 1,
    };
  }
  if (typeof confidence === "object") {
    const c = confidence as {
      estimate?: unknown;
      provenance?: unknown;
      n?: unknown;
      intervalWidth?: unknown;
    };
    if (typeof c.estimate === "number" && Number.isFinite(c.estimate)) {
      return {
        estimate: c.estimate,
        provenance:
          typeof c.provenance === "string" && c.provenance.trim()
            ? c.provenance
            : "asserted",
        n: typeof c.n === "number" ? c.n : 0,
        intervalWidth:
          typeof c.intervalWidth === "number" ? c.intervalWidth : 1,
      };
    }
  }
  // Unusable shape (e.g. object without a numeric estimate): no honest
  // number to present, so surface no confidence rather than a bare guess.
  return null;
}

/**
 * Parcel-terrain-model provenance envelope. Emits a
 * did:hauska:parcel-terrain-model:<materializableElementId> provenance
 * atom carrying the source citation (USGS 3DEP), fetched-at timestamp,
 * and the coverage-honest confidence signals from the read row. Per
 * structural commitment 1, the mesh and IFC references never ship without
 * these quality-gate signals attached.
 */
export function parcelTerrainModelEnvelope(
  response: ParcelTerrainModelResponse,
  engagementId: string,
  options: BuildEnvelopeOptions,
): ToolEnvelope<ParcelTerrainModelResponse> {
  const fetchedAt =
    response.updatedAt ?? response.createdAt ?? new Date().toISOString();
  const entityId = response.materializableElementId ?? engagementId;
  const hasModel =
    response.status === "ok" &&
    (response.meshRef !== undefined || response.ifcRef !== undefined);
  const atoms: AtomProvenanceEntry[] = hasModel
    ? [
        {
          did: `did:hauska:parcel-terrain-model:${entityId}`,
          entityType: "parcel-terrain-model",
          entityId,
          jurisdictionTenant: "legacy",
          contentHash: null,
          cidNote: CID_NOTE,
          source: {
            // Terrain is derived from USGS 3DEP public elevation; the
            // materialized row is served by the legacy engine route.
            adapter: "usgs-3dep",
            url: `/api/engagements/${engagementId}/site-topography`,
            fetchedAt,
          },
        },
      ]
    : [];
  return buildEnvelope(response, builtProvenance(atoms), options);
}

// -----------------------------------------------------------------
// Tier 1 encumbrance envelopes (Group C).
// -----------------------------------------------------------------

export function encumbrancesEnvelope(
  response: EncumbrancesListResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<EncumbrancesListResponse> {
  const fetchedAt = new Date().toISOString();
  const atoms: AtomProvenanceEntry[] = [];
  for (const row of response.instruments) {
    const atom = row.instrument as {
      instrumentDid?: string;
      entityType?: string;
    };
    const did =
      atom.instrumentDid ??
      `did:hauska:recorded-instrument:${row.id}`;
    atoms.push({
      did,
      entityType: "recorded-instrument",
      entityId: row.id,
      jurisdictionTenant: "brokerage",
      contentHash: null,
      cidNote: CID_NOTE,
      source: {
        adapter: "legacy-design-tools",
        url: "/api/brokerage/v1/workspaces/encumbrances",
        fetchedAt,
      },
    });
  }
  for (const row of response.clauses) {
    const clause = row.clause as { clauseDid?: string };
    const did =
      clause.clauseDid ?? `did:hauska:restriction-clause:${row.id}`;
    atoms.push({
      did,
      entityType: "restriction-clause",
      entityId: row.id,
      jurisdictionTenant: "brokerage",
      contentHash: null,
      cidNote: CID_NOTE,
      source: {
        adapter: "legacy-design-tools",
        url: "/api/brokerage/v1/workspaces/encumbrances",
        fetchedAt,
      },
    });
  }
  return buildEnvelope(response, builtProvenance(atoms), options);
}

export function restrictionsEnvelope(
  response: EncumbrancesListResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<{
  workspaceDid?: string;
  listingKey?: string;
  clauses: EncumbrancesListResponse["clauses"];
  instruments: EncumbrancesListResponse["instruments"];
}> {
  const projection = {
    workspaceDid: response.workspaceDid,
    listingKey: response.listingKey,
    clauses: response.clauses,
    instruments: response.instruments,
  };
  const fetchedAt = new Date().toISOString();
  const atoms: AtomProvenanceEntry[] = response.clauses.map((row) => {
    const clause = row.clause as { clauseDid?: string };
    const did = clause.clauseDid ?? `did:hauska:restriction-clause:${row.id}`;
    return {
      did,
      entityType: "restriction-clause",
      entityId: row.id,
      jurisdictionTenant: "brokerage",
      contentHash: null,
      cidNote: CID_NOTE,
      source: {
        adapter: "legacy-design-tools",
        url: "/api/brokerage/v1/workspaces/encumbrances",
        fetchedAt,
      },
    };
  });
  return buildEnvelope(projection, builtProvenance(atoms), options);
}

// -----------------------------------------------------------------
// Tier 1 Cotality credential-pending envelope (Group D).
// -----------------------------------------------------------------

export function credentialPendingEnvelope(
  response: CredentialPendingResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<CredentialPendingResponse> {
  return buildEnvelope(response, emptyProvenance("credential-pending"), {
    ...options,
    readKind: "empty",
    note: response.message,
  });
}
