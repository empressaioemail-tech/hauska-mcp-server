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

import {
  adminAuthMiddleware,
  buildAuthMiddleware,
  whoamiHandler,
  type AuthContext,
} from "./auth.js";
import { buildAdminRouter } from "./admin.js";
import { emitGateProbeSignal, runGateProbe } from "./gate-probe.js";
import { createHealthHandler, createReadinessHandler } from "./health-routes.js";
import { buildHealthzReportAndEmit } from "./healthz.js";
import { createLogSink, type LogSinkHandle } from "./log-sink.js";
import { addLogSink, logger } from "./logger.js";
import { getMeteringSummary } from "./metering-summary.js";
import { metrics } from "./metrics.js";
import { isProduct, type Product } from "./products.js";
import {
  buildPrimaryRateLimitStore,
  getRateLimitRuntimeState,
  MemoryRateLimitStore,
  RATE_LIMIT_OUTAGE_POLICY,
  ResilientRateLimitStore,
  resolveRateLimitStoreKind,
  setRateLimitRuntimeState,
  type RateLimitStore,
} from "./rate-limit.js";
import { requestContext } from "./request-context.js";
import { getSourceObligationLedger } from "./source-obligation-reader.js";
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

  const docsRoot = fileURLToPath(new URL("../docs/site", import.meta.url));
  const docsStatic = express.static(docsRoot, { extensions: ["html"] });

  // Static docs site. Built by `npm run build:docs` into docs/site.
  // Served at /docs (mcp.hauska.dev/docs) and mirrored paths for hauska.dev/mcp DNS.
  app.use("/docs", docsStatic);

  // hauska.dev root discovery files (E2)
  app.get("/llms.txt", (_req, res) => {
    res.sendFile(`${docsRoot}/llms.txt`);
  });
  app.get("/.well-known/agents.txt", (_req, res) => {
    res.sendFile(`${docsRoot}/.well-known/agents.txt`);
  });

  // Canonical docs URL alias (E1): /mcp → MCP landing page
  app.get(["/mcp", "/mcp/"], (_req, res) => {
    res.redirect(302, "/docs/mcp.html");
  });
  app.get("/mcp/coverage", (_req, res) => {
    res.redirect(302, "/docs/coverage.html");
  });

  // Health check. Public, no auth. Always HTTP 200 while the process is
  // alive; the body's `status` field reflects the dependency rollup, so
  // the Cloud Run liveness probe stays green even when a downstream
  // dependency is down.
  app.get("/health", createHealthHandler());

  // Readiness check. Public, no auth. This is separate from /health because
  // Cloud Run uses /health for liveness. Only a DOWN engine/retrieval API or
  // Postgres dependency returns 503; skipped, degraded, and non-critical
  // dependencies leave readiness green.
  app.get("/health/ready", createReadinessHandler());

  // Normalized health surface for the platform observability sprint (76e).
  // Public, no auth. Emits one hauska_health structured log line per check.
  app.get("/healthz", async (_req, res) => {
    try {
      res.json(await buildHealthzReportAndEmit());
    } catch (err) {
      logger.error("healthz_report_error", { error: String(err) });
      res.json({
        status: "degraded",
        deps: {
          retrieval_api: "down",
          legacy_backend: "down",
        },
        revision: process.env.K_REVISION ?? "local",
        error: "healthz report failed",
      });
    }
  });

  // Gate-availability synthetic probe (76e). Loops back to /mcp on the
  // same instance so Cloud Scheduler and uptime-adjacent checks avoid
  // external Streamable-HTTP client quirks. Public read-only; alert-only.
  app.get("/gate-probe", async (_req, res) => {
    try {
      const baseUrl = `http://127.0.0.1:${PORT}`;
      const result = await runGateProbe({
        baseUrl,
        codexProbeKey: process.env.GATE_PROBE_CODEX_KEY,
      });
      emitGateProbeSignal(result);
      res.status(result.status === "ok" ? 200 : 503).json(result);
    } catch (err) {
      logger.error("gate_probe_error", { error: String(err) });
      res.status(503).json({
        status: "fail",
        error: "gate probe failed",
        detail: String(err).slice(0, 200),
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
    // local developer can exercise codex / reporting / map tools without
    // standing up the api_keys table. Missing / unknown header defaults
    // to 'public' which matches production-anonymous behavior.
    authMiddleware = (req, _res, next) => {
      const headerRaw = (req.headers["x-hauska-dev-product"] as
        | string
        | undefined)?.trim();
      const product: Product =
        headerRaw && isProduct(headerRaw) ? headerRaw : "public";
      const tenantRaw = (req.headers["x-hauska-dev-tenant"] as
        | string
        | undefined)?.trim();
      const platformInternal =
        (req.headers["x-hauska-dev-platform-internal"] as string | undefined)
          ?.trim()
          .toLowerCase() === "true";
      req.hauska = {
        tier: "free_anonymous",
        product,
        jurisdiction_tenant: tenantRaw && tenantRaw.length > 0 ? tenantRaw : null,
        platform_internal: platformInternal,
        rate_limit_id: `dev:${req.ip ?? "unknown"}`,
        remaining_rpm: -1,
        remaining_daily: -1,
      };
      next();
    };
  } else {
    let primaryStore: RateLimitStore;
    try {
      const kind = resolveRateLimitStoreKind();
      primaryStore = buildPrimaryRateLimitStore();
      setRateLimitRuntimeState({ primaryKind: kind, memoryFallback: false });
    } catch (err) {
      const logData = {
        error: String(err),
        fallback: "MemoryRateLimitStore",
        note:
          ENV === "production"
            ? "PRODUCTION FAIL-LOUD: Postgres rate-limit store unavailable. Rate limits are per-instance only, NOT shared across Cloud Run instances. Set DATABASE_URL and run migration 010_rate_limit_counters."
            : "Using in-memory rate limiter. Limits are per-instance only.",
      };
      // Production degrading to a per-instance limiter is a real incident
      // (the whole point of Cloud Run autoscaling is multiple instances,
      // each of which would enforce its own separate budget) — log it at
      // error, not warn, so it surfaces in alerting instead of getting lost.
      if (ENV === "production") {
        logger.error("rate_limit_store_env_missing", logData);
      } else {
        logger.warn("rate_limit_store_env_missing", logData);
      }
      primaryStore = new MemoryRateLimitStore();
      setRateLimitRuntimeState({ primaryKind: "memory", memoryFallback: true });
    }
    rateLimitStore = new ResilientRateLimitStore(primaryStore, logger);
    logger.info("rate_limit_store_ready", {
      ...getRateLimitRuntimeState(),
      outage_policy: RATE_LIMIT_OUTAGE_POLICY,
    });
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

  // Metering summary endpoint (A4c). Gated by platform_internal key.
  // Mounted OUTSIDE /admin so the command-center proxy (which blocks
  // /admin/*) can reach it with its reporting key.
  app.get("/metering/summary", authMiddleware, getMeteringSummary);

  // Source obligation ledger reader (G-111, gap 2). Same platform_internal
  // gate as /metering/summary. Scoped lookups only -- see
  // source-obligation-reader.ts for why an unfiltered read is refused.
  app.get(
    "/obligations/source-ledger",
    authMiddleware,
    getSourceObligationLedger,
  );

  // G-11: Dashboards resolves X-Hauska-Key here. Plain JSON, no key
  // material. Anonymous callers get anonymous:true. Unknown keys 401
  // from authMiddleware before this handler runs.
  app.get("/auth/whoami", authMiddleware, whoamiHandler);

  // The MCP endpoint. Auth runs first, then the transport handles the
  // JSON-RPC request. The auth context is bound via AsyncLocalStorage so
  // tool handlers (which do not see Express req) can read the caller's
  // tier when shaping per-tier behavior such as attribution surfacing.
  app.post("/mcp", authMiddleware, async (req, res) => {
    // Generate the correlation id before anything else and bind it into
    // the request context so every downstream log line carries it.
    const requestId = randomUUID();
    // G-111 gap 1: this is the same id source_obligation_ledger.request_id
    // gets for any accrual this call produces (source-obligation-meter.ts
    // reads it back via getCurrentRequestId()). Until this line existed, a
    // caller had no way to learn it -- not in the JSON-RPC body, not in a
    // header -- so a consumer wanting to reconcile its own cache against the
    // ledger (plan-review's source_obligation_ledger reconciliation,
    // hauska-mcp-server PR #8 upstream) had nothing to join on. Set before
    // the transport writes anything, so it survives whatever headers the
    // transport itself sets (Node merges prior setHeader calls with a later
    // writeHead unless the same header name is repeated).
    res.setHeader("x-hauska-request-id", requestId);
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

  // Tenancy T1 gate-signed context — log startup warning if the signing
  // key is unset. Never crash; the gate simply skips stamping signed
  // contexts when the key is absent (behavior identical to today).
  if (!process.env.GATE_CONTEXT_SIGNING_KEY?.trim()) {
    logger.warn("gate_context_signing_key_unset", {
      message:
        "GATE_CONTEXT_SIGNING_KEY is not configured. The gate will forward " +
        "plain tenant headers without signing them. Upstream services will " +
        "not be able to verify tenant context. Set GATE_CONTEXT_SIGNING_KEY " +
        "to enable T1 gate-signed tenant context.",
    });
  }

  app.listen(PORT, () => {
    logger.info("server_started", {
      port: PORT,
      env: ENV,
      endpoint: "/mcp",
      health: "/health",
      readiness: "/health/ready",
      healthz: "/healthz",
      whoami: "/auth/whoami",
      gate_probe: "/gate-probe",
      admin: "/admin/keys",
      admin_introspection: "/admin/introspection/tools",
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
