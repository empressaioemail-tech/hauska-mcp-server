// Hauska Client.
//
// HTTP client against the `hauska-engine` retrieval API (Sync 3 contract).
// Wraps five locked endpoints exposed by `services/retrieval-api/src/server.ts`
// in the engine repo:
//
//   GET /search
//   GET /atoms/:did
//   GET /jurisdictions
//   GET /jurisdictions/:id
//   GET /jurisdictions/:id/permits
//
// Bearer-token auth via `HAUSKA_ENGINE_API_KEY`. Base URL via
// `HAUSKA_BACKEND_URL`. Both default to localhost values for dev so the
// scaffold runs without environment plumbing.
//
// The wire-shape types below mirror the engine's storage port (AtomSearchResult,
// JurisdictionStatusSnapshot) and BaseAtomInstance shape exactly. They are
// duplicated here intentionally; we do not pull `@hauska-engine/*` workspace
// packages into the mcp-server build graph. If the engine contract ever
// drifts, the mismatch surfaces in `tools.ts` consumers as a type error.

import type { AccessPolicy } from "@hauska/atom-contract";

import { logger } from "./logger.js";
import type { ParcelKeyedPropertyEntityType } from "./property-entity-types.js";

const DEFAULT_BACKEND_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 10_000;

function backendUrl(): string {
  return process.env.HAUSKA_BACKEND_URL ?? DEFAULT_BACKEND_URL;
}

function engineApiKey(): string {
  return process.env.HAUSKA_ENGINE_API_KEY ?? "";
}

// -----------------------------------------------------------------
// Wire types - mirrored from `hauska-engine` storage and atom packages.
// -----------------------------------------------------------------

export type CodeAtomEntityType =
  | "code-section"
  | "code-definition"
  | "code-amendment"
  | "code-cross-reference"
  | "code-edition"
  | "jurisdiction-corpus";

/** Property parcel-keyed entity types (derived from engine PROPERTY_ENTITY_TYPES). */
export type PropertyAtomEntityType = ParcelKeyedPropertyEntityType;

export type CatalogAtomEntityType = CodeAtomEntityType | PropertyAtomEntityType;

/** Result row from `GET /search` and `GET /jurisdictions/:id/permits`. */
export interface AtomSearchResult {
  atomDid: string;
  entityType: CodeAtomEntityType;
  entityId: string;
  jurisdictionTenant: string;
  sectionNumber: string | null;
  snippet: string;
  score: number;
  /** ADR-017 access tier when the engine surfaces it on search rows. */
  accessPolicy?: AccessPolicy;
}

export interface SearchResponse {
  results: AtomSearchResult[];
  totalCandidates: number;
}

/**
 * Fields common to every atom instance per the engine's `BaseAtomInstance`.
 * Each entityType extends this with its own payload; we keep the response
 * loosely typed and let the tool layer pass through unknown fields.
 */
export interface AtomInstanceBase {
  entityType: string;
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  [key: string]: unknown;
}

export interface AtomLink {
  fromEntityType: string;
  fromEntityId: string;
  toEntityType: string;
  toEntityId: string;
  linkType: string;
  context?: string;
}

export interface GetAtomResponse {
  atom: AtomInstanceBase | null;
  composition?: Array<{
    link: AtomLink;
    atom: AtomInstanceBase | null;
  }>;
}

/** Entry in engine atom-chain `atoms[]` list. */
export interface PropertyAtomChainWireAtomEntry {
  did?: string;
  type?: string;
  kind?: string;
  accessPolicy?: AccessPolicy;
  payload?: AtomInstanceBase;
}

/** Wire shape for GET /property-nodes/:parcelNodeId/atom-chain (when deployed). */
export interface PropertyAtomChainWireResponse {
  parcelNodeId: string;
  zoningFact?: AtomInstanceBase | null;
  setbackRule?: AtomInstanceBase | null;
  buildableEnvelope?: AtomInstanceBase | null;
  atomsByType?: Partial<Record<PropertyAtomEntityType, AtomInstanceBase | null>>;
  atoms?: ReadonlyArray<PropertyAtomChainWireAtomEntry>;
  attachingRoads?: ReadonlyArray<AtomInstanceBase>;
}

