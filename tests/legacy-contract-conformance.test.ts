// L-surface contract-conformance test (Group 4, MCP side).
//
// The MCP-side sibling of cc-agent-C's Lane C.4 contract-conformance
// test. Parses representative JSON examples of the L1-L6 atom shapes —
// the response payloads the legacy-design-tools endpoints return per
// `_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md` —
// against the engine-pinned Zod schemas in `src/legacy-schemas.ts`.
//
// Purpose: contract drift between the MCP mirror and the engine atom
// source of truth (@hauska-engine/atoms@0.6.0, SHA 7ed915c) surfaces
// here in CI, not at runtime against a live backend. This does NOT
// exercise the legacy backend — e2e coverage is Group 4's cross-client
// pass, gated on Lane C.4 endpoints landing.
//
// Each fixture is a representative response payload, JSON-round-tripped
// (stringify + parse) before validation so the test reflects what
// actually crosses the wire.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ATTACHED_DOCUMENT_SCHEMA,
  DELIVERABLE_LETTER_FETCH_RESPONSE_SCHEMA,
  DELIVERABLE_LETTER_LIST_RESPONSE_SCHEMA,
  DELIVERABLE_LETTER_RENDER_SCHEMA,
  DELIVERABLE_LETTER_SCHEMA,
  DETAIL_CALLOUT_SPEC_SCHEMA,
  L_SURFACE_ATOM_SCHEMAS,
  PRODUCT_SPEC_REFERENCE_SCHEMA,
  RESPONSE_TASK_SCHEMA,
  SHEET_CONTENT_EXTRACTION_SCHEMA,
} from "../src/legacy-schemas.js";
import type { z } from "zod";

// JSON-round-trip a fixture so the test validates what actually crosses
// the wire (Date drift, undefined-stripping, etc. would surface here).
function overWire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

function assertConforms(
  schema: z.ZodTypeAny,
  value: unknown,
  label: string,
): void {
  const result = schema.safeParse(overWire(value));
  assert.equal(
    result.success,
    true,
    `${label} should conform to its engine atom contract` +
      (result.success ? "" : `: ${JSON.stringify(result.error.issues)}`),
  );
}

function assertRejects(
  schema: z.ZodTypeAny,
  value: unknown,
  label: string,
): void {
  const result = schema.safeParse(overWire(value));
  assert.equal(
    result.success,
    false,
    `${label} should be rejected as a contract violation`,
  );
}

// -----------------------------------------------------------------
// L1 — response-task. POST /api/engagements/:id/response-tasks etc.
// -----------------------------------------------------------------

function responseTaskFixture() {
  return {
    entityType: "response-task",
    entityId: "rt-7c1a",
    jurisdictionTenant: "musgrave-engagements",
    fetchedAt: "2026-05-19T18:00:00.000Z",
    sourceAdapter: "cortex-response-task",
    sourceUrl: "",
    contentHash: "a".repeat(64),
    title: "Address fire-rated corridor comment",
    description: "Client comment 7 — corridor at level 2 lacks rated assembly.",
    state: "open",
    createdAt: "2026-05-19T18:00:00.000Z",
    dueAt: null,
    completedAt: null,
    sourceClientCommentId: null,
    findingId: null,
    engagementId: "eng-musgrave",
    actorId: null,
    principalActorId: null,
    accessPolicy: "tenant-private",
  };
}

test("L1 response-task — representative atom conforms", () => {
  assertConforms(RESPONSE_TASK_SCHEMA, responseTaskFixture(), "response-task");
});

test("L1 response-task — completed task with completedAt conforms", () => {
  const done = responseTaskFixture();
  done.state = "done";
  done.completedAt = "2026-05-19T20:00:00.000Z";
  assertConforms(RESPONSE_TASK_SCHEMA, done, "completed response-task");
});

test("L1 response-task — unknown state enum rejected", () => {
  const bad = responseTaskFixture();
  (bad as Record<string, unknown>).state = "blocked";
  assertRejects(RESPONSE_TASK_SCHEMA, bad, "response-task with bad state");
});

