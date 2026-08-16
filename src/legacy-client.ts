// Legacy Client.
//
// HTTP client against the `legacy-design-tools` api-server. Wraps both
// Codex (plan-review) and Cortex (design accelerator) endpoints
// consumed by the codex_* / cortex_* MCP tools per Lane B dispatch.
//
// Codex (Group 1):
//   POST /api/submissions/:submissionId/findings/generate
//   GET  /api/submissions/:submissionId/findings/status
//   GET  /api/submissions/:submissionId/findings
//   POST /api/findings/:findingId/override
//   GET  /api/engagements/:id/briefing
//   POST /api/engagements/:id/submissions
//
// Cortex (Group 2):
//   POST /api/snapshots                        (x-snapshot-secret)
//   POST /api/snapshots/:id/ifc                (x-snapshot-secret, multipart)
//   GET  /api/engagements/:id/bim-model        (cookie session today)
//   POST /api/engagements/:id/briefing/generate (cookie session today)
//
// Two auth paths:
//   - Bearer (`LEGACY_BACKEND_API_KEY`) for the cookie-session routes.
//     The legacy backend must grow a service-token middleware before
//     those tools work end-to-end. Flagged as a Lane C coordination
//     item.
//   - Snapshot secret (`LEGACY_SNAPSHOT_SECRET`) for /api/snapshots and
//     /api/snapshots/:id/ifc — the legacy backend already accepts
//     x-snapshot-secret on those routes (originally for the Revit
//     add-in's service-to-service path).
//
// Wire-shape types below mirror what the legacy backend returns today
// (taken from artifacts/api-server/src/routes/{findings,parcelBriefings,
// engagements,snapshots,bimModels}.ts as of 2026-05-19). They are
// duplicated here on purpose; pulling legacy workspace packages into
// the mcp-server build graph is out of scope for v1 and would couple
// this server to the legacy repo's dependency churn through the Cloud
// Run cutover.

import { logger } from "./logger.js";
import { getCurrentAccessSubject, getCurrentProduct } from "./request-context.js";
import { buildSignedGateContext } from "./gate-context.js";

/** ADR-008 / PR #160 gate-front seam headers forwarded to cortex-api engine routes. */
const GATE_JURISDICTION_TENANT_HEADER = "X-Hauska-Jurisdiction-Tenant";
const GATE_PLATFORM_INTERNAL_HEADER = "X-Hauska-Platform-Internal";

/** Tenancy T1 gate-signed context headers. */
const GATE_CONTEXT_HEADER = "X-Hauska-Gate-Context";
const GATE_SIGNATURE_HEADER = "X-Hauska-Gate-Signature";

function gateSigningKey(): string | undefined {
  return process.env.GATE_CONTEXT_SIGNING_KEY?.trim() || undefined;
}

function gateFrontScopeHeaders(): Record<string, string> {
  const subject = getCurrentAccessSubject();
  const headers: Record<string, string> = {};

  // Plain forwarded headers (backward compat during staged rollout).
  const tenant = subject.jurisdictionTenant?.trim();
  if (tenant) {
    headers[GATE_JURISDICTION_TENANT_HEADER] = tenant;
  }
  if (subject.platformInternal) {
    headers[GATE_PLATFORM_INTERNAL_HEADER] = "true";
  }

  // Signed gate context (T1 producer side). If the signing key is
  // unset, skip stamping — behavior identical to today.
  const key = gateSigningKey();
  if (key) {
    try {
      const { payload, signature } = buildSignedGateContext(
        {
          tenant: subject.jurisdictionTenant,
          product: getCurrentProduct(),
          tier: subject.tier,
          keyId: null,
          platformInternal: subject.platformInternal,
        },
        key,
      );
      headers[GATE_CONTEXT_HEADER] = payload;
      headers[GATE_SIGNATURE_HEADER] = signature;
    } catch (err) {
      logger.warn("gate_context_signing_failed", {
        error: String(err),
      });
    }
  }

  return headers;
}

/** True when `path` targets a cortex-api engine entry behind the #160 gate-front seam. */
function isGateFrontEnginePath(path: string): boolean {
  const pathname = path.split("?")[0] ?? path;
  if (pathname.startsWith("/api/brokerage/v1/brief")) return true;
  if (pathname.startsWith("/api/brokerage/v1/place/")) return true;
  if (pathname.startsWith("/api/brokerage/v1/workspaces/encumbrances")) {
    return true;
  }
  if (/^\/api\/engagements\/[^/]+\/site-drainage/.test(pathname)) return true;
  if (/^\/api\/engagements\/[^/]+\/site-topography/.test(pathname)) return true;
  if (/^\/api\/engagements\/[^/]+\/encumbrances/.test(pathname)) return true;
  if (/^\/api\/submissions\/[^/]+\/findings/.test(pathname)) return true;
  if (/^\/api\/findings\/[^/]+\/override/.test(pathname)) return true;
  return false;
}

const DEFAULT_BACKEND_URL = "http://localhost:5000";
const DEFAULT_TIMEOUT_MS = 30_000;

function backendUrl(): string {
  return process.env.LEGACY_BACKEND_URL ?? DEFAULT_BACKEND_URL;
}

function legacyApiKey(): string {
  return process.env.LEGACY_BACKEND_API_KEY ?? "";
}

function snapshotSecret(): string {
  return process.env.LEGACY_SNAPSHOT_SECRET ?? "";
}

// -----------------------------------------------------------------
// Wire types — mirrored from legacy-design-tools api-server route
// handlers and lib/api-zod generated schemas.
// -----------------------------------------------------------------

export type FindingGenerationState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface GenerateFindingsResponse {
  generationId: string;
  state: FindingGenerationState;
  // Set to true when the kickoff lost a single-flight race; the
  // generationId points at the already-running job. Surfaced separately
  // so tool callers can present it without sniffing HTTP semantics.
  alreadyInFlight?: boolean;
}

export type FindingSeverity = "blocker" | "concern" | "advisory";

export type FindingCategory =
  | "setback"
  | "height"
  | "coverage"
  | "egress"
  | "use"
  | "overlay-conflict"
  | "divergence-related"
  | "other";

export type FindingCitationWire =
  | { kind: "code-section"; atomId: string }
  | { kind: "briefing-source"; id: string; label: string };

export interface FindingWireRow {
  id: string;
  submissionId: string;
  severity: FindingSeverity;
  category: FindingCategory | string;
  status: string;
  text: string;
  citations: FindingCitationWire[];
  [key: string]: unknown;
}

export interface FetchSubmissionFindingsResponse {
  findings: FindingWireRow[];
  /** Partition key for ADR-005 gate scoping when surfaced by cortex-api. */
  jurisdictionTenant?: string;
}

export interface FindingGenerationStatusResponse {
  generationId: string | null;
  state: FindingGenerationState | "idle";
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  /** Partition key for ADR-005 gate scoping when surfaced by cortex-api. */
  jurisdictionTenant?: string;
}

export interface OverrideFindingResponse {
  // The legacy backend returns the full finding wire row under
  // `finding`. We pass it through opaquely so the tool layer surfaces
  // the canonical legacy shape without re-mapping every field.
  finding: Record<string, unknown>;
}

export interface BriefingResponse {
  // Either a briefing wire object or null when no briefing has been
  // uploaded yet for the engagement.
  briefing: Record<string, unknown> | null;
}

export type SubmissionDiscipline =
  | "building"
  | "fire"
  | "zoning"
  | "civil";

// -----------------------------------------------------------------
// Cortex tile capability registry wire type.
// GET /api/plan-review/admin/tile-registry returns a JSON array of
// these objects (one per workspace tile the cortex-api exposes).
// -----------------------------------------------------------------

export interface TileCapability {
  id: string;
  label: string;
  category: string;
  engine?: string;
  status: "live" | "degraded" | "partial" | "planned";
  degradedReason?: string;
  minWidth?: number;
  minColShare?: number;
  requires: {
    engagementId?: boolean;
    apn?: boolean;
    jurisdiction?: boolean;
    uploadedDocuments?: boolean;
    completedFindings?: boolean;
  };
  produces: {
    spatialOverlays?: boolean;
    findings?: boolean;
    annotations?: boolean;
    letter?: boolean;
  };
  modes: Array<"full" | "card" | "inline" | "raw">;
  mcpTools: string[];
}

export interface CreateSubmissionResponse {
  // Legacy backend returns the inserted submission row; pass-through.
  submission: Record<string, unknown>;
}

// -----------------------------------------------------------------
// Brokerage V1 workspace retrieval wire types.
// -----------------------------------------------------------------

export interface WorkspaceEvidenceRef {
  refId: string;
  kind: "atom" | "listing" | "attachment" | "share-edge" | "note";
  atomDid?: string;
  sourceUrl?: string;
  observedAt?: string;
}

export interface PropertyWorkspaceSummary {
  workspaceId: string;
  addressLabel: string;
  listingUrls: string[];
  ownerUserId: string;
  collaboratorUserIds: string[];
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  role: "owner" | "collaborator";
  evidenceRefs?: WorkspaceEvidenceRef[];
}

export interface PropertyWorkspaceBundle extends PropertyWorkspaceSummary {
  briefRuns: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
}

export interface ListPropertyWorkspacesResponse {
  workspaces: PropertyWorkspaceSummary[];
}

export interface GetPropertyWorkspaceResponse {
  workspace: PropertyWorkspaceBundle | null;
}

export interface WorkspaceShareEdge {
  edgeId: string;
  workspaceId: string;
  fromUserId: string;
  toUserId: string;
  sharedAt: string;
  consentVisible: boolean;
  observedAt: string;
  evidenceRefs?: WorkspaceEvidenceRef[];
}

export interface ListWorkspaceShareEdgesResponse {
  edges: WorkspaceShareEdge[];
}

// -----------------------------------------------------------------
// Place API wire types (brokerage v1 / GTM sprint C1).
// -----------------------------------------------------------------

export interface ResolvePlaceResponse {
  placeKey: string;
  jurisdiction_key: string;
  ll_uuid?: string | null;
  workspaceDid?: string | null;
  geocodeConfidence?: number | null;
  errorClass?: string | null;
}

