// I-K / Master 2.5.4 — inbound source-obligation meter.
//
// free anonymous ICC reference accrues; non-ICC zero; paid also accrues.
// Public path must not load @hauska-sdk.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ICC_ACTOR_RECORD_FIXTURE,
  ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE,
} from "@empressaio/atom-contract/reasoning";

import { logToolRead } from "../src/read-attribution.js";
import { requestContext } from "../src/request-context.js";
import {
  wasSdkMeteringModuleLoaded,
  resetSdkMeteringGateForTests,
} from "../src/sdk-metering.js";
import {
  ICC_ACTOR_DID,
  ICC_SOURCED_ATOM_DID_ALLOWLIST,
  accrueSourceObligations,
  collectSourceObligationTargets,
  extractCitedAtomDid,
  getSourceObligationTestCaptures,
  resolveSourceActorDid,
  setSourceObligationInsertForTests,
} from "../src/source-obligation-meter.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("uses shipped ICC actor + license-reference-royalty fixtures", () => {
  assert.equal(ICC_ACTOR_DID, "did:hauska:actor:org:icc");
  assert.equal(ICC_ACTOR_DID, ICC_ACTOR_RECORD_FIXTURE.actorId);
  assert.equal(
    ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.obligationType,
    "license-reference-royalty",
  );
  assert.equal(
    ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.owedToActorDid,
    ICC_ACTOR_DID,
  );
  assert.equal(
    ICC_ACTOR_RECORD_FIXTURE.sourceLicensing?.meterFreeTier,
    true,
  );
  assert.ok(
    ICC_SOURCED_ATOM_DID_ALLOWLIST.has(
      ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.anchorDid,
    ),
  );
});

test("resolveSourceActorDid: allowlist + stamp + citation + cited code", () => {
  assert.equal(
    resolveSourceActorDid(ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.anchorDid),
    ICC_ACTOR_DID,
  );
  assert.equal(
    resolveSourceActorDid("did:hauska:code-section:storage-port-proof/phase-1a"),
    ICC_ACTOR_DID,
  );
  assert.equal(
    resolveSourceActorDid({
      did: "did:hauska:code-section:random-local/1",
      sourceActorDid: ICC_ACTOR_DID,
    }),
    ICC_ACTOR_DID,
  );
  assert.equal(
    resolveSourceActorDid({
      did: "did:hauska:code-section:other/1",
      sourceCitation: "ICC IBC 2024 Section 1003.1",
    }),
    ICC_ACTOR_DID,
  );
  assert.equal(
    resolveSourceActorDid({
      did: "did:hauska:setback-rule:48209:156346",
      citedAtomDid: "did:hauska:code-section:storage-port-proof/phase-1a",
    }),
    ICC_ACTOR_DID,
  );
  assert.equal(
    resolveSourceActorDid("did:hauska:zoning-fact:48209:156346"),
    null,
  );
});

test("extractCitedAtomDid reads sourceCodeAtomRef shapes", () => {
  assert.equal(
    extractCitedAtomDid({
      sourceCodeAtomRef: {
        atomDid: "did:hauska:code-section:storage-port-proof/phase-1a",
        role: "rule",
      },
    }),
    "did:hauska:code-section:storage-port-proof/phase-1a",
  );
});

test("non-ICC atoms produce zero accrual targets", () => {
  const targets = collectSourceObligationTargets([
    "did:hauska:zoning-fact:48209:156346",
    "did:hauska:buildable-envelope:48209:156346",
  ]);
  assert.equal(targets.length, 0);
});

