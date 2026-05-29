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
import type { Product } from "./products.js";

export const requestContext = new AsyncLocalStorage<AuthContext>();

type EnvelopeTier = "free_anonymous" | "free" | "developer_pro" | "team" | "embedder";

export function getCurrentTier(): EnvelopeTier {
  const ctx = requestContext.getStore();
  return ctx?.tier ?? "free_anonymous";
}

// Default 'public' when no context is bound. A tool called outside the
// request path (e.g. a unit test exercising the handler directly) sees
// the public-substrate product, which is the conservative default since
// the public catalog tools accept any product.
export function getCurrentProduct(): Product {
  const ctx = requestContext.getStore();
  return ctx?.product ?? "public";
}

// The correlation id of the in-flight /mcp request. The logger reads
// this to stamp every line emitted during request handling, so tool
// handlers do not need to thread the id themselves. Undefined outside
// the request path (startup logs, direct-handler unit tests).
export function getCurrentRequestId(): string | undefined {
  return requestContext.getStore()?.request_id;
}

// Full auth context for tool handlers that need caller identity (for
// owner/collaborator access checks on backend read APIs).
export function getCurrentAuthContext(): AuthContext | undefined {
  return requestContext.getStore();
}
