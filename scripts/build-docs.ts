// Renders docs/content/*.md into a static HTML site at docs/site/.
//
// No site framework: Markdown rendered with `marked`, wrapped in one
// template with an inline stylesheet and a sidebar nav. The output is
// served by the Express app at /docs (see src/index.ts). Run via
// `npm run build:docs`, after generate-tool-reference.ts.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { marked } from "marked";

const CONTENT_DIR = fileURLToPath(new URL("../docs/content", import.meta.url));
const SITE_DIR = fileURLToPath(new URL("../docs/site", import.meta.url));

// Nav order and friendly labels. Files not listed append after these.
const NAV: Array<[string, string]> = [
  ["mcp", "MCP home"],
  ["index", "Overview"],
  ["tool-reference", "Tool reference"],
  ["capability-matrix", "Capability matrix"],
  ["coverage", "Central TX coverage"],
  ["examples", "Example queries"],
  ["quickstart-claude-desktop", "Quickstart: Claude Desktop"],
  ["quickstart-claude-code", "Quickstart: Claude Code"],
  ["quickstart-cursor", "Quickstart: Cursor"],
  ["quickstart-sdk", "Quickstart: SDK agent"],
  ["tiers", "Tiers and limits"],
  ["pricing", "Pricing"],
  ["attribution", "Attribution"],
  ["commercial-use", "Commercial use"],
  ["terms", "Terms of Service"],
  ["privacy", "Privacy"],
];

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; background: #fff; }
.layout { display: flex; min-height: 100vh; }
nav { flex: 0 0 240px; background: #f6f7f8; border-right: 1px solid #e4e6e8; padding: 24px 16px; }
nav .brand { font-weight: 700; font-size: 15px; margin-bottom: 16px; }
nav a { display: block; padding: 5px 8px; color: #38424c; text-decoration: none; border-radius: 5px; font-size: 14px; }
nav a:hover { background: #e9ebed; }
nav a.active { background: #1a5fb4; color: #fff; }
main { flex: 1; padding: 40px 56px; max-width: 860px; }
h1 { font-size: 30px; margin: 0 0 8px; }
h2 { font-size: 22px; margin: 36px 0 10px; border-bottom: 1px solid #e4e6e8; padding-bottom: 4px; }
h3 { font-size: 17px; margin: 26px 0 6px; }
code { background: #f0f1f2; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
pre { background: #f6f7f8; border: 1px solid #e4e6e8; border-radius: 7px; padding: 14px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
th, td { border: 1px solid #e4e6e8; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f6f7f8; }
a { color: #1a5fb4; }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e4e6e8; font-size: 13px; color: #6b7178; }
@media (prefers-color-scheme: dark) {
  body { color: #e6e6e6; background: #14171a; }
  nav { background: #1b1f23; border-color: #2b3036; }
  nav a { color: #b8c0c8; } nav a:hover { background: #262b30; }
  h2, footer { border-color: #2b3036; }
  code, pre { background: #1b1f23; } pre { border-color: #2b3036; }
  th { background: #1b1f23; } th, td { border-color: #2b3036; }
}
`;

function label(slug: string): string {
  const hit = NAV.find(([s]) => s === slug);
  return hit ? hit[1] : slug;
}

function navHtml(current: string): string {
  const slugs = readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  const ordered = [
    ...NAV.map(([s]) => s).filter((s) => slugs.includes(s)),
    ...slugs.filter((s) => !NAV.some(([n]) => n === s)).sort(),
  ];
  const links = ordered
    .map((s) => {
      const cls = s === current ? ' class="active"' : "";
      return `    <a href="${s}.html"${cls}>${label(s)}</a>`;
    })
    .join("\n");
  return `  <nav>\n    <div class="brand">Hauska MCP Server</div>\n${links}\n  </nav>`;
}

function page(slug: string, body: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Hauska MCP Server</title>
<style>${STYLE}</style>
</head>
<body>
<div class="layout">
${navHtml(slug)}
  <main>
${body}
  <footer>Hauska MCP Server documentation. Powered by Hauska Engine — hauska.dev</footer>
  </main>
</div>
</body>
</html>
`;
}

function titleOf(md: string, slug: string): string {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? m[1]!.trim() : label(slug);
}

const COVERAGE_API_URL =
  process.env.COVERAGE_API_URL ??
  "https://api.hauska.dev/api/brokerage/v1/coverage";

const MCP_TRANSPORT = "https://mcp.hauska.dev/mcp";
const DOCS_HOME = "https://hauska.dev/mcp";

function writeAgentDiscoveryFiles(): void {
  const llms = `# Hauska MCP Server
> Texas building code MCP + property workspace read API (Central TX pilot for place tools).

- MCP endpoint: ${MCP_TRANSPORT}
- Documentation: ${DOCS_HOME}
- ICP: Agent builders shipping construction-tech, permitting, diligence, and civic agents
- Public catalog: search_atoms, get_atom, list_jurisdictions, query_jurisdiction, search_permit_atoms (no API key)
- Product reads: resolve_place, get_place_layers, get_place_dossier, property workspace tools (API key)
- Coverage: ${COVERAGE_API_URL}
- Support: support@hauska.dev
- Attribution: Powered by Hauska Engine — hauska.dev (free tier)
`;

  const agents = `# Hauska agents discovery
contact: support@hauska.dev
docs: ${DOCS_HOME}
mcp: ${MCP_TRANSPORT}
llms_txt: https://hauska.dev/llms.txt
coverage: ${COVERAGE_API_URL}
capabilities: ${DOCS_HOME}/capability-matrix.html
`;

  writeFileSync(`${SITE_DIR}/llms.txt`, llms);
  mkdirSync(`${SITE_DIR}/.well-known`, { recursive: true });
  writeFileSync(`${SITE_DIR}/.well-known/agents.txt`, agents);
}

function main(): void {
  mkdirSync(SITE_DIR, { recursive: true });
  const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.error("build-docs: no .md files in docs/content");
    process.exit(1);
  }
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    let md = readFileSync(`${CONTENT_DIR}/${f}`, "utf8");
    if (slug === "coverage") {
      md = md.replace("__COVERAGE_API_URL__", COVERAGE_API_URL);
    }
    const body = marked.parse(md, { async: false }) as string;
    writeFileSync(`${SITE_DIR}/${slug}.html`, page(slug, body, titleOf(md, slug)));
  }
  // hauska.dev/mcp landing → mcp.html
  writeFileSync(
    `${SITE_DIR}/mcp-index.html`,
    readFileSync(`${SITE_DIR}/mcp.html`, "utf8"),
  );
  writeAgentDiscoveryFiles();
  console.error(`build-docs: rendered ${files.length} page(s) to docs/site/`);
}

main();