test("free anonymous ICC reference accrues pending-rate row", async () => {
  setSourceObligationInsertForTests(async () => {});
  try {
    await requestContext.run(
      {
        tier: "free_anonymous",
        product: "public",
        rate_limit_id: "ip:test",
        remaining_rpm: 10,
        remaining_daily: 100,
        request_id: "req-anon-icc-accrual",
      },
      () => {
        logToolRead(
          {
            tool: "get_property_atom_chain",
            tier: "free_anonymous",
            latency_ms: 1,
          },
          [
            {
              did: "did:hauska:setback-rule:48209:156346",
              entityType: "setback-rule",
              entityId: "48209:156346",
              jurisdictionTenant: "us-tx-hays",
              contentHash: null,
              cidNote: "",
              source: { adapter: null, url: null, fetchedAt: null },
              citedAtomDid:
                "did:hauska:code-section:storage-port-proof/phase-1a",
            },
          ],
        );
      },
    );
    await sleep(30);
    const rows = getSourceObligationTestCaptures();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sourceActorDid, ICC_ACTOR_DID);
    assert.equal(rows[0]?.atomDid, "did:hauska:setback-rule:48209:156346");
    assert.equal(rows[0]?.tier, "free_anonymous");
    assert.equal(rows[0]?.product, "public");
    assert.equal(rows[0]?.obligationType, "license-reference-royalty");
    assert.equal(rows[0]?.amountMinor, null);
    assert.equal(rows[0]?.graceTerms, "pending-rate");
    assert.equal(rows[0]?.requestId, "req-anon-icc-accrual");
  } finally {
    setSourceObligationInsertForTests(null);
  }
});

test("paid tier also accrues ICC reference", async () => {
  setSourceObligationInsertForTests(async () => {});
  try {
    accrueSourceObligations({
      tool: "get_atom",
      product: "codex",
      tier: "developer_pro",
      requestId: "req-paid-icc",
      atoms: [ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.anchorDid],
    });
    await sleep(30);
    const rows = getSourceObligationTestCaptures();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tier, "developer_pro");
    assert.equal(rows[0]?.product, "codex");
    assert.equal(rows[0]?.sourceActorDid, ICC_ACTOR_DID);
  } finally {
    setSourceObligationInsertForTests(null);
  }
});

test("free anonymous ICC path does not load @hauska-sdk", async () => {
  resetSdkMeteringGateForTests();
  const prev = process.env.SDK_METERING;
  process.env.SDK_METERING = "1";
  setSourceObligationInsertForTests(async () => {});
  try {
    assert.equal(wasSdkMeteringModuleLoaded(), false);
    await requestContext.run(
      {
        tier: "free_anonymous",
        product: "public",
        rate_limit_id: "ip:test",
        remaining_rpm: 10,
        remaining_daily: 100,
        request_id: "req-anon-no-sdk",
      },
      () => {
        logToolRead(
          { tool: "get_atom", tier: "free_anonymous", latency_ms: 1 },
          [ICC_LICENSE_REFERENCE_OBLIGATION_FIXTURE.anchorDid],
        );
      },
    );
    await sleep(30);
    assert.ok(getSourceObligationTestCaptures().length >= 1);
    assert.equal(
      wasSdkMeteringModuleLoaded(),
      false,
      "I-K free path must not load @hauska-sdk",
    );
  } finally {
    if (prev === undefined) delete process.env.SDK_METERING;
    else process.env.SDK_METERING = prev;
    setSourceObligationInsertForTests(null);
    resetSdkMeteringGateForTests();
  }
});

