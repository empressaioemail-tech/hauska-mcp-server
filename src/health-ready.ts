// Critical-dependency readiness reporting.
//
// Unlike /health (process liveness), GET /health/ready is allowed to return
// a non-200 status. It does so only when a critical dependency is DOWN.
// Degraded, skipped, and non-critical dependencies do not make the process
// unready.

import {
  buildHealthReport,
  type DepHealth,
  type ProbeFns,
} from "./health.js";

export interface ReadinessReport {
  status: "ready" | "not_ready";
  service: string;
  version: string;
  env: string;
  critical_dependencies: {
    engine_retrieval_api: DepHealth;
    postgres: DepHealth;
  };
}

export async function buildReadinessReport(
  probes: Partial<ProbeFns> = {},
): Promise<ReadinessReport> {
  const health = await buildHealthReport(probes);
  const criticalDependencies = {
    engine_retrieval_api: health.dependencies.engine_retrieval_api,
    postgres: health.dependencies.postgres,
  };
  const criticalDown = Object.values(criticalDependencies).some(
    (dependency) => dependency.state === "down",
  );

  return {
    status: criticalDown ? "not_ready" : "ready",
    service: health.service,
    version: health.version,
    env: health.env,
    critical_dependencies: criticalDependencies,
  };
}

export function readinessHttpStatus(report: ReadinessReport): 200 | 503 {
  return report.status === "ready" ? 200 : 503;
}
