// Hauska MCP Server
// Entry point. Sets up Express with the Streamable HTTP transport
// from the official MCP TypeScript SDK and registers the tool surface.

import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { NextFunction, Request, Response } from "express";

import { adminAuthMiddleware, buildAuthMiddleware } from "./auth.js";
import { buildAdminRouter } from "./admin.js";
import { logger } from "./logger.js";
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

async function main() {
  const app = express();
  app.use(express.json());

  // Trust the first proxy hop so req.ip reflects the real client when
  // running behind Cloud Run or Cloud Armor. Set to a higher integer if
  // chained behind multiple proxies.
  app.set("trust proxy", parseInt(process.env.HAUSKA_TRUST_PROXY ?? "1", 10));

  // Health check. Public, no auth.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "hauska-mcp-server",
      version: "0.1.0",
      env: ENV,
    });
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

  // Admin endpoints. Gated by bootstrap key. Mount BEFORE /mcp so a
  // misrouted admin call never reaches the MCP transport. In dev mode
  // the admin router will fail at the DB layer; that is expected.
  app.use("/admin", adminAuthMiddleware, buildAdminRouter());

  // The MCP endpoint. Auth runs first, then the transport handles the
  // JSON-RPC request. The auth context is bound via AsyncLocalStorage so
  // tool handlers (which do not see Express req) can read the caller's
  // tier when shaping per-tier behavior such as attribution surfacing.
  app.post("/mcp", authMiddleware, async (req, res) => {
    const ctx = req.hauska ?? {
      tier: "free_anonymous" as const,
      product: "public" as const,
      rate_limit_id: `ip:${req.ip ?? "unknown"}`,
      remaining_rpm: -1,
      remaining_daily: -1,
    };
    logger.info("mcp_request", {
      method: req.body?.method,
      id: req.body?.id,
      ip: req.ip,
      tier: ctx.tier,
      product: ctx.product,
      key_id: ctx.key_id,
    });
    const { transport, close } = await buildPerRequestMcp();
    res.on("close", () => {
      close().catch((err) =>
        logger.error("mcp_close_error", { error: String(err) }),
      );
    });
    await requestContext.run(ctx, async () => {
      try {
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error("mcp_error", { error: String(err) });
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
    console.error(`Hauska MCP server listening on port ${PORT}`);
    console.error(`Endpoint: http://localhost:${PORT}/mcp`);
    console.error(`Health: http://localhost:${PORT}/health`);
    console.error(`Admin: http://localhost:${PORT}/admin/keys`);
    console.error(`Environment: ${ENV}`);
  });
}

main().catch((err) => {
  console.error("Failed to start Hauska MCP server:", err);
  process.exit(1);
});
