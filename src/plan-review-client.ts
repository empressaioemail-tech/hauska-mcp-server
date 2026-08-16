/**
 * Plan-review HTTP client. Codex tools call this host, not cortex-api.
 * PLAN-ROW G-60. Zero plan-review DSN on MCP.
 */

import { LegacyHttpError, LegacyUnreachableError } from "./legacy-client.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const FORBIDDEN = /cortex-api|legacy-design-tools|fancy-fire/i;

export function planReviewBackendUrl(): string {
  const url = (process.env.PLAN_REVIEW_BACKEND_URL ?? "").replace(/\/$/, "");
  if (!url) {
    throw new Error("PLAN_REVIEW_BACKEND_URL is required");
  }
  if (FORBIDDEN.test(url)) {
    throw new Error("PLAN_REVIEW_BACKEND_URL refuses cortex-api as the plan-review host");
  }
  return url;
}

function serviceToken(): string {
  return process.env.PLAN_REVIEW_API_KEY ?? "";
}

export async function planReviewFetch<T>(
  path: string,
  init: { method?: string; jsonBody?: unknown; source?: string } = {},
): Promise<T> {
  const url = `${planReviewBackendUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "hauska-mcp-server/g60",
  };
  const apiKey = serviceToken();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (init.source) headers["x-plan-review-source"] = init.source;
  if (init.jsonBody !== undefined) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new LegacyUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new LegacyHttpError(res.status, url, text.slice(0, 500));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export const planReviewClient = {
  queue(source: string) {
    return planReviewFetch<Record<string, unknown>>("/api/plan-review/queue", { source });
  },
  intake(body: Record<string, unknown>, source: string) {
    return planReviewFetch<Record<string, unknown>>("/api/plan-review/intake", {
      method: "POST",
      jsonBody: body,
      source,
    });
  },
  engagement(id: string, source: string) {
    return planReviewFetch<Record<string, unknown>>(
      `/api/plan-review/engagements/${encodeURIComponent(id)}`,
      { source },
    );
  },
  matrix(id: string, source: string) {
    return planReviewFetch<Record<string, unknown>>(
      `/api/plan-review/engagements/${encodeURIComponent(id)}/matrix`,
      { source },
    );
  },
  findings(sectionId: string, source: string) {
    const q = new URLSearchParams({ sectionId });
    return planReviewFetch<Record<string, unknown>>(`/api/plan-review/findings?${q}`, {
      source,
    });
  },
  override(id: string, body: Record<string, unknown>, source: string) {
    return planReviewFetch<Record<string, unknown>>(
      `/api/plan-review/engagements/${encodeURIComponent(id)}/override`,
      { method: "POST", jsonBody: body, source },
    );
  },
  briefing(id: string, sectionAtomId: string | undefined, source: string) {
    const q = sectionAtomId ? `?sectionAtomId=${encodeURIComponent(sectionAtomId)}` : "";
    return planReviewFetch<Record<string, unknown>>(
      `/api/plan-review/engagements/${encodeURIComponent(id)}/briefing${q}`,
      { source },
    );
  },
  letter(id: string, source: string) {
    return planReviewFetch<Record<string, unknown>>(
      `/api/plan-review/engagements/${encodeURIComponent(id)}/letter`,
      { source },
    );
  },
  generateLetter(id: string, body: Record<string, unknown>, source: string) {
    return planReviewFetch<Record<string, unknown>>(
      `/api/plan-review/engagements/${encodeURIComponent(id)}/letter/generate`,
      { method: "POST", jsonBody: body, source },
    );
  },
  code(query: { book?: string; chapter?: string; section?: string }, source: string) {
    const q = new URLSearchParams();
    if (query.book) q.set("book", query.book);
    if (query.chapter) q.set("chapter", query.chapter);
    if (query.section) q.set("section", query.section);
    return planReviewFetch<Record<string, unknown>>(`/api/plan-review/code?${q}`, {
      source,
    });
  },
  uploadDocument(id: string, body: Record<string, unknown>, source: string) {
    return planReviewFetch<Record<string, unknown>>(
      `/api/plan-review/engagements/${encodeURIComponent(id)}/documents`,
      { method: "POST", jsonBody: body, source },
    );
  },
  activity(actorDid: string, source: string) {
    const q = new URLSearchParams({ actorDid });
    return planReviewFetch<Record<string, unknown>>(`/api/icc/activity?${q}`, { source });
  },
};
