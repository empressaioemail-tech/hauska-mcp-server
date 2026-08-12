// Dual-window rate limiter.
//
// Every check enforces two bands simultaneously:
//   - rpm: a 60-second fixed window
//   - daily: a calendar-UTC-day fixed window
//
// Either band tripping returns false. A limit of 0 on either axis means
// that axis is unmetered (Embedder tier default). When both axes are 0
// the limiter short-circuits to allow.
//
// The store is injectable so tests can run against an in-memory backend
// without needing external credentials. Production prefers Postgres
// counters on the shared DATABASE_URL pool (distributed by construction).

import { Redis } from "@upstash/redis";

import { getPool } from "./db.js";
import type { RateLimits } from "./tiers.js";

export interface RateLimitDecision {
  allowed: boolean;
  // Which band tripped first. Useful for the 429 response body so
  // clients can present a precise reason.
  reason: "ok" | "rpm" | "daily";
  // Remaining count in each band after the increment. -1 means unmetered
  // on that axis.
  remaining_rpm: number;
  remaining_daily: number;
}

export interface RateLimitStore {
  // Atomically increment the counter at `key` and return the new value.
  // If the counter was just created, set its TTL to `ttlSeconds`.
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
}

// -----------------------------------------------------------------
// Upstash-backed production store.
// -----------------------------------------------------------------

export class UpstashRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      // First write in this window. Set TTL so the key auto-expires.
      // EXPIRE failure is non-fatal (worst case: the key persists for
      // one extra window cycle, which Redis garbage-collects anyway).
      await this.redis.expire(key, ttlSeconds);
    }
    return count;
  }
}

// A URL containing "REPLACE-with" is a known placeholder shape (the
// literal cloudbuild-mcp.yaml default before a real Upstash database is
// wired). Treat it identically to a missing URL: fail loud, do not
// attempt to reach it.
export function isPlaceholderUpstashUrl(url: string | undefined): boolean {
  return !url || url.includes("REPLACE-with");
}

export function buildUpstashStore(): UpstashRateLimitStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (isPlaceholderUpstashUrl(url) || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set " +
        "to real values (a REPLACE-with placeholder URL counts as unset).",
    );
  }
  return new UpstashRateLimitStore(new Redis({ url, token }));
}

// -----------------------------------------------------------------
// Postgres-backed production store (T4 recommended path).
// -----------------------------------------------------------------

const INCR_WITH_TTL_SQL = `
INSERT INTO rate_limit_counters (counter_key, count, expires_at)
VALUES ($1, 1, NOW() + ($2::double precision * INTERVAL '1 second'))
ON CONFLICT (counter_key) DO UPDATE SET
  count = CASE
    WHEN rate_limit_counters.expires_at <= NOW() THEN 1
    ELSE rate_limit_counters.count + 1
  END,
  expires_at = CASE
    WHEN rate_limit_counters.expires_at <= NOW()
      THEN NOW() + ($2::double precision * INTERVAL '1 second')
    ELSE rate_limit_counters.expires_at
  END
RETURNING count;
`;

export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: import("pg").Pool | null = null) {}

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const db = this.pool ?? getPool();
    const result = await db.query<{ count: string }>(INCR_WITH_TTL_SQL, [
      key,
      ttlSeconds,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error("PostgresRateLimitStore: upsert returned no row");
    }
    return Number(row.count);
  }
}

export type RateLimitPrimaryKind = "postgres" | "upstash" | "memory";

// Documented outage mode (L13 / P-29). Store outage never 503s the
// public gate; it fail-degrades to per-instance memory and MUST surface
// on /health as state=degraded. Silent skip is the defect class.
export const RATE_LIMIT_OUTAGE_POLICY = "fail-degraded" as const;

export interface RateLimitRuntimeState {
  primaryKind: RateLimitPrimaryKind;
  memoryFallback: boolean;
}

let runtimeState: RateLimitRuntimeState = {
  primaryKind: "memory",
  memoryFallback: true,
};

export function getRateLimitRuntimeState(): RateLimitRuntimeState {
  return runtimeState;
}

export function setRateLimitRuntimeState(state: RateLimitRuntimeState): void {
  runtimeState = state;
}

export function resolveRateLimitStoreKind(): Exclude<RateLimitPrimaryKind, "memory"> {
  const explicit = (process.env.HAUSKA_RATE_LIMIT_STORE ?? "").trim().toLowerCase();
  if (explicit === "upstash") return "upstash";
  if (explicit === "postgres") return "postgres";
  const env = process.env.HAUSKA_ENV ?? "development";
  if (env === "production") return "postgres";
  if (process.env.DATABASE_URL) return "postgres";
  throw new Error(
    "No distributed rate-limit store configured: set DATABASE_URL for postgres or HAUSKA_RATE_LIMIT_STORE=upstash",
  );
}

export function buildPrimaryRateLimitStore(): RateLimitStore {
  const kind = resolveRateLimitStoreKind();
  if (kind === "upstash") {
    return buildUpstashStore();
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set when HAUSKA_RATE_LIMIT_STORE=postgres (default in production).",
    );
  }
  return new PostgresRateLimitStore();
}

