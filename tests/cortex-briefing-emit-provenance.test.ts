// cortex_briefing_emit provenance class regression.
//
// The briefing-generation kickoff must tag its envelope as brief-run,
// not finding-generation-run, so agents tracing lineage see the correct
// atom class.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { codexEnvelope, codexProvenance } from "../src/atom-shape.js";

test("cortex_briefing_emit envelope carries brief-run provenance class", () => {
  const generationId = "br-gen-abc-123";
  const engagementId = "11111111-1111-4111-8111-111111111111";
  const response = {
    generationId,
    state: "pending" as const,
    alreadyInFlight: undefined,
  };

  const env = codexEnvelope(
    response,
    codexProvenance({
      atomKind: "brief-run",
      rowId: response.generationId,
      jurisdictionTenant: "legacy",
      sourcePath: `/api/engagements/${engagementId}/briefing/generate`,
    }),
    { tier: "developer_pro" },
  );

  assert.equal(env.atoms.length, 1);
  assert.equal(env.atoms[0]!.entityType, "brief-run");
  assert.equal(env.atoms[0]!.did, `legacy:brief-run:${generationId}`);
  assert.equal(env.atoms[0]!.entityId, generationId);
  assert.equal(
    env.atoms[0]!.source.url,
    `/api/engagements/${engagementId}/briefing/generate`,
  );
});

test("codex_finding_generation provenance remains finding-generation-run", () => {
  const entry = codexProvenance({
    atomKind: "finding-generation-run",
    rowId: "gen-finding-1",
    jurisdictionTenant: "legacy",
    sourcePath: "/api/submissions/sub-1/findings/generate",
  });
  assert.equal(entry.entityType, "finding-generation-run");
  assert.equal(entry.did, "legacy:finding-generation-run:gen-finding-1");
});
