// SDK money-boundary adapter (Gate D / Master WDLL 3.11 / I-F).
//
// Paid product-gated tools authorize via McpMeteringGate.authorizeCall
// BEFORE serve. Public-free / anonymous paths never import @hauska-sdk/*
// (dynamic import behind the paid gate only).
//
// Tier adapter: MCP free|developer_pro|team|embedder -> SDK free|builder|pro.
// Circle overage is optional; missing Circle secrets honest-degrade (PARTIAL).

import { getPool } from "./db.js";
import { logger } from "./logger.js";

/** Local shape matching @hauska-sdk/metering MeteringStore (no static SDK import). */
interface MeteringStore {
  getLayer2Usage(keyId: string, period: string): Promise<number>;
  incrementLayer2Usage(keyId: string, period: string): Promise<number>;
}

export type McpGateTier =
  | "free_anonymous"
  | "free"
  | "developer_pro"
  | "team"
  | "embedder";

/** Map MCP rate-limit tiers onto Decision B SDK metering tiers. */
export function mapMcpTierToSdkTier(
  tier: McpGateTier | string,
): "free" | "builder" | "pro" {
  switch (tier) {
    case "free":
    case "free_anonymous":
      return "free";
    case "developer_pro":
      return "builder";
    case "team":
    case "embedder":
      return "pro";
    default:
      return "free";
  }
}