export interface PlaceLayerRef {
  layerKind: string;
  provenance?: Record<string, unknown>;
  atomDid?: string | null;
  asOf?: string | null;
}

export interface GetPlaceLayersResponse {
  placeKey: string;
  jurisdiction_key: string;
  layers: PlaceLayerRef[];
  errorClass?: string | null;
}

export interface GetPlaceDossierResponse {
  placeKey: string;
  jurisdiction_key: string;
  inlineRefs?: Array<Record<string, unknown>>;
  layers?: Array<Record<string, unknown>>;
  federalSummaryRefs?: Array<Record<string, unknown>>;
  asOf?: string | null;
  errorClass?: string | null;
}

// -----------------------------------------------------------------
// Cortex wire types.
// -----------------------------------------------------------------

export interface CreateSnapshotResponse {
  // Legacy POST /snapshots returns the snapshot result row plus optional
  // engagement metadata. We pass through opaquely; consumers parse what
  // they need.
  [key: string]: unknown;
}

export interface IfcIngestResponse {
  // POST /snapshots/:id/ifc returns the ingest job ref + parsed metadata
  // (counts, bounds). Shape is multi-modal depending on whether ingest
  // is synchronous or async; pass-through.
  [key: string]: unknown;
}

export interface BimModelQueryResponse {
  // GET /engagements/:id/bim-model returns { bimModel: ... | null }.
  bimModel: Record<string, unknown> | null;
}

export interface BriefingEmitResponse {
  generationId: string;
  state: FindingGenerationState;
  // Set to true when the kickoff lost a single-flight race; same
  // pattern as generateFindings(). The legacy backend uses identical
  // 409 semantics for briefing-generation as for finding-generation.
  alreadyInFlight?: boolean;
}

// -----------------------------------------------------------------
// L1 response-task wire types (Lane B Group 3).
//
// Hand-mirrored from `hauska-engine/packages/atoms` `ResponseTaskAtomInstance`
// (Sync B(L1), engine atoms package 0.1.0). Mirrored rather than imported:
// `@hauska-engine/atoms` is an engine workspace package, not published to
// npm; pulling it into the mcp-server build graph is out of scope. If the
// engine atom shape drifts, the mismatch surfaces as a type error in the
// L1 tool handlers.
//
// MCP-FIRST CONTRACT. The L1 endpoints below do not exist in
// legacy-design-tools yet. This client defines the contract; cc-agent-C
// builds the matching legacy routes in Lane C.4. Until then the L1 tools
// are mocked-fetch testable only — e2e is blocked on Lane C.4 (the same
// shape as Groups 1+2 being e2e-blocked on the Lane C bearer middleware).
// -----------------------------------------------------------------

export type ResponseTaskState =
  | "open"
  | "in-progress"
  | "done"
  | "cancelled";

/**
 * Full `response-task` atom instance returned by the L1 endpoints.
 * Conforms to the engine's `ResponseTaskAtomInstance` /
 * `RESPONSE_TASK_SCHEMA`.
 */
export interface ResponseTaskAtom {
  entityType: "response-task";
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  title: string;
  description: string;
  state: ResponseTaskState;
  createdAt: string;
  dueAt: string | null;
  completedAt: string | null;
  sourceClientCommentId: string | null;
  findingId: string | null;
  engagementId: string | null;
  actorId: string | null;
  principalActorId: string | null;
  accessPolicy?: string;
}

export interface ResponseTaskResponse {
  responseTask: ResponseTaskAtom;
}

export interface ListResponseTasksResponse {
  responseTasks: ResponseTaskAtom[];
}

// -----------------------------------------------------------------
// L2 sheet-content-extraction + attached-document wire types (Group 3).
//
// Hand-mirrored from `hauska-engine/packages/atoms` (Sync B(L2), engine
// atoms package 0.2.0). Two atoms in one phase: they are coupled at the
// producer — the sheet-ingest pass emits both. MCP-first contract: the
// L2 endpoints below do not exist in legacy-design-tools yet; this
// client defines them and cc-agent-C builds the matching routes in
// Lane C.4.
// -----------------------------------------------------------------

/** Page-relative bounding box; coordinates normalized to [0, 1]. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SheetAnnotationKind =
  | "revision-cloud"
  | "dimension"
  | "schedule-row"
  | "callout";

export interface SheetTextSegment {
  text: string;
  boundingBox: BoundingBox;
  sourceConfidence: number;
}

export interface SheetStructuredAnnotation {
  kind: SheetAnnotationKind;
  position: BoundingBox;
  content: string;
  sourceConfidence: number;
}

/** Full `sheet-content-extraction` atom instance (L2a). */
export interface SheetContentExtractionAtom {
  entityType: "sheet-content-extraction";
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  sourceSheetId: string;
  engagementId: string | null;
  pageLabel: string;
  extractedTextSegments: SheetTextSegment[];
  structuredAnnotations: SheetStructuredAnnotation[];
  ocrModel: string;
  actorId: string | null;
  accessPolicy?: string;
}

export type AttachedDocumentType =
  | "specification"
  | "calculation"
  | "product-data"
  | "narrative";

/** Full `attached-document` atom instance (L2b). */
export interface AttachedDocumentAtom {
  entityType: "attached-document";
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  engagementId: string;
  title: string;
  documentType: AttachedDocumentType;
  extractedText: string;
  originalBlobRef: string;
  actorId: string | null;
  accessPolicy?: string;
}

export interface SheetContentExtractionResponse {
  // Null when the sheet has not been extracted yet (fetch before trigger).
  sheetContentExtraction: SheetContentExtractionAtom | null;
}

export interface AttachedDocumentResponse {
  attachedDocument: AttachedDocumentAtom;
}

export interface ListAttachedDocumentsResponse {
  attachedDocuments: AttachedDocumentAtom[];
}

// -----------------------------------------------------------------
// L3 deliverable-letter wire types (Lane B Group 3).
//
// Hand-mirrored from `hauska-engine/packages/atoms` (Sync B(L3), engine
// atoms package 0.3.0). MCP-first contract: the L3 endpoints do not
// exist in legacy-design-tools yet; this client defines them and
// cc-agent-C builds the matching routes in Lane C.4.
// -----------------------------------------------------------------

export type LetterSectionKind =
  | "cover"
  | "intro"
  | "per-comment-response"
  | "signature";

/** Sections a letter must carry to be complete / sendable. */
export const REQUIRED_LETTER_SECTION_KINDS: ReadonlyArray<LetterSectionKind> = [
  "cover",
  "intro",
  "signature",
];

/** Per-section provenance — the atoms that fed a section's content. */
export interface LetterSectionProvenance {
  responseTaskIds: string[];
  sheetContentExtractionIds: string[];
  findingIds: string[];
  adjudicationStateIds: string[];
}

/** One structured section of a deliverable letter. */
export interface LetterSection {
  kind: LetterSectionKind;
  heading: string;
  content: string;
  provenance: LetterSectionProvenance;
}

export type DeliverableLetterStatus = "draft" | "sent";

/** Full `deliverable-letter` atom instance returned by the L3 endpoints. */
export interface DeliverableLetterAtom {
  entityType: "deliverable-letter";
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  engagementId: string;
  title: string;
  status: DeliverableLetterStatus;
  recipientActorId: string | null;
  sections: LetterSection[];
  createdAt: string;
  sentAt: string | null;
  actorId: string | null;
  principalActorId: string | null;
  accessPolicy?: string;
}

export interface DeliverableLetterResponse {
  deliverableLetter: DeliverableLetterAtom;
}

export interface ListDeliverableLettersResponse {
  deliverableLetters: DeliverableLetterAtom[];
}

/**
 * Result of the section-completeness check. `missing` lists the
 * required section kinds (cover / intro / signature) absent from the
 * letter. The legacy backend runs the engine's
 * `deliverableLetterCompleteness()` helper.
 */
export interface DeliverableLetterCompletenessResponse {
  complete: boolean;
  missing: LetterSectionKind[];
}

// -----------------------------------------------------------------
// L4 detail-callout-spec wire types (Lane B Group 3).
//
// Hand-mirrored from `hauska-engine/packages/atoms` (Sync B(L4), engine
// atoms package 0.4.0). MCP-first contract: the L4 endpoints do not
// exist in legacy-design-tools yet; this client defines them and
// cc-agent-C builds the matching routes in Lane C.4.
//
// `spec` is a discriminated union keyed on `detailType`. The MCP tool
// surface keeps `detail_type` as an explicit enum param and forwards
// the type-specific fields as an opaque `spec` object; the legacy
// backend validates the assembled payload against the engine's
// `DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA` discriminated union. This avoids
// nested-`oneOf` JSON-Schema friction in MCP clients (the same opaque-
// payload pattern as `cortex_snapshot_register`).
// -----------------------------------------------------------------

export type DetailCalloutType =
  | "door-schedule"
  | "wall-section"
  | "wall-type"
  | "room-finish";

export type DetailCalloutPushState =
  | "pending"
  | "pushed"
  | "applied"
  | "rejected-by-user";

/** Full `detail-callout-spec` atom instance returned by the L4 endpoints. */
export interface DetailCalloutSpecAtom {
  entityType: "detail-callout-spec";
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  engagementId: string;
  /** Discriminated spec payload — carries `detailType` plus type-specific fields. */
  spec: Record<string, unknown>;
  pushState: DetailCalloutPushState;
  apsTaskRef: string | null;
  findingId: string | null;
  responseTaskId: string | null;
  createdAt: string;
  pushedAt: string | null;
  actorId: string | null;
  principalActorId: string | null;
  accessPolicy?: string;
}

export interface DetailCalloutSpecResponse {
  detailCalloutSpec: DetailCalloutSpecAtom;
}

export interface ListDetailCalloutSpecsResponse {
  detailCalloutSpecs: DetailCalloutSpecAtom[];
}

// -----------------------------------------------------------------
// L5 product-spec-reference wire types (Lane B Group 3).
//
// Hand-mirrored from `hauska-engine/packages/atoms` (Sync B(L5), engine
// atoms package 0.5.0). MCP-first contract: the L5 endpoints do not
// exist in legacy-design-tools yet; this client defines them and
// cc-agent-C builds the matching routes in Lane C.4.
// -----------------------------------------------------------------

