// codex_findings_fetch + citation lineage closure tests (P0a).

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import {
  citationAtomEnvelopeDid,
  provenanceEntriesFromFindings,
  type FindingWire,
} from "../src/codex-citation-lineage.js";
import { assertSubmissionPartitionReadable } from "../src/codex-submission-tenant.js";
import {
  LegacyHttpError,
  legacyClient,
} from "../src/legacy-client.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

const calls: RecordedCall[] = [];
let mockResponse: { status: number; body: unknown } = {
  status: 200,
  body: {},
};

const realFetch = globalThis.fetch;

const CORPUS_UUID = "550E8400-E29B-41D4-A716-446655440000";
const REASONING_ID = "reasoning:fbc-2023:fbc-m601-6";

beforeEach(() => {
  calls.length = 0;
  mockResponse = { status: 200, body: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(mockResponse.body), {
      status: mockResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("fetchSubmissionFindings GETs /api/submissions/:id/findings", async () => {
  mockResponse = {
    status: 200,
    body: {
      findings: [
        {
          id: "finding:sub-1:ABC",
          submissionId: "sub-1",
          citations: [{ kind: "code-section", atomId: CORPUS_UUID }],
        },
      ],
    },
  };
  const res = await legacyClient.fetchSubmissionFindings({
    submissionId: "11111111-1111-4111-8111-111111111111",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(
    url.pathname,
    "/api/submissions/11111111-1111-4111-8111-111111111111/findings",
  );
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(res.findings[0]!.citations[0]!.atomId, CORPUS_UUID);
});

test("getFindingGenerationStatus GETs status endpoint", async () => {
  mockResponse = {
    status: 200,
    body: {
      generationId: "run-1",
      state: "succeeded",
      startedAt: "2026-06-09T00:00:00.000Z",
      completedAt: "2026-06-09T00:01:00.000Z",
      error: null,
      invalidCitationCount: 2,
      invalidCitations: ["[[CODE:bad]]"],
      discardedFindingCount: 1,
      jurisdictionTenant: "mox-living",
    },
  };
  const res = await legacyClient.getFindingGenerationStatus({
    submissionId: "sub-1",
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/submissions/sub-1/findings/status");
  assert.equal(res.generationId, "run-1");
  assert.equal(res.jurisdictionTenant, "mox-living");
  assert.equal(res.invalidCitationCount, 2);
});

test("generation-persists-citations: findings wire carries citations[].atomId verbatim", async () => {
  mockResponse = {
    status: 200,
    body: {
      jurisdictionTenant: "mox-living",
      findings: [
        {
          id: "finding:sub-1:GEN1",
          submissionId: "sub-1",
          citations: [
            { kind: "code-section", atomId: CORPUS_UUID },
            { kind: "code-section", atomId: REASONING_ID },
          ],
        },
      ],
    },
  };
  const res = await legacyClient.fetchSubmissionFindings({ submissionId: "sub-1" });
  assert.equal(res.findings[0]!.citations[0]!.atomId, CORPUS_UUID);
  assert.equal(res.findings[0]!.citations[1]!.atomId, REASONING_ID);
});

test("key-space consistency: gate envelope DID matches HTTP atom id without re-normalize", () => {
  const findings: FindingWire[] = [
    {
      id: "f-1",
      submissionId: "sub-1",
      citations: [
        { kind: "code-section", atomId: CORPUS_UUID },
        { kind: "code-section", atomId: REASONING_ID },
        {
          kind: "code-section",
          atomId: `did:hauska:code-section:${CORPUS_UUID.toLowerCase()}`,
        },
      ],
    },
  ];
  assert.equal(citationAtomEnvelopeDid(CORPUS_UUID), `did:hauska:code-section:${CORPUS_UUID}`);
  assert.equal(citationAtomEnvelopeDid(REASONING_ID), REASONING_ID);
  const atoms = provenanceEntriesFromFindings(findings, "sub-1", "mox-living");
  assert.equal(atoms[0]!.entityId, CORPUS_UUID);
  assert.equal(atoms[0]!.did, `did:hauska:code-section:${CORPUS_UUID}`);
  assert.equal(atoms[1]!.entityId, REASONING_ID);
  assert.equal(atoms[1]!.did, REASONING_ID);
});

test("tenant scoping: tenant-B denied for tenant-A submission partition", () => {
  const denied = assertSubmissionPartitionReadable(
    {
      tier: "developer_pro",
      jurisdictionTenant: "bastrop-tx",
      platformInternal: false,
    },
    "mox-living",
    "codex_findings_fetch",
  );
  assert.equal(denied.ok, false);

  const allowed = assertSubmissionPartitionReadable(
    {
      tier: "developer_pro",
      jurisdictionTenant: "mox-living",
      platformInternal: false,
    },
    "mox-living",
    "codex_findings_fetch",
  );
  assert.equal(allowed.ok, true);

  const internal = assertSubmissionPartitionReadable(
    {
      tier: "team",
      jurisdictionTenant: null,
      platformInternal: true,
    },
    "mox-living",
    "codex_findings_fetch",
  );
  assert.equal(internal.ok, true);
});

test("overrideFinding forwards citations[] in POST body", async () => {
  mockResponse = {
    status: 200,
    body: {
      finding: {
        id: "finding:sub-1:REV",
        submissionId: "sub-1",
        citations: [{ kind: "code-section", atomId: CORPUS_UUID }],
      },
    },
  };
  await legacyClient.overrideFinding({
    findingId: "finding:sub-1:ORIG",
    text: "Revised text.",
    severity: "concern",
    category: "setback",
    citations: [{ kind: "code-section", atomId: CORPUS_UUID }],
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(body.citations, [
    { kind: "code-section", atomId: CORPUS_UUID },
  ]);
});

test("fetchSubmissionFindings rethrows 404 as LegacyHttpError", async () => {
  mockResponse = { status: 404, body: { error: "submission_not_found" } };
  await assert.rejects(
    () => legacyClient.fetchSubmissionFindings({ submissionId: "missing" }),
    (err: unknown) => err instanceof LegacyHttpError && err.status === 404,
  );
});
