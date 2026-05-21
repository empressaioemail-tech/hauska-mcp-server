// Auth middleware.
//
// v1 model:
//   No X-Hauska-Key header        -> free-tier path, IP-bucketed.
//   Header present, shape invalid -> 401 (shape error logged).
//   Header valid, DB miss         -> 401 (hash-miss logged).
//   Header valid, DB hit, !active -> 403.
//   Header valid, DB hit, active  -> tier-bucketed rate limit.
//   Either rate band trips        -> 429.
//
// The raw key is never logged. The hash and key_id are safe to log
// because the hash cannot be reversed and key_id is the admin-facing
// handle, not the secret itself.

import type { NextFunction, Request, Response } from "express";

import { findKeyByHash, touchLastUsed } from "./db.js";
import { constantTimeEquals, parseKey } from "./keys.js";
import { logger } from "./logger.js";
import type { Product } from "./products.js";
import {
  checkRateLimit,
  type RateLimitDecision,
  type RateLimitStore,
} from "./rate-limit.js";
import { freeIpLimits, limitsForTier, type Tier } from "./tiers.js";

export interface AuthContext {
  tier: Tier | "free_anonymous";
  // Product the caller is authorized for. Free-anonymous callers are
  // implicitly 'public'; codex / cortex products are reachable only via
  // a key bound to that product per migration 002.
  product: Product;
  // Present only for authenticated requests.
  key_id?: string;
  key_hash?: string;
  // The rate-limit identifier actually used (for log correlation).
  rate_limit_id: string;
  remaining_rpm: number;
  remaining_daily: number;
  // Per-request correlation id. Generated in index.ts before auth runs
  // and merged into the context so every log line emitted while handling
  // the request carries it. Absent outside the /mcp request path.
  request_id?: string;
}

// Type extension via module augmentation so req.hauska has shape.
// Named `hauska` (not `auth`) to avoid collision with the MCP SDK,
// which augments Express.Request with its own `auth?: AuthInfo` for
// OAuth flows.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      hauska?: AuthContext;
    }
  }
}

const HEADER_KEY = "x-hauska-key";
const HEADER_ADMIN = "x-hauska-admin-key";

function rateLimitErrorResponse(
  res: Response,
  reqId: unknown,
  decision: RateLimitDecision,
  tier: Tier | "free_anonymous",
) {
  const message =
    tier === "free_anonymous"
      ? "Rate limit exceeded for the free tier. Request an API key at hauska.dev for higher limits."
      : `Rate limit exceeded for tier "${tier}" on band "${decision.reason}".`;
  return res.status(429).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
      data: {
        band: decision.reason,
        tier,
      },
    },
    id: reqId ?? null,
  });
}

export function buildAuthMiddleware(store: RateLimitStore) {
  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const reqId = req.body?.id;
    const rawKey = (req.headers[HEADER_KEY] as string | undefined)?.trim();

    if (rawKey) {
      const parsed = parseKey(rawKey);
      if (!parsed) {
        logger.warn("auth_shape_invalid", { ip: req.ip });
        return res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Invalid API key format." },
          id: reqId ?? null,
        });
      }
      let row;
      try {
        row = await findKeyByHash(parsed.hash);
      } catch (err) {
        logger.error("auth_db_error", { error: String(err) });
        return res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32002, message: "Auth backend unavailable." },
          id: reqId ?? null,
        });
      }
      if (!row) {
        logger.warn("auth_hash_miss", { ip: req.ip, hash_prefix: parsed.hash.slice(0, 12) });
        return res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unknown API key." },
          id: reqId ?? null,
        });
      }
      if (row.status !== "active") {
        logger.warn("auth_inactive", {
          key_id: row.key_id,
          status: row.status,
        });
        return res.status(403).json({
          jsonrpc: "2.0",
          error: {
            code: -32003,
            message: `API key status is "${row.status}". Contact support@hauska.dev.`,
          },
          id: reqId ?? null,
        });
      }

      const limits = limitsForTier(row.tier);
      const identifier = `key:${row.key_id}`;
      const decision = await checkRateLimit(store, identifier, limits);
      if (!decision.allowed) {
        logger.warn("auth_rate_limited", {
          key_id: row.key_id,
          tier: row.tier,
          band: decision.reason,
        });
        return rateLimitErrorResponse(res, reqId, decision, row.tier);
      }

      req.hauska = {
        tier: row.tier,
        product: row.product,
        key_id: row.key_id,
        key_hash: row.key_hash,
        rate_limit_id: identifier,
        remaining_rpm: decision.remaining_rpm,
        remaining_daily: decision.remaining_daily,
      };
      touchLastUsed(row.key_id);
      return next();
    }

    // Free-tier anonymous path.
    const ip = req.ip ?? "unknown";
    const limits = freeIpLimits();
    const identifier = `ip:${ip}`;
    let decision: RateLimitDecision;
    try {
      decision = await checkRateLimit(store, identifier, limits);
    } catch (err) {
      logger.error("rate_limit_error", { error: String(err), identifier });
      // If the rate limiter is down, fail open with a low-cardinality log.
      // Cloud Run min-instances=1 plus Upstash REST should keep this rare.
      decision = {
        allowed: true,
        reason: "ok",
        remaining_rpm: -1,
        remaining_daily: -1,
      };
    }
    if (!decision.allowed) {
      logger.warn("auth_rate_limited", {
        ip,
        tier: "free_anonymous",
        band: decision.reason,
      });
      return rateLimitErrorResponse(res, reqId, decision, "free_anonymous");
    }
    req.hauska = {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: identifier,
      remaining_rpm: decision.remaining_rpm,
      remaining_daily: decision.remaining_daily,
    };
    next();
  };
}

// Bootstrap-key middleware for /admin/* routes. Compares against
// HAUSKA_ADMIN_BOOTSTRAP_KEY env via constant-time equality. Returns 503
// if the env var is unset so admin endpoints never accept "any key
// works" by accident.
export function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const expected = process.env.HAUSKA_ADMIN_BOOTSTRAP_KEY;
  if (!expected) {
    return res.status(503).json({
      error: "Admin endpoints disabled: HAUSKA_ADMIN_BOOTSTRAP_KEY not set.",
    });
  }
  const provided = (req.headers[HEADER_ADMIN] as string | undefined)?.trim();
  if (!provided || !constantTimeEquals(provided, expected)) {
    return res.status(401).json({ error: "Invalid admin bootstrap key." });
  }
  next();
}
