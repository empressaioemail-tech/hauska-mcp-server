// GET /metering/summary — Layer2 call revenue summary endpoint (A4c).
//
// Aggregates metering_events (migration 007) into a windowed summary for
// the command center's revenue panel. Auth restricted to platform_internal
// keys (the panel calls through a Vercel proxy holding the reporting key).

import type { Request, Response } from "express";

import { getPool } from "./db.js";
import { logger } from "./logger.js";

export interface DaySummary {
  date: string;
  layer2Calls: number;
  byProduct: Record<string, number>;
  byTool: Record<string, number>;
}

export interface MeteringSummaryResponse {
  windowDays: number;
  totals: {
    layer2Calls: number;
    billed: number;
    unbilled: number;
  };
  days: DaySummary[];
}

/**
 * GET /metering/summary?days=7
 * 
 * Returns aggregated Layer 2 call counts for the last N days (1..31, default 7).
 * Auth: requires a platform_internal=true key.
 */
export async function getMeteringSummary(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = req.hauska;
  if (!ctx) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }

  if (!ctx.platform_internal) {
    logger.warn("metering_summary_forbidden", {
      key_id: ctx.key_id ?? "anonymous",
      tier: ctx.tier,
    });
    res.status(403).json({ error: "platform_internal_required" });
    return;
  }

  const daysParam = req.query.days;
  let days = 7;
  if (daysParam !== undefined) {
    const raw = String(daysParam);
    const parsed = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
      res.status(400).json({
        error: "invalid_days_parameter",
        message: "days must be an integer between 1 and 31",
      });
      return;
    }
    days = parsed;
  }

  try {
    const summary = await buildMeteringSummary(days);
    res.json(summary);
  } catch (err) {
    logger.error("metering_summary_error", {
      error: String(err).slice(0, 500),
      key_id: ctx.key_id,
    });
    res.status(500).json({
      error: "internal_error",
      message: "Failed to build metering summary",
    });
  }
}

async function buildMeteringSummary(
  windowDays: number,
): Promise<MeteringSummaryResponse> {
  const pool = getPool();
  const now = new Date();

  // Calculate window start (midnight UTC, N days ago)
  const windowStart = new Date(now);
  windowStart.setUTCDate(now.getUTCDate() - windowDays);
  windowStart.setUTCHours(0, 0, 0, 0);

  // Aggregate totals
  const totalsResult = await pool.query<{
    total: string;
    billed: string;
    unbilled: string;
  }>(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE billed = true) as billed,
       COUNT(*) FILTER (WHERE billed = false) as unbilled
     FROM metering_events
     WHERE ts >= $1`,
    [windowStart.toISOString()],
  );

  // Aggregate by day, product, and tool
  const dailyResult = await pool.query<{
    date: string;
    product: string;
    tool: string;
    count: string;
  }>(
    `SELECT
       TO_CHAR(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
       product,
       tool,
       COUNT(*) as count
     FROM metering_events
     WHERE ts >= $1
     GROUP BY TO_CHAR(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD'), product, tool
     ORDER BY date ASC`,
    [windowStart.toISOString()],
  );

  return aggregateMeteringRows(
    totalsResult.rows[0],
    dailyResult.rows,
    windowDays,
    now,
  );
}

/**
 * Pure aggregation over the two query result shapes — exported for
 * DB-free unit tests.
 */
export function aggregateMeteringRows(
  totalsRow: { total: string; billed: string; unbilled: string } | undefined,
  dailyRows: Array<{ date: string; product: string; tool: string; count: string }>,
  windowDays: number,
  now: Date,
): MeteringSummaryResponse {
  const totals = {
    layer2Calls: parseInt(totalsRow?.total ?? "0", 10),
    billed: parseInt(totalsRow?.billed ?? "0", 10),
    unbilled: parseInt(totalsRow?.unbilled ?? "0", 10),
  };

  // Build a map of date -> {layer2Calls, byProduct, byTool}
  const dayMap = new Map<string, DaySummary>();

  for (const row of dailyRows) {
    const date = row.date;
    const product = row.product;
    const tool = row.tool;
    const count = parseInt(row.count, 10);

    if (!dayMap.has(date)) {
      dayMap.set(date, {
        date,
        layer2Calls: 0,
        byProduct: {},
        byTool: {},
      });
    }

    const daySummary = dayMap.get(date)!;
    daySummary.layer2Calls += count;
    daySummary.byProduct[product] = (daySummary.byProduct[product] ?? 0) + count;
    daySummary.byTool[tool] = (daySummary.byTool[tool] ?? 0) + count;
  }

  // Zero-fill missing days
  const days: DaySummary[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    const dateStr = d.toISOString().split("T")[0]!;

    const existing = dayMap.get(dateStr);
    if (existing) {
      days.push(existing);
    } else {
      days.push({
        date: dateStr,
        layer2Calls: 0,
        byProduct: {},
        byTool: {},
      });
    }
  }

  return {
    windowDays,
    totals,
    days,
  };
}
