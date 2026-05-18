// Auth middleware.
//
// v1 auth model:
//   - No header present: request is treated as free tier. Rate limited.
//   - Header X-Hauska-Key present and matches a registered key: paid tier.
//   - Header present but does not match: rejected.
//
// v2 will move to OAuth 2.1 per the MCP 2026 roadmap.

import type { Request, Response, NextFunction } from "express";

const PAID_KEYS = (process.env.HAUSKA_MCP_API_KEYS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const FREE_RPM = parseInt(process.env.HAUSKA_FREE_TIER_RPM ?? "20", 10);
const PAID_RPM = parseInt(process.env.HAUSKA_PAID_TIER_RPM ?? "600", 10);

// Simple in-memory rate limiter. Replace with Redis or Upstash for production.
const buckets: Map<string, { count: number; resetAt: number }> = new Map();

function rateLimitOk(key: string, rpm: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= rpm) return false;
  bucket.count += 1;
  return true;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const headerKey = (req.headers["x-hauska-key"] as string | undefined)?.trim();

  if (headerKey) {
    if (PAID_KEYS.includes(headerKey)) {
      (req as any).tier = "paid";
      if (!rateLimitOk(`paid:${headerKey}`, PAID_RPM)) {
        return res.status(429).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Rate limit exceeded for paid tier." },
          id: req.body?.id ?? null,
        });
      }
      return next();
    }
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid API key." },
      id: req.body?.id ?? null,
    });
  }

  // No key means free tier. Rate limit by IP.
  (req as any).tier = "free";
  const ip = req.ip ?? "unknown";
  if (!rateLimitOk(`free:${ip}`, FREE_RPM)) {
    return res.status(429).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Rate limit exceeded for free tier. Request an API key for paid access.",
      },
      id: req.body?.id ?? null,
    });
  }
  next();
}
