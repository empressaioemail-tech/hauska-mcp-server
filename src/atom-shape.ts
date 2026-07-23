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
// @hauska/atom-contract read-contract object alongside provenance.

import type { ReadContract } from "@hauska/atom-contract/read-contract";

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
  atoms: AtomProvenanceEntry[],
  options: BuildEnvelopeOptions,
): ToolEnvelope<T> {
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
  const atoms = response.results.map(provenanceFromSearchResult);
  const scores = response.results.map((r) => r.score).filter((s) => s > 0);
  const avgScore =
    scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : undefined;
  return buildEnvelope(response, atoms, {
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
  return buildEnvelope(response, atoms, options);
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
  return buildEnvelope(data, atoms, { ...options, readKind });
}

export function atomTraceEnvelope(
  trace: import("./hauska-client.js").AtomTraceResponse | null,
  options: BuildEnvelopeOptions,
): ToolEnvelope<import("./hauska-client.js").AtomTraceResponse | null> {
  if (!trace) {
    return buildEnvelope(null, [], {
      ...options,
      readKind: "empty",
      note: "No trace found for atom DID.",
    });
  }
  const atoms: AtomProvenanceEntry[] = [provenanceFromAtom(trace.atom)];
  for (const edge of [...trace.outbound, ...trace.inbound]) {
    if (edge.atom) atoms.push(provenanceFromAtom(edge.atom));
  }
  return buildEnvelope(trace, atoms, {
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
  return buildEnvelope(data, atoms, {
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
  return buildEnvelope(response, [], { ...options, readKind: "empty" });
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
  return buildEnvelope(response, atoms, {
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
  return buildEnvelope(response, atoms, options);
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
  return buildEnvelope(response, atoms, options);
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
  return buildEnvelope(response, atoms, options);
}

/**
 * Coverage-honest confidence as it reaches the parcel-terrain-model surface.
 * Mirrors the @hauska/atom-contract WidthedConfidence shape closely enough
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
  return buildEnvelope(response, atoms, options);
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
  return buildEnvelope(response, atoms, options);
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
  return buildEnvelope(projection, atoms, options);
}

// -----------------------------------------------------------------
// Tier 1 Cotality credential-pending envelope (Group D).
// -----------------------------------------------------------------

export function credentialPendingEnvelope(
  response: CredentialPendingResponse,
  options: BuildEnvelopeOptions,
): ToolEnvelope<CredentialPendingResponse> {
  return buildEnvelope(response, [], {
    ...options,
    readKind: "empty",
    note: response.message,
  });
}