export interface AtomTraceProvenance {
  atomDid: string;
  sourceAdapter: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
}

export interface AtomTraceEdge {
  link: AtomLink;
  atom: AtomInstanceBase | null;
  atomDid: string;
}

export interface AtomTraceResponse {
  atom: AtomInstanceBase;
  atomDid: string;
  contextSummary: Record<string, unknown>;
  provenance: AtomTraceProvenance;
  consequenceStrata: ReadonlyArray<{ kind: string; value: string }>;
  citations: ReadonlyArray<Record<string, unknown>>;
  outbound: ReadonlyArray<AtomTraceEdge>;
  inbound: ReadonlyArray<AtomTraceEdge>;
}

/** Per-jurisdiction snapshot from `GET /jurisdictions` and `:id`. */
export interface JurisdictionStatusSnapshot {
  jurisdictionTenant: string;
  jurisdictionName: string;
  currentEditionDid: string | null;
  qualityBar:
    | "not-evaluated"
    | "failing"
    | "passing"
    | "passing-recalibrated";
  top3Score: number | null;
  sectionNumScore: number | null;
  crossRefScore: number | null;
  atomCount: number;
  lastRefreshedAt: string | null;
  driftStatus: "clean" | "amendments-pending" | "stale";
  /**
   * ADR-017 access tier propagated from the jurisdiction-corpus atom
   * (`@hauska/atom-contract@^1.1.0`). The substrate-MCP filter on
   * `list_jurisdictions` uses this to hide partnership-pending
   * jurisdictions from unauthenticated callers. Absent on the wire =>
   * treat as `"public-free"` (the engine docstring says the same).
   */
  accessPolicy?: AccessPolicy;
}

export interface ListJurisdictionsResponse {
  jurisdictions: JurisdictionStatusSnapshot[];
}

export interface QueryJurisdictionResponse {
  status: JurisdictionStatusSnapshot | null;
  permitAtoms?: AtomSearchResult[];
}

// -----------------------------------------------------------------
// Error type - surfaced to tool handlers so they can choose between
// "engine reachable, atom missing" (404) and "engine unreachable / 5xx"
// (operator-actionable).
// -----------------------------------------------------------------

export class EngineHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(
      `Engine request failed (${status}) for ${url}: ${body.slice(0, 200)}`,
    );
    this.name = "EngineHttpError";
  }
}

export class EngineUnreachableError extends Error {
  constructor(public readonly url: string, cause: unknown) {
    super(`Engine unreachable at ${url}: ${String(cause)}`);
    this.name = "EngineUnreachableError";
    this.cause = cause;
  }
}

// -----------------------------------------------------------------
// Core fetch wrapper.
// -----------------------------------------------------------------

