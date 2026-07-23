// Atom-grain read attribution helpers (Calibrated Spine F1).
//
// Gate D / WDLL 3.11: paid-read money path is authorizePaidRead →
// McpMeteringGate.authorizeCall at authorize-time (before serve).
// Post-success Stripe fire-and-forget is retired.

import { logToolInvocation, type ToolInvocationFields } from "./gtm-observability.js";
import type { AtomProvenanceEntry } from "./atom-shape.js";
import { recordLayer2Call } from "./metering.js";
import {
  getCurrentAuthContext,
  getCurrentProduct,
  getCurrentRequestId,
  getCurrentTier,
} from "./request-context.js";
import {
  authorizePaidCall,
  isSdkMeteringEnabled,
  type AuthorizePaidCallResult,
} from "./sdk-metering.js";

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

/**
 * Authorize a paid (product-gated) read via @hauska-sdk/metering.
 * Call at authorize-time, before tool serve. Public/anonymous never enter.
 */
export async function authorizePaidRead(params: {
  tool: string;
}): Promise<AuthorizePaidCallResult | { allowed: true; skipped: true }> {
  if (!isSdkMeteringEnabled()) {
    return { allowed: true, skipped: true };
  }

  const ctx = getCurrentAuthContext();
  const product = getCurrentProduct();
  const tier = getCurrentTier();
  const requestId = getCurrentRequestId();

  // Layer 1 / public product: never meter, never load SDK.
  if (product === "public" || !ctx?.key_id) {
    return { allowed: true, skipped: true };
  }

  return authorizePaidCall({
    keyId: ctx.key_id,
    keyHash: ctx.key_hash,
    mcpTier: tier,
    tool: params.tool,
    requestId,
    product,
  });
}

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

  // Dual-path fallback only: when SDK metering flag is off, keep the
  // post-success observability row (no Stripe). When flag is on,
  // authorizePaidRead already recorded at authorize-time.
  if (isSdkMeteringEnabled()) {
    return;
  }

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
