/**
 * Codex + ICC tools retargeted at plan-review Cloud Run (G-60).
 * Do not call cortex-api /api/plan-review from these handlers.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildEnvelope,
  builtProvenance,
  emptyProvenance,
  makeProvenanceEntry,
  type EnvelopeProvenance,
} from "./atom-shape.js";
import { ICC_ACTOR_DID, ICC_JURISDICTION_TENANT, ICC_SOURCE_ADAPTER } from "./icc-content.js";
import { LegacyHttpError } from "./legacy-client.js";
import { planReviewClient, planReviewBackendUrl } from "./plan-review-client.js";
import { logToolRead } from "./read-attribution.js";
import { getCurrentProduct, getCurrentTier } from "./request-context.js";
import { listSourceObligationLedger } from "./source-obligation-meter.js";
import { CODEX_TIER } from "./tool-copy.js";

function envelopeContent(envelope: ReturnType<typeof buildEnvelope>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }] };
}

function errorContent(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

function describeFailure(tool: string, err: unknown): string {
  if (err instanceof LegacyHttpError) {
    return `${tool}: plan-review HTTP ${err.status}: ${err.body}`;
  }
  return `${tool}: ${String(err)}`;
}

function source(tool: string): string {
  return `mcp:${tool}`;
}

async function requireCodex(tool: string) {
  const product = getCurrentProduct();
  if (product !== "codex") {
    return {
      ok: false as const,
      content: errorContent(
        `${tool} requires a "codex"-product API key (got product "${product}").`,
      ),
    };
  }
  try {
    planReviewBackendUrl();
  } catch (err) {
    return { ok: false as const, content: errorContent(`${tool}: ${String(err)}`) };
  }
  return { ok: true as const };
}

/**
 * wrap requires an explicit provenance status. A bare [] is unrepresentable.
 * Ledger B (source_obligation_ledger) is authoritative. Ledger A is a cache.
 * This path accrues Ledger B via logToolRead; it does not write Ledger A.
 */
export function wrap(
  tool: string,
  data: unknown,
  provenance: EnvelopeProvenance,
) {
  const env = buildEnvelope(data, provenance, {
    tier: getCurrentTier(),
    readKind: provenance.status === "empty" ? "empty" : "catalog",
    note: "Served by plan-review Cloud Run. Not cortex-api. Calibration later.",
  });
  logToolRead({ tool, tier: getCurrentTier() }, env.atoms);
  return envelopeContent(env);
}

export function provenanceFromPlanReviewCode(
  data: Record<string, unknown>,
): EnvelopeProvenance {
  if (data.status === "typed-absence") {
    return emptyProvenance("no-atoms");
  }
  const book = typeof data.book === "string" ? data.book : "";
  const section =
    typeof data.section === "string"
      ? data.section
      : typeof data.sectionId === "string"
        ? data.sectionId
        : "";
  const sectionAtomId =
    typeof data.sectionAtomId === "string" ? data.sectionAtomId : "";
  const isIccBook =
    book.toUpperCase().includes("IBC") ||
    book.toUpperCase().includes("IRC") ||
    book.toUpperCase().includes("IFC") ||
    book.toUpperCase().includes("IPMC") ||
    Boolean(data.iccDeepLink);
  if (!isIccBook) {
    if (!sectionAtomId && !section) return emptyProvenance("no-atoms");
    return builtProvenance([
      makeProvenanceEntry({
        did: sectionAtomId || `did:hauska:code-section:${book || "local"}/${section}`,
        entityType: "code-section",
        entityId: section || sectionAtomId,
        jurisdictionTenant:
          typeof data.jurisdictionTenant === "string"
            ? data.jurisdictionTenant
            : "bastrop-tx",
        adapter: { status: "unmeasured" },
        sourceActorDid: null,
        sourceCitation: typeof data.citation === "string" ? data.citation : null,
        iccSourced: false,
        citedAtomDid: null,
      }),
    ]);
  }
  const did =
    sectionAtomId ||
    `did:hauska:code-section:${ICC_JURISDICTION_TENANT}/${book || "IBC"}/${section || "unknown"}`;
  return builtProvenance([
    makeProvenanceEntry({
      did,
      entityType: "code-section",
      entityId: section || did,
      jurisdictionTenant: ICC_JURISDICTION_TENANT,
      adapter: { status: "known", value: ICC_SOURCE_ADAPTER },
      url: typeof data.iccDeepLink === "string" ? data.iccDeepLink : null,
      sectionNumber: section || null,
      sourceActorDid: ICC_ACTOR_DID,
      sourceCitation: typeof data.citation === "string" ? data.citation : null,
      iccSourced: true,
      citedAtomDid: null,
    }),
  ]);
}