export type ProductSpecStatus = "active" | "withdrawn" | "expired";

/** ICC-ES ESR number format guard (`ESR-<digits>`). */
export const ESR_NUMBER_RE = /^ESR-\d+$/;

/** Structured product identity — never free-text. */
export interface ProductIdentifier {
  name: string;
  manufacturer: string;
}

/** One entry in the append-only ESR-status-change chain. */
export interface ProductSpecStatusChange {
  status: ProductSpecStatus;
  changedAt: string;
  sourceUrl: string;
}

/** Full `product-spec-reference` atom instance returned by the L5 endpoints. */
export interface ProductSpecReferenceAtom {
  entityType: "product-spec-reference";
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  product: ProductIdentifier;
  esrNumber: string;
  status: ProductSpecStatus;
  lastVerifiedAt: string;
  statusHistory: ProductSpecStatusChange[];
  engagementId: string | null;
  findingId: string | null;
  responseTaskId: string | null;
  createdAt: string;
  actorId: string | null;
  principalActorId: string | null;
  accessPolicy?: string;
}

export interface ProductSpecReferenceResponse {
  productSpecReference: ProductSpecReferenceAtom;
}

export interface ListProductSpecReferencesResponse {
  productSpecReferences: ProductSpecReferenceAtom[];
}

// -----------------------------------------------------------------
// L6 deliverable-letter-render wire types (Lane B Group 3).
//
// Hand-mirrored from `hauska-engine/packages/atoms` (Sync B(L6), engine
// atoms package 0.6.0). The rendered DOCX/PDF artifact of an L3
// deliverable-letter, as a first-class atom. MCP-first contract: the
// L6 endpoints do not exist in legacy-design-tools yet; this client
// defines them and cc-agent-C builds the matching routes in Lane C.4.
// -----------------------------------------------------------------

/** Render output format. Lowercase, matching the engine atom enum. */
export type RenderFormat = "docx" | "pdf";

/** Full `deliverable-letter-render` atom instance returned by the L6 endpoints. */
export interface DeliverableLetterRenderAtom {
  entityType: "deliverable-letter-render";
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  /** did:hauska:deliverable-letter:<localId> ref to the L3 source letter. */
  sourceLetterRef: string;
  /** Source letter's contentHash at render time — pins the rendered version. */
  sourceLetterVersion: string;
  format: RenderFormat;
  /** Opaque pointer to the stored render bytes. */
  blobRef: string;
  renderedAt: string;
  renderedByActorId: string | null;
  accessPolicy?: string;
}

export interface DeliverableLetterRenderResponse {
  render: DeliverableLetterRenderAtom;
  /**
   * Optional directly-usable download URL (e.g. a signed URL) the
   * backend may resolve from `render.blobRef`. The atom carries the
   * opaque `blobRef`; this is a convenience the backend can include.
   */
  downloadUrl?: string;
}

export interface ListDeliverableLetterRendersResponse {
  renders: DeliverableLetterRenderAtom[];
}

/**
 * The downloaded bytes of a deliverable-letter render. The L6 byte-serve
 * endpoint (`GET /api/deliverable-letter-renders/:renderId/file`) returns
 * the file itself, not a JSON envelope — `bytes` carries the raw content,
 * `contentType` and `filename` come from the response headers
 * (`Content-Type` / `Content-Disposition`). Added in Lane C.4, ratified
 * Sprint Amendment 8.
 */
export interface DeliverableLetterDownload {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

// -----------------------------------------------------------------
// Error types — matched to hauska-client.ts conventions so tool
// handlers can use a uniform error shape across both backends.
// -----------------------------------------------------------------

export class LegacyHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(
      `Legacy backend request failed (${status}) for ${url}: ${body.slice(0, 200)}`,
    );
    this.name = "LegacyHttpError";
  }
}

export class LegacyUnreachableError extends Error {
  constructor(public readonly url: string, cause: unknown) {
    super(`Legacy backend unreachable at ${url}: ${String(cause)}`);
    this.name = "LegacyUnreachableError";
    this.cause = cause;
  }
}

// -----------------------------------------------------------------
// Core fetch wrapper.
// -----------------------------------------------------------------

interface LegacyFetchInit extends Omit<RequestInit, "body"> {
  timeoutMs?: number;
  jsonBody?: unknown;
}

async function legacyFetch<T>(
  path: string,
  init?: LegacyFetchInit,
): Promise<{ status: number; body: T }> {
  const url = `${backendUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "hauska-mcp-server/0.1",
    ...(isGateFrontEnginePath(path) ? gateFrontScopeHeaders() : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const apiKey = legacyApiKey();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let body: string | undefined;
  if (init?.jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.jsonBody);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new LegacyUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<no-body>");
    logger.warn("legacy_http_error", {
      url,
      status: res.status,
      body: text.slice(0, 500),
    });
    throw new LegacyHttpError(res.status, url, text);
  }

  const parsed = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body: parsed };
}

// Snapshot-secret fetch wrapper. Used for /api/snapshots and
// /api/snapshots/:id/ifc routes which the legacy backend gates on the
// x-snapshot-secret header instead of cookie session / bearer.
async function snapshotFetch<T>(
  path: string,
  init: {
    method: "POST";
    jsonBody?: unknown;
    multipart?: FormData;
    timeoutMs?: number;
  },
): Promise<{ status: number; body: T }> {
  const url = `${backendUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "hauska-mcp-server/0.1",
  };
  const secret = snapshotSecret();
  if (secret) headers["x-snapshot-secret"] = secret;

  let body: BodyInit | undefined;
  if (init.multipart) {
    // Let fetch set the multipart content-type with the boundary param;
    // do NOT manually set content-type for FormData bodies or fetch
    // strips the boundary and the legacy backend's busboy parse fails.
    body = init.multipart;
  } else if (init.jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.jsonBody);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new LegacyUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<no-body>");
    logger.warn("legacy_http_error", {
      url,
      status: res.status,
      body: text.slice(0, 500),
    });
    throw new LegacyHttpError(res.status, url, text);
  }

  const parsed = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body: parsed };
}

