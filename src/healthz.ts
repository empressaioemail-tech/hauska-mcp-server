// Normalized /healthz payload for the platform observability sprint (76e).
//
// Shape: { status, deps, revision } where deps covers retrieval-api and
// legacy-backend reachability only. Postgres and Upstash stay on /health.

import { emitHauskaHealthSignal } from "./health-signals.js";
import { buildHealthReport, type DepHealth, type ProbeFns } from "./health.js";

export type DepReachability = "ok" | "degraded" | "down" | "skipped";

export interface HealthzDeps {
  retrieval_api: DepReachability;
  legacy_backend: DepReachability;
}

export interface HealthzReport {
  status: "ok" | "degraded";
  deps: HealthzDeps;
  revision: string;
}

function depReachability(dep: DepHealth): DepReachability {
  return dep.state;
}

function rollupStatus(deps: HealthzDeps): "ok" | "degraded" {
  const values = Object.values(deps);
  if (values.some((d) => d === "down" || d === "degraded")) {
    return "degraded";
  }
  return "ok";
}

export function revisionFromEnv(): string {
  return process.env.K_REVISION ?? "local";
}

export async function buildHealthzReport(
  probes: Partial<ProbeFns> = {},
): Promise<HealthzReport> {
  const report = await buildHealthReport(probes);
  const deps: HealthzDeps = {
    retrieval_api: depReachability(report.dependencies.engine_retrieval_api),
    legacy_backend: depReachability(report.dependencies.cortex_api),
  };
  return {
    status: rollupStatus(deps),
    deps,
    revision: revisionFromEnv(),
  };
}

export async function buildHealthzReportAndEmit(): Promise<HealthzReport> {
  const report = await buildHealthzReport();
  const depSummary = Object.entries(report.deps)
    .map(([name, state]) => `${name}=${state}`)
    .join(",");
  emitHauskaHealthSignal({
    check: "healthz",
    service: "hauska-mcp-server",
    status: report.status === "ok" ? "ok" : "fail",
    value: `revision=${report.revision};${depSummary}`,
    threshold: "all deps ok",
    source: "GET /healthz",
  });
  return report;
}
