// Legacy Client.
//
// HTTP client against the `legacy-design-tools` api-server. Wraps the
// Codex-side endpoints (finding generation, override write, briefing
// fetch, submission ingest) consumed by the codex_* MCP tools per Lane B
// dispatch.
//
//   POST /api/submissions/:submissionId/findings/generate
//   POST /api/findings/:findingId/override
//   GET  /api/engagements/:id/briefing
//   POST /api/engagements/:id/submissions
//
// Service-to-service auth via `LEGACY_BACKEND_API_KEY`. Base URL via
// `LEGACY_BACKEND_URL`. Cookie-session auth (the legacy backend's
// existing reviewer-audience gate via `requireReviewerAudience`) does
// NOT cover this client; the legacy backend must grow a bearer-token
// middleware before these tools work end-to-end against a deployed
// instance. Flagged as a Lane C coordination item.
//
// Wire-shape types below mirror what the legacy backend returns today
// (taken from artifacts/api-server/src/routes/{findings,parcelBriefings,
// engagements}.ts as of 2026-05-19). They are duplicated here on purpose;
// pulling legacy workspace packages into the mcp-server build graph is
// out of scope for v1 and would couple this server to the legacy repo's
// dependency churn through the Cloud Run cutover.

import { logger } from "./logger.js";

const DEFAULT_BACKEND_URL = "http://localhost:5000";
const DEFAULT_TIMEOUT_MS = 30_000;

function backendUrl(): string {
  return process.env.LEGACY_BACKEND_URL ?? DEFAULT_BACKEND_URL;
}

function legacyApiKey(): string {
  return process.env.LEGACY_BACKEND_API_KEY ?? "";
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
};
