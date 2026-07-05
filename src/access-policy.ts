// ADR-005 / ADR-017 accessPolicy enforcement at the MCP gate (Layer A).
//
// Evaluates whether a caller may read an atom (or jurisdiction snapshot)
// given its declared accessPolicy, jurisdictionTenant, and optional
// tenant-shared list. Denied reads are audit-logged by the tool layer.

import type { AccessPolicy } from "@hauska/atom-contract";

import type { AuthContext } from "./auth.js";
import { logger } from "./logger.js";
import type { Tier } from "./tiers.js";

/**
 * Access policy enforced at the MCP gate. Equal to the contract union:
 * @hauska/atom-contract >=1.2 supplies the full five-value union including
 * "tenant-shared", so no local extension is needed (verified against 1.6.1).
 */
export type EnforcedAccessPolicy = AccessPolicy;

export type AccessSubjectTier = Tier | "free_anonymous";

export interface AccessSubject {
  tier: AccessSubjectTier;
  jurisdictionTenant: string | null;
  platformInternal: boolean;
}

export interface AccessTarget {
  accessPolicy?: EnforcedAccessPolicy;
  jurisdictionTenant: string;
  sharedWithTenants?: ReadonlyArray<string>;
}

export function accessSubjectFromContext(
  ctx: AuthContext | undefined,
): AccessSubject {
  return {
    tier: ctx?.tier ?? "free_anonymous",
    jurisdictionTenant: ctx?.jurisdiction_tenant ?? null,
    platformInternal: ctx?.platform_internal ?? false,
  };
}

/** Default unset accessPolicy per ADR-005 / dispatch. */
export function effectiveAccessPolicy(target: AccessTarget): EnforcedAccessPolicy {
  if (target.accessPolicy) return target.accessPolicy;
  if (target.jurisdictionTenant) return "tenant-private";
  return "public-free";
}

function isPaidTier(tier: AccessSubjectTier): boolean {
  return tier !== "free_anonymous" && tier !== "free";
}

function tenantOnSharedList(
  tenant: string,
  sharedWith?: ReadonlyArray<string>,
): boolean {
  return sharedWith?.includes(tenant) ?? false;
}

export function canReadAccessTarget(
  subject: AccessSubject,
  target: AccessTarget,
): boolean {
  const policy = effectiveAccessPolicy(target);
  switch (policy) {
    case "public-free":
      return true;
    case "public-paid":
      return isPaidTier(subject.tier);
    case "platform-internal":
      return subject.platformInternal;
    case "tenant-private":
      if (subject.platformInternal) return true;
      if (!subject.jurisdictionTenant) return false;
      return subject.jurisdictionTenant === target.jurisdictionTenant;
    case "tenant-shared":
      if (subject.platformInternal) return true;
      if (!subject.jurisdictionTenant) return false;
      if (subject.jurisdictionTenant === target.jurisdictionTenant) {
        return true;
      }
      return tenantOnSharedList(
        subject.jurisdictionTenant,
        target.sharedWithTenants,
      );
    default:
      return false;
  }
}

export function logAccessDenied(params: {
  tool: string;
  policy: EnforcedAccessPolicy;
  atomJurisdiction: string;
  subjectTenant: string | null;
  platformInternal: boolean;
  reason: string;
}): void {
  logger.warn("access_policy_denied", {
    tool: params.tool,
    policy: params.policy,
    atom_jurisdiction: params.atomJurisdiction,
    subject_tenant: params.subjectTenant,
    platform_internal: params.platformInternal,
    reason: params.reason,
  });
}

export function filterByAccessPolicy<T>(
  items: ReadonlyArray<T>,
  subject: AccessSubject,
  toTarget: (item: T) => AccessTarget,
  audit: { tool: string },
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const target = toTarget(item);
    if (canReadAccessTarget(subject, target)) {
      kept.push(item);
      continue;
    }
    logAccessDenied({
      tool: audit.tool,
      policy: effectiveAccessPolicy(target),
      atomJurisdiction: target.jurisdictionTenant,
      subjectTenant: subject.jurisdictionTenant,
      platformInternal: subject.platformInternal,
      reason: "post_fetch_filter",
    });
  }
  return kept;
}

export function readSharedWithTenants(
  record: Record<string, unknown>,
): string[] | undefined {
  const raw = record.sharedWithTenants ?? record.shared_with_tenants;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === "string");
}