async function engineFetch<T>(
  pathWithQuery: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const url = `${backendUrl()}${pathWithQuery}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "hauska-mcp-server/0.1",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const apiKey = engineApiKey();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (err) {
    throw new EngineUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<no-body>");
    logger.warn("engine_http_error", {
      url,
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new EngineHttpError(res.status, url, body);
  }

  return (await res.json()) as T;
}

function appendIfDefined(
  params: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value === undefined) return;
  params.set(key, String(value));
}

// -----------------------------------------------------------------
// Client.
// -----------------------------------------------------------------

export const hauskaClient = {
  async searchAtoms(params: {
    query: string;
    jurisdiction?: string;
    entityType?: CodeAtomEntityType;
    limit?: number;
  }): Promise<SearchResponse> {
    const qs = new URLSearchParams();
    qs.set("q", params.query);
    appendIfDefined(qs, "jurisdiction", params.jurisdiction);
    appendIfDefined(qs, "entityType", params.entityType);
    appendIfDefined(qs, "limit", params.limit);
    return engineFetch<SearchResponse>(`/search?${qs.toString()}`);
  },

  async getAtom(params: {
    atomDid: string;
    includeComposition?: boolean;
  }): Promise<GetAtomResponse> {
    const qs = new URLSearchParams();
    if (params.includeComposition) qs.set("includeComposition", "true");
    const query = qs.toString();
    const path = `/atoms/${encodeURIComponent(params.atomDid)}${
      query ? `?${query}` : ""
    }`;
    try {
      return await engineFetch<GetAtomResponse>(path);
    } catch (err) {
      if (err instanceof EngineHttpError && err.status === 404) {
        return { atom: null };
      }
      throw err;
    }
  },

  async listJurisdictions(params?: {
    qualityBarOnly?: boolean;
    /**
     * Access-policy allow-list forwarded to the engine as a
     * comma-separated `accessPolicies` query param. The engine applies
     * the visibility partition at the storage layer per ADR-017. When
     * omitted, the engine returns every jurisdiction (no filter). The
     * MCP `list_jurisdictions` tool passes `["public-free"]` for
     * unauthenticated callers.
     */
    accessPolicies?: ReadonlyArray<AccessPolicy>;
  }): Promise<ListJurisdictionsResponse> {
    const qs = new URLSearchParams();
    if (params?.qualityBarOnly) qs.set("qualityBarOnly", "true");
    if (params?.accessPolicies && params.accessPolicies.length > 0) {
      qs.set("accessPolicies", params.accessPolicies.join(","));
    }
    const query = qs.toString();
    const path = `/jurisdictions${query ? `?${query}` : ""}`;
    return engineFetch<ListJurisdictionsResponse>(path);
  },

  async queryJurisdiction(params: {
    jurisdiction: string;
    queryType?: "summary" | "permits";
  }): Promise<QueryJurisdictionResponse> {
    const qs = new URLSearchParams();
    if (params.queryType) qs.set("queryType", params.queryType);
    const query = qs.toString();
    const path = `/jurisdictions/${encodeURIComponent(params.jurisdiction)}${
      query ? `?${query}` : ""
    }`;
    try {
      return await engineFetch<QueryJurisdictionResponse>(path);
    } catch (err) {
      if (err instanceof EngineHttpError && err.status === 404) {
        return { status: null };
      }
      throw err;
    }
  },

  async searchPermitAtoms(params: {
    jurisdiction: string;
    projectType: string;
  }): Promise<QueryJurisdictionResponse> {
    const qs = new URLSearchParams();
    qs.set("projectType", params.projectType);
    const path = `/jurisdictions/${encodeURIComponent(
      params.jurisdiction,
    )}/permits?${qs.toString()}`;
    return engineFetch<QueryJurisdictionResponse>(path);
  },

  /**
   * Property-node reasoning chain (Phase 1c). Returns null on 404 when the
   * retrieval-api route is not yet deployed - callers fall back to per-DID fetch.
   */
  async getPropertyAtomChain(params: {
    parcelNodeId: string;
  }): Promise<PropertyAtomChainWireResponse | null> {
    const path = `/property-nodes/${encodeURIComponent(params.parcelNodeId)}/atom-chain`;
    try {
      return await engineFetch<PropertyAtomChainWireResponse>(path);
    } catch (err) {
      if (err instanceof EngineHttpError && err.status === 404) {
        return null;
      }
      throw err;
    }
  },

  async getAtomTrace(params: {
    atomDid: string;
    audience?: "user" | "ai" | "internal";
  }): Promise<AtomTraceResponse | null> {
    const qs = new URLSearchParams();
    if (params.audience) qs.set("audience", params.audience);
    const query = qs.toString();
    const path = `/atoms/trace/${encodeURIComponent(params.atomDid)}${
      query ? `?${query}` : ""
    }`;
    try {
      return await engineFetch<AtomTraceResponse>(path);
    } catch (err) {
      if (err instanceof EngineHttpError && err.status === 404) {
        return null;
      }
      throw err;
    }
  },
};
