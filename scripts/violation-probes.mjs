#!/usr/bin/env node
/**
 * File-based both-directions violation instrument for S-1, S-2, S-3.
 * Does not mutate the tree. Reimplements the defective and refuse-all
 * variants and scores the same fixture tables the tests use.
 */
import { strict as assert } from "node:assert";

const ICC_TENANT = "icc-model-code";
const ICC_ADAPTER = "icc-code-connect";
const ICC_ACTOR = "did:hauska:actor:org:icc";

function detectorCorrect(id) {
  if (id.jurisdictionTenant === ICC_TENANT) return true;
  if (id.sourceAdapter === ICC_ADAPTER) return true;
  if (id.sourceActorDid === ICC_ACTOR) return true;
  return false;
}
function detectorNoTenant(id) {
  if (id.sourceAdapter === ICC_ADAPTER) return true;
  if (id.sourceActorDid === ICC_ACTOR) return true;
  return false;
}
function detectorRefuseAll() {
  return false;
}

const cells = [];
for (const tenant of [ICC_TENANT, "bastrop-tx", null]) {
  for (const adapter of [ICC_ADAPTER, "municode-html", null]) {
    for (const actor of [ICC_ACTOR, null]) {
      cells.push({ tenant, adapter, actor });
    }
  }
}

function score(fn) {
  let fail = 0;
  for (const c of cells) {
    const expected = detectorCorrect({
      jurisdictionTenant: c.tenant,
      sourceAdapter: c.adapter,
      sourceActorDid: c.actor,
    });
    const got = fn({
      jurisdictionTenant: c.tenant,
      sourceAdapter: c.adapter,
      sourceActorDid: c.actor,
    });
    if (got !== expected) fail += 1;
  }
  return fail;
}

const s2Correct = score(detectorCorrect);
const s2NoTenant = score(detectorNoTenant);
const s2RefuseAll = score(detectorRefuseAll);
assert.equal(s2Correct, 0);
assert.ok(s2NoTenant > 0, "no-tenant limb must fail some cells");
assert.ok(s2RefuseAll > 0, "refuse-all must fail some cells");

// S-1: ICC code must accrue 1; empty must accrue 0.
function s1Accrue(mode, kind) {
  if (mode === "empty-wrap") return 0;
  if (mode === "refuse-all") return 0;
  return kind === "icc" ? 1 : 0;
}
const s1Cases = ["icc", "empty"];
function s1Fails(mode) {
  let fail = 0;
  for (const kind of s1Cases) {
    const expected = kind === "icc" ? 1 : 0;
    if (s1Accrue(mode, kind) !== expected) fail += 1;
  }
  return fail;
}
const s1Correct = s1Fails("correct");
const s1Defect = s1Fails("empty-wrap");
const s1Refuse = s1Fails("refuse-all");
assert.equal(s1Correct, 0);
assert.equal(s1Defect, 1);
assert.equal(s1Refuse, 1);

// S-3: authorized=true and no billing record must not report revenue.
function s3Revenue(mode, authorized, hasBilling) {
  if (mode === "old-billed") return authorized ? 1 : 0;
  if (mode === "refuse-all") return null;
  return hasBilling ? 1 : null;
}
function s3Fails(mode) {
  const reported = s3Revenue(mode, true, false);
  const isMoney = typeof reported === "number" && reported > 0;
  return isMoney ? 1 : 0;
}
const s3Correct = s3Fails("correct");
const s3Defect = s3Fails("old-billed");
const s3Refuse = s3Fails("refuse-all");
assert.equal(s3Correct, 0);
assert.equal(s3Defect, 1);
assert.equal(s3Refuse, 0);

console.log(
  JSON.stringify(
    {
      s1: { injectDefectFails: s1Defect, refuseAllFails: s1Refuse, cells: s1Cases.length },
      s2: { injectDefectFails: s2NoTenant, refuseAllFails: s2RefuseAll, cells: cells.length },
      s3: { injectDefectFails: s3Defect, refuseAllFails: s3Refuse, cells: 1 },
    },
    null,
    2,
  ),
);
