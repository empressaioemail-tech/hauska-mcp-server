// Legacy L-surface response schemas — runtime contract-conformance surface.
//
// Mirrored from @hauska-engine/atoms@0.6.0 (SHA 7ed915c). Source of truth
// is hauska-engine/packages/atoms/src/instances.ts. Re-mirror on engine
// atoms version bump; surface any contract drift to the planner before
// changing schemas locally.
//
// Companion to `legacy-client.ts`. That file carries the MCP mirror as
// TypeScript interfaces (compile-time only); this file carries the same
// six L-surface atom shapes as runtime Zod schemas so the contract can be
// validated against representative JSON — the legacy backend's responses
// are checked against the engine atom contract, not just assumed.
//
// Consumed by `tests/legacy-contract-conformance.test.ts` (the MCP-side
// sibling of cc-agent-C's Lane C.4 contract-conformance test). The two
// mirrors must stay in lockstep: a re-mirror updates the interfaces in
// `legacy-client.ts` AND the schemas here in the same pass.
//
// The schemas below are faithful to the engine schemas — discriminated
// union for the L4 `spec`, ESR-number regex on L5, deliverable-letter DID
// regex on L6, the four-value `accessPolicy` enum. `legacy-client.ts`
// types `spec` as an opaque `Record<string, unknown>` and `accessPolicy`
// as `string` on purpose (MCP-client ergonomics); the canonical contract
// is tighter, and this file validates against the canonical contract.

import { z } from "zod";

// -----------------------------------------------------------------
// Shared building blocks.
// -----------------------------------------------------------------

/** Page-relative bounding box; coordinates normalized to [0, 1]. */
export const BOUNDING_BOX_SCHEMA = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** ADR-017 access tier. Optional — an omitted field is treated as public-free. */
export const ACCESS_POLICY_SCHEMA = z
  .enum(["public-free", "public-paid", "platform-internal", "tenant-private"])
  .optional();

// -----------------------------------------------------------------
// L1 — response-task.
// -----------------------------------------------------------------

