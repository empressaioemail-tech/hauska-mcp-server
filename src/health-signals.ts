// Structured health signals for the platform observability hub (76e).
//
// Every monitored check emits one Cloud Logging line with
// jsonPayload.hauska_health=true so cc-agent-C can filter and group by
// check + service without a shared table or direct hub calls.

import { logger } from "./logger.js";

export type HealthCheck =
  | "healthz"
  | "gate_probe"
  | "scraper_job"
  | "neon_size"
  | "revision_drift";

export type HealthService =
  | "hauska-retrieval-api"
  | "hauska-mcp-server"
  | "cortex-api"
  | "api-server"
  | "smartcity-api"
  | "smartcity-scraper";

export type HealthStatus = "ok" | "warn" | "fail";

export interface HauskaHealthSignal {
  hauska_health: true;
  check: HealthCheck;
  service: HealthService;
  status: HealthStatus;
  value: string;
  threshold: string;
  source: string;
  ts: string;
}

export function emitHauskaHealthSignal(
  fields: Omit<HauskaHealthSignal, "hauska_health" | "ts"> & {
    ts?: string;
  },
): HauskaHealthSignal {
  const signal: HauskaHealthSignal = {
    hauska_health: true,
    ts: fields.ts ?? new Date().toISOString(),
    check: fields.check,
    service: fields.service,
    status: fields.status,
    value: fields.value,
    threshold: fields.threshold,
    source: fields.source,
  };
  logger.info("hauska_health_signal", { ...signal });
  return signal;
}
