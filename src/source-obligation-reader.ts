// GET /obligations/source-ledger — scoped reader for source_obligation_ledger
// (G-111, gap 2). Same auth shape as GET /metering/summary: platform_internal
// keys only, mirrored deliberately rather than invented fresh.
//
// WHY SCOPED, NOT A DUMP. This ledger is Hauska's money-OUT liability to a
// licensed source (ICC first). Serving it unscoped to anything with a
// platform_internal key would hand out exact per-source accrual volumes on
// request; the two real consumers named in the request that produced this
// endpoint (plan-review's reconciliation, a licensor audit) both look up a
// specific request_id or a specific source_actor_did, never "give me
// everything." At least one of the two is required; there is no unfiltered
// path, and no default LIMIT-only fallback that would let an empty query
// silently become a full-table read.
//
// WHY platform_internal, NOT a new tier. An external licensor auditing this
// directly would need its own credential model, which is a bigger scope than
// this card (G-111) took on -- flagged as a named residual in the close, not
// built here. plan-review reaching this endpoint for its own reconciliation
// also needs a platform_internal-tier key issued to it, which is govtech's
// step to take, not this one's.

import type { Request, Response } from "express";

import { getPool } from "./db.js";
import { logger } from "./logger.js";

export interface SourceObligationLedgerRow {
  id: string;
  created_at: string;
  source_actor_did: string;
  atom_did: string;
  tool: string;
  product: string;
  tier: string;
  request_id: string;
  obligation_type: string;
  amount_minor: number | null;
  currency: string | null;
  grace_terms: string | null;
  note: string | null;
}

export interface LedgerQuery {
  requestId?: string;
  sourceActorDid?: string;
}

export type LedgerQueryValidation =
  | { ok: true; value: LedgerQuery }
  | { ok: false; status: number; body: { error: string; message: string } };

/**
 * Pure. Exported so the "at least one scope" refusal is testable without a
 * request/response pair or a database.
 */
export function validateLedgerQuery(
  query: Record<string, unknown>,
): LedgerQueryValidation {
  const requestId =
    typeof query.request_id === "string" ? query.request_id.trim() : "";
  const sourceActorDid =
    typeof query.source_actor_did === "string"
      ? query.source_actor_did.trim()
      : "";

  if (!requestId && !sourceActorDid) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "scope_required",
        message:
          "At least one of request_id or source_actor_did is required. " +
          "This endpoint does not serve an unscoped ledger read.",
      },
    };
  }

  return {
    ok: true,
    value: {
      requestId: requestId || undefined,
      sourceActorDid: sourceActorDid || undefined,
    },
  };
}

/**
 * GET /obligations/source-ledger?request_id=...&source_actor_did=...
 *
 * Auth: requires a platform_internal=true key (same gate as
 * GET /metering/summary). Returns matching source_obligation_ledger rows,
 * most recent first, capped at 200 -- a cap that only matters once a
 * source_actor_did with real volume exists; today's 12 seed-era rows are far
 * under it.
 */
export async function getSourceObligationLedger(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = req.hauska;
  if (!ctx) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }

  if (!ctx.platform_internal) {
    logger.warn("source_obligation_ledger_read_forbidden", {
      key_id: ctx.key_id ?? "anonymous",
      tier: ctx.tier,
    });
    res.status(403).json({ error: "platform_internal_required" });
    return;
  }

  const parsed = validateLedgerQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(parsed.status).json(parsed.body);
    return;
  }

  try {
    const rows = await querySourceObligationLedger(parsed.value);
    res.json({ rows, count: rows.length });
  } catch (err) {
    logger.error("source_obligation_ledger_read_error", {
      error: String(err).slice(0, 500),
      key_id: ctx.key_id,
    });
    res.status(500).json({
      error: "internal_error",
      message: "Failed to read source_obligation_ledger",
    });
  }
}

async function querySourceObligationLedger(
  q: LedgerQuery,
): Promise<SourceObligationLedgerRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<SourceObligationLedgerRow>(
    `SELECT id, created_at, source_actor_did, atom_did, tool, product, tier,
            request_id, obligation_type, amount_minor, currency, grace_terms, note
       FROM source_obligation_ledger
      WHERE ($1::text IS NULL OR request_id = $1)
        AND ($2::text IS NULL OR source_actor_did = $2)
      ORDER BY created_at DESC
      LIMIT 200`,
    [q.requestId ?? null, q.sourceActorDid ?? null],
  );
  return rows;
}