export const RESPONSE_TASK_SCHEMA = z.object({
  entityType: z.literal("response-task"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  state: z.enum(["open", "in-progress", "done", "cancelled"]),
  createdAt: z.string().min(1),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  sourceClientCommentId: z.string().nullable(),
  findingId: z.string().nullable(),
  engagementId: z.string().nullable(),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// -----------------------------------------------------------------
// L2 — sheet-content-extraction + attached-document.
// -----------------------------------------------------------------

export const SHEET_CONTENT_EXTRACTION_SCHEMA = z.object({
  entityType: z.literal("sheet-content-extraction"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  sourceSheetId: z.string().min(1),
  engagementId: z.string().nullable(),
  pageLabel: z.string(),
  extractedTextSegments: z.array(
    z.object({
      text: z.string(),
      boundingBox: BOUNDING_BOX_SCHEMA,
      sourceConfidence: z.number().min(0).max(1),
    }),
  ),
  structuredAnnotations: z.array(
    z.object({
      kind: z.enum(["revision-cloud", "dimension", "schedule-row", "callout"]),
      position: BOUNDING_BOX_SCHEMA,
      content: z.string(),
      sourceConfidence: z.number().min(0).max(1),
    }),
  ),
  ocrModel: z.string().min(1),
  actorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

export const ATTACHED_DOCUMENT_SCHEMA = z.object({
  entityType: z.literal("attached-document"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  engagementId: z.string().min(1),
  title: z.string().min(1),
  documentType: z.enum([
    "specification",
    "calculation",
    "product-data",
    "narrative",
  ]),
  extractedText: z.string(),
  originalBlobRef: z.string().min(1),
  actorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// -----------------------------------------------------------------
// L3 — deliverable-letter.
// -----------------------------------------------------------------

export const LETTER_SECTION_PROVENANCE_SCHEMA = z.object({
  responseTaskIds: z.array(z.string()),
  sheetContentExtractionIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  adjudicationStateIds: z.array(z.string()),
});

export const DELIVERABLE_LETTER_SCHEMA = z.object({
  entityType: z.literal("deliverable-letter"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  engagementId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["draft", "sent"]),
  recipientActorId: z.string().nullable(),
  sections: z.array(
    z.object({
      kind: z.enum(["cover", "intro", "per-comment-response", "signature"]),
      heading: z.string(),
      content: z.string(),
      provenance: LETTER_SECTION_PROVENANCE_SCHEMA,
    }),
  ),
  createdAt: z.string().min(1),
  sentAt: z.string().nullable(),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// -----------------------------------------------------------------
// L4 — detail-callout-spec. `spec` is a discriminated union on `detailType`.
// -----------------------------------------------------------------

const WALL_ASSEMBLY_LAYER_SCHEMA = z.object({
  material: z.string(),
  thickness: z.string(),
  function: z.string(),
});

export const DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA = z.discriminatedUnion(
  "detailType",
  [
    z.object({
      detailType: z.literal("door-schedule"),
      rows: z.array(
        z.object({
          doorMark: z.string(),
          doorType: z.string(),
          width: z.string(),
          height: z.string(),
          material: z.string(),
          fireRating: z.string(),
          hardwareSet: z.string(),
        }),
      ),
    }),
    z.object({
      detailType: z.literal("wall-section"),
      sectionMark: z.string(),
      cutLocation: z.string(),
      assemblyLayers: z.array(WALL_ASSEMBLY_LAYER_SCHEMA),
      baseDatum: z.string(),
      topDatum: z.string(),
    }),
    z.object({
      detailType: z.literal("wall-type"),
      typeMark: z.string(),
      assemblyLayers: z.array(WALL_ASSEMBLY_LAYER_SCHEMA),
      fireRating: z.string(),
      stcRating: z.string(),
    }),
    z.object({
      detailType: z.literal("room-finish"),
      roomName: z.string(),
      roomNumber: z.string(),
      floorFinish: z.string(),
      baseFinish: z.string(),
      wallFinish: z.string(),
      ceilingFinish: z.string(),
      ceilingHeight: z.string(),
    }),
  ],
);

export const DETAIL_CALLOUT_SPEC_SCHEMA = z.object({
  entityType: z.literal("detail-callout-spec"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  engagementId: z.string().min(1),
  spec: DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA,
  pushState: z.enum(["pending", "pushed", "applied", "rejected-by-user"]),
  apsTaskRef: z.string().nullable(),
  findingId: z.string().nullable(),
  responseTaskId: z.string().nullable(),
  createdAt: z.string().min(1),
  pushedAt: z.string().nullable(),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// -----------------------------------------------------------------
// L5 — product-spec-reference. `esrNumber` is format-validated.
// -----------------------------------------------------------------

/** ICC-ES ESR number format guard (`ESR-<digits>`). */
export const ESR_NUMBER_RE = /^ESR-\d+$/;

export const PRODUCT_SPEC_REFERENCE_SCHEMA = z.object({
  entityType: z.literal("product-spec-reference"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  product: z.object({
    name: z.string().min(1),
    manufacturer: z.string().min(1),
  }),
  esrNumber: z.string().regex(ESR_NUMBER_RE, {
    message: "esrNumber must match ESR-<digits> (e.g. ESR-1234)",
  }),
  status: z.enum(["active", "withdrawn", "expired"]),
  lastVerifiedAt: z.string().min(1),
  statusHistory: z.array(
    z.object({
      status: z.enum(["active", "withdrawn", "expired"]),
      changedAt: z.string().min(1),
      sourceUrl: z.string(),
    }),
  ),
  engagementId: z.string().nullable(),
  findingId: z.string().nullable(),
  responseTaskId: z.string().nullable(),
  createdAt: z.string().min(1),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// -----------------------------------------------------------------
// L6 — deliverable-letter-render. `sourceLetterRef` is DID-prefix validated.
// -----------------------------------------------------------------

/** DID-prefix guard for `sourceLetterRef` — must point at a deliverable-letter atom. */
export const DELIVERABLE_LETTER_DID_RE = /^did:hauska:deliverable-letter:.+/;

export const DELIVERABLE_LETTER_RENDER_SCHEMA = z.object({
  entityType: z.literal("deliverable-letter-render"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  sourceLetterRef: z.string().regex(DELIVERABLE_LETTER_DID_RE, {
    message:
      "sourceLetterRef must be a did:hauska:deliverable-letter:<localId> ref",
  }),
  sourceLetterVersion: z.string().min(1),
  format: z.enum(["docx", "pdf"]),
  blobRef: z.string().min(1),
  renderedAt: z.string().min(1),
  renderedByActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

/**
 * Every L-surface atom schema keyed by `entityType`. Lets the
 * conformance test iterate the full L1-L6 set without re-listing.
 */
export const L_SURFACE_ATOM_SCHEMAS = {
  "response-task": RESPONSE_TASK_SCHEMA,
  "sheet-content-extraction": SHEET_CONTENT_EXTRACTION_SCHEMA,
  "attached-document": ATTACHED_DOCUMENT_SCHEMA,
  "deliverable-letter": DELIVERABLE_LETTER_SCHEMA,
  "detail-callout-spec": DETAIL_CALLOUT_SPEC_SCHEMA,
  "product-spec-reference": PRODUCT_SPEC_REFERENCE_SCHEMA,
  "deliverable-letter-render": DELIVERABLE_LETTER_RENDER_SCHEMA,
} as const;
