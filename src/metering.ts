// Layer 2 call metering observability (legacy post-success path).
//
// Gate D / WDLL 3.11: the live paid money path is McpMeteringGate.authorizeCall
// in src/sdk-metering.ts (authorize-time, before serve). The legacy Stripe
// billing-meter post is RETIRED and must not return.
//
// This module remains only for the SDK_METERING=0 dual-path fallback: append
// metering_events rows + structured logs, with no external billing post.

import { getPool } from "./db.js";
import { logger } from "./logger.js";
import type { Product } from "./products.js";

export interface Layer2CallParams {
  keyId: string;
  keyHash: string;
  product: Product;
  tier: string;
  tool: string;
  requestId: string;
}

/**
 * Records a Layer 2 call for observability when SDK metering flag is off.
 * Never posts to Stripe. Failures are logged but never thrown.
 */
export function recordLayer2Call(params: Layer2CallParams): void {
  const { keyId, keyHash, product, tier, tool, requestId } = params;

  void (async () => {
    try {
      try {
        await getPool().query(
          `INSERT INTO metering_events
             (key_id, key_hash, product, tier, tool, request_id, authorized)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [keyId, keyHash, product, tier, tool, requestId, false],
        );
      } catch (dbErr) {
        logger.error("metering_events_insert_error", {
          key_id: keyId,
          tool,
          error: String(dbErr).slice(0, 500),
        });
      }

      logger.info("layer2_call", {
        key_id: keyId,
        key_hash: keyHash,
        product,
        tier,
        tool,
        request_id: requestId,
        authorized: false,
        money_path: "observability_only",
      });
    } catch (err) {
      logger.error("layer2_call_meter_error", {
        key_id: keyId,
        tool,
        error: String(err).slice(0, 500),
      });
    }
  })();
}