test("L1 response-task — missing required title rejected", () => {
  const bad = responseTaskFixture() as Record<string, unknown>;
  delete bad.title;
  assertRejects(RESPONSE_TASK_SCHEMA, bad, "response-task without title");
});

// -----------------------------------------------------------------
// L2 — sheet-content-extraction + attached-document.
// -----------------------------------------------------------------

function sheetContentExtractionFixture() {
  return {
    entityType: "sheet-content-extraction",
    entityId: "sce-3f20",
    jurisdictionTenant: "musgrave-engagements",
    fetchedAt: "2026-05-19T18:05:00.000Z",
    sourceAdapter: "cortex-sheet-ingest",
    sourceUrl: "",
    contentHash: "b".repeat(64),
    sourceSheetId: "sheet-A-101",
    engagementId: "eng-musgrave",
    pageLabel: "A-101",
    extractedTextSegments: [
      {
        text: "ROOM FINISH SCHEDULE",
        boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
        sourceConfidence: 0.97,
      },
    ],
    structuredAnnotations: [
      {
        kind: "revision-cloud",
        position: { x: 0.5, y: 0.5, width: 0.2, height: 0.15 },
        content: "Revision 3 — corridor rating",
        sourceConfidence: 0.88,
      },
    ],
    ocrModel: "claude-sonnet-4-5",
    actorId: null,
    accessPolicy: "tenant-private",
  };
}

test("L2 sheet-content-extraction — representative atom conforms", () => {
  assertConforms(
    SHEET_CONTENT_EXTRACTION_SCHEMA,
    sheetContentExtractionFixture(),
    "sheet-content-extraction",
  );
});

test("L2 sheet-content-extraction — empty segment arrays conform", () => {
  const empty = sheetContentExtractionFixture();
  empty.extractedTextSegments = [];
  empty.structuredAnnotations = [];
  assertConforms(
    SHEET_CONTENT_EXTRACTION_SCHEMA,
    empty,
    "sheet-content-extraction with empty arrays",
  );
});

test("L2 sheet-content-extraction — unknown annotation kind rejected", () => {
  const bad = sheetContentExtractionFixture();
  (bad.structuredAnnotations[0] as Record<string, unknown>).kind = "stamp";
  assertRejects(
    SHEET_CONTENT_EXTRACTION_SCHEMA,
    bad,
    "sheet-content-extraction with bad annotation kind",
  );
});

test("L2 sheet-content-extraction — confidence out of [0,1] rejected", () => {
  const bad = sheetContentExtractionFixture();
  bad.extractedTextSegments[0]!.sourceConfidence = 1.4;
  assertRejects(
    SHEET_CONTENT_EXTRACTION_SCHEMA,
    bad,
    "sheet-content-extraction with bad confidence",
  );
});

function attachedDocumentFixture() {
  return {
    entityType: "attached-document",
    entityId: "ad-9b41",
    jurisdictionTenant: "musgrave-engagements",
    fetchedAt: "2026-05-19T18:06:00.000Z",
    sourceAdapter: "cortex-sheet-ingest",
    sourceUrl: "",
    contentHash: "c".repeat(64),
    engagementId: "eng-musgrave",
    title: "Structural calculations — lateral",
    documentType: "calculation",
    extractedText: "Lateral analysis per ASCE 7-22 ...",
    originalBlobRef: "gs://cortex-prod/attached/ad-9b41.pdf",
    actorId: null,
    accessPolicy: "tenant-private",
  };
}

test("L2 attached-document — representative atom conforms", () => {
  assertConforms(
    ATTACHED_DOCUMENT_SCHEMA,
    attachedDocumentFixture(),
    "attached-document",
  );
});

test("L2 attached-document — unknown documentType rejected", () => {
  const bad = attachedDocumentFixture();
  (bad as Record<string, unknown>).documentType = "drawing";
  assertRejects(
    ATTACHED_DOCUMENT_SCHEMA,
    bad,
    "attached-document with bad documentType",
  );
});

