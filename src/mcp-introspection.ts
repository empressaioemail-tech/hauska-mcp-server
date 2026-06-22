// Operator-console MCP introspection (Calibrated Spine Wave 1).
//
// Read-only catalog of the live tool surface plus in-process tool/call
// probes. Uses the same registerTools() path as production /mcp so the
// console always sees the wire-accurate surface.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuthContext } from "./auth.js";
import type { Product } from "./products.js";
import {
  toolGateMetadata,
  type ToolGateKind,
  type ToolProductGate,
} from "./product-gates.js";
import { requestContext } from "./request-context.js";
import { registerTools } from "./tools.js";
import type { Tier } from "./tiers.js";

export type { ToolGateKind, ToolProductGate };

export interface ToolGateMetadata extends ToolProductGate {}

export interface IntrospectionToolSummary extends ToolGateMetadata {
  name: string;
  description: string;
}

export interface IntrospectionToolDetail extends IntrospectionToolSummary {
  input_schema: Record<string, unknown>;
  required: string[];
}

export interface IntrospectionCallAuth {
  product?: Product;
  tier?: Tier | "free_anonymous";
  key_id?: string;
  key_hash?: string;
  jurisdiction_tenant?: string | null;
  platform_internal?: boolean;
}

export interface IntrospectionCallResult {
  tool: string;
  latency_ms: number;
  auth: {
    product: Product;
    tier: Tier | "free_anonymous";
  };
  result: unknown;
  is_error: boolean;
}

interface JsonSchemaProp {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: { type?: string };
}

interface WireTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
}

export { toolGateMetadata };

function defaultAuthContext(
  auth?: IntrospectionCallAuth,
): AuthContext {
  const product = auth?.product ?? "public";
  const tier = auth?.tier ?? (auth?.key_id ? "free" : "free_anonymous");
  return {
    tier,
    product,
    jurisdiction_tenant: auth?.jurisdiction_tenant ?? null,
    platform_internal: auth?.platform_internal ?? false,
    key_id: auth?.key_id,
    key_hash: auth?.key_hash,
    rate_limit_id: auth?.key_id ? `key:${auth.key_id}` : "introspection:anonymous",
    remaining_rpm: -1,
    remaining_daily: -1,
    request_id: `introspection-${Date.now()}`,
  };
}

async function withMcpClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "hauska", version: "0.1.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "hauska-introspection", version: "0.1.0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function summarizeTool(tool: WireTool): IntrospectionToolSummary {
  const gate = toolGateMetadata(tool.name);
  return {
    name: tool.name,
    description: tool.description ?? "",
    ...gate,
  };
}

/** List every registered tool with product gating metadata. */
export async function listIntrospectionTools(): Promise<{
  total: number;
  by_product: Record<Product, number>;
  by_gate: Record<ToolGateKind, number>;
  tools: IntrospectionToolSummary[];
}> {
  const tools = await withMcpClient(async (client) => {
    const { tools: listed } = (await client.listTools()) as {
      tools: WireTool[];
    };
    return listed.sort((a, b) => a.name.localeCompare(b.name));
  });

  const by_product: Record<Product, number> = {
    public: 0,
    codex: 0,
    reporting: 0,
    map: 0,
  };
  const by_gate: Record<ToolGateKind, number> = {
    access_policy: 0,
    identified_caller: 0,
    product_codex: 0,
    product_reporting: 0,
    product_map: 0,
  };

  const summaries = tools.map((t) => {
    const s = summarizeTool(t);
    by_product[s.product]++;
    by_gate[s.gate]++;
    return s;
  });

  return {
    total: summaries.length,
    by_product,
    by_gate,
    tools: summaries,
  };
}

/** Inspect one tool: schema + gating. */
export async function getIntrospectionTool(
  name: string,
): Promise<IntrospectionToolDetail | null> {
  return withMcpClient(async (client) => {
    const { tools } = (await client.listTools()) as { tools: WireTool[] };
    const tool = tools.find((t) => t.name === name);
    if (!tool) return null;
    const summary = summarizeTool(tool);
    const props = tool.inputSchema?.properties ?? {};
    const input_schema: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(props)) {
      input_schema[key] = {
        type: prop.type ?? (prop.enum ? "enum" : "unknown"),
        description: prop.description ?? "",
        ...(prop.enum ? { enum: prop.enum } : {}),
        ...(prop.default !== undefined ? { default: prop.default } : {}),
      };
    }
    return {
      ...summary,
      input_schema,
      required: tool.inputSchema?.required ?? [],
    };
  });
}

/** Execute a live in-process tools/call with optional auth simulation. */
export async function callIntrospectionTool(
  name: string,
  args: Record<string, unknown>,
  auth?: IntrospectionCallAuth,
): Promise<IntrospectionCallResult> {
  const ctx = defaultAuthContext(auth);
  const startedAt = Date.now();

  const result = await requestContext.run(ctx, async () =>
    withMcpClient(async (client) => {
      return client.callTool({ name, arguments: args });
    }),
  );

  const isError =
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: boolean }).isError === true;

  return {
    tool: name,
    latency_ms: Date.now() - startedAt,
    auth: { product: ctx.product, tier: ctx.tier },
    result,
    is_error: isError,
  };
}