export function isSdkMeteringEnabled(): boolean {
  const raw = process.env.SDK_METERING?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Postgres MeteringStore — durable Layer 2 usage by key + YYYY-MM period. */
export class PostgresMeteringStore implements MeteringStore {
  async getLayer2Usage(keyId: string, period: string): Promise<number> {
    const result = await getPool().query<{ layer2_count: number }>(
      `SELECT layer2_count FROM sdk_metering_usage
       WHERE key_id = $1 AND period = $2`,
      [keyId, period],
    );
    return result.rows[0]?.layer2_count ?? 0;
  }

  async incrementLayer2Usage(keyId: string, period: string): Promise<number> {
    const result = await getPool().query<{ layer2_count: number }>(
      `INSERT INTO sdk_metering_usage (key_id, period, layer2_count, updated_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (key_id, period) DO UPDATE
         SET layer2_count = sdk_metering_usage.layer2_count + 1,
             updated_at = NOW()
       RETURNING layer2_count`,
      [keyId, period],
    );
    return result.rows[0]?.layer2_count ?? 1;
  }
}

type SdkMeteringModule = typeof import("@hauska-sdk/metering");
type PaymentModule = typeof import("@hauska-sdk/payment");

let gatePromise: Promise<InstanceType<SdkMeteringModule["McpMeteringGate"]>> | null =
  null;
let sdkLoaded = false;

/** Test/introspection: has the SDK module been dynamically imported? */
export function wasSdkMeteringModuleLoaded(): boolean {
  return sdkLoaded;
}

/** Reset singleton (tests only). */
export function resetSdkMeteringGateForTests(): void {
  gatePromise = null;
  sdkLoaded = false;
}

/** True when env looks like a real Circle value (not scaffold placeholder). */
function isPresentSecret(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return false;
  if (v === "absent" || v === "unset" || v === "pending" || v === "replace-me") {
    return false;
  }
  return true;
}

function circleConfigured(): boolean {
  return (
    isPresentSecret(process.env.CIRCLE_API_KEY) &&
    isPresentSecret(process.env.CIRCLE_MERCHANT_WALLET_ID) &&
    isPresentSecret(process.env.HAUSKA_CHECKOUT_BASE_URL)
  );
}

async function buildGate(): Promise<
  InstanceType<SdkMeteringModule["McpMeteringGate"]>
> {
  // Dynamic import: public-free path never reaches here.
  const metering: SdkMeteringModule = await import("@hauska-sdk/metering");
  sdkLoaded = true;

  const store = new PostgresMeteringStore();
  let circleCheckout: InstanceType<
    PaymentModule["CircleCheckoutService"]
  > | undefined;
  let revenueRouter: InstanceType<PaymentModule["RevenueRouter"]> | undefined;

  if (circleConfigured()) {
    try {
      const payment: PaymentModule = await import("@hauska-sdk/payment");
      circleCheckout = new payment.CircleCheckoutService({
        provider: "circle",
        apiKey: process.env.CIRCLE_API_KEY!.trim(),
        merchantWalletId: process.env.CIRCLE_MERCHANT_WALLET_ID!.trim(),
        checkoutBaseUrl: process.env.HAUSKA_CHECKOUT_BASE_URL!.trim(),
        apiUrl: process.env.CIRCLE_API_URL?.trim() || undefined,
      });
      const takeRateBps = Number.parseInt(
        process.env.HAUSKA_TAKE_RATE_BPS?.trim() || "200",
        10,
      );
      revenueRouter = new payment.RevenueRouter({
        takeRateBps:
          Number.isFinite(takeRateBps) && takeRateBps >= 150 && takeRateBps <= 250
            ? takeRateBps
            : 200,
        ledger: new payment.InMemoryRoutingLedger(),
      });
      logger.info("sdk_metering_circle_wired", {});
    } catch (err) {
      logger.warn("sdk_metering_circle_init_failed", {
        error: String(err).slice(0, 500),
        note: "Authorize gate still runs; overage checkout honest-degrades.",
      });
    }
  } else {
    logger.info("sdk_metering_circle_absent", {
      note: "CIRCLE_* / HAUSKA_CHECKOUT_BASE_URL unset; within-bundle authorize OK; overage PARTIAL.",
    });
  }

  return new metering.McpMeteringGate({
    store,
    circleCheckout,
    revenueRouter,
  });
}

async function getGate(): Promise<
  InstanceType<SdkMeteringModule["McpMeteringGate"]>
> {
  if (!gatePromise) {
    gatePromise = buildGate();
  }
  return gatePromise;
}

export interface AuthorizePaidCallParams {
  keyId: string;
  mcpTier: McpGateTier | string;
  tool: string;
  requestId?: string;
  product: string;
  keyHash?: string;
}

export interface AuthorizePaidCallResult {
  allowed: boolean;
  denyMessage?: string;
  usage?: number;
  quota?: number;
  overage?: boolean;
  checkoutUrl?: string;
  sdkTier: "free" | "builder" | "pro";
  denyReason?: string;
}

/**
 * Authorize a Layer 2 (product-gated) call via SDK metering.
 * Must run at authorize-time, before tool serve.
 */
export async function authorizePaidCall(
  params: AuthorizePaidCallParams,
): Promise<AuthorizePaidCallResult> {
  const sdkTier = mapMcpTierToSdkTier(params.mcpTier);
  const gate = await getGate();
  const result = await gate.authorizeCall({
    keyId: params.keyId,
    tier: sdkTier,
    layer: 2,
  });

  logger.info("sdk_metering_authorize", {
    tool: params.tool,
    key_id: params.keyId,
    mcp_tier: params.mcpTier,
    sdk_tier: sdkTier,
    product: params.product,
    request_id: params.requestId ?? null,
    allowed: result.allowed,
    usage: result.usage ?? null,
    quota: result.quota ?? null,
    overage: result.overage ?? false,
    deny_reason: result.denyReason ?? null,
    fail_safe: result.failSafe ?? false,
    checkout_url: result.checkoutUrl ?? null,
  });

  // Observability append-only log. Writes authorized, never a payment flag.
  if (params.keyHash && params.requestId) {
    try {
      await getPool().query(
        `INSERT INTO metering_events
           (key_id, key_hash, product, tier, tool, request_id, authorized)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          params.keyId,
          params.keyHash,
          params.product,
          params.mcpTier,
          params.tool,
          params.requestId,
          result.allowed && !result.failSafe,
        ],
      );
    } catch (dbErr) {
      logger.error("metering_events_insert_error", {
        key_id: params.keyId,
        tool: params.tool,
        error: String(dbErr).slice(0, 500),
      });
    }
  }

  if (result.allowed) {
    return {
      allowed: true,
      usage: result.usage,
      quota: result.quota,
      overage: result.overage,
      checkoutUrl: result.checkoutUrl,
      sdkTier,
    };
  }

  const denyMessage = [
    `Metering denied for tool "${params.tool}"`,
    result.denyReason ? `(${result.denyReason})` : null,
    result.upgradeHint ?? result.error ?? null,
    result.checkoutUrl ? `Checkout: ${result.checkoutUrl}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  return {
    allowed: false,
    denyMessage,
    usage: result.usage,
    quota: result.quota,
    overage: result.overage,
    checkoutUrl: result.checkoutUrl,
    sdkTier,
    denyReason: result.denyReason,
  };
}