test("L2 attached-document — null engagementId rejected (required, non-null)", () => {
  const bad = attachedDocumentFixture() as Record<string, unknown>;
  bad.engagementId = null;
  assertRejects(
    ATTACHED_DOCUMENT_SCHEMA,
    bad,
    "attached-document with null engagementId",
  );
});

// -----------------------------------------------------------------
// L3 — deliverable-letter.
// -----------------------------------------------------------------

function emptyProvenance() {
  return {
    responseTaskIds: [],
    sheetContentExtractionIds: [],
    findingIds: [],
    adjudicationStateIds: [],
  };
}

function deliverableLetterFixture() {
  return {
    entityType: "deliverable-letter",
    entityId: "dl-1100",
    jurisdictionTenant: "musgrave-engagements",
    fetchedAt: "2026-05-19T19:00:00.000Z",
    sourceAdapter: "cortex-deliverable-letter",
    sourceUrl: "",
    contentHash: "d".repeat(64),
    engagementId: "eng-musgrave",
    title: "Comment response letter — Musgrave",
    status: "draft",
    recipientActorId: null,
    sections: [
      { kind: "cover", heading: "", content: "Cover", provenance: emptyProvenance() },
      { kind: "intro", heading: "Introduction", content: "Intro body", provenance: emptyProvenance() },
      {
        kind: "per-comment-response",
        heading: "Response to Comment 7",
        content: "Corridor assembly upgraded to 1-hr rated.",
        provenance: {
          responseTaskIds: ["rt-7c1a"],
          sheetContentExtractionIds: ["sce-3f20"],
          findingIds: [],
          adjudicationStateIds: [],
        },
      },
      { kind: "signature", heading: "", content: "Sincerely,", provenance: emptyProvenance() },
    ],
    createdAt: "2026-05-19T19:00:00.000Z",
    sentAt: null,
    actorId: null,
    principalActorId: null,
    accessPolicy: "tenant-private",
  };
}

test("L3 deliverable-letter — representative atom conforms", () => {
  assertConforms(
    DELIVERABLE_LETTER_SCHEMA,
    deliverableLetterFixture(),
    "deliverable-letter",
  );
});

test("L3 deliverable-letter — unknown section kind rejected", () => {
  const bad = deliverableLetterFixture();
  (bad.sections[0] as Record<string, unknown>).kind = "appendix";
  assertRejects(
    DELIVERABLE_LETTER_SCHEMA,
    bad,
    "deliverable-letter with bad section kind",
  );
});

test("L3 deliverable-letter — section missing provenance rejected", () => {
  const bad = deliverableLetterFixture();
  delete (bad.sections[0] as Record<string, unknown>).provenance;
  assertRejects(
    DELIVERABLE_LETTER_SCHEMA,
    bad,
    "deliverable-letter section without provenance",
  );
});

// -----------------------------------------------------------------
// L4 — detail-callout-spec. Discriminated union on `spec.detailType`.
// All four arms are validated — this is the static half of the
// Group 4 L4 discriminated-union round-trip verification (the
// cross-client half is gated on live MCP clients).
// -----------------------------------------------------------------

function detailCalloutSpecFixture(spec: Record<string, unknown>) {
  return {
    entityType: "detail-callout-spec",
    entityId: "dcs-4400",
    jurisdictionTenant: "musgrave-engagements",
    fetchedAt: "2026-05-19T19:10:00.000Z",
    sourceAdapter: "cortex-detail-callout-spec",
    sourceUrl: "",
    contentHash: "e".repeat(64),
    engagementId: "eng-musgrave",
    spec,
    pushState: "pending",
    apsTaskRef: null,
    findingId: null,
    responseTaskId: null,
    createdAt: "2026-05-19T19:10:00.000Z",
    pushedAt: null,
    actorId: null,
    principalActorId: null,
    accessPolicy: "tenant-private",
  };
}

