// Gate-front seam — types and header builder for engine-api calls.
//
// Mirrors services/engine-api/src/gate-front-context.ts. The MCP gate is
// the sole authority for tenant + package resolution before proxying.

import type { AccessPolicy } from "@empressaio/atom-contract";

import type { AuthContext } from "./auth.js";
import type { Product } from "./products.js";
import { getCurrentAuthContext, getCurrentRequestId } from "./request-context.js";

export const GATE_FRONT_PRODUCTS = [
  "cortex",
  "codex",
  "smartcity",
  "brief-extension",
  "revit-addin",
] as const;

export type GateFrontProduct = (typeof GATE_FRONT_PRODUCTS)[number];

export const GATE_FRONT_ACCESS_TIERS = [
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
] as const;

export type GateFrontAccessTier = (typeof GATE_FRONT_ACCESS_TIERS)[number];

export const GATE_FRONT_HEADERS = {
  product: "x-hauska-product",
  tenantId: "x-hauska-tenant-id",
  packageId: "x-hauska-package-id",
  accessTier: "x-hauska-access-tier",
  credentialId: "x-hauska-gate-credential-id",
  requestId: "x-hauska-request-id",
  subjectId: "x-hauska-subject-id",
} as const;

const PRODUCT_TO_GATE: Record<Product, GateFrontProduct | null> = {
  public: null,
  codex: "codex",
  reporting: "cortex",
  map: "cortex",
};

/** Map substrate product to engine-api gate-front product surface. */
export function gateFrontProductFor(product: Product): GateFrontProduct | null {
  return PRODUCT_TO_GATE[product];
}

/**
 * Resolve the access tier the gate forwards to engine-api from the
 * caller's auth context (ADR-017 / map-layers-contract).
 */
export function resolveGateAccessTier(
  ctx: AuthContext | undefined,
): GateFrontAccessTier | null {
  if (!ctx || ctx.tier === "free_anonymous") return null;
  if (ctx.platform_internal) return "platform-internal";
  if (ctx.jurisdiction_tenant?.trim()) return "tenant-private";
  if (ctx.tier !== "free") return "public-paid";
  return "public-free";
}

export function resolveGateTenantId(ctx: AuthContext | undefined): string | null {
  const tenant = ctx?.jurisdiction_tenant?.trim();
  return tenant && tenant.length > 0 ? tenant : null;
}

export interface GateFrontHeaderParams {
  product: GateFrontProduct;
  packageId: string;
  accessTier: GateFrontAccessTier;
  tenantId: string;
  gateCredentialId: string;
  requestId: string;
}

export function buildGateFrontHeaders(
  params: GateFrontHeaderParams,
): Record<string, string> {
  return {
    [GATE_FRONT_HEADERS.product]: params.product,
    [GATE_FRONT_HEADERS.tenantId]: params.tenantId,
    [GATE_FRONT_HEADERS.packageId]: params.packageId,
    [GATE_FRONT_HEADERS.accessTier]: params.accessTier,
    [GATE_FRONT_HEADERS.credentialId]: params.gateCredentialId,
    [GATE_FRONT_HEADERS.requestId]: params.requestId,
  };
}

export function gateFrontHeadersFromContext(params: {
  product: GateFrontProduct;
  packageId: string;
  accessTier: GateFrontAccessTier;
  tenantId: string;
  gateCredentialId: string;
  requestId?: string;
}): Record<string, string> {
  return buildGateFrontHeaders({
    ...params,
    requestId: params.requestId ?? getCurrentRequestId() ?? `gate-${Date.now()}`,
  });
}

/** Package access tiers recommended by map-layers-contract. */
export const MAP_LAYERS_ACCESS_TIERS: ReadonlyArray<AccessPolicy> = [
  "public-paid",
  "platform-internal",
  "tenant-private",
];

export function mapLayersAccessPolicyAllowed(
  tier: GateFrontAccessTier,
): boolean {
  return (MAP_LAYERS_ACCESS_TIERS as readonly string[]).includes(tier);
}
