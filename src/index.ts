// Hauska MCP Server
// Entry point. Sets up Express with the Streamable HTTP transport
// from the official MCP TypeScript SDK and registers the tool surface.

import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { adminAuthMiddleware, buildAuthMiddleware } from "./auth.js";
import { buildAdminRouter } from "./admin.js";
import { logger } from "./logger.js";
import { buildUpstashStore } from "./rate-limit.js";
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

  // Create the MCP server instance.
  const server = new McpServer({
    name: "hauska",
    version: "0.1.0",
  });

  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  // Rate-limit store: Upstash in prod; allow tests / local dev to opt
  // out by setting HAUSKA_RATE_LIMIT=disabled (uses no-op decisions).
  // For full local-dev rate-limiting use a free Upstash dev DB.
  const rateLimitStore = buildUpstashStore();
  const authMiddleware = buildAuthMiddleware(rateLimitStore);

  // Admin endpoints. Gated by bootstrap key. Mount BEFORE /mcp so a
  // misrouted admin call never reaches the MCP transport.
  app.use("/admin", adminAuthMiddleware, buildAdminRouter());

  // The MCP endpoint. Auth runs first, then the transport handles the
  // JSON-RPC request.
  app.post("/mcp", authMiddleware, async (req, res) => {
    try {
      logger.info("mcp_request", {
        method: req.body?.method,
        id: req.body?.id,
        ip: req.ip,
        tier: req.hauska?.tier ?? "free_anonymous",
        key_id: req.hauska?.key_id,
      });
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
