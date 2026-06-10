// Submission tenant partition gate for Codex finding tools (ADR-005).

import {
  canReadAccessTarget,
  effectiveAccessPolicy,
  logAccessDenied,
  type AccessSubject,
} from "./access-policy.js";

export function normalizeTenantSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/_/g, "-");
}

export function assertSubmissionPartitionReadable(
  subject: AccessSubject,
  submissionJurisdictionTenant: string | null | undefined,
  tool: string,
):
  | { ok: true; submissionTenant: string }
  | { ok: false; message: string } {
  if (subject.platformInternal) {
    return {
      ok: true,
      submissionTenant: submissionJurisdictionTenant
        ? normalizeTenantSlug(submissionJurisdictionTenant)
        : "hauska-internal",
    };
  }
  const raw = (submissionJurisdictionTenant ?? "").trim();
  if (!raw) {
    return {
      ok: false,
      message: `Tool "${tool}" denied: submission tenant partition is unknown.`,
    };
  }
  const submissionTenant = normalizeTenantSlug(raw);
  const target = {
    accessPolicy: "tenant-private" as const,
    jurisdictionTenant: submissionTenant,
  };
  const normalizedSubject: AccessSubject = {
    ...subject,
    jurisdictionTenant: subject.jurisdictionTenant
      ? normalizeTenantSlug(subject.jurisdictionTenant)
      : null,
  };
  if (!canReadAccessTarget(normalizedSubject, target)) {
    logAccessDenied({
      tool,
      policy: effectiveAccessPolicy(target),
      atomJurisdiction: submissionTenant,
      subjectTenant: normalizedSubject.jurisdictionTenant,
      platformInternal: normalizedSubject.platformInternal,
      reason: "submission_partition",
    });
    return {
      ok: false,
      message: `Tool "${tool}" denied: submission belongs to tenant "${submissionTenant}" and does not match the caller's partition.`,
    };
  }
  return { ok: true, submissionTenant };
}
