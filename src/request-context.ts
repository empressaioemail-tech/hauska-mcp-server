// Request-scoped context threaded via AsyncLocalStorage.
//
// The MCP SDK tool handler does not receive the Express `req` object;
// tools.ts therefore cannot read `req.hauska` directly to decide
// per-tier behavior (e.g. attribution surface rules). AsyncLocalStorage
// lets us bind tier-and-auth info around the transport.handleRequest()
// call in index.ts and read it from tool handlers without changing
// every handler's signature.
//
// Safe default when no context is bound: free_anonymous. This means a
// tool invoked outside the request path (e.g. in a unit test that calls
// the handler directly) gets the attribution-bearing free-tier shape,
// which is the safer default.

import { AsyncLocalStorage } from "node:async_hooks";

import type { AuthContext } from "./auth.js";

export const requestContext = new AsyncLocalStorage<AuthContext>();

type EnvelopeTier = "free_anonymous" | "free" | "developer_pro" | "team" | "embedder";

export function getCurrentTier(): EnvelopeTier {
  const ctx = requestContext.getStore();
  return ctx?.tier ?? "free_anonymous";
}
