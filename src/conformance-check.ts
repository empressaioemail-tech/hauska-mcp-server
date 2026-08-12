// Read-tool conformance against @empressaio/atom-contract/conformance (1.5.0).

import {
  ATOM_CONFORMANCE_TARGET_VERSION,
  validateAtomConformance,
  type AtomConformanceValidationResult,
} from "@empressaio/atom-contract/conformance";
import type { AccessPolicy } from "@empressaio/atom-contract";
import type { ReadContract } from "@empressaio/atom-contract/read-contract";

import { logger } from "./logger.js";

export { ATOM_CONFORMANCE_TARGET_VERSION };

export function checkReadToolConformance(params: {
  tool: string;
  readContract: ReadContract;
  accessPolicy?: AccessPolicy;
}): AtomConformanceValidationResult {
  const result = validateAtomConformance({
    tier: "app",
    readContract: params.readContract,
    accessPolicy: params.accessPolicy ?? "public-free",
  });
  if (!result.ok) {
    logger.warn("read_tool_conformance_miss", {
      tool: params.tool,
      target: ATOM_CONFORMANCE_TARGET_VERSION,
      errors: result.errors,
    });
  }
  return result;
}
