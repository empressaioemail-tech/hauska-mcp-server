// Generates docs/content/tool-reference.md from the live Zod tool
// schemas. Stands up the real tool surface on an in-process McpServer,
// pairs it with an in-process MCP client, calls tools/list, and renders
// the result. The reference is therefore always exactly what an agent
// sees on the wire; it cannot drift from the code.
//
// Run via `npm run build:docs` (which runs this, then build-docs.ts).

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "../src/tools.js";

interface JsonSchemaProp {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  items?: { type?: string };
}

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
}

function productOf(name: string): "Public catalog" | "Codex" | "Cortex" {
  if (name.startsWith("codex_")) return "Codex";
  if (name.startsWith("cortex_")) return "Cortex";
  return "Public catalog";
}

function propType(p: JsonSchemaProp): string {
  if (p.enum) return p.enum.map((v) => `\`${String(v)}\``).join(" / ");
  if (p.type === "array") return `${p.items?.type ?? "any"}[]`;
  return p.type ?? "any";
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderTool(tool: ToolDef): string {
  const lines: string[] = [`### \`${tool.name}\``, ""];
  if (tool.description) lines.push(tool.description, "");
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) {
    lines.push("_No parameters._", "");
    return lines.join("\n");
  }
  lines.push("| Parameter | Type | Required | Description |");
  lines.push("|---|---|---|---|");
  for (const n of names) {
    const p = props[n]!;
    const req = required.has(n) ? "yes" : "no";
    let desc = p.description ?? "";
    if (p.default !== undefined) desc += ` Default: \`${String(p.default)}\`.`;
    lines.push(
      `| \`${n}\` | ${escapeCell(propType(p))} | ${req} | ${escapeCell(desc)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "hauska", version: "0.1.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "hauska-docgen", version: "0.1.0" });
  await client.connect(clientTransport);

  const { tools } = (await client.listTools()) as { tools: ToolDef[] };
  await client.close();
  await server.close();

  const groups: Record<string, ToolDef[]> = {
    "Public catalog": [],
    Codex: [],
    Cortex: [],
  };
  for (const t of tools) groups[productOf(t.name)]!.push(t);
  for (const g of Object.values(groups)) g.sort((a, b) => a.name.localeCompare(b.name));

  const intro: Record<string, string> = {
    "Public catalog":
      "Layer 1 jurisdiction and building-code retrieval. No API key " +
      "required; these tools are open to every caller.",
    Codex:
      "Plan-review tools. Require a `codex`-product API key.",
    Cortex:
      "Design-accelerator tools. Require a `cortex`-product API key.",
  };

  const out: string[] = [
    "# Tool reference",
    "",
    `The Hauska MCP Server exposes ${tools.length} tools. This page is ` +
      "generated directly from the server's Zod input schemas, so it is " +
      "always exactly the surface an agent sees on the wire.",
    "",
  ];
  for (const [group, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    out.push(`## ${group} (${list.length})`, "", intro[group] ?? "", "");
    for (const t of list) out.push(renderTool(t));
  }

  const outPath = fileURLToPath(
    new URL("../docs/content/tool-reference.md", import.meta.url),
  );
  mkdirSync(fileURLToPath(new URL("../docs/content", import.meta.url)), {
    recursive: true,
  });
  writeFileSync(outPath, out.join("\n"));
  console.error(`Wrote ${outPath} (${tools.length} tools)`);
}

main().catch((err) => {
  console.error("generate-tool-reference failed:", err);
  process.exit(1);
});
