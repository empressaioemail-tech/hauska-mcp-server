// Legacy Client.
//
// HTTP client against the `legacy-design-tools` api-server. Wraps both
// Codex (plan-review) and Cortex (design accelerator) endpoints
// consumed by the codex_* / cortex_* MCP tools per Lane B dispatch.
//
// Codex (Group 1):
//   POST /api/submissions/:submissionId/findings/generate
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

export interface CreateSubmissionResponse {
  // Legacy backend returns the inserted submission row; pass-through.
  submission: Record<string, unknown>;
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
  }): Promise<OverrideFindingResponse> {
    const { body } = await legacyFetch<OverrideFindingResponse>(
      `/api/findings/${encodeURIComponent(params.findingId)}/override`,
      {
        method: "POST",
        jsonBody: {
          text: params.text,
          severity: params.severity,
          category: params.category,
          reviewerComment: params.reviewerComment ?? "",
        },
      },
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
};
