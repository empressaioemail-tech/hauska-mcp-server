// S-1: plan-review wrap must accrue Ledger B from ICC code, not from a log line.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  provenanceFromPlanReviewCode,
  wrap,
} from "../src/plan-review-tools.js";
import { emptyProvenance } from "../src/atom-shape.js";
import { ICC_ACTOR_DID, ICC_JURISDICTION_TENANT } from "../src/icc-content.js";
import { requestContext } from "../src/request-context.js";
import {
  getSourceObligationTestCaptures,
  setSourceObligationInsertForTests,
} from "../src/source-obligation-meter.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ICC_CODE = {
  book: "IBC2018P6",
  section: "R311.7",
  citation: "IBC 2018 Section R311.7",
  heading: "Stairways",
  iccDeepLink: "https://codes.iccsafe.org/content/IBC2018P6/R311.7",
  bodyVerbatim: false,
};

test("provenanceFromPlanReviewCode builds ICC tenant + adapter for IBC", () => {
  const p = provenanceFromPlanReviewCode(ICC_CODE);
  assert.equal(p.status, "built");
  if (p.status !== "built") return;
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0]?.jurisdictionTenant, ICC_JURISDICTION_TENANT);
  assert.equal(p.entries[0]?.source.adapter, "icc-code-connect");
  assert.equal(p.entries[0]?.source.adapterStatus, "known");
  assert.equal(p.entries[0]?.sourceActorDid, ICC_ACTOR_DID);
});

test("typed-absence is explicit empty, not an unbuilt []", () => {
  const p = provenanceFromPlanReviewCode({
    book: "IPMC2018P2",
    status: "typed-absence",
  });
  assert.deepEqual(p, { status: "empty", reason: "no-atoms" });
});

test("plan_review_get_code ICC section accrues one Ledger B row", async () => {
  setSourceObligationInsertForTests(async () => {});
  try {
    await requestContext.run(
      {
        tier: "developer_pro",
        product: "codex",
        rate_limit_id: "key:test",
        remaining_rpm: 10,
        remaining_daily: 100,
        request_id: "req-s1-icc-code",
      },
      () => {
        wrap("plan_review_get_code", ICC_CODE, provenanceFromPlanReviewCode(ICC_CODE));
      },
    );
    await sleep(30);
    const rows = getSourceObligationTestCaptures();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sourceActorDid, ICC_ACTOR_DID);
    assert.equal(rows[0]?.tool, "plan_review_get_code");
    assert.equal(rows[0]?.graceTerms, "pending-rate");
  } finally {
    setSourceObligationInsertForTests(null);
  }
});

test("explicit empty provenance accrues zero and still logs", async () => {
  setSourceObligationInsertForTests(async () => {});
  try {
    await requestContext.run(
      {
        tier: "developer_pro",
        product: "codex",
        rate_limit_id: "key:test",
        remaining_rpm: 10,
        remaining_daily: 100,
        request_id: "req-s1-no-atoms",
      },
      () => {
        wrap("plan_review_get_letter", { letter: true }, emptyProvenance("no-atoms"));
      },
    );
    await sleep(30);
    assert.equal(getSourceObligationTestCaptures().length, 0);
  } finally {
    setSourceObligationInsertForTests(null);
  }
});