export function registerPlanReviewTools(server: McpServer): void {
  server.tool(
    "codex_finding_generation",
    "Codex (plan review): start intake for a parcel or load the applicability matrix for an existing engagement. " +
      "Calls plan-review POST /intake or GET /matrix. Zero Cotality. " +
      CODEX_TIER,
    {
      parcel_node_id: z.string().optional().describe("Parcel node id, e.g. 48021:28286. Required to start intake."),
      project_type: z.string().optional().describe("Project type. Defaults to new-single-family."),
      engagement_id: z.string().uuid().optional().describe("Existing engagement id. When set, returns the matrix."),
      org_id: z.string().optional().describe("Persona org. Defaults to icc-demo."),
      user_id: z.string().optional().describe("Persona user. Defaults to reviewer."),
      scope: z.string().optional(),
    },
    async (args) => {
      const tool = "codex_finding_generation";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        if (args.engagement_id) {
          return wrap(tool, await planReviewClient.matrix(args.engagement_id, source(tool)), emptyProvenance("no-atoms"));
        }
        if (!args.parcel_node_id) {
          return errorContent(`${tool}: parcel_node_id or engagement_id is required`);
        }
        return wrap(
          tool,
          await planReviewClient.intake(
            {
              parcelNodeId: args.parcel_node_id,
              projectType: args.project_type || "new-single-family",
              orgId: args.org_id || "icc-demo",
              userId: args.user_id || "reviewer",
              scope: args.scope,
            },
            source(tool),
          ),
          emptyProvenance("no-atoms"),
        );
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "codex_findings_fetch",
    "Codex (plan review): GET queue and/or findings library by section. " + CODEX_TIER,
    {
      section_id: z.string().optional().describe("Code section id for the findings library, e.g. R311.7."),
    },
    async ({ section_id }) => {
      const tool = "codex_findings_fetch";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        const queue = await planReviewClient.queue(source(tool));
        const findings = section_id
          ? await planReviewClient.findings(section_id, source(tool))
          : { findings: [] };
        return wrap(tool, { queue, findings }, emptyProvenance("no-atoms"));
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "codex_override_write",
    "Codex (plan review): POST override on a live engagement. Engine ingest may return a pending DID while L26 holds the slot. " +
      CODEX_TIER,
    {
      engagement_id: z.string().uuid(),
      section_atom_id: z.string().min(1),
      determination: z.string().min(1),
      reason: z.string().min(1),
      analysis: z.string().optional(),
      stage: z.string().optional(),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
    },
    async (args) => {
      const tool = "codex_override_write";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        return wrap(
          tool,
          await planReviewClient.override(
            args.engagement_id,
            {
              orgId: args.org_id || "icc-demo",
              userId: args.user_id || "reviewer",
              sectionAtomId: args.section_atom_id,
              determination: args.determination,
              reason: args.reason,
              analysis: args.analysis,
              stage: args.stage,
            },
            source(tool),
          ),
          emptyProvenance("no-atoms"),
        );
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "codex_briefing_fetch",
    "Codex (plan review): GET the atom-chain briefing for an engagement section. " + CODEX_TIER,
    {
      engagement_id: z.string().uuid(),
      section_atom_id: z.string().optional(),
    },
    async ({ engagement_id, section_atom_id }) => {
      const tool = "codex_briefing_fetch";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        return wrap(
          tool,
          await planReviewClient.briefing(engagement_id, section_atom_id, source(tool)),
          emptyProvenance("no-atoms"),
        );
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "codex_snapshot_ingest",
    "Codex (plan review): upload a sheet into the engagement Smart Files folder. Not an LDT snapshot. " +
      CODEX_TIER,
    {
      engagement_id: z.string().uuid(),
      title: z.string().min(1),
      bytes_base64: z.string().min(1),
      content_type: z.string().optional(),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
    },
    async (args) => {
      const tool = "codex_snapshot_ingest";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        return wrap(
          tool,
          await planReviewClient.uploadDocument(
            args.engagement_id,
            {
              orgId: args.org_id || "icc-demo",
              userId: args.user_id || "reviewer",
              title: args.title,
              contentType: args.content_type || "application/octet-stream",
              bytesBase64: args.bytes_base64,
            },
            source(tool),
          ),
          emptyProvenance("no-atoms"),
        );
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "plan_review_get_letter",
    "Codex (plan review): GET or generate the decision letter for an engagement. " + CODEX_TIER,
    {
      engagement_id: z.string().uuid(),
      generate: z.boolean().optional(),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
    },
    async (args) => {
      const tool = "plan_review_get_letter";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        if (args.generate) {
          return wrap(
            tool,
            await planReviewClient.generateLetter(
              args.engagement_id,
              { orgId: args.org_id || "icc-demo", userId: args.user_id || "reviewer" },
              source(tool),
            ),
            emptyProvenance("no-atoms"),
          );
        }
        return wrap(tool, await planReviewClient.letter(args.engagement_id, source(tool)), emptyProvenance("no-atoms"));
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "plan_review_get_code",
    "Codex (plan review): GET a code-library citation. IPMC is a typed absence. No verbatim ICC body. " +
      CODEX_TIER,
    {
      book: z.string().optional(),
      chapter: z.string().optional(),
      section: z.string().optional(),
    },
    async (args) => {
      const tool = "plan_review_get_code";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        const data = await planReviewClient.code(args, source(tool));
        return wrap(tool, data, provenanceFromPlanReviewCode(data));
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "plan_review_get_map_context",
    "Codex (plan review): parcel + overlay payload for E6. MCP does not serve tiles. " + CODEX_TIER,
    {
      engagement_id: z.string().uuid(),
    },
    async ({ engagement_id }) => {
      const tool = "plan_review_get_map_context";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        const engagement = await planReviewClient.engagement(engagement_id, source(tool));
        return wrap(tool, {
          engagement,
          e6Mounted: false,
          note: "Map compose is a clean hauska-map worktree on plan-review-app. MCP does not serve tiles.",
        }, emptyProvenance("no-atoms"));
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );

  server.tool(
    "icc_activity_list",
    "ICC activity portal data: inbound ledger rows for did:hauska:actor:org:icc. " + CODEX_TIER,
    {
      actor_did: z.string().optional(),
    },
    async ({ actor_did }) => {
      const tool = "icc_activity_list";
      const gate = await requireCodex(tool);
      if (!gate.ok) return gate.content;
      try {
        const actorDid = actor_did || "did:hauska:actor:org:icc";
        const cache = await planReviewClient.activity(actorDid, source(tool));
        const authoritative = await listSourceObligationLedger({
          sourceActorDid: actorDid,
          limit: 200,
        });
        return wrap(
          tool,
          {
            host: "hauska-mcp-server",
            store: "source_obligation_ledger",
            role: "authoritative",
            cacheRole: "plan_review_activity",
            actorDid,
            cache,
            rows: authoritative,
            note: "source_obligation_ledger is authoritative. plan_review_activity is a cache that reconciles against it. This tool does not accrue.",
          },
          emptyProvenance("no-atoms"),
        );
      } catch (err) {
        return errorContent(describeFailure(tool, err));
      }
    },
  );
}
