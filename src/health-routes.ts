import type { RequestHandler } from "express";

import { buildHealthReport, type HealthReport } from "./health.js";
import {
  buildReadinessReport,
  readinessHttpStatus,
  type ReadinessReport,
} from "./health-ready.js";
import { logger } from "./logger.js";

type HealthBuilder = () => Promise<HealthReport>;
type ReadinessBuilder = () => Promise<ReadinessReport>;

const ENV = process.env.HAUSKA_ENV ?? "development";

export function createHealthHandler(
  buildReport: HealthBuilder = buildHealthReport,
): RequestHandler {
  return async (_req, res) => {
    try {
      // Deliberately omit res.status(...): /health is liveness and remains
      // HTTP 200 even when the dependency rollup says degraded.
      res.json(await buildReport());
    } catch (err) {
      logger.error("health_report_error", { error: String(err) });
      res.json({
        status: "degraded",
        service: "hauska-mcp-server",
        version: "0.1.0",
        env: ENV,
        error: "health report failed",
      });
    }
  };
}

export function createReadinessHandler(
  buildReport: ReadinessBuilder = buildReadinessReport,
): RequestHandler {
  return async (_req, res) => {
    try {
      const report = await buildReport();
      res.status(readinessHttpStatus(report)).json(report);
    } catch (err) {
      logger.error("health_ready_report_error", { error: String(err) });
      res.status(503).json({
        status: "not_ready",
        service: "hauska-mcp-server",
        version: "0.1.0",
        env: ENV,
        error: "readiness report failed",
      });
    }
  };
}