const doorScheduleSpec = {
  detailType: "door-schedule",
  rows: [
    {
      doorMark: "101A",
      doorType: "HM",
      width: "3'-0\"",
      height: "7'-0\"",
      material: "Hollow Metal",
      fireRating: "90 min",
      hardwareSet: "HW-3",
    },
  ],
};

const wallSectionSpec = {
  detailType: "wall-section",
  sectionMark: "A/A-501",
  cutLocation: "Exterior wall at grid 4",
  assemblyLayers: [
    { material: "Brick veneer", thickness: "3 5/8\"", function: "finish" },
    { material: "CMU", thickness: "8\"", function: "structure" },
  ],
  baseDatum: "T.O. Slab",
  topDatum: "T.O. Parapet",
};

const wallTypeSpec = {
  detailType: "wall-type",
  typeMark: "W1",
  assemblyLayers: [
    { material: "Gypsum board", thickness: "5/8\"", function: "finish" },
  ],
  fireRating: "1 hr",
  stcRating: "STC 50",
};

const roomFinishSpec = {
  detailType: "room-finish",
  roomName: "Corridor",
  roomNumber: "C-201",
  floorFinish: "Sealed concrete",
  baseFinish: "Rubber base",
  wallFinish: "Painted GWB",
  ceilingFinish: "ACT",
  ceilingHeight: "9'-0\"",
};

for (const spec of [
  doorScheduleSpec,
  wallSectionSpec,
  wallTypeSpec,
  roomFinishSpec,
]) {
  test(`L4 detail-callout-spec — ${spec.detailType} arm conforms`, () => {
    assertConforms(
      DETAIL_CALLOUT_SPEC_SCHEMA,
      detailCalloutSpecFixture(spec),
      `detail-callout-spec ${spec.detailType}`,
    );
  });
}

test("L4 detail-callout-spec — unknown detailType rejected", () => {
  assertRejects(
    DETAIL_CALLOUT_SPEC_SCHEMA,
    detailCalloutSpecFixture({ detailType: "stair-section", treads: 12 }),
    "detail-callout-spec with unknown detailType",
  );
});

test("L4 detail-callout-spec — payload mismatched to its discriminant rejected", () => {
  // door-schedule discriminant but wall-section body.
  assertRejects(
    DETAIL_CALLOUT_SPEC_SCHEMA,
    detailCalloutSpecFixture({
      detailType: "door-schedule",
      sectionMark: "A/A-501",
      cutLocation: "x",
      assemblyLayers: [],
      baseDatum: "x",
      topDatum: "y",
    }),
    "detail-callout-spec with mismatched spec arm",
  );
});

test("L4 detail-callout-spec — illegal pushState rejected", () => {
  const bad = detailCalloutSpecFixture(doorScheduleSpec);
  (bad as Record<string, unknown>).pushState = "in-review";
  assertRejects(
    DETAIL_CALLOUT_SPEC_SCHEMA,
    bad,
    "detail-callout-spec with bad pushState",
  );
});

// -----------------------------------------------------------------
// L5 — product-spec-reference. `esrNumber` is format-validated.
// -----------------------------------------------------------------

function productSpecReferenceFixture() {
  return {
    entityType: "product-spec-reference",
    entityId: "psr-5500",
    jurisdictionTenant: "musgrave-engagements",
    fetchedAt: "2026-05-19T19:20:00.000Z",
    sourceAdapter: "cortex-product-spec-reference",
    sourceUrl: "https://icc-es.org/report-listing/ESR-1234",
    contentHash: "f".repeat(64),
    product: {
      name: "Strong-Drive SDWS Timber Screw",
      manufacturer: "Simpson Strong-Tie",
    },
    esrNumber: "ESR-1234",
    status: "active",
    lastVerifiedAt: "2026-05-19T19:20:00.000Z",
    statusHistory: [
      {
        status: "active",
        changedAt: "2026-05-19T19:20:00.000Z",
        sourceUrl: "https://icc-es.org/report-listing/ESR-1234",
      },
    ],
    engagementId: "eng-musgrave",
    findingId: null,
    responseTaskId: null,
    createdAt: "2026-05-19T19:20:00.000Z",
    actorId: null,
    principalActorId: null,
    accessPolicy: "tenant-private",
  };
}

