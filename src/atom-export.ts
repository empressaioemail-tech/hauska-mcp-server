// atom_export — DownloadableAtom assembly via @hauska/atom-contract/export.

import type { AccessPolicy } from "@hauska/atom-contract";
import {
  createDownloadableAtom,
  type DownloadableAtom,
} from "@hauska/atom-contract/export";
import type { ContextSummary } from "@hauska/atom-contract";
import type { ReadContract } from "@hauska/atom-contract/read-contract";

import type { AtomInstanceBase, GetAtomResponse } from "./hauska-client.js";
import { canReadAccessTarget, effectiveAccessPolicy } from "./access-policy.js";
import type { AccessSubject } from "./access-policy.js";
import { buildReadContract } from "./read-contract-bridge.js";

export interface AtomTraceWire {
  atom?: AtomInstanceBase;
  atomDid?: string;
  contextSummary?: ContextSummary;
  citations?: ReadonlyArray<{
    crossReferenceDid?: string;
    targetAtomDid?: string | null;
    crossReference?: AtomInstanceBase | null;
    targetAtom?: AtomInstanceBase | null;
  }>;
  outbound?: ReadonlyArray<{
    atomDid: string;
    atom?: AtomInstanceBase | null;
  }>;
  inbound?: ReadonlyArray<{
    atomDid: string;
    atom?: AtomInstanceBase | null;
  }>;
  signedEventChain?: unknown[];
  signedHistory?: { events?: unknown[] };
  verifyChain?: DownloadableAtom["verifyChain"];
}

const APP_ENTITY_TYPES = new Set([
  "property-workspace",
  "brief-run",
  "workspace-attachment",
  "workspace-share-edge",
  "deliverable-letter",
  "deliverable-letter-render",
]);

function atomTier(atom: AtomInstanceBase): "app" | "data" {
  if (atom.tier === "app" || atom.tier === "data") return atom.tier;
  return APP_ENTITY_TYPES.has(atom.entityType) ? "app" : "data";
}

function accessTarget(atom: AtomInstanceBase) {
  const accessPolicy =
    typeof atom.accessPolicy === "string"
      ? (atom.accessPolicy as AccessPolicy)
      : undefined;
  return {
    accessPolicy,
    jurisdictionTenant: atom.jurisdictionTenant,
    sharedWithTenants:
      Array.isArray(atom.sharedWithTenants) ?
        (atom.sharedWithTenants as string[])
      : undefined,
  };
}

/**
 * Export policy: caller may export tenant-private atoms in their partition
 * plus public-free/public-paid atoms composed by reference — never another
 * tenant's private data.
 *
 * BLOCKED-54: full tenant-leg partition for composed private refs is partial
 * until the tenant leg ships; we filter composition refs with canReadAccessTarget
 * but do not yet enforce workspace consent edges on export.
 */
export function assertAtomExportAllowed(
  subject: AccessSubject,
  atom: AtomInstanceBase,
): boolean {
  return canReadAccessTarget(subject, accessTarget(atom));
}

function pickIdentity(atom: AtomInstanceBase, atomDid: string) {
  return {
    entityType: atom.entityType,
    entityId: atom.entityId,
    contentId:
      (typeof atom.contentHash === "string" && atom.contentHash) ||
      atomDid,
    vdaRef:
      typeof atom.vdaRef === "string" ? atom.vdaRef : undefined,
  };
}

function pickContextSummary(
  atom: AtomInstanceBase,
  trace?: AtomTraceWire | null,
): ContextSummary {
  if (trace?.contextSummary) return trace.contextSummary as ContextSummary;
  return {
    prose:
      (typeof atom.bodyText === "string" ? atom.bodyText.slice(0, 500) : "") ||
      `${atom.entityType}/${atom.entityId}`,
    typed: { entityType: atom.entityType, entityId: atom.entityId },
    keyMetrics: [],
    relatedAtoms: [],
    historyProvenance: {
      latestEventId: String(atom.contentHash ?? atom.entityId),
      latestEventAt: atom.fetchedAt ?? new Date().toISOString(),
    },
    scopeFiltered: false,
  };
}

function pickReadContract(
  envelopeReadContract?: ReadContract,
): ReadContract {
  if (envelopeReadContract) return envelopeReadContract;
  return buildReadContract({ kind: "catalog", atomCount: 1 });
}

function compositionRefs(
  trace: AtomTraceWire | null | undefined,
  subject: AccessSubject,
) {
  const edges = [
    ...(trace?.outbound ?? []),
    ...(trace?.inbound ?? []),
  ];
  const refs: Array<{
    kind: "atom";
    entityType: string;
    entityId: string;
    displayLabel?: string;
  }> = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const atom = edge.atom;
    if (!atom) continue;
    if (!assertAtomExportAllowed(subject, atom)) continue;
    const key = `${atom.entityType}:${atom.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      kind: "atom",
      entityType: atom.entityType,
      entityId: atom.entityId,
    });
  }
  return refs;
}

function pickCitations(trace?: AtomTraceWire | null) {
  if (!trace?.citations?.length) return [];
  return trace.citations.map((c) => ({
    citationDid:
      c.crossReferenceDid ??
      c.targetAtomDid ??
      "did:hauska:code-cross-reference:unknown",
    citedAtom:
      c.targetAtom ?
        {
          kind: "atom" as const,
          entityType: c.targetAtom.entityType,
          entityId: c.targetAtom.entityId,
        }
      : undefined,
  }));
}

export function assembleDownloadableAtomExport(params: {
  atomDid: string;
  getAtom: GetAtomResponse;
  trace?: AtomTraceWire | null;
  readContract?: ReadContract;
  subject: AccessSubject;
}) {
  const atom = params.getAtom.atom;
  if (!atom) {
    return {
      ok: false as const,
      errors: [{ path: "atom", message: "Atom not found" }],
    };
  }
  if (!assertAtomExportAllowed(params.subject, atom)) {
    return {
      ok: false as const,
      errors: [
        {
          path: "accessPolicy",
          message:
            "Export denied: atom is not readable under caller access policy (tenant-private partition).",
        },
      ],
    };
  }

  const tier = atomTier(atom);
  const signedEventChain = (
    params.trace?.signedEventChain ??
    params.trace?.signedHistory?.events ??
    (Array.isArray(atom.signedEventChain) ? atom.signedEventChain : [])
  ) as DownloadableAtom["signedEventChain"];

  const outcome = createDownloadableAtom({
    tier,
    identity: pickIdentity(atom, params.atomDid),
    accessPolicy: (effectiveAccessPolicy(accessTarget(atom)) ??
      "public-free") as AccessPolicy,
    contextSummary: pickContextSummary(atom, params.trace),
    readContract: pickReadContract(params.readContract),
    compositionReferences: compositionRefs(params.trace, params.subject),
    citations: pickCitations(params.trace),
    signedEventChain: tier === "data" ? signedEventChain : [],
  });

  return outcome;
}