test("source-obligation-meter has no static @hauska-sdk import", () => {
  const src = readFileSync(
    resolve(ROOT, "src/source-obligation-meter.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /from\s+["']@hauska-sdk\//);
  assert.doesNotMatch(src, /import\s*\(\s*["']@hauska-sdk\//);
  const attribution = readFileSync(
    resolve(ROOT, "src/read-attribution.ts"),
    "utf8",
  );
  assert.match(attribution, /accrueSourceObligations/);
  // Accrual must appear before the paid-only SDK early return.
  const accrueAt = attribution.indexOf("accrueSourceObligations");
  const earlyReturnAt = attribution.indexOf("isSdkMeteringEnabled()");
  assert.ok(accrueAt > 0 && earlyReturnAt > accrueAt);
});

import { isIccCatalogTarget } from "../src/access-policy.js";
import { provenanceFromSearchResult } from "../src/atom-shape.js";
import {
  ICC_JURISDICTION_TENANT,
  isIccContent,
  identityFromHint,
} from "../src/icc-content.js";

test("tenant-only ICC search hit accrues one row (live search-path defect)", async () => {
  setSourceObligationInsertForTests(async () => {});
  try {
    const entry = provenanceFromSearchResult({
      atomDid: "did:hauska:code-section:icc-model-code/IBC2018/1003.1",
      entityType: "code-section",
      entityId: "icc-model-code/IBC2018/1003.1",
      jurisdictionTenant: ICC_JURISDICTION_TENANT,
      sectionNumber: "1003.1",
      snippet: "Egress.",
      score: 0.9,
    });
    assert.equal(entry.source.adapter, null);
    assert.equal(entry.source.adapterStatus, "unmeasured");
    assert.equal(entry.sourceActorDid, null);
    assert.equal(
      isIccCatalogTarget({
        jurisdictionTenant: ICC_JURISDICTION_TENANT,
        sourceAdapter: undefined,
      }),
      true,
    );
    accrueSourceObligations({
      tool: "search_atoms",
      product: "codex",
      tier: "developer_pro",
      requestId: "req-search-icc-tenant",
      atoms: [entry],
    });
    await sleep(30);
    const rows = getSourceObligationTestCaptures();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sourceActorDid, ICC_ACTOR_DID);
  } finally {
    setSourceObligationInsertForTests(null);
  }
});

test("gate and meter agree across tenant x adapter x actor cells", () => {
  const tenants = [ICC_JURISDICTION_TENANT, "bastrop-tx", null] as const;
  const adapters = ["icc-code-connect", "municode-html", null] as const;
  const actors = [ICC_ACTOR_DID, null] as const;
  let cells = 0;
  for (const tenant of tenants) {
    for (const adapter of adapters) {
      for (const actor of actors) {
        cells += 1;
        const gate = isIccCatalogTarget({
          jurisdictionTenant: tenant ?? "",
          sourceAdapter: adapter ?? undefined,
          sourceActorDid: actor ?? undefined,
        });
        const meter =
          resolveSourceActorDid({
            did: "did:hauska:code-section:cell/1",
            jurisdictionTenant: tenant,
            sourceAdapter: adapter,
            adapterStatus: adapter == null ? "unmeasured" : "known",
            sourceActorDid: actor,
          }) === ICC_ACTOR_DID;
        assert.equal(
          gate,
          meter,
          `disagree tenant=${tenant} adapter=${adapter} actor=${actor} gate=${gate} meter=${meter}`,
        );
        const unified = isIccContent(
          identityFromHint({
            did: "did:hauska:code-section:cell/1",
            jurisdictionTenant: tenant,
            sourceAdapter: adapter,
            adapterStatus: adapter == null ? "unmeasured" : "known",
            sourceActorDid: actor,
          }),
        );
        assert.equal(unified, gate);
        assert.equal(unified, meter);
      }
    }
  }
  assert.equal(cells, 18);
});

test("ledger reader returns captured rows (reader is armed)", async () => {
  const stored: Array<{ sourceActorDid: string; atomDid: string; requestId: string }> =
    [];
  setSourceObligationInsertForTests(async (row) => {
    stored.push({
      sourceActorDid: row.sourceActorDid,
      atomDid: row.atomDid,
      requestId: row.requestId,
    });
  });
  const { setSourceObligationSelectForTests, listSourceObligationLedger } =
    await import("../src/source-obligation-meter.js");
  setSourceObligationSelectForTests(async (opts) =>
    stored
      .filter((r) => !opts.requestId || r.requestId === opts.requestId)
      .map((r, i) => ({
        id: i + 1,
        createdAt: "2026-08-24T00:00:00.000Z",
        sourceActorDid: r.sourceActorDid,
        atomDid: r.atomDid,
        tool: "search_atoms",
        product: "codex",
        tier: "developer_pro",
        requestId: r.requestId,
        obligationType: "license-reference-royalty",
        amountMinor: null,
        currency: null,
        graceTerms: "pending-rate",
        note: "icc-inbound-reference",
      })),
  );
  try {
    accrueSourceObligations({
      tool: "search_atoms",
      product: "codex",
      tier: "developer_pro",
      requestId: "req-ledger-read",
      atoms: [
        {
          did: "did:hauska:code-section:icc-model-code/x",
          jurisdictionTenant: ICC_JURISDICTION_TENANT,
        },
      ],
    });
    await sleep(30);
    const read = await listSourceObligationLedger({ requestId: "req-ledger-read" });
    assert.equal(read.length, 1);
    assert.equal(read[0]?.sourceActorDid, ICC_ACTOR_DID);
    assert.equal(read[0]?.requestId, "req-ledger-read");
  } finally {
    setSourceObligationInsertForTests(null);
    setSourceObligationSelectForTests(null);
  }
});
