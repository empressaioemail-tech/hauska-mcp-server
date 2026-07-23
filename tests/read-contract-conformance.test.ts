// Read-contract conformance across the live MCP read-tool inventory (F4).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateAtomConformance, ATOM_CONFORMANCE_TARGET_VERSION } from "@hauska/atom-contract/conformance";

import {
  buildEnvelope,
  codexEnvelope,
  getAtomEnvelope,
  listJurisdictionsEnvelope,
  searchAtomsEnvelope,
} from "../src/atom-shape.js";
import { registerTools } from "../src/tools.js";
import { writeRequestLog, type QueryFn } from "../src/log-sink.js";
import { logToolInvocation } from "../src/gtm-observability.js";
import { addLogSink, type LogEntry } from "../src/logger.js";
import { requestContext } from "../src/request-context.js";
import type { AtomSearchResult, JurisdictionStatusSnapshot } from "../src/hauska-client.js";

const READ_TOOLS = new Set([
  "search_atoms",
  "get_atom",
  "get_property_atom_chain",
  "atom_trace",
  "query_jurisdiction",
  "search_permit_atoms",
  "list_jurisdictions",
  "list_property_workspaces",
  "get_property_workspace",
  "list_workspace_share_edges",
  "resolve_place",
  "get_place_layers",
  "get_place_dossier",
  "codex_findings_fetch",
  "codex_briefing_fetch",
  "cortex_attached_document_fetch",
  "cortex_attached_document_list",
  "cortex_bim_model_query",
  "cortex_deliverable_letter_fetch",
  "cortex_deliverable_letter_list",
  "cortex_deliverable_letter_render_download",
  "cortex_deliverable_letter_renders_list",
  "cortex_detail_callout_spec_get",
  "cortex_detail_callout_spec_list",
  "cortex_product_spec_reference_get",
  "cortex_product_spec_reference_list",
  "cortex_response_task_list",
  "cortex_sheet_content_extraction_fetch",
  "generate_property_brief",
  "get_property_brief_run",
  "get_site_drainage",
  "get_site_topography",
  "search_encumbrances",
  "get_restrictions",
  "get_property_detail",
  "get_replacement_cost",
  "get_hazard_profile",
  "get_parcel_polygon",
  "assemble_map_layers",
  "read_atom_calibration",
]);

const WRITE_OR_ACTION_TOOLS = [
  "codex_finding_generation",
  "codex_override_write",
  "codex_snapshot_ingest",
  "cortex_snapshot_register",
  "cortex_ifc_ingest",
  "cortex_briefing_emit",
  "simulate_site_drainage",
];

const SEARCH_RESULT: AtomSearchResult = {
  atomDid: "did:hauska:code-section:bastrop-tx/udc-2024/5.04",
  entityType: "code-section",
  entityId: "bastrop-tx/udc-2024/5.04",
  jurisdictionTenant: "bastrop-tx",
  sectionNumber: "5.04",
  snippet: "Setback requirements.",
  score: 0.92,
};

const JUR: JurisdictionStatusSnapshot = {
  jurisdictionTenant: "bastrop-tx",
  jurisdictionName: "Bastrop, TX",
  currentEditionDid: "did:hauska:code-edition:bastrop-tx/udc-2024",
  qualityBar: "passing",
  top3Score: 0.95,
  sectionNumScore: 1.0,
  crossRefScore: 0.96,
  atomCount: 217,
  lastRefreshedAt: "2026-05-19T08:00:00Z",
  driftStatus: "clean",
};

test("catalog envelope builders attach conformance-valid readContract (1.5.0)", () => {
  for (const envelope of [
    searchAtomsEnvelope({ results: [SEARCH_RESULT] }, { tier: "free_anonymous" }),
    getAtomEnvelope({ atom: null, composition: [] }, { tier: "free" }),
    listJurisdictionsEnvelope({ jurisdictions: [JUR] }, { tier: "developer_pro" }),
    buildEnvelope({ ok: true }, [], { tier: "embedder", readKind: "empty" }),
    codexEnvelope({ findings: [] }, [], { tier: "developer_pro", readKind: "legacy-deterministic" }),
  ]) {
    const conformance = validateAtomConformance({
      tier: "app",
      readContract: envelope.readContract,
      accessPolicy: "public-free",
    });
    assert.equal(conformance.conformanceTargetVersion, ATOM_CONFORMANCE_TARGET_VERSION);
    assert.equal(conformance.ok, true, JSON.stringify(conformance.errors));
    assert.ok(envelope.readContract.axes.calibratedConfidence);
    assert.ok(
      typeof envelope.readContract.axes.calibratedConfidence.estimate === "number",
    );
  }
});

test("live tool inventory: read tools classified; write tools excluded from read set", async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "hauska", version: "0.1.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "read-contract-test", version: "0.1.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();

  assert.ok(tools.length >= 60, `expected >=60 tools on wire, got ${tools.length}`);
  for (const name of READ_TOOLS) {
    assert.ok(
      tools.some((t) => t.name === name),
      `read tool ${name} missing from live inventory`,
    );
  }
  for (const name of WRITE_OR_ACTION_TOOLS) {
    assert.equal(
      READ_TOOLS.has(name),
      false,
      `${name} should not be in read-tool conformance set`,
    );
  }
});

test("logToolInvocation envelope derives atom_ids into request_log sink", async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const query: QueryFn = async (text, values) => {
    calls.push({ text, values: values ?? [] });
    return {};
  };
  const captured: LogEntry[] = [];
  addLogSink((e) => captured.push(e));

  const envelope = searchAtomsEnvelope({ results: [SEARCH_RESULT] }, {
    tier: "free_anonymous",
  });

  requestContext.run(
    {
      tier: "free_anonymous",
      product: "public",
      rate_limit_id: "ip:test",
      remaining_rpm: -1,
      remaining_daily: -1,
      request_id: "req-atom-grain-1",
    },
    () => {
      logToolInvocation({
        tool: "search_atoms",
        envelope,
      });
    },
  );

  const toolCall = captured.find(
    (e) => e.event === "tool_call" && e.tool === "search_atoms",
  );
  assert.ok(toolCall);
  assert.deepEqual(toolCall!.atom_ids, [SEARCH_RESULT.atomDid]);

  await writeRequestLog(query, {
    ts: new Date().toISOString(),
    severity: "INFO",
    level: "info",
    event: "tool_call",
    env: "test",
    request_id: "req-atom-grain-1",
    tool: "search_atoms",
    atom_ids: toolCall!.atom_ids as string[],
  });
  assert.deepEqual(calls[0]!.values[3], [SEARCH_RESULT.atomDid]);
});
