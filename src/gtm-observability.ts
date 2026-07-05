// GTM observation helpers (Track M / sprint 76b).
//
// Extends Stream 2C tool_call logs with fields for steward digest (E5/E6)
// and forwards a redacted event to cortex-api POST /api/brokerage/v1/gtm/mcp-event.

import { logger } from "./logger.js";
import { getCurrentAuthContext } from "./request-context.js";
import { atomIdsFromProvenance } from "./read-attribution.js";

export type GtmErrorClass =
  | "no_coverage"
  | "empty_corpus"
  | "auth_reject"
  | "upstream_timeout"
  | "geocode_miss"
  | "validation_error"
  | "feature_disabled"
  | "unknown";

export interface ToolInvocationFields {
  tool: string;
  jurisdiction_key?: string;
  error_class?: GtmErrorClass;
  latency_ms?: number;
  /** Atom-grain DID list for Postgres request_log.atom_ids_returned. */
  atom_ids?: string[];
  /** Legacy numeric count; derived from atom_ids when envelope/atoms supplied. */
  atom_ids_returned?: number;
  /** Read envelope; atom_ids derived from envelope.atoms when present. */
  envelope?: { atoms: ReadonlyArray<{ did: string }> };
  [key: string]: unknown;
}

function internalKeyHashes(): Set<string> {
  const raw = process.env.HAUSKA_INTERNAL_KEY_HASHES ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** True when the caller is not on the operator internal hash allowlist. */
export function isExternalCaller(keyHash: string | undefined): boolean {
  const allow = internalKeyHashes();
  if (allow.size === 0) {
    // No allowlist configured: treat authenticated keys as external for E5
    // unless anonymous (anonymous is always external).
    return true;
  }
  if (!keyHash) return true;
  return !allow.has(keyHash);
}

export function placeApiEnabled(): boolean {
  return process.env.PLACE_API_ENABLED === "true";
}

function cortexApiUrl(): string {
  return (
    process.env.CORTEX_API_URL ??
    process.env.LEGACY_BACKEND_URL ??
    "http://localhost:5000"
  );
}

function gtmEventBearer(): string {
  return (
    process.env.GTM_MCP_EVENT_API_KEY ??
    process.env.LEGACY_BACKEND_API_KEY ??
    ""
  );
}

/**
 * Canonical tool_call log + async gtm/mcp-event POST (fire-and-forget).
 */
export function logToolInvocation(fields: ToolInvocationFields): void {
  const ctx = getCurrentAuthContext();
  const key_hash = ctx?.key_hash ?? null;
  const jurisdiction_key =
    fields.jurisdiction_key ??
    (typeof fields.jurisdiction === "string" ? fields.jurisdiction : undefined);

  const derivedAtomIds =
    fields.atom_ids ??
    (fields.envelope
      ? atomIdsFromProvenance(fields.envelope.atoms)
      : undefined);
  const atomCount =
    derivedAtomIds !== undefined
      ? derivedAtomIds.length
      : typeof fields.atom_ids_returned === "number"
        ? fields.atom_ids_returned
        : undefined;

  const { envelope: _envelope, ...rest } = fields;
  const payload: Record<string, unknown> = {
    ...rest,
    key_hash,
    is_external: isExternalCaller(ctx?.key_hash),
    ...(jurisdiction_key ? { jurisdiction_key } : {}),
    ...(derivedAtomIds !== undefined ? { atom_ids: derivedAtomIds } : {}),
    ...(atomCount !== undefined ? { atom_ids_returned: atomCount } : {}),
  };

  logger.info("tool_call", payload);

  if (process.env.GTM_MCP_EVENT_ENABLED === "false") return;

  void postGtmMcpEvent({
    tool_name: fields.tool,
    key_hash,
    is_external: payload.is_external as boolean,
    jurisdiction_key: jurisdiction_key ?? null,
    error_class: fields.error_class ?? null,
    latency_ms: fields.latency_ms ?? null,
    atom_ids_returned:
      atomCount ??
      (Array.isArray(fields.atom_ids) ? fields.atom_ids.length : null),
    request_id: ctx?.request_id ?? null,
  }).catch((err) => {
    logger.warn("gtm_mcp_event_post_failed", {
      tool: fields.tool,
      error: String(err).slice(0, 200),
    });
  });
}

export async function postGtmMcpEvent(body: Record<string, unknown>): Promise<void> {
  const bearer = gtmEventBearer();
  if (!bearer) return;

  const url = `${cortexApiUrl()}/api/brokerage/v1/gtm/mcp-event`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        "user-agent": "hauska-mcp-server/0.1",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gtm mcp-event ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
