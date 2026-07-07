// Atom-grain read attribution helpers (Calibrated Spine F1).

import { logToolInvocation, type ToolInvocationFields } from "./gtm-observability.js";
import type { AtomProvenanceEntry } from "./atom-shape.js";
import { recordLayer2Call } from "./metering.js";
import { getCurrentAuthContext, getCurrentProduct, getCurrentRequestId, getCurrentTier } from "./request-context.js";

/** Deduped DID list from envelope provenance entries. */
export function atomIdsFromProvenance(
  entries: ReadonlyArray<Pick<AtomProvenanceEntry, "did">>,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of entries) {
    const did = entry.did?.trim();
    if (!did || seen.has(did)) continue;
    seen.add(did);
    ids.push(did);
  }
  return ids;
}

type ReadLogFields = Omit<ToolInvocationFields, "atom_ids" | "atom_ids_returned">;

/** Canonical tool_call log for read handlers with atom-grain attribution. */
export function logToolRead(
  fields: ReadLogFields & { tool: string },
  atoms: ReadonlyArray<Pick<AtomProvenanceEntry, "did">> | string[],
): void {
  const atom_ids =
    Array.isArray(atoms) &&
    atoms.length > 0 &&
    typeof atoms[0] === "string"
      ? (atoms as string[])
      : atomIdsFromProvenance(
          atoms as ReadonlyArray<Pick<AtomProvenanceEntry, "did">>,
        );
  logToolInvocation({
    ...fields,
    atom_ids,
    atom_ids_returned: atom_ids.length,
  });

  // Layer 2 call metering: record successful product-gated tool calls
  // (product != "public") by authenticated callers for billing.
  const ctx = getCurrentAuthContext();
  const product = getCurrentProduct();
  const tier = getCurrentTier();
  const requestId = getCurrentRequestId();

  if (
    product !== "public" &&
    ctx?.key_id &&
    ctx?.key_hash &&
    requestId
  ) {
    recordLayer2Call({
      keyId: ctx.key_id,
      keyHash: ctx.key_hash,
      product,
      tier,
      tool: fields.tool,
      requestId,
    });
  }
}
