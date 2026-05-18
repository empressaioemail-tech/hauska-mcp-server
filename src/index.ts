// Hauska MCP Server
// Entry point. Sets up Express with the Streamable HTTP transport
// from the official MCP TypeScript SDK and registers the tool surface.

import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { registerTools } from "./tools.js";
import { authMiddleware } from "./auth.js";
import { logger } from "./logger.js";

dotenv.config();

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const ENV = process.env.HAUSKA_ENV ?? "development";

async function main() {
  const app = express();
  app.use(express.json());

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

  // Register all five tools against the server.
  registerTools(server);

  // Create the Streamable HTTP transport.
  // sessionIdGenerator: undefined means stateless. Sessions can be added in v2.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Wire the transport into the server.
  await server.connect(transport);

  // The MCP endpoint. Auth middleware runs first, then the transport handles the request.
  app.post("/mcp", authMiddleware, async (req, res) => {
    try {
      logger.info("mcp_request", {
        method: req.body?.method,
        id: req.body?.id,
        ip: req.ip,
        tier: (req as any).tier ?? "free",
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
    console.error(`Environment: ${ENV}`);
  });
}

main().catch((err) => {
  console.error("Failed to start Hauska MCP server:", err);
  process.exit(1);
});