// -----------------------------------------------------------------
// Resilient store wrapper with circuit-breaker fallback.
//
// Wraps a primary store (typically Postgres) and automatically falls
// back to a MemoryRateLimitStore when the primary fails. Retries the
// primary no more than once every 60s. Never throws; always returns
// a decision (fail-degraded, not fail-closed). The fallback is a
// degraded mode, not a silent one: setRateLimitRuntimeState flips
// memoryFallback so /health reports state=degraded.
// -----------------------------------------------------------------

export class ResilientRateLimitStore implements RateLimitStore {
  private fallbackStore: MemoryRateLimitStore | null = null;
  private lastFailureTimeMs = 0;
  private readonly retryWindowMs = 60_000;
  private now: () => number = () => Date.now();

  constructor(
    private readonly primary: RateLimitStore,
    private readonly logger: { error: (event: string, data: any) => void },
  ) {}

  setClock(now: () => number): void {
    this.now = now;
  }

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const nowMs = this.now();
    const inFallbackMode = this.fallbackStore !== null;

    if (inFallbackMode) {
      const fallback = this.fallbackStore!;
      const shouldRetry = nowMs - this.lastFailureTimeMs >= this.retryWindowMs;
      if (shouldRetry) {
        try {
          const result = await this.primary.incrWithTtl(key, ttlSeconds);
          this.fallbackStore = null;
          setRateLimitRuntimeState({
            ...getRateLimitRuntimeState(),
            memoryFallback: false,
          });
          this.logger.error("rate_limit_store_recovered", {});
          return result;
        } catch (err) {
          this.lastFailureTimeMs = nowMs;
          this.logger.error("rate_limit_store_degraded", {
            error: String(err),
          });
          return fallback.incrWithTtl(key, ttlSeconds);
        }
      }
      return fallback.incrWithTtl(key, ttlSeconds);
    }

    try {
      return await this.primary.incrWithTtl(key, ttlSeconds);
    } catch (err) {
      this.lastFailureTimeMs = nowMs;
      this.fallbackStore = new MemoryRateLimitStore();
      this.fallbackStore.setClock(this.now);
      setRateLimitRuntimeState({
        ...getRateLimitRuntimeState(),
        memoryFallback: true,
      });
      this.logger.error("rate_limit_store_degraded", {
        error: String(err),
      });
      return this.fallbackStore.incrWithTtl(key, ttlSeconds);
    }
  }
}

// -----------------------------------------------------------------
// In-memory store for tests and local dev.
//
// Not safe across multiple processes. Do not use behind a load balancer.
// -----------------------------------------------------------------

interface MemoryEntry {
  count: number;
  expiresAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, MemoryEntry>();
  private now: () => number = () => Date.now();

  // Test seam: tests inject a fake clock to advance time without sleep.
  setClock(now: () => number): void {
    this.now = now;
  }

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const t = this.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.expiresAt <= t) {
      this.buckets.set(key, { count: 1, expiresAt: t + ttlSeconds * 1000 });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  // Diagnostics for tests; not used by production code.
  size(): number {
    return this.buckets.size;
  }
}

// -----------------------------------------------------------------
// Public check function. Identifier should already be tier-tagged so
// the same identity does not collide across paths. Examples:
//   ip:203.0.113.7              free-tier unauthed traffic
//   key:550e8400-e29b-41d4-...  any authed key, keyed by key_id
// -----------------------------------------------------------------

const DAY_SECONDS = 86_400;

function utcDayBucket(now: number): string {
  // YYYYMMDD in UTC. Stable across processes; rolls at 00:00 UTC.
  const d = new Date(now);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

function minuteBucket(now: number): number {
  return Math.floor(now / 60_000);
}

export async function checkRateLimit(
  store: RateLimitStore,
  identifier: string,
  limits: RateLimits,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  const rpmUnmetered = limits.rpm === 0;
  const dailyUnmetered = limits.daily === 0;

  if (rpmUnmetered && dailyUnmetered) {
    return {
      allowed: true,
      reason: "ok",
      remaining_rpm: -1,
      remaining_daily: -1,
    };
  }

  // Daily check first; on a cold day-start the burst window is empty
  // anyway, so the order has no functional difference, but if the daily
  // cap trips we skip the RPM increment to save a Redis op.
  let dailyCount = 0;
  if (!dailyUnmetered) {
    const dailyKey = `rl:daily:${identifier}:${utcDayBucket(nowMs)}`;
    dailyCount = await store.incrWithTtl(dailyKey, DAY_SECONDS);
    if (dailyCount > limits.daily) {
      return {
        allowed: false,
        reason: "daily",
        remaining_rpm: -1,
        remaining_daily: 0,
      };
    }
  }

  let rpmCount = 0;
  if (!rpmUnmetered) {
    const rpmKey = `rl:rpm:${identifier}:${minuteBucket(nowMs)}`;
    rpmCount = await store.incrWithTtl(rpmKey, 60);
    if (rpmCount > limits.rpm) {
      return {
        allowed: false,
        reason: "rpm",
        remaining_rpm: 0,
        remaining_daily: dailyUnmetered ? -1 : Math.max(0, limits.daily - dailyCount),
      };
    }
  }

  return {
    allowed: true,
    reason: "ok",
    remaining_rpm: rpmUnmetered ? -1 : Math.max(0, limits.rpm - rpmCount),
    remaining_daily: dailyUnmetered ? -1 : Math.max(0, limits.daily - dailyCount),
  };
}