test("L5 product-spec-reference — representative atom conforms", () => {
  assertConforms(
    PRODUCT_SPEC_REFERENCE_SCHEMA,
    productSpecReferenceFixture(),
    "product-spec-reference",
  );
});

test("L5 product-spec-reference — empty statusHistory conforms", () => {
  const fresh = productSpecReferenceFixture();
  fresh.statusHistory = [];
  assertConforms(
    PRODUCT_SPEC_REFERENCE_SCHEMA,
    fresh,
    "product-spec-reference with empty statusHistory",
  );
});

test("L5 product-spec-reference — malformed esrNumber rejected", () => {
  const bad = productSpecReferenceFixture();
  bad.esrNumber = "ESR1234";
  assertRejects(
    PRODUCT_SPEC_REFERENCE_SCHEMA,
    bad,
    "product-spec-reference with malformed esrNumber",
  );
});

test("L5 product-spec-reference — free-text product (string) rejected", () => {
  const bad = productSpecReferenceFixture() as Record<string, unknown>;
  bad.product = "Simpson Strong-Tie SDWS";
  assertRejects(
    PRODUCT_SPEC_REFERENCE_SCHEMA,
    bad,
    "product-spec-reference with free-text product",
  );
});

// -----------------------------------------------------------------
// L6 — deliverable-letter-render. `sourceLetterRef` is DID-validated.
// -----------------------------------------------------------------

function deliverableLetterRenderFixture() {
  return {
    entityType: "deliverable-letter-render",
    entityId: "dlr-6600",
    jurisdictionTenant: "musgrave-engagements",
    fetchedAt: "2026-05-19T19:30:00.000Z",
    sourceAdapter: "cortex-deliverable-letter-render",
    sourceUrl: "",
    contentHash: "0".repeat(64),
    sourceLetterRef: "did:hauska:deliverable-letter:dl-1100",
    sourceLetterVersion: "d".repeat(64),
    format: "docx",
    blobRef: "gs://cortex-prod/renders/dlr-6600.docx",
    renderedAt: "2026-05-19T19:30:00.000Z",
    renderedByActorId: null,
    accessPolicy: "tenant-private",
  };
}

test("L6 deliverable-letter-render — representative atom conforms", () => {
  assertConforms(
    DELIVERABLE_LETTER_RENDER_SCHEMA,
    deliverableLetterRenderFixture(),
    "deliverable-letter-render",
  );
});

test("L6 deliverable-letter-render — pdf format conforms", () => {
  const pdf = deliverableLetterRenderFixture();
  pdf.format = "pdf";
  pdf.blobRef = "gs://cortex-prod/renders/dlr-6600.pdf";
  assertConforms(
    DELIVERABLE_LETTER_RENDER_SCHEMA,
    pdf,
    "deliverable-letter-render pdf",
  );
});

test("L6 deliverable-letter-render — non-DID sourceLetterRef rejected", () => {
  const bad = deliverableLetterRenderFixture();
  bad.sourceLetterRef = "dl-1100";
  assertRejects(
    DELIVERABLE_LETTER_RENDER_SCHEMA,
    bad,
    "deliverable-letter-render with non-DID sourceLetterRef",
  );
});

test("L6 deliverable-letter-render — wrong-atom-type DID rejected", () => {
  const bad = deliverableLetterRenderFixture();
  bad.sourceLetterRef = "did:hauska:response-task:rt-7c1a";
  assertRejects(
    DELIVERABLE_LETTER_RENDER_SCHEMA,
    bad,
    "deliverable-letter-render with wrong-type DID",
  );
});

