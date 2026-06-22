// Gate package registry — capability authorization before engine-api proxy.
//
// cc-agent-M registers packages here; each tool asserts package access
// (product key + accessPolicy + tenant scope) before calling engine-api.

import type { AccessSubject } from "./access-policy.js";
import {
  gateFrontProductFor,
  mapLayersAccessPolicyAllowed,
  resolveGateAccessTier,
  resolveGateTenantId,
  type GateFrontAccessTier,
  type GateFrontProduct,
} from "./gate-front.js";
import {
  MAP_LAYER_BASIC_KEYS,
  MAP_LAYER_KEYS,
  MAP_LAYER_RICH_KEYS,
  MAP_LAYERS_PACKAGE_ID,
  type MapLayerKey,
  type MapLayersJurisdiction,
} from "./map-layers-contract.js";
import { getCurrentAuthContext, getCurrentProduct } from "./request-context.js";
import { logger } from "./logger.js";

export interface PackageGateDenial {
  ok: false;
  message: string;
}

export interface PackageGateOk {
  ok: true;
  gateProduct: GateFrontProduct;
  accessTier: GateFrontAccessTier;
  tenantId: string;
  gateCredentialId: string;
}

export type PackageGateResult = PackageGateOk | PackageGateDenial;

function deny(tool: string, message: string): PackageGateDenial {
  logger.warn("package_gate_denied", { tool, package: MAP_LAYERS_PACKAGE_ID, message });
  return { ok: false, message };
}

/** Max-tier map render entitlement — rich wave-3 layer slots. */
export function hasMaxTierEntitlement(subject: AccessSubject): boolean {
  return (
    subject.platformInternal ||
    subject.tier === "team" ||
    subject.tier === "embedder"
  );
}

export function isRichMapLayer(layer: MapLayerKey): boolean {
  return (MAP_LAYER_RICH_KEYS as readonly string[]).includes(layer);
}

/** Filter requested layers to those the caller's tier may assemble. */
export function filterLayersForEntitlement(
  requested: ReadonlyArray<MapLayerKey> | undefined,
  subject: AccessSubject,
): { ok: true; layers: MapLayerKey[] } | PackageGateDenial {
  const base = requested ?? [...MAP_LAYER_KEYS];
  if (hasMaxTierEntitlement(subject)) {
    return { ok: true, layers: [...base] };
  }

  const rich = base.filter(isRichMapLayer);
  if (rich.length > 0) {
    return deny(
      "assemble_map_layers",
      `Layer(s) [${rich.join(", ")}] require Max-tier map render entitlement (team or embedder API key, or platform-internal operator key). Basic tier may request: ${MAP_LAYER_BASIC_KEYS.join(", ")}.`,
    );
  }
  return { ok: true, layers: [...base] };
}

/**
 * Cross-tenant guard: when a local jurisdiction key is present it must
 * match the caller's tenant partition (unless platform-internal).
 */
export function assertJurisdictionTenantScope(
  tool: string,
  jurisdiction: MapLayersJurisdiction,
  subject: AccessSubject,
): { ok: true } | PackageGateDenial {
  if (subject.platformInternal) return { ok: true };
  const localKey = jurisdiction.localKey;
  if (!localKey) return { ok: true };
  if (!subject.jurisdictionTenant) {
    return deny(
      tool,
      `Jurisdiction localKey "${localKey}" requires a tenant-bound API key.`,
    );
  }
  if (subject.jurisdictionTenant !== localKey) {
    return deny(
      tool,
      `Cross-tenant denial: jurisdiction localKey "${localKey}" does not match caller tenant "${subject.jurisdictionTenant}".`,
    );
  }
  return { ok: true };
}

/** Post-proxy audit: response tenantScope must match the caller partition. */
export function assertResponseTenantScope(
  tool: string,
  tenantScope: string,
  subject: AccessSubject,
): { ok: true } | PackageGateDenial {
  if (subject.platformInternal) return { ok: true };
  if (!subject.jurisdictionTenant) {
    return deny(tool, "Response tenantScope mismatch: caller has no tenant binding.");
  }
  if (tenantScope !== subject.jurisdictionTenant) {
    return deny(
      tool,
      `Cross-tenant denial: engine returned tenantScope "${tenantScope}" for caller tenant "${subject.jurisdictionTenant}".`,
    );
  }
  return { ok: true };
}

/**
 * Full map-layers package gate: product key, accessPolicy tier, tenant
 * binding, and gate-front header material for engine-api proxy.
 */
export function assertMapLayersPackageGate(tool: string): PackageGateResult {
  const product = getCurrentProduct();
  const gateProduct = gateFrontProductFor(product);
  if (!gateProduct) {
    return deny(
      tool,
      `Tool "${tool}" requires a map-product API key. The caller is on product "${product}".`,
    );
  }

  const ctx = getCurrentAuthContext();
  const accessTier = resolveGateAccessTier(ctx);
  if (!accessTier) {
    return deny(tool, `Tool "${tool}" requires an authenticated API key.`);
  }
  if (!mapLayersAccessPolicyAllowed(accessTier)) {
    return deny(
      tool,
      `Package "${MAP_LAYERS_PACKAGE_ID}" denied for access tier "${accessTier}".`,
    );
  }

  const tenantId = resolveGateTenantId(ctx);
  if (!tenantId && !ctx?.platform_internal) {
    return deny(
      tool,
      `Package "${MAP_LAYERS_PACKAGE_ID}" requires a tenant-bound API key (jurisdiction_tenant on the key row).`,
    );
  }
  if (!tenantId) {
    return deny(
      tool,
      `Package "${MAP_LAYERS_PACKAGE_ID}" requires X-Hauska-Tenant-Id; platform-internal keys must still specify jurisdiction_tenant for map layer assembly.`,
    );
  }

  const gateCredentialId = ctx?.key_id;
  if (!gateCredentialId) {
    return deny(tool, `Tool "${tool}" requires an authenticated API key id for gate audit.`);
  }

  return {
    ok: true,
    gateProduct,
    accessTier,
    tenantId,
    gateCredentialId,
  };
}

export { MAP_LAYERS_PACKAGE_ID };
