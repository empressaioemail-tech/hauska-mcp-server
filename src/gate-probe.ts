// MCP gate-availability synthetic probe (76e).
//
// Asserts three documented gate behaviors against POST /mcp:
//   1. No X-Hauska-Key → anonymous path resolves to product "public".
//   2. Valid product key → resolves to that product (not 401).
//   3. Malformed / unknown key → HTTP 401.
//
// Uses X-Hauska-Key exclusively. Authorization: Bearer would silently
// fall through to public and mask gate failures.

import { emitHauskaHealthSignal } from "./health-signals.js";

const PROBE_TIMEOUT_MS = 10_000;
const CODEX_PROBE_TOOL = "codex_finding_generation";

export type GateCaseName =
  | "anonymous_public"
  | "valid_key_product"
  | "malformed_key_401";

export interface GateProbeCaseResult {
  case: GateCaseName;
  header_used: string;
  http_status: number;
  product_resolved: string | null;
  pass: boolean;
  detail: string;
  body_preview: string;
}

export interface GateProbeResult {
  status: "ok" | "fail";
  base_url: string;
  ts: string;
  cases: GateProbeCaseResult[];
}

export interface GateProbeOptions {
  baseUrl: string;
  /** A live codex-product API key for the valid-key case. */
  codexProbeKey?: string;
  fetchFn?: typeof fetch;
}

function toolsCallBody(tool: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "gate-probe",
    method: "tools/call",
    params: {
      name: tool,
      arguments: {},
    },
  });
}

function previewBody(text: string, max = 512): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function productFromMcpBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.error === "object" && record.error !== null) {
    const message = (record.error as { message?: unknown }).message;
    if (typeof message === "string") {
      const match = /product "([^"]+)"/.exec(message);
      if (match?.[1]) return match[1];
    }
  }
  const result = record.result;
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const match = /product "([^"]+)"/.exec(text);
    if (match?.[1]) return match[1];
    if (text.includes("requires a \"codex\"-product")) return "public";
  }
  return null;
}

async function postMcp(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function headerLabel(headers: Record<string, string>): string {
  if (!headers["X-Hauska-Key"]) return "(none)";
  const key = headers["X-Hauska-Key"];
  if (key.length <= 16) return `X-Hauska-Key: ${key}`;
  return `X-Hauska-Key: ${key.slice(0, 12)}…${key.slice(-4)}`;
}

export async function runGateProbe(
  options: GateProbeOptions,
): Promise<GateProbeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const mcpUrl = `${options.baseUrl.replace(/\/$/, "")}/mcp`;
  const body = toolsCallBody(CODEX_PROBE_TOOL);
  const ts = new Date().toISOString();
  const cases: GateProbeCaseResult[] = [];

  // Case 1: anonymous → public (not 401).
  {
    const headers: Record<string, string> = {};
    const res = await postMcp(fetchFn, mcpUrl, headers, body);
    const product = productFromMcpBody(res.json);
    const pass = res.status !== 401 && product === "public";
    cases.push({
      case: "anonymous_public",
      header_used: headerLabel(headers),
      http_status: res.status,
      product_resolved: product,
      pass,
      detail: pass
        ? "anonymous caller resolved to product public"
        : `expected public product without 401; got status=${res.status} product=${product ?? "null"}`,
      body_preview: previewBody(res.text),
    });
  }

  // Case 2: malformed key → 401.
  {
    const headers = { "X-Hauska-Key": "not-a-valid-key-shape" };
    const res = await postMcp(fetchFn, mcpUrl, headers, body);
    const pass = res.status === 401;
    cases.push({
      case: "malformed_key_401",
      header_used: headerLabel(headers),
      http_status: res.status,
      product_resolved: null,
      pass,
      detail: pass
        ? "malformed key rejected with 401"
        : `expected HTTP 401 for malformed key; got ${res.status}`,
      body_preview: previewBody(res.text),
    });
  }

  // Case 3: valid codex key → product codex (not 401, not public gate).
  {
    const key = options.codexProbeKey?.trim();
    if (!key) {
      cases.push({
        case: "valid_key_product",
        header_used: "X-Hauska-Key: (not configured)",
        http_status: 0,
        product_resolved: null,
        pass: false,
        detail: "GATE_PROBE_CODEX_KEY not configured; valid-key case skipped",
        body_preview: "",
      });
    } else {
      const headers = { "X-Hauska-Key": key };
      const res = await postMcp(fetchFn, mcpUrl, headers, body);
      const product = productFromMcpBody(res.json);
      const pass =
        res.status !== 401 &&
        product !== "public" &&
        (product === "codex" || (res.status < 500 && product === null));
      cases.push({
        case: "valid_key_product",
        header_used: headerLabel(headers),
        http_status: res.status,
        product_resolved: product ?? "codex",
        pass,
        detail: pass
          ? "valid codex key passed auth and product gate"
          : `expected codex product resolution without 401; got status=${res.status} product=${product ?? "null"}`,
        body_preview: previewBody(res.text),
      });
    }
  }

  const status = cases.every((c) => c.pass) ? "ok" : "fail";
  return { status, base_url: options.baseUrl, ts, cases };
}

export function emitGateProbeSignal(result: GateProbeResult): void {
  const caseSummary = result.cases
    .map((c) => `${c.case}:${c.pass ? "pass" : "fail"}`)
    .join(",");
  emitHauskaHealthSignal({
    check: "gate_probe",
    service: "hauska-mcp-server",
    status: result.status === "ok" ? "ok" : "fail",
    value: caseSummary,
    threshold: "anonymous_public+valid_key_product+malformed_key_401=all pass",
    source: "gate-probe /mcp X-Hauska-Key",
    ts: result.ts,
  });
}