test("L6 deliverable-letter-render — unsupported format rejected", () => {
  const bad = deliverableLetterRenderFixture();
  (bad as Record<string, unknown>).format = "html";
  assertRejects(
    DELIVERABLE_LETTER_RENDER_SCHEMA,
    bad,
    "deliverable-letter-render with bad format",
  );
});

// -----------------------------------------------------------------
// L3/L6 read-endpoint response envelopes (Sprint Amendment 8).
//
// cc-agent-C's Lane C.4 added three read endpoints beyond the original
// write-path-only L3/L6 contract. The two JSON ones get response-envelope
// schemas, validated here. The third
// (GET /api/deliverable-letter-renders/:renderId/file) byte-serves the
// file with no JSON envelope, so it has no schema; its wire behavior
// (content-type + filename lifted off the response headers) is covered
// by tests/cortex-deliverable-letter-render.test.ts.
// -----------------------------------------------------------------

test("L3 deliverable-letter list envelope — conforms (empty, one, many)", () => {
  for (const n of [0, 1, 3]) {
    const letters = Array.from({ length: n }, (_, i) => {
      const l = deliverableLetterFixture();
      l.entityId = `dl-${i}`;
      return l;
    });
    assertConforms(
      DELIVERABLE_LETTER_LIST_RESPONSE_SCHEMA,
      { deliverableLetters: letters },
      `deliverable-letter list of ${n}`,
    );
  }
});

test("L3 deliverable-letter list envelope — a malformed letter in the array is rejected", () => {
  const bad = deliverableLetterFixture();
  (bad as Record<string, unknown>).status = "archived";
  assertRejects(
    DELIVERABLE_LETTER_LIST_RESPONSE_SCHEMA,
    { deliverableLetters: [deliverableLetterFixture(), bad] },
    "deliverable-letter list with a bad member",
  );
});

test("L3 deliverable-letter list envelope — wrong wrapper key rejected", () => {
  assertRejects(
    DELIVERABLE_LETTER_LIST_RESPONSE_SCHEMA,
    { letters: [deliverableLetterFixture()] },
    "deliverable-letter list with wrong wrapper key",
  );
});

test("L3 deliverable-letter fetch envelope — conforms", () => {
  assertConforms(
    DELIVERABLE_LETTER_FETCH_RESPONSE_SCHEMA,
    { deliverableLetter: deliverableLetterFixture() },
    "deliverable-letter fetch envelope",
  );
});

test("L3 deliverable-letter fetch envelope — bare atom without wrapper rejected", () => {
  assertRejects(
    DELIVERABLE_LETTER_FETCH_RESPONSE_SCHEMA,
    deliverableLetterFixture(),
    "deliverable-letter fetch without wrapper",
  );
});

// -----------------------------------------------------------------
// Coverage guard — every L-surface entityType has a schema, and each
// representative fixture's entityType matches the schema it parses.
// -----------------------------------------------------------------

test("all six L-surface entityTypes are covered by a schema", () => {
  assert.deepEqual(Object.keys(L_SURFACE_ATOM_SCHEMAS).sort(), [
    "attached-document",
    "deliverable-letter",
    "deliverable-letter-render",
    "detail-callout-spec",
    "product-spec-reference",
    "response-task",
    "sheet-content-extraction",
  ]);
});

test("did:hauska: DID provenance — render sourceLetterRef carries a real DID", () => {
  // L-surface atoms ship real did:hauska: DIDs (lSurfaceProvenance),
  // not synthetic legacy: identifiers. The render atom's sourceLetterRef
  // is the one DID field carried inside an L-surface atom body; verify
  // the contract enforces the did:hauska: shape end-to-end through the
  // schema. Full DID-through-the-stack verification is Group 4 e2e.
  const render = deliverableLetterRenderFixture();
  assert.ok(render.sourceLetterRef.startsWith("did:hauska:"));
  assertConforms(
    DELIVERABLE_LETTER_RENDER_SCHEMA,
    render,
    "deliverable-letter-render DID provenance",
  );
});
