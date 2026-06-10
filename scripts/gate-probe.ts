#!/usr/bin/env node
// Scheduled gate-availability probe for hauska-mcp-server (76e).
//
// Usage:
//   GATE_PROBE_BASE_URL=https://... \
//   GATE_PROBE_CODEX_KEY=hk_pro_... \
//   npx tsx scripts/gate-probe.ts
//
// Exits 0 when all three gate cases pass; 1 otherwise. Emits the pinned
// hauska_health Cloud Logging line via stdout JSON.

import { emitGateProbeSignal, runGateProbe } from "../src/gate-probe.js";

async function main(): Promise<void> {
  const baseUrl =
    process.env.GATE_PROBE_BASE_URL ??
    process.env.MCP_BASE_URL ??
    "http://localhost:3000";
  const codexProbeKey = process.env.GATE_PROBE_CODEX_KEY;

  const result = await runGateProbe({ baseUrl, codexProbeKey });
  emitGateProbeSignal(result);

  const output = {
    ...result,
    source: "scripts/gate-probe.ts",
  };
  console.log(JSON.stringify(output, null, 2));

  if (result.status !== "ok") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
