// Hauska MCP Server
// Entry point. Sets up Express with the Streamable HTTP transport
// from the official MCP TypeScript SDK and registers the tool surface.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { NextFunction, Request, Response } from "express";

import { adminAuthMiddleware, buildAuthMiddleware, type AuthContext } from "./auth.js";
import { buildAdminRouter } from "./admin.js";
import { buildHealthReport } from "./health.js";
import { createLogSink, type LogSinkHandle } from "./log-sink.js";
import { addLogSink, logger } from "./logger.js";
import { metrics } from "./metrics.js";
import { isProduct, type Product } from "./products.js";
import {
  buildUpstashStore,
  MemoryRateLimitStore,
  type RateLimitStore,
} from "./rate-limit.js";
import { requestContext } from "./request-context.js";
import { registerTools } from "./tools.js";

dotenv.config();

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const ENV = process.env.HAUSKA_ENV ?? "development";

// Bounds the params payload that lands in the structured entry log. Full
// request payloads (e.g. base64 IFC uploads) are captured by the GCS
// raw-payload sink (Stream 2C.2), not the structured index.
function summarizeParams(params: unknown): unknown {
  if (params === undefined || params === null) return params;
  try {
    const json = JSON.stringify(params);
    if (json.length > 2048) {
      return { _truncated: true, _bytes: json.length, preview: json.slice(0, 2048) };
    }
    return params;
  } catch {
    return { _unserializable: true };
  }
}

