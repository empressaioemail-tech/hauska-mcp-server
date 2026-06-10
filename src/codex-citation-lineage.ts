// Codex finding citation lineage — gate envelope helpers (P0a).
//
// Citation atom ids are returned verbatim as stored post-P0b (#158).
// Envelope provenance surfaces cited code-section DIDs (or passes
// reasoning:/websearch: ids through unchanged).

import type { AtomProvenanceEntry } from "./atom-shape.js";

const CODE_SECTION_DID_PREFIX = "did:hauska:code-section:" as const;
const REASONING_PREFIXES = ["reasoning:", "websearch:"] as const;

export type FindingCodeCitationWire = {
  kind: "code-section";
  atomId: string;
};

export type FindingSourceCitationWire = {
  kind: "briefing-source";
  id: string;
  label: string;
};

export type FindingCitationWire =
  | FindingCodeCitationWire
  | FindingSourceCitationWire;

export interface FindingWire {
  id: string;
  submissionId: string;
  citations: FindingCitationWire[];
  [key: string]: unknown;
}

function isReasoningLayerAtomId(atomId: string): boolean {
  return REASONING_PREFIXES.some((p) => atomId.startsWith(p));
}

/** Map a stored citation atom id to an envelope DID without re-normalizing. */
export function citationAtomEnvelopeDid(atomId: string): string {
  if (atomId.startsWith("did:") || isReasoningLayerAtomId(atomId)) {
    return atomId;
  }
  return `${CODE_SECTION_DID_PREFIX}${atomId}`;
}

export function provenanceFromCodeCitation(
  citation: FindingCodeCitationWire,
  sourcePath: string,
  jurisdictionTenant: string,
): AtomProvenanceEntry {
  const atomId = citation.atomId;
  return {
    did: citationAtomEnvelopeDid(atomId),
    entityType: "code-section",
    entityId: atomId,
    jurisdictionTenant,
    contentHash: null,
    cidNote:
      "Citation atom id returned verbatim from findings row; DID maps code-section corpus ids for agent cite ergonomics.",
    source: {
      adapter: "legacy-design-tools",
      url: sourcePath,
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function provenanceEntriesFromFindings(
  findings: ReadonlyArray<FindingWire>,
  submissionId: string,
  jurisdictionTenant: string,
): AtomProvenanceEntry[] {
  const sourcePath = `/api/submissions/${submissionId}/findings`;
  const seen = new Set<string>();
  const atoms: AtomProvenanceEntry[] = [];
  for (const finding of findings) {
    for (const citation of finding.citations ?? []) {
      if (citation.kind !== "code-section") continue;
      const key = citation.atomId;
      if (seen.has(key)) continue;
      seen.add(key);
      atoms.push(
        provenanceFromCodeCitation(citation, sourcePath, jurisdictionTenant),
      );
    }
  }
  return atoms;
}
