// Health and readiness reporting.
//
// GET /health returns process liveness, a metrics summary, and the
// reachability of each downstream dependency. The HTTP status stays 200
// while the process is alive (so the Cloud Run liveness probe stays
// green); the body's `status` field reflects the dependency rollup, so
// observability still sees "degraded" when something downstream is down.
//
// Dependency probes are bounded (short timeout, run in parallel) and
// cached briefly so /health stays cheap under polling.

import { getPool } from "./db.js";
import { metrics, type MetricsSnapshot } from "./metrics.js";
import {
  getRateLimitRuntimeState,
  resolveRateLimitStoreKind,
} from "./rate-limit.js";

const PROBE_TIMEOUT_MS = 2_000;
const DEP_CACHE_TTL_MS = 15_000;

const SERVICE = "hauska-mcp-server";
const VERSION = "0.1.0";
const ENV = process.env.HAUSKA_ENV ?? "development";

export type DepState = "ok" | "degraded" | "down" | "skipped";

export interface DepHealth {
  state: DepState;
  latency_ms: number | null;
  detail?: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  service: string;
  version: string;
  env: string;
  metrics: MetricsSnapshot;
  dependencies: Record<string, DepHealth>;
}

export interface ProbeFns {
  engine: () => Promise<DepHealth>;
  cortexApi: () => Promise<DepHealth>;
  postgres: () => Promise<DepHealth>;
  rateLimitStore: () => Promise<DepHealth>;
}

function engineUrl(): string {
  return process.env.HAUSKA_BACKEND_URL ?? "http://localhost:8080";
}

function cortexApiUrl(): string {
  return process.env.LEGACY_BACKEND_URL ?? "http://localhost:5000";
}

// A dependency that answers HTTP at all is "reachable". A 5xx is
// "degraded" (up but unhealthy); any other status is "ok" (an
// unauthenticated probe drawing a 401/404 still proves reachability). A
// transport error or timeout is "down".
async function probeHttp(
  url: string,
  headers: Record<string, string> = {},
): Promise<DepHealth> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    if (res.status >= 500) {
      return { state: "degraded", latency_ms: latency, detail: `HTTP ${res.status}` };
    }
    return {
      state: "ok",
      latency_ms: latency,
      ...(res.ok ? {} : { detail: `HTTP ${res.status}` }),
    };
  } catch (err) {
    return {
      state: "down",
      latency_ms: Date.now() - started,
      detail: String(err).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probePostgres(): Promise<DepHealth> {
  if (process.env.HAUSKA_DEV_MODE === "true") {
    return { state: "skipped", latency_ms: null, detail: "dev mode" };
  }
  const started = Date.now();
  try {
    await getPool().query("SELECT 1");
    return { state: "ok", latency_ms: Date.now() - started };
  } catch (err) {
    return {
      state: "down",
      latency_ms: Date.now() - started,
      detail: String(err).slice(0, 160),
    };
  }
}

export async function probeRateLimitStore(): Promise<DepHealth> {
  if (process.env.HAUSKA_DEV_MODE === "true") {
    return { state: "skipped", latency_ms: null, detail: "dev mode" };
  }

  const runtime = getRateLimitRuntimeState();
  if (runtime.memoryFallback || runtime.primaryKind === "memory") {
    return {
      state: "degraded",
      latency_ms: null,
      detail:
        "degraded — rate-limit on per-instance memory fallback (not shared across instances)",
    };
  }

  if (runtime.primaryKind === "postgres") {
    const started = Date.now();
    try {
      await getPool().query("SELECT 1 FROM rate_limit_counters LIMIT 0");
      return { state: "ok", latency_ms: Date.now() - started, detail: "postgres" };
    } catch (err) {
      return {
        state: "degraded",
        latency_ms: Date.now() - started,
        detail: `postgres rate_limit_counters probe failed: ${String(err).slice(0, 120)}`,
      };
    }
  }

  // Legacy upstash adapter (secondary / unused in T4 posture).
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!token || !url || url.includes("REPLACE-with")) {
    return {
      state: "degraded",
      latency_ms: null,
      detail: "degraded — upstash adapter selected but not configured",
    };
  }
  return probeHttp(`${url}/ping`, { authorization: `Bearer ${token}` });
}

/** @deprecated Use probeRateLimitStore. Kept for transitional imports in tests. */
export const probeUpstash = probeRateLimitStore;

const defaultProbes: ProbeFns = {
  engine: () => probeHttp(`${engineUrl()}/healthz`),
  cortexApi: () => probeHttp(`${cortexApiUrl()}/api/healthz`),
  postgres: probePostgres,
  rateLimitStore: probeRateLimitStore,
};

let depCache: { at: number; deps: Record<string, DepHealth> } | null = null;

async function resolveDeps(
  probes: Partial<ProbeFns>,
): Promise<Record<string, DepHealth>> {
  const useCache = Object.keys(probes).length === 0;
  const now = Date.now();
  if (useCache && depCache && now - depCache.at < DEP_CACHE_TTL_MS) {
    return depCache.deps;
  }
  const p: ProbeFns = { ...defaultProbes, ...probes };
  const [engine, cortexApi, postgres, rateLimitStore] = await Promise.all([
    p.engine(),
    p.cortexApi(),
    p.postgres(),
    p.rateLimitStore(),
  ]);
  const deps: Record<string, DepHealth> = {
    engine_retrieval_api: engine,
    cortex_api: cortexApi,
    postgres,
    rate_limit_store: rateLimitStore,
  };
  if (useCache) depCache = { at: now, deps };
  return deps;
}

/**
 * Build the /health report. Pass `probes` to inject dependency probes
 * (used by tests); the default set probes the real dependencies and
 * caches the result for DEP_CACHE_TTL_MS.
 */
export async function buildHealthReport(
  probes: Partial<ProbeFns> = {},
): Promise<HealthReport> {
  const dependencies = await resolveDeps(probes);
  const degraded = Object.values(dependencies).some(
    (d) => d.state === "down" || d.state === "degraded",
  );
  return {
    status: degraded ? "degraded" : "ok",
    service: SERVICE,
    version: VERSION,
    env: ENV,
    metrics: metrics.snapshot(),
    dependencies,
  };
}