async function main() {
  const app = express();
  app.use(express.json());

  // Trust the first proxy hop so req.ip reflects the real client when
  // running behind Cloud Run or Cloud Armor. Set to a higher integer if
  // chained behind multiple proxies.
  app.set("trust proxy", parseInt(process.env.HAUSKA_TRUST_PROXY ?? "1", 10));

  // Static docs site. Built by `npm run build:docs` into docs/site and
  // copied into the image; served at /docs (mcp.hauska.dev/docs). The
  // `extensions` option lets /docs/tiers resolve to tiers.html.
  app.use(
    "/docs",
    express.static(fileURLToPath(new URL("../docs/site", import.meta.url)), {
      extensions: ["html"],
    }),
  );

  // Health check. Public, no auth. Always HTTP 200 while the process is
  // alive; the body's `status` field reflects the dependency rollup, so
  // the Cloud Run liveness probe stays green even when a downstream
  // dependency is down.
  app.get("/health", async (_req, res) => {
    try {
      res.json(await buildHealthReport());
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
  });

  // Per-request McpServer + transport factory. Stateless mode
  // (sessionIdGenerator: undefined) cannot reuse a transport across
  // requests — line 140 of the SDK's webStandardStreamableHttp.js
  // throws "Stateless transport cannot be reused across requests" on
  // the second call. So we build a fresh server + transport on every
  // /mcp POST. Tool registration is cheap (no I/O, just Zod schema
  // attachment), so per-request construction is fine.
  async function buildPerRequestMcp(): Promise<{
    transport: StreamableHTTPServerTransport;
    close: () => Promise<void>;
  }> {
    const mcpServer = new McpServer({
      name: "hauska",
      version: "0.1.0",
    });
    registerTools(mcpServer);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    return {
      transport,
      close: async () => {
        await transport.close();
        await mcpServer.close();
      },
    };
  }

  // Dev mode: HAUSKA_DEV_MODE=true skips Postgres + Upstash provisioning
  // and treats every request as free-tier anonymous. Useful for local
  // end-to-end testing with MCP Inspector against a local engine without
  // standing up paid-tier auth infrastructure. Production must leave it
  // unset.
  const devMode = process.env.HAUSKA_DEV_MODE === "true";

  let rateLimitStore: RateLimitStore;
  let authMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => unknown;

  if (devMode) {
    logger.warn("dev_mode_enabled", {
      note: "HAUSKA_DEV_MODE=true. Auth + rate limit disabled; every request treated as free_anonymous. Do NOT use in production.",
    });
    rateLimitStore = new MemoryRateLimitStore();
    // Dev mode honors an optional X-Hauska-Dev-Product header so a
    // local developer can exercise codex_* / cortex_* tools without
    // standing up the api_keys table. Missing / unknown header defaults
    // to 'public' which matches production-anonymous behavior.
    authMiddleware = (req, _res, next) => {
      const headerRaw = (req.headers["x-hauska-dev-product"] as
        | string
        | undefined)?.trim();
      const product: Product =
        headerRaw && isProduct(headerRaw) ? headerRaw : "public";
      req.hauska = {
        tier: "free_anonymous",
        product,
        rate_limit_id: `dev:${req.ip ?? "unknown"}`,
        remaining_rpm: -1,
        remaining_daily: -1,
      };
      next();
    };
  } else {
    rateLimitStore = buildUpstashStore();
    authMiddleware = buildAuthMiddleware(rateLimitStore);
  }

  // Structured-log persistence (Stream 2C.2). Production registers the
  // Postgres request_log index sink, plus a GCS archive sink when
  // GCS_LOG_BUCKET is set. Dev mode keeps the console sink alone.
  let logSink: LogSinkHandle | null = null;
  if (!devMode) {
    let gcsWriter = null;
    const gcsBucket = process.env.GCS_LOG_BUCKET;
    if (gcsBucket) {
      try {
        const { createGcsWriter } = await import("./gcs-writer.js");
        gcsWriter = createGcsWriter(gcsBucket);
      } catch (err) {
        logger.error("gcs_writer_init_failed", { error: String(err) });
      }
    }
    logSink = createLogSink({ gcs: gcsWriter });
    addLogSink(logSink.sink);
    logger.info("log_sink_registered", {
      postgres: true,
      gcs: gcsWriter !== null,
    });
  }

  // Admin endpoints. Gated by bootstrap key. Mount BEFORE /mcp so a
  // misrouted admin call never reaches the MCP transport. In dev mode
  // the admin router will fail at the DB layer; that is expected.
  app.use("/admin", adminAuthMiddleware, buildAdminRouter());

  // The MCP endpoint. Auth runs first, then the transport handles the
  // JSON-RPC request. The auth context is bound via AsyncLocalStorage so
  // tool handlers (which do not see Express req) can read the caller's
  // tier when shaping per-tier behavior such as attribution surfacing.
  app.post("/mcp", authMiddleware, async (req, res) => {
    // Generate the correlation id before anything else and bind it into
    // the request context so every downstream log line carries it.
    const requestId = randomUUID();
    const startedAt = Date.now();
    const base: AuthContext = req.hauska ?? {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: `ip:${req.ip ?? "unknown"}`,
      remaining_rpm: -1,
      remaining_daily: -1,
    };
    const ctx: AuthContext = { ...base, request_id: requestId };

    // Canonical entry log (per Stream 2C log shape).
    logger.info("request_received", {
      request_id: requestId,
      method: req.body?.method,
      params: summarizeParams(req.body?.params),
      ip: req.ip,
      key_hash: ctx.key_hash ?? null,
      tier: ctx.tier,
      product: ctx.product,
    });

    // Canonical response log + metrics, recorded once the response is
    // fully flushed.
    res.on("finish", () => {
      const latencyMs = Date.now() - startedAt;
      const ok = res.statusCode < 500;
      metrics.recordRequest(latencyMs, ok);
      logger.info("request_completed", {
        request_id: requestId,
        method: req.body?.method,
        response_status: res.statusCode,
        latency_ms: latencyMs,
        tier: ctx.tier,
      });
    });

    const { transport, close } = await buildPerRequestMcp();
    res.on("close", () => {
      close().catch((err) =>
        logger.error("mcp_close_error", {
          request_id: requestId,
          error: String(err),
        }),
      );
    });
    await requestContext.run(ctx, async () => {
      try {
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error("mcp_error", {
          request_id: requestId,
          error: String(err),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: req.body?.id ?? null,
          });
        }
      }
    });
  });

  app.listen(PORT, () => {
    logger.info("server_started", {
      port: PORT,
      env: ENV,
      endpoint: "/mcp",
      health: "/health",
      admin: "/admin/keys",
      dev_mode: devMode,
    });
  });

  // Cloud Run sends SIGTERM before stopping an instance. Flush the
  // pending GCS log batch so the tail of the archive is not lost.
  process.on("SIGTERM", () => {
    logger.info("sigterm_received", {});
    const done = (): void => process.exit(0);
    if (logSink) {
      logSink.stop();
      logSink.flush().then(done, done);
    } else {
      done();
    }
  });
}

main().catch((err) => {
  console.error("Failed to start Hauska MCP server:", err);
  process.exit(1);
});