// Binary fetch wrapper. Used for the L6 byte-serve endpoint, which
// returns the rendered DOCX/PDF file directly instead of a JSON
// envelope. Reads the response as bytes and lifts `Content-Type` /
// `Content-Disposition` off the headers. Bearer-auth, same as
// legacyFetch(). Error handling mirrors legacyFetch() so tool handlers
// see one error surface across JSON and binary routes.
async function legacyFetchBinary(
  path: string,
  init?: { timeoutMs?: number },
): Promise<{
  status: number;
  bytes: Uint8Array;
  contentType: string;
  contentDisposition: string;
}> {
  const url = `${backendUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "*/*",
    "user-agent": "hauska-mcp-server/0.1",
  };
  const apiKey = legacyApiKey();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    throw new LegacyUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<no-body>");
    logger.warn("legacy_http_error", {
      url,
      status: res.status,
      body: text.slice(0, 500),
    });
    throw new LegacyHttpError(res.status, url, text);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    status: res.status,
    bytes: new Uint8Array(arrayBuffer),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    contentDisposition: res.headers.get("content-disposition") ?? "",
  };
}

// Pull the filename out of a `Content-Disposition` header. Handles both
// the plain `filename="..."` form and the RFC 5987 `filename*=UTF-8''...`
// form. Returns null when the header carries no filename.
function filenameFromContentDisposition(value: string): string | null {
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(value);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return star[1].trim().replace(/^"|"$/g, "");
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1] ? plain[1].trim() : null;
}

// Fallback render filename when the backend sends no Content-Disposition.
function defaultRenderFilename(renderId: string, contentType: string): string {
  const ext = contentType.includes("pdf")
    ? "pdf"
    : contentType.includes("wordprocessingml")
      ? "docx"
      : "bin";
  return `${renderId}.${ext}`;
}

// -----------------------------------------------------------------
// Tier 1 MCP wire types (Groups A–D, cc-agent-M build-out 2026-06-06).
//
// Hand-mirrored from cortex-api route handlers:
//   brokerageBrief.ts — POST /api/brokerage/v1/brief, GET .../brief/:runId
//   siteDrainage.ts   — POST/GET /api/engagements/:id/site-drainage(+)
//   siteTopography.ts — POST/GET /api/engagements/:id/site-topography(+)
//   brokerageEncumbrances.ts — GET /api/brokerage/v1/workspaces/encumbrances
//   Cotality adapter pack — MCP-first contract; cc-agent-C exposes routes.
// -----------------------------------------------------------------

export interface BriefInlineRefWire {
  did: string;
  entityType: string;
  entityId: string;
  label: string;
  mode: string;
}

export interface BriefAtomProjectionWire {
  workspaceDid: string;
  briefRunDid: string;
  placeLayers: Array<Record<string, unknown>>;
  citationRefs: Array<Record<string, unknown>>;
  inlineRefs: BriefInlineRefWire[];
}

export interface GenerateBriefResponse {
  runId: string;
  startedAt: string;
  finishedAt: string;
  presentationMode?: string;
  property: Record<string, unknown>;
  jurisdiction: string | null;
  corpusStatus: string;
  geocode?: { lat: number; lon: number };
  siteContext?: Record<string, unknown>;
  sections?: Array<Record<string, unknown>>;
  citations?: Array<Record<string, unknown>>;
  atoms?: BriefAtomProjectionWire;
  reasoningSummary?: string;
  laySummary?: string;
  privateRestrictions?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
  workspaceId?: string;
  workspaceDid?: string;
}

export interface GetBriefRunResponse extends GenerateBriefResponse {}

export interface SiteDrainageRefreshResponse {
  status: string;
  atomEventId?: string;
  eventType?: string;
  materializableElementId?: string;
  flowLineCount?: number;
  drainageZoneCount?: number;
  rainfallDepthInches?: number;
  forcingSource?: string;
  reusedExisting?: boolean;
  reason?: string;
  code?: string;
}

export interface SiteDrainageReadResponse {
  status: string;
  materializableElementId?: string;
  createdAt?: string;
  updatedAt?: string;
  propertySet?: Record<string, unknown>;
  reason?: string;
}

export interface SiteDrainageDesignStormsResponse {
  status: string;
  estimate?: Record<string, unknown>;
  reason?: string;
}

export interface SiteTopographyRefreshResponse {
  status: string;
  atomEventId?: string;
  eventType?: string;
  materializableElementId?: string;
  demGcsObjectPath?: string;
  contourCount?: number;
  contourIntervalMeters?: number;
  demResolutionMeters?: number;
  parcelOrigin?: Record<string, unknown>;
  parcelBbox?: Record<string, unknown>;
  catchmentBbox?: Record<string, unknown>;
  reusedExisting?: boolean;
  reason?: string;
  code?: string;
}

export interface SiteTopographyReadResponse {
  status: string;
  materializableElementId?: string;
  createdAt?: string;
  updatedAt?: string;
  propertySet?: Record<string, unknown>;
  reason?: string;
}

/**
 * Mesh metadata block carried on the site-topography read row's
 * propertySet (emitted by siteTopographyIngest on the ldt side).
 */
export interface ParcelTerrainMeshMeta {
  vertexCount?: number;
  triangleCount?: number;
  georefOrigin?: Record<string, unknown>;
  byteCount?: number;
  format?: string;
  [key: string]: unknown;
}

/**
 * IFC metadata block carried on the site-topography read row's
 * propertySet (emitted by siteTopographyIngest on the ldt side).
 */
export interface ParcelTerrainIfcMeta {
  ifcSchemaVersion?: string;
  byteCount?: number;
  [key: string]: unknown;
}

/**
 * Projected parcel-terrain-model view over the site-topography read row.
 * meshRef / ifcRef are GLB / IFC object-store paths; absent when the
 * topography has not been generated for the engagement yet.
 */
export interface ParcelTerrainModelResponse {
  status: string;
  materializableElementId?: string;
  createdAt?: string;
  updatedAt?: string;
  meshRef?: string;
  mesh?: ParcelTerrainMeshMeta;
  ifcRef?: string;
  ifc?: ParcelTerrainIfcMeta;
  // Coverage-honesty signals carried alongside mesh/ifc on the propertySet.
  confidence?: unknown;
  coverage?: unknown;
  contours?: unknown;
  demResolutionMeters?: unknown;
  sourceCitation?: unknown;
  reason?: string;
  raw?: Record<string, unknown>;
}

export interface EncumbranceInstrumentWire {
  id: string;
  instrument: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EncumbranceClauseWire {
  id: string;
  instrumentId: string;
  clause: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EncumbrancesListResponse {
  workspaceDid?: string;
  listingKey?: string;
  instruments: EncumbranceInstrumentWire[];
  clauses: EncumbranceClauseWire[];
}

export interface CredentialPendingResponse {
  status: "credential-pending";
  adapter: string;
  message: string;
}

export type CotalityAdapterKey =
  | "cotality:property"
  | "cotality:replacementCost"
  | "cotality:hazards"
  | "cotality:parcels";

const COTALITY_ADAPTER_ROUTES: Record<CotalityAdapterKey, string> = {
  "cotality:property": "/api/brokerage/v1/cotality/property-detail",
  "cotality:replacementCost": "/api/brokerage/v1/cotality/replacement-cost",
  "cotality:hazards": "/api/brokerage/v1/cotality/hazard-profile",
  "cotality:parcels": "/api/brokerage/v1/cotality/parcel-polygon",
};

export function cotalityCredentialsConfigured(): boolean {
  const id = process.env.COTALITY_CLIENT_ID?.trim();
  const secret = process.env.COTALITY_CLIENT_SECRET?.trim();
  return Boolean(id && secret);
}

function mcpServiceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.LEGACY_MCP_SERVICE_TOKEN?.trim();
  if (token) headers["x-hauska-mcp-service"] = token;
  return headers;
}

async function brokerageFetch<T>(
  path: string,
  init?: LegacyFetchInit,
): Promise<{ status: number; body: T }> {
  return legacyFetch<T>(path, {
    ...init,
    headers: {
      ...mcpServiceHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

// -----------------------------------------------------------------
// Client.
// -----------------------------------------------------------------

export const legacyClient = {
  /**
   * POST /api/submissions/:submissionId/findings/generate
   *
   * Kicks off finding generation against an existing submission. 202
   * means the job is queued; 409 means a job is already in flight and
   * the returned generationId points at it. We normalize the 409 case
   * into the success response so callers reason about "always returns
   * the canonical generationId" instead of HTTP semantics.
   */
  async generateFindings(params: {
    submissionId: string;
  }): Promise<GenerateFindingsResponse> {
    try {
      const { body } = await legacyFetch<GenerateFindingsResponse>(
        `/api/submissions/${encodeURIComponent(params.submissionId)}/findings/generate`,
        { method: "POST", jsonBody: {} },
      );
      return body;
    } catch (err) {
      if (err instanceof LegacyHttpError && err.status === 409) {
        // 409 body shape: { error: "finding_generation_already_in_flight", generationId }
        try {
          const parsed = JSON.parse(err.body) as {
            generationId?: string;
          };
          if (parsed.generationId) {
            return {
              generationId: parsed.generationId,
              state: "running",
              alreadyInFlight: true,
            };
          }
        } catch {
          // Fall through to rethrow.
        }
      }
      throw err;
    }
  },

  /**
   * POST /api/findings/:findingId/override
   *
   * Writes a reviewer-authored revision finding. Body shape per
   * OverrideFindingBody (text, severity, category, reviewerComment).
   * Carry-over flag from PR #20 close-out: the 409
   * `finding_already_overridden` envelope does not surface
   * `resolvedBy` / `resolvedAt` so cross-tab race attribution is
   * partial. Tool callers should not rely on those fields.
   */
  async overrideFinding(params: {
    findingId: string;
    text: string;
    severity: FindingSeverity;
    category: FindingCategory;
    reviewerComment?: string;
    citations?: FindingCitationWire[];
  }): Promise<OverrideFindingResponse> {
    const jsonBody: Record<string, unknown> = {
      text: params.text,
      severity: params.severity,
      category: params.category,
      reviewerComment: params.reviewerComment ?? "",
    };
    if (params.citations !== undefined) {
      jsonBody.citations = params.citations;
    }
    const { body } = await legacyFetch<OverrideFindingResponse>(
      `/api/findings/${encodeURIComponent(params.findingId)}/override`,
      {
        method: "POST",
        jsonBody,
      },
    );
    return body;
  },

  /**
   * GET /api/submissions/:submissionId/findings/status
   *
   * Reads the most recent finding-generation run for the submission.
   * Calibration fields (`invalidCitationCount`, `invalidCitations`,
   * `discardedFindingCount`) are consumed internally by the gate but
   * stripped from tool output (rail-quiet I7).
   */
  async getFindingGenerationStatus(params: {
    submissionId: string;
  }): Promise<FindingGenerationStatusResponse & {
    invalidCitationCount?: number | null;
    invalidCitations?: string[] | null;
    discardedFindingCount?: number | null;
  }> {
    const { body } = await legacyFetch<
      FindingGenerationStatusResponse & {
        invalidCitationCount?: number | null;
        invalidCitations?: string[] | null;
        discardedFindingCount?: number | null;
      }
    >(
      `/api/submissions/${encodeURIComponent(params.submissionId)}/findings/status`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/submissions/:submissionId/findings
   *
   * Lists findings for a submission (newest first at the wire layer).
   * Citations carry canonical atom ids as stored post-P0b (#158).
   */
  async fetchSubmissionFindings(params: {
    submissionId: string;
  }): Promise<FetchSubmissionFindingsResponse> {
    const { body } = await legacyFetch<FetchSubmissionFindingsResponse>(
      `/api/submissions/${encodeURIComponent(params.submissionId)}/findings`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/engagements/:id/briefing
   *
   * Returns the engagement's parcel briefing as a wire object, or
   * { briefing: null } when no briefing has been uploaded yet. 404
   * (engagement not found) is intentionally NOT normalized — that
   * means the caller passed an unknown engagement id, which is an
   * input error rather than an empty result.
   */
  async fetchBriefing(params: {
    engagementId: string;
  }): Promise<BriefingResponse> {
    const { body } = await legacyFetch<BriefingResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/briefing`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/plan-review/admin/tile-registry
   *
   * Fetches the cortex-api tile capability registry (the set of
   * workspace tiles cortex-api can render, with their requirements,
   * produced artifacts, render modes, and backing MCP tools). Uses the
   * existing Bearer service-token path (LEGACY_BACKEND_URL +
   * LEGACY_BACKEND_API_KEY via legacyFetch). Returns the JSON array
   * verbatim. Must only be called inside a tool handler, never at
   * module load / server startup.
   */
  async getTileRegistry(): Promise<TileCapability[]> {
    const { body } = await legacyFetch<TileCapability[]>(
      "/api/plan-review/admin/tile-registry",
      { method: "GET" },
    );
    return body;
  },

  /**
   * POST /api/engagements/:id/submissions
   *
   * Records that a plan-review package has been submitted. The legacy
   * route auto-triggers classification + finding generation downstream
   * via lib/autoTriggerClassificationOnSubmissionCreated and
   * autoTriggerFindingsOnSubmissionCreated; the MCP tool surfaces the
   * inserted submission row so the agent can chain into
   * codex_finding_generation if it wants to poll status explicitly.
   */
  async createSubmission(params: {
    engagementId: string;
    note?: string;
    discipline?: SubmissionDiscipline;
  }): Promise<CreateSubmissionResponse> {
    const jsonBody: Record<string, unknown> = {};
    if (params.note !== undefined) jsonBody.note = params.note;
    if (params.discipline !== undefined) jsonBody.discipline = params.discipline;
    const { body } = await legacyFetch<CreateSubmissionResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/submissions`,
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * GET /api/brokerage/v1/workspaces
   *
   * Lists owner/collaborator-visible property workspaces for the caller.
   * The backend enforces access by caller identity and returns newest-first.
   */
  async listPropertyWorkspaces(params: {
    requesterKeyId: string;
    limit?: number;
  }): Promise<ListPropertyWorkspacesResponse> {
    const qs = new URLSearchParams();
    qs.set("requesterKeyId", params.requesterKeyId);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const query = qs.toString();
    const { body } = await legacyFetch<ListPropertyWorkspacesResponse>(
      `/api/brokerage/v1/workspaces${query ? `?${query}` : ""}`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/brokerage/v1/workspaces/:workspaceId
   *
   * Fetches a full workspace package if the caller is owner/collaborator.
   * Returns { workspace: null } when the id is not visible to the caller.
   */
  async getPropertyWorkspace(params: {
    workspaceId: string;
    requesterKeyId: string;
  }): Promise<GetPropertyWorkspaceResponse> {
    const qs = new URLSearchParams();
    qs.set("requesterKeyId", params.requesterKeyId);
    const { body } = await legacyFetch<GetPropertyWorkspaceResponse>(
      `/api/brokerage/v1/workspaces/${encodeURIComponent(params.workspaceId)}?${qs.toString()}`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/brokerage/v1/workspaces/:workspaceId/share-edges
   *
   * Lists consent-filtered share edges for one workspace, visible to
   * owner/collaborator callers.
   */
  async listWorkspaceShareEdges(params: {
    workspaceId: string;
    requesterKeyId: string;
    consentVisibleOnly?: boolean;
  }): Promise<ListWorkspaceShareEdgesResponse> {
    const qs = new URLSearchParams();
    qs.set("requesterKeyId", params.requesterKeyId);
    if (params.consentVisibleOnly !== undefined) {
      qs.set("consentVisibleOnly", params.consentVisibleOnly ? "true" : "false");
    }
    const { body } = await legacyFetch<ListWorkspaceShareEdgesResponse>(
      `/api/brokerage/v1/workspaces/${encodeURIComponent(params.workspaceId)}/share-edges?${qs.toString()}`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * POST /api/brokerage/v1/place/resolve
   */
  async resolvePlace(params: {
    requesterKeyId: string;
    address?: string;
    lat?: number;
    lng?: number;
  }): Promise<ResolvePlaceResponse> {
    const jsonBody: Record<string, unknown> = {
      requesterKeyId: params.requesterKeyId,
    };
    if (params.address !== undefined) jsonBody.address = params.address;
    if (params.lat !== undefined) jsonBody.lat = params.lat;
    if (params.lng !== undefined) jsonBody.lng = params.lng;
    const { body } = await legacyFetch<ResolvePlaceResponse>(
      "/api/brokerage/v1/place/resolve",
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * GET /api/brokerage/v1/place/:placeKey/layers
   */
  async getPlaceLayers(params: {
    placeKey: string;
    requesterKeyId: string;
  }): Promise<GetPlaceLayersResponse> {
    const qs = new URLSearchParams();
    qs.set("requesterKeyId", params.requesterKeyId);
    const { body } = await legacyFetch<GetPlaceLayersResponse>(
      `/api/brokerage/v1/place/${encodeURIComponent(params.placeKey)}/layers?${qs.toString()}`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/brokerage/v1/place/:placeKey/dossier
   */
  async getPlaceDossier(params: {
    placeKey: string;
    requesterKeyId: string;
  }): Promise<GetPlaceDossierResponse> {
    const qs = new URLSearchParams();
    qs.set("requesterKeyId", params.requesterKeyId);
    const { body } = await legacyFetch<GetPlaceDossierResponse>(
      `/api/brokerage/v1/place/${encodeURIComponent(params.placeKey)}/dossier?${qs.toString()}`,
      { method: "GET" },
    );
    return body;
  },

  // -----------------------------------------------------------------
  // Cortex methods (Group 2).
  // -----------------------------------------------------------------

  /**
   * POST /api/snapshots
   *
   * Registers a snapshot (a versioned design state) against either an
   * existing engagement (when engagementId is supplied) or by creating
   * a new engagement (when projectName is supplied instead). The legacy
   * route discriminates on the body shape. Uses the x-snapshot-secret
   * service auth path, not the bearer-token path.
   */
  async registerSnapshot(
    params:
      | { engagementId: string; payload: Record<string, unknown> }
      | {
          projectName: string;
          revitCentralGuid?: string;
          revitDocumentPath?: string;
          payload: Record<string, unknown>;
        },
  ): Promise<CreateSnapshotResponse> {
    const body: Record<string, unknown> = { ...params.payload };
    if ("engagementId" in params) {
      body.engagementId = params.engagementId;
    } else {
      body.projectName = params.projectName;
      if (params.revitCentralGuid !== undefined) {
        body.revitCentralGuid = params.revitCentralGuid;
      }
      if (params.revitDocumentPath !== undefined) {
        body.revitDocumentPath = params.revitDocumentPath;
      }
    }
    const { body: response } = await snapshotFetch<CreateSnapshotResponse>(
      "/api/snapshots",
      { method: "POST", jsonBody: body },
    );
    return response;
  },

  /**
   * POST /api/snapshots/:id/ifc
   *
   * Uploads an IFC file against an existing snapshot. The legacy route
   * expects multipart/form-data with the IFC blob in a file field. The
   * MCP tool surface accepts the IFC bytes as a buffer (decoded from
   * base64 at the tool layer) plus a filename. Triggers
   * lib/ifcIngest.ts on the legacy side, which emits a bim-model atom
   * symmetric with Push-to-Revit. Known carry-over bug per the sprint
   * decision record: IFC import has unresolved failure modes; surface
   * raw legacy responses so callers see whatever the backend returns.
   */
  async ingestIfc(params: {
    snapshotId: string;
    filename: string;
    bytes: Uint8Array;
    contentType?: string;
  }): Promise<IfcIngestResponse> {
    const form = new FormData();
    // Copy into a fresh ArrayBuffer-backed view to satisfy the DOM lib's
    // BlobPart type (which rejects Uint8Array<ArrayBufferLike>). Node's
    // Buffer extends Uint8Array<ArrayBufferLike> and the same generic
    // mismatch applies; copying once is cheap relative to the network
    // upload that follows.
    const buffer = new ArrayBuffer(params.bytes.byteLength);
    new Uint8Array(buffer).set(params.bytes);
    const blob = new Blob([buffer], {
      type: params.contentType ?? "application/octet-stream",
    });
    // Field name "file" matches busboy field detection conventions used
    // by lib/ifcIngest.ts; the legacy handler reads the first file
    // stream encountered, so the exact field name is not load-bearing
    // but keeping it canonical aids debugging.
    form.append("file", blob, params.filename);
    const { body } = await snapshotFetch<IfcIngestResponse>(
      `/api/snapshots/${encodeURIComponent(params.snapshotId)}/ifc`,
      { method: "POST", multipart: form, timeoutMs: 120_000 },
    );
    return body;
  },

  /**
   * GET /api/engagements/:id/bim-model
   *
   * Returns the bim-model atom for an engagement or { bimModel: null }
   * when no model has been pushed yet. The legacy backend may
   * synthesize a wire shape from a parsed IFC ingest when the bim_models
   * row is absent but an IFC has been processed. Uses the bearer-token
   * path; depends on the Lane C service-token middleware.
   */
  async queryBimModel(params: {
    engagementId: string;
  }): Promise<BimModelQueryResponse> {
    const { body } = await legacyFetch<BimModelQueryResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/bim-model`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * POST /api/engagements/:id/briefing/generate
   *
   * Kicks off parcel-briefing generation for an engagement. Same 202 /
   * 409-already-in-flight pattern as finding generation; the 409
   * envelope carries the existing generationId, which we normalize
   * into alreadyInFlight=true. Returns 400 when the engagement has no
   * briefing sources yet; that surfaces as LegacyHttpError(400).
   * Uses the bearer-token path; depends on the Lane C service-token
   * middleware.
   */
  async emitBriefing(params: {
    engagementId: string;
    regenerate?: boolean;
  }): Promise<BriefingEmitResponse> {
    try {
      const { body } = await legacyFetch<BriefingEmitResponse>(
        `/api/engagements/${encodeURIComponent(params.engagementId)}/briefing/generate`,
        {
          method: "POST",
          jsonBody: { regenerate: params.regenerate ?? false },
        },
      );
      return body;
    } catch (err) {
      if (err instanceof LegacyHttpError && err.status === 409) {
        try {
          const parsed = JSON.parse(err.body) as { generationId?: string };
          if (parsed.generationId) {
            return {
              generationId: parsed.generationId,
              state: "running",
              alreadyInFlight: true,
            };
          }
        } catch {
          // Fall through to rethrow.
        }
      }
      throw err;
    }
  },

  // -----------------------------------------------------------------
  // L1 response-task methods (Group 3). MCP-first contract — these
  // endpoints are defined here and built to match by cc-agent-C in
  // Lane C.4. All bearer-auth; depend on the Lane C service-token
  // middleware for e2e.
  // -----------------------------------------------------------------

  /**
   * POST /api/engagements/:engagementId/response-tasks
   *
   * Creates a response-task within an engagement. The legacy backend
   * assigns `entityId`, sets `state` to `"open"`, stamps `createdAt`,
   * and records the `response-task-opened` audit event. Returns the
   * full response-task atom instance.
   */
  async createResponseTask(params: {
    engagementId: string;
    title: string;
    description: string;
    sourceClientCommentId?: string;
    findingId?: string;
    dueAt?: string;
    actorId?: string;
    principalActorId?: string;
  }): Promise<ResponseTaskResponse> {
    const jsonBody: Record<string, unknown> = {
      title: params.title,
      description: params.description,
    };
    if (params.sourceClientCommentId !== undefined) {
      jsonBody.sourceClientCommentId = params.sourceClientCommentId;
    }
    if (params.findingId !== undefined) jsonBody.findingId = params.findingId;
    if (params.dueAt !== undefined) jsonBody.dueAt = params.dueAt;
    if (params.actorId !== undefined) jsonBody.actorId = params.actorId;
    if (params.principalActorId !== undefined) {
      jsonBody.principalActorId = params.principalActorId;
    }
    const { body } = await legacyFetch<ResponseTaskResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/response-tasks`,
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * POST /api/response-tasks/:responseTaskId/state
   *
   * Transitions a response-task to a new state. The legacy backend
   * validates the transition, stamps `completedAt` when the new state
   * is `"done"`, and records the matching audit event
   * (response-task-progressed / -completed). A forbidden transition
   * surfaces as a 409.
   */
  async updateResponseTaskState(params: {
    responseTaskId: string;
    state: ResponseTaskState;
  }): Promise<ResponseTaskResponse> {
    const { body } = await legacyFetch<ResponseTaskResponse>(
      `/api/response-tasks/${encodeURIComponent(params.responseTaskId)}/state`,
      { method: "POST", jsonBody: { state: params.state } },
    );
    return body;
  },

  /**
   * GET /api/engagements/:engagementId/response-tasks
   *
   * Lists response-tasks for an engagement, optionally filtered to a
   * single state. Returns the full atom instances newest-first.
   */
  async listResponseTasks(params: {
    engagementId: string;
    state?: ResponseTaskState;
  }): Promise<ListResponseTasksResponse> {
    const qs = new URLSearchParams();
    if (params.state !== undefined) qs.set("state", params.state);
    const query = qs.toString();
    const { body } = await legacyFetch<ListResponseTasksResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/response-tasks${
        query ? `?${query}` : ""
      }`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * POST /api/response-tasks/:responseTaskId/link-finding
   *
   * Links a response-task to a finding by setting the atom's
   * `findingId`. Returns the updated response-task atom.
   */
  async linkResponseTaskFinding(params: {
    responseTaskId: string;
    findingId: string;
  }): Promise<ResponseTaskResponse> {
    const { body } = await legacyFetch<ResponseTaskResponse>(
      `/api/response-tasks/${encodeURIComponent(params.responseTaskId)}/link-finding`,
      { method: "POST", jsonBody: { findingId: params.findingId } },
    );
    return body;
  },

  // -----------------------------------------------------------------
  // L2 sheet-content-extraction + attached-document methods (Group 3).
  // MCP-first contract — built to match by cc-agent-C in Lane C.4. All
  // bearer-auth.
  // -----------------------------------------------------------------

  /**
   * POST /api/sheets/:sheetId/content-extraction
   *
   * Triggers the structured-content extraction pass (OCR text segments
   * + structured annotations) against a sheet. The legacy backend runs
   * the extraction and emits a `sheet-content-extraction` atom. Returns
   * the produced atom.
   */
  async triggerSheetContentExtraction(params: {
    sheetId: string;
  }): Promise<SheetContentExtractionResponse> {
    const { body } = await legacyFetch<SheetContentExtractionResponse>(
      `/api/sheets/${encodeURIComponent(params.sheetId)}/content-extraction`,
      { method: "POST", jsonBody: {} },
    );
    return body;
  },

  /**
   * GET /api/sheets/:sheetId/content-extraction
   *
   * Fetches the `sheet-content-extraction` atom for a sheet. Returns
   * `{ sheetContentExtraction: null }` when the sheet has not been
   * extracted yet — that is a normal empty result, not an error.
   */
  async fetchSheetContentExtraction(params: {
    sheetId: string;
  }): Promise<SheetContentExtractionResponse> {
    const { body } = await legacyFetch<SheetContentExtractionResponse>(
      `/api/sheets/${encodeURIComponent(params.sheetId)}/content-extraction`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/engagements/:engagementId/attached-documents
   *
   * Lists the supporting documents attached to an engagement,
   * optionally filtered to one document type.
   */
  async listAttachedDocuments(params: {
    engagementId: string;
    documentType?: AttachedDocumentType;
  }): Promise<ListAttachedDocumentsResponse> {
    const qs = new URLSearchParams();
    if (params.documentType !== undefined) {
      qs.set("documentType", params.documentType);
    }
    const query = qs.toString();
    const { body } = await legacyFetch<ListAttachedDocumentsResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/attached-documents${
        query ? `?${query}` : ""
      }`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/attached-documents/:attachedDocumentId
   *
   * Fetches a single attached-document atom, including its parsed
   * `extractedText` and the `originalBlobRef` to the stored original.
   */
  async fetchAttachedDocument(params: {
    attachedDocumentId: string;
  }): Promise<AttachedDocumentResponse> {
    const { body } = await legacyFetch<AttachedDocumentResponse>(
      `/api/attached-documents/${encodeURIComponent(params.attachedDocumentId)}`,
      { method: "GET" },
    );
    return body;
  },

  // -----------------------------------------------------------------
  // L3 deliverable-letter methods (Group 3). MCP-first contract —
  // built to match by cc-agent-C in Lane C.4. All bearer-auth.
  // -----------------------------------------------------------------

  /**
   * POST /api/engagements/:engagementId/deliverable-letters
   *
   * Creates a deliverable letter in `draft` status. `sections` is
   * optional — each entry carries kind / heading / content; provenance
   * starts empty and is attached later via attachProvenance. The
   * backend assigns `entityId`, stamps `createdAt`, and records the
   * `deliverable-letter.drafted` event.
   */
  async createDeliverableLetter(params: {
    engagementId: string;
    title: string;
    sections?: ReadonlyArray<{
      kind: LetterSectionKind;
      heading: string;
      content: string;
    }>;
    recipientActorId?: string;
    actorId?: string;
    principalActorId?: string;
  }): Promise<DeliverableLetterResponse> {
    const jsonBody: Record<string, unknown> = { title: params.title };
    if (params.sections !== undefined) jsonBody.sections = params.sections;
    if (params.recipientActorId !== undefined) {
      jsonBody.recipientActorId = params.recipientActorId;
    }
    if (params.actorId !== undefined) jsonBody.actorId = params.actorId;
    if (params.principalActorId !== undefined) {
      jsonBody.principalActorId = params.principalActorId;
    }
    const { body } = await legacyFetch<DeliverableLetterResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/deliverable-letters`,
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * POST /api/deliverable-letters/:letterId/sections
   *
   * Upserts a section by index into the ordered `sections` array.
   * `sectionIndex` within the current array replaces that section's
   * kind / heading / content (provenance preserved); `sectionIndex`
   * equal to the current array length appends a new section (provenance
   * starts empty); a larger index is a 400. Records the
   * `deliverable-letter.section-revised` event.
   */
  async updateDeliverableLetterSection(params: {
    letterId: string;
    sectionIndex: number;
    kind: LetterSectionKind;
    heading: string;
    content: string;
  }): Promise<DeliverableLetterResponse> {
    const { body } = await legacyFetch<DeliverableLetterResponse>(
      `/api/deliverable-letters/${encodeURIComponent(params.letterId)}/sections`,
      {
        method: "POST",
        jsonBody: {
          sectionIndex: params.sectionIndex,
          kind: params.kind,
          heading: params.heading,
          content: params.content,
        },
      },
    );
    return body;
  },

  /**
   * POST /api/deliverable-letters/:letterId/sections/:sectionIndex/provenance
   *
   * Merges atom references into a section's provenance (response-task,
   * sheet-content-extraction, finding, adjudication-state entityIds).
   * Ids are added to the existing provenance arrays, deduped. Returns
   * the updated letter atom.
   */
  async attachDeliverableLetterProvenance(params: {
    letterId: string;
    sectionIndex: number;
    responseTaskIds?: ReadonlyArray<string>;
    sheetContentExtractionIds?: ReadonlyArray<string>;
    findingIds?: ReadonlyArray<string>;
    adjudicationStateIds?: ReadonlyArray<string>;
  }): Promise<DeliverableLetterResponse> {
    const jsonBody: Record<string, unknown> = {};
    if (params.responseTaskIds !== undefined) {
      jsonBody.responseTaskIds = params.responseTaskIds;
    }
    if (params.sheetContentExtractionIds !== undefined) {
      jsonBody.sheetContentExtractionIds = params.sheetContentExtractionIds;
    }
    if (params.findingIds !== undefined) {
      jsonBody.findingIds = params.findingIds;
    }
    if (params.adjudicationStateIds !== undefined) {
      jsonBody.adjudicationStateIds = params.adjudicationStateIds;
    }
    const { body } = await legacyFetch<DeliverableLetterResponse>(
      `/api/deliverable-letters/${encodeURIComponent(params.letterId)}/sections/${params.sectionIndex}/provenance`,
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * GET /api/deliverable-letters/:letterId/completeness
   *
   * Runs the engine `deliverableLetterCompleteness()` helper against
   * the letter's sections. Returns `{ complete, missing }` where
   * `missing` lists the required section kinds (cover / intro /
   * signature) that are absent.
   */
  async checkDeliverableLetterCompleteness(params: {
    letterId: string;
  }): Promise<DeliverableLetterCompletenessResponse> {
    const { body } =
      await legacyFetch<DeliverableLetterCompletenessResponse>(
        `/api/deliverable-letters/${encodeURIComponent(params.letterId)}/completeness`,
        { method: "GET" },
      );
    return body;
  },

  /**
   * POST /api/deliverable-letters/:letterId/send
   *
   * Transitions a letter from `draft` to `sent`. The backend runs the
   * completeness check first — an incomplete letter is rejected with a
   * 409 `{ error: "deliverable_letter_incomplete", missing: [...] }`.
   * On success the letter's `status` is `sent` and `sentAt` is stamped;
   * the `deliverable-letter.sent` event is recorded.
   */
  async sendDeliverableLetter(params: {
    letterId: string;
  }): Promise<DeliverableLetterResponse> {
    const { body } = await legacyFetch<DeliverableLetterResponse>(
      `/api/deliverable-letters/${encodeURIComponent(params.letterId)}/send`,
      { method: "POST", jsonBody: {} },
    );
    return body;
  },

  /**
   * GET /api/engagements/:engagementId/deliverable-letters
   *
   * Lists the deliverable letters for an engagement, newest-first,
   * optionally filtered to a single status. Added in Lane C.4 (the
   * original L3 contract was write-path only); ratified Sprint
   * Amendment 8.
   */
  async listDeliverableLetters(params: {
    engagementId: string;
    status?: DeliverableLetterStatus;
  }): Promise<ListDeliverableLettersResponse> {
    const qs = new URLSearchParams();
    if (params.status !== undefined) qs.set("status", params.status);
    const query = qs.toString();
    const { body } = await legacyFetch<ListDeliverableLettersResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/deliverable-letters${
        query ? `?${query}` : ""
      }`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/deliverable-letters/:letterId
   *
   * Fetches a single deliverable-letter atom by id. Added in Lane C.4;
   * ratified Sprint Amendment 8.
   */
  async getDeliverableLetter(params: {
    letterId: string;
  }): Promise<DeliverableLetterResponse> {
    const { body } = await legacyFetch<DeliverableLetterResponse>(
      `/api/deliverable-letters/${encodeURIComponent(params.letterId)}`,
      { method: "GET" },
    );
    return body;
  },

  // -----------------------------------------------------------------
  // L4 detail-callout-spec methods (Group 3). MCP-first contract —
  // built to match by cc-agent-C in Lane C.4. All bearer-auth.
  // -----------------------------------------------------------------

  /**
   * POST /api/engagements/:engagementId/detail-callout-specs
   *
   * Creates a detail-callout spec. The `spec` field carries the
   * type-specific payload; the legacy backend assembles the atom's
   * discriminated `spec` as `{ detailType, ...spec }` and validates it
   * against the engine `DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA`. The
   * backend assigns `entityId`, sets `pushState` to `"pending"`, leaves
   * `apsTaskRef` null, stamps `createdAt`, and records the
   * `detail-callout-spec.created` event.
   */
  async createDetailCalloutSpec(params: {
    engagementId: string;
    detailType: DetailCalloutType;
    spec: Record<string, unknown>;
    findingId?: string;
    responseTaskId?: string;
    actorId?: string;
    principalActorId?: string;
  }): Promise<DetailCalloutSpecResponse> {
    const jsonBody: Record<string, unknown> = {
      // The wire `spec` is the discriminated payload: detailType plus
      // the type-specific fields.
      spec: { detailType: params.detailType, ...params.spec },
    };
    if (params.findingId !== undefined) jsonBody.findingId = params.findingId;
    if (params.responseTaskId !== undefined) {
      jsonBody.responseTaskId = params.responseTaskId;
    }
    if (params.actorId !== undefined) jsonBody.actorId = params.actorId;
    if (params.principalActorId !== undefined) {
      jsonBody.principalActorId = params.principalActorId;
    }
    const { body } = await legacyFetch<DetailCalloutSpecResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/detail-callout-specs`,
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * POST /api/detail-callout-specs/:specId/push-state
   *
   * Transitions a detail-callout spec to a new push state. The legacy
   * backend validates the transition via the engine
   * `isLegalPushTransition` helper — an illegal transition is rejected
   * with a 409 `{ error: "illegal_push_transition", from, to,
   * legalNextStates }`. On success the matching event
   * (`detail-callout-spec.pushed` / `.applied` / `.rejected`) is
   * recorded; entering `"pushed"` stamps `pushedAt`.
   */
  async updateDetailCalloutSpecPushState(params: {
    specId: string;
    pushState: DetailCalloutPushState;
  }): Promise<DetailCalloutSpecResponse> {
    const { body } = await legacyFetch<DetailCalloutSpecResponse>(
      `/api/detail-callout-specs/${encodeURIComponent(params.specId)}/push-state`,
      { method: "POST", jsonBody: { pushState: params.pushState } },
    );
    return body;
  },

  /**
   * POST /api/detail-callout-specs/:specId/aps-ref
   *
   * Writes the opaque APS Design Automation work-item ref onto the
   * spec — populated by the Revit Connector once a push fires.
   */
  async attachDetailCalloutSpecApsRef(params: {
    specId: string;
    apsTaskRef: string;
  }): Promise<DetailCalloutSpecResponse> {
    const { body } = await legacyFetch<DetailCalloutSpecResponse>(
      `/api/detail-callout-specs/${encodeURIComponent(params.specId)}/aps-ref`,
      { method: "POST", jsonBody: { apsTaskRef: params.apsTaskRef } },
    );
    return body;
  },

  /**
   * GET /api/engagements/:engagementId/detail-callout-specs
   *
   * Lists the detail-callout specs for an engagement, optionally
   * filtered to a single push state.
   */
  async listDetailCalloutSpecs(params: {
    engagementId: string;
    pushState?: DetailCalloutPushState;
  }): Promise<ListDetailCalloutSpecsResponse> {
    const qs = new URLSearchParams();
    if (params.pushState !== undefined) qs.set("pushState", params.pushState);
    const query = qs.toString();
    const { body } = await legacyFetch<ListDetailCalloutSpecsResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/detail-callout-specs${
        query ? `?${query}` : ""
      }`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/detail-callout-specs/:specId
   *
   * Fetches a single detail-callout-spec atom.
   */
  async getDetailCalloutSpec(params: {
    specId: string;
  }): Promise<DetailCalloutSpecResponse> {
    const { body } = await legacyFetch<DetailCalloutSpecResponse>(
      `/api/detail-callout-specs/${encodeURIComponent(params.specId)}`,
      { method: "GET" },
    );
    return body;
  },

  // -----------------------------------------------------------------
  // L5 product-spec-reference methods (Group 3). MCP-first contract —
  // built to match by cc-agent-C in Lane C.4. All bearer-auth.
  // -----------------------------------------------------------------

  /**
   * POST /api/engagements/:engagementId/product-spec-references
   *
   * Creates a product-spec reference (an ICC-ES-evaluated product the
   * engagement cites). The backend assigns `entityId`, sets `status`
   * to `"active"`, stamps `createdAt` + `lastVerifiedAt`, initializes
   * `statusHistory`, and records the creation event.
   */
  async createProductSpecReference(params: {
    engagementId: string;
    product: ProductIdentifier;
    esrNumber: string;
    findingId?: string;
    responseTaskId?: string;
    actorId?: string;
    principalActorId?: string;
  }): Promise<ProductSpecReferenceResponse> {
    const jsonBody: Record<string, unknown> = {
      product: params.product,
      esrNumber: params.esrNumber,
    };
    if (params.findingId !== undefined) jsonBody.findingId = params.findingId;
    if (params.responseTaskId !== undefined) {
      jsonBody.responseTaskId = params.responseTaskId;
    }
    if (params.actorId !== undefined) jsonBody.actorId = params.actorId;
    if (params.principalActorId !== undefined) {
      jsonBody.principalActorId = params.principalActorId;
    }
    const { body } = await legacyFetch<ProductSpecReferenceResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/product-spec-references`,
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * POST /api/product-spec-references/:referenceId/refresh
   *
   * Triggers a synchronous backend re-poll of the ICC-ES listing. The
   * legacy backend fetches the ICC-ES page (typically fast, HTML-
   * scrapable), and if the status changed appends a new entry to
   * `statusHistory` and updates `status` + `lastVerifiedAt`. The call
   * blocks until the poll completes; the periodic background re-poll is
   * a separate legacy-side runtime concern (out of MCP-tool scope per
   * sprint Amendment 6). Returns the refreshed atom.
   */
  async refreshProductSpecReferenceStatus(params: {
    referenceId: string;
  }): Promise<ProductSpecReferenceResponse> {
    const { body } = await legacyFetch<ProductSpecReferenceResponse>(
      `/api/product-spec-references/${encodeURIComponent(params.referenceId)}/refresh`,
      { method: "POST", jsonBody: {} },
    );
    return body;
  },

  /**
   * GET /api/engagements/:engagementId/product-spec-references
   *
   * Lists the product-spec references for an engagement, optionally
   * filtered to a single ICC-ES status.
   */
  async listProductSpecReferences(params: {
    engagementId: string;
    status?: ProductSpecStatus;
  }): Promise<ListProductSpecReferencesResponse> {
    const qs = new URLSearchParams();
    if (params.status !== undefined) qs.set("status", params.status);
    const query = qs.toString();
    const { body } = await legacyFetch<ListProductSpecReferencesResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/product-spec-references${
        query ? `?${query}` : ""
      }`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/product-spec-references/:referenceId
   *
   * Fetches a single product-spec-reference atom, including its full
   * append-only `statusHistory`.
   */
  async getProductSpecReference(params: {
    referenceId: string;
  }): Promise<ProductSpecReferenceResponse> {
    const { body } = await legacyFetch<ProductSpecReferenceResponse>(
      `/api/product-spec-references/${encodeURIComponent(params.referenceId)}`,
      { method: "GET" },
    );
    return body;
  },

  // -----------------------------------------------------------------
  // L6 deliverable-letter-render methods (Group 3). MCP-first contract
  // — built to match by cc-agent-C in Lane C.4. All bearer-auth.
  // -----------------------------------------------------------------

  /**
   * POST /api/deliverable-letters/:letterId/renders
   *
   * Renders an L3 deliverable letter to DOCX or PDF, producing a
   * first-class `deliverable-letter-render` atom. The render is
   * synchronous — the call blocks until generation completes. The
   * backend gates on completeness first (via the engine
   * `deliverableLetterCompleteness` helper): an incomplete letter is
   * rejected with a 409 `{ error: "deliverable_letter_incomplete",
   * missing: [...] }` rather than producing a confusing partial
   * document. On success the render atom pins `sourceLetterVersion` to
   * the source letter's contentHash at render time.
   */
  async renderDeliverableLetter(params: {
    letterId: string;
    format: RenderFormat;
    renderedByActorId?: string;
  }): Promise<DeliverableLetterRenderResponse> {
    const jsonBody: Record<string, unknown> = { format: params.format };
    if (params.renderedByActorId !== undefined) {
      jsonBody.renderedByActorId = params.renderedByActorId;
    }
    const { body } = await legacyFetch<DeliverableLetterRenderResponse>(
      `/api/deliverable-letters/${encodeURIComponent(params.letterId)}/renders`,
      { method: "POST", jsonBody },
    );
    return body;
  },

  /**
   * GET /api/deliverable-letters/:letterId/renders
   *
   * Lists every render of a deliverable letter, newest-first. A letter
   * is 1-to-many with its renders (format changes, re-renders against
   * an updated source letter).
   */
  async listDeliverableLetterRenders(params: {
    letterId: string;
  }): Promise<ListDeliverableLetterRendersResponse> {
    const { body } = await legacyFetch<ListDeliverableLetterRendersResponse>(
      `/api/deliverable-letters/${encodeURIComponent(params.letterId)}/renders`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/deliverable-letter-renders/:renderId/file
   *
   * Downloads the rendered DOCX/PDF bytes for a render atom. This route
   * byte-serves the file (not a JSON envelope): the response carries the
   * raw bytes plus `Content-Type` and `Content-Disposition` headers.
   * Added in Lane C.4; ratified Sprint Amendment 8.
   */
  async downloadDeliverableLetterRender(params: {
    renderId: string;
  }): Promise<DeliverableLetterDownload> {
    const { bytes, contentType, contentDisposition } = await legacyFetchBinary(
      `/api/deliverable-letter-renders/${encodeURIComponent(params.renderId)}/file`,
    );
    return {
      bytes,
      contentType,
      filename:
        filenameFromContentDisposition(contentDisposition) ??
        defaultRenderFilename(params.renderId, contentType),
    };
  },

  // -----------------------------------------------------------------
  // Tier 1 Group A — Property Brief (brokerage v1).
  // Service path: bearer + optional x-hauska-mcp-service (cc-agent-C).
  // Without install id the wallet paywall is skipped on the legacy side.
  // -----------------------------------------------------------------

  /**
   * POST /api/brokerage/v1/brief
   *
   * Generates a Property Brief for an address. Returns reasoningSummary,
   * laySummary, siteContext, cited atom projection, and a brief-run id.
   */
  async generateBrief(params: {
    address: string;
    mls_id?: string;
    source?: string;
    presentationMode?: "consumer" | "pro";
  }): Promise<GenerateBriefResponse> {
    const jsonBody: Record<string, unknown> = { address: params.address };
    if (params.mls_id !== undefined) jsonBody.mls_id = params.mls_id;
    if (params.source !== undefined) jsonBody.source = params.source;
    if (params.presentationMode !== undefined) {
      jsonBody.presentationMode = params.presentationMode;
    }
    const { body } = await brokerageFetch<GenerateBriefResponse>(
      "/api/brokerage/v1/brief",
      { method: "POST", jsonBody, timeoutMs: 120_000 },
    );
    return body;
  },

  /**
   * GET /api/brokerage/v1/brief/:runId
   *
   * MCP-first contract — cc-agent-C exposes the read path for stored
   * brief-run payloads. Until then mock-fetch testable only.
   */
  async getBriefRun(params: { runId: string }): Promise<GetBriefRunResponse> {
    const { body } = await brokerageFetch<GetBriefRunResponse>(
      `/api/brokerage/v1/brief/${encodeURIComponent(params.runId)}`,
      { method: "GET" },
    );
    return body;
  },

  // -----------------------------------------------------------------
  // Tier 1 Group B — Hydrology and topography (engagement-scoped).
  // -----------------------------------------------------------------

  /**
   * POST /api/engagements/:id/site-drainage/refresh
   */
  async refreshSiteDrainage(params: {
    engagementId: string;
    manualDepthInches?: number;
    returnPeriodYears?: number;
    accumulationThreshold?: number;
    forceRefresh?: boolean;
    useCotalityForcing?: boolean;
  }): Promise<SiteDrainageRefreshResponse> {
    const jsonBody: Record<string, unknown> = {};
    if (params.manualDepthInches !== undefined) {
      jsonBody.manualDepthInches = params.manualDepthInches;
    }
    if (params.returnPeriodYears !== undefined) {
      jsonBody.returnPeriodYears = params.returnPeriodYears;
    }
    if (params.accumulationThreshold !== undefined) {
      jsonBody.accumulationThreshold = params.accumulationThreshold;
    }
    if (params.forceRefresh !== undefined) jsonBody.forceRefresh = params.forceRefresh;
    if (params.useCotalityForcing !== undefined) {
      jsonBody.useCotalityForcing = params.useCotalityForcing;
    }
    const { body } = await legacyFetch<SiteDrainageRefreshResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/site-drainage/refresh`,
      { method: "POST", jsonBody, timeoutMs: 120_000 },
    );
    return body;
  },

  /**
   * GET /api/engagements/:id/site-drainage
   */
  async getSiteDrainage(params: {
    engagementId: string;
  }): Promise<SiteDrainageReadResponse> {
    const { body } = await legacyFetch<SiteDrainageReadResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/site-drainage`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/engagements/:id/site-drainage/design-storms
   */
  async getSiteDrainageDesignStorms(params: {
    engagementId: string;
  }): Promise<SiteDrainageDesignStormsResponse> {
    const { body } = await legacyFetch<SiteDrainageDesignStormsResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/site-drainage/design-storms`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * POST /api/engagements/:id/site-topography/refresh
   */
  async refreshSiteTopography(params: {
    engagementId: string;
    contourIntervalMeters?: number;
    catchmentBufferMeters?: number;
    demResolutionMeters?: number;
    forceRefresh?: boolean;
  }): Promise<SiteTopographyRefreshResponse> {
    const jsonBody: Record<string, unknown> = {};
    if (params.contourIntervalMeters !== undefined) {
      jsonBody.contourIntervalMeters = params.contourIntervalMeters;
    }
    if (params.catchmentBufferMeters !== undefined) {
      jsonBody.catchmentBufferMeters = params.catchmentBufferMeters;
    }
    if (params.demResolutionMeters !== undefined) {
      jsonBody.demResolutionMeters = params.demResolutionMeters;
    }
    if (params.forceRefresh !== undefined) jsonBody.forceRefresh = params.forceRefresh;
    const { body } = await legacyFetch<SiteTopographyRefreshResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/site-topography/refresh`,
      { method: "POST", jsonBody, timeoutMs: 120_000 },
    );
    return body;
  },

  /**
   * GET /api/engagements/:id/site-topography
   */
  async getSiteTopography(params: {
    engagementId: string;
  }): Promise<SiteTopographyReadResponse> {
    const { body } = await legacyFetch<SiteTopographyReadResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/site-topography`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/engagements/:id/site-topography, projected as a
   * parcel-terrain-model view. The site-topography read row's propertySet
   * carries meshRef (GLB object path) + mesh metadata and ifcRef (IFC
   * object path) + ifc metadata alongside contours/coverage/confidence.
   * meshRef/ifcRef are absent until site-topography ingest has run.
   */
  async getParcelTerrainModel(params: {
    engagementId: string;
  }): Promise<ParcelTerrainModelResponse> {
    const { body } = await legacyFetch<SiteTopographyReadResponse>(
      `/api/engagements/${encodeURIComponent(params.engagementId)}/site-topography`,
      { method: "GET" },
    );
    const props = (body.propertySet ?? {}) as Record<string, unknown>;
    return {
      status: body.status,
      materializableElementId: body.materializableElementId,
      createdAt: body.createdAt,
      updatedAt: body.updatedAt,
      meshRef: props.meshRef as string | undefined,
      mesh: props.mesh as ParcelTerrainMeshMeta | undefined,
      ifcRef: props.ifcRef as string | undefined,
      ifc: props.ifc as ParcelTerrainIfcMeta | undefined,
      confidence: props.confidence,
      coverage: props.coverage,
      contours: props.contours,
      demResolutionMeters: props.demResolutionMeters,
      sourceCitation: props.sourceCitation,
      reason: body.reason,
      raw: props,
    };
  },

  // -----------------------------------------------------------------
  // Tier 1 Group C — Encumbrances (brokerage workspace-scoped).
  // -----------------------------------------------------------------

  /**
   * GET /api/brokerage/v1/workspaces/encumbrances?workspaceDid=...
   *
   * Lists recorded-instrument and restriction-clause atoms for a workspace.
   */
  async searchEncumbrances(params: {
    workspaceDid: string;
  }): Promise<EncumbrancesListResponse> {
    const qs = new URLSearchParams();
    qs.set("workspaceDid", params.workspaceDid);
    const { body } = await brokerageFetch<EncumbrancesListResponse>(
      `/api/brokerage/v1/workspaces/encumbrances?${qs.toString()}`,
      { method: "GET" },
    );
    return body;
  },

  /**
   * GET /api/brokerage/v1/workspaces/encumbrances?workspaceDid=...
   *
   * Same upstream route as searchEncumbrances; the MCP tool layer projects
   * restriction-clause atoms for agent consumption.
   */
  async getRestrictions(params: {
    workspaceDid: string;
  }): Promise<EncumbrancesListResponse> {
    return this.searchEncumbrances(params);
  },

  // -----------------------------------------------------------------
  // Tier 1 Group D — Cotality data tier (designed, inert until creds).
  // MCP-first contract — cc-agent-C exposes adapter routes.
  // -----------------------------------------------------------------

  cotalityCredentialsConfigured,

  credentialPending(adapter: CotalityAdapterKey): CredentialPendingResponse {
    return {
      status: "credential-pending",
      adapter,
      message:
        "CoreLogic/Cotality OAuth credentials are not configured on this deployment. " +
        "Operator must activate the client identifier before this adapter can return data.",
    };
  },

  async fetchCotalityAdapter(params: {
    adapter: CotalityAdapterKey;
    address?: string;
    lat?: number;
    lng?: number;
  }): Promise<Record<string, unknown>> {
    return {
      status: "extinguished",
      adapter: params.adapter,
      error: "extinguished",
      message:
        "Cotality is extinguished. Re-route. Never rotate that credential. Zero outbound Cotality calls.",
      cotalityCalls: 0,
    };
  },

  async getPropertyDetail(params: {
    address?: string;
    lat?: number;
    lng?: number;
  }): Promise<Record<string, unknown> | CredentialPendingResponse> {
    return this.fetchCotalityAdapter({
      adapter: "cotality:property",
      ...params,
    });
  },

  async getReplacementCost(params: {
    address?: string;
    lat?: number;
    lng?: number;
  }): Promise<Record<string, unknown> | CredentialPendingResponse> {
    return this.fetchCotalityAdapter({
      adapter: "cotality:replacementCost",
      ...params,
    });
  },

  async getHazardProfile(params: {
    address?: string;
    lat?: number;
    lng?: number;
  }): Promise<Record<string, unknown> | CredentialPendingResponse> {
    return this.fetchCotalityAdapter({
      adapter: "cotality:hazards",
      ...params,
    });
  },

  async getParcelPolygon(params: {
    address?: string;
    lat?: number;
    lng?: number;
  }): Promise<Record<string, unknown> | CredentialPendingResponse> {
    return this.fetchCotalityAdapter({
      adapter: "cotality:parcels",
      ...params,
    });
  },
};
