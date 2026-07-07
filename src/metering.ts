// Layer 2 call metering (A4b — ICC contract acceptance criterion).
//
// Tracks product-gated tool calls (product != "public") for billing purposes.
// Emits structured logs and, when configured, posts events to Stripe billing meters.
//
// A Layer 2 call = successful `tools/call` on a product-gated tool by a keyed caller.
// Public-product tools are Layer 1 (free tier, never metered).

import { findKeyByHash, getPool } from "./db.js";
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
 * Records a Layer 2 call for metering and billing.
 * 
 * - ALWAYS emits a structured `layer2_call` log event (native truth for revenue panel)
 * - Writes to metering_events table (migration 007) for /metering/summary aggregation
 * - When STRIPE_SECRET_KEY is set AND key has stripe_customer_id, posts to Stripe meter
 * - Failures are logged but never thrown (tool path is never disrupted)
 */
export function recordLayer2Call(params: Layer2CallParams): void {
  const { keyId, keyHash, product, tier, tool, requestId } = params;

  // Fire-and-forget async flow: fetch key row for stripe_customer_id,
  // write to metering_events table, then log and optionally post to Stripe.
  // Never throws into tool path.
  void (async () => {
    try {
      const keyRow = await findKeyByHash(keyHash);
      const stripeCustomerId = keyRow?.stripe_customer_id ?? null;

      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const canBill = !!stripeKey && !!stripeCustomerId;

      // Write to metering_events table for native revenue aggregation
      try {
        await getPool().query(
          `INSERT INTO metering_events
             (key_id, key_hash, product, tier, tool, request_id, billed)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [keyId, keyHash, product, tier, tool, requestId, canBill],
        );
      } catch (dbErr) {
        // Log DB failure but continue with structured log + Stripe posting
        logger.error("metering_events_insert_error", {
          key_id: keyId,
          tool,
          error: String(dbErr).slice(0, 500),
        });
      }

      // Always log the native truth event
      logger.info("layer2_call", {
        key_id: keyId,
        key_hash: keyHash,
        product,
        tier,
        tool,
        request_id: requestId,
        stripe_customer_id: stripeCustomerId,
      });

      // Determine if we can bill via Stripe
      if (!stripeKey) {
        logger.info("layer2_call_unbilled", {
          key_id: keyId,
          tool,
          reason: "no_stripe_key",
        });
        return;
      }

      if (!stripeCustomerId) {
        logger.info("layer2_call_unbilled", {
          key_id: keyId,
          tool,
          reason: "no_customer_mapping",
        });
        return;
      }

      // Post to Stripe billing meter
      await postStripeMeterEvent({
        stripeKey,
        stripeCustomerId,
        requestId,
        keyId,
        tool,
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

interface StripeMeterEventParams {
  stripeKey: string;
  stripeCustomerId: string;
  requestId: string;
  keyId: string;
  tool: string;
}

/**
 * Posts an event to the Stripe billing meter API.
 * Uses the `layer2_call` meter created 2026-07-05 (test mode).
 * Meter ID: mtr_test_61UzHInRw5N1hYEjh41FjAepSMTX7ItU
 */
async function postStripeMeterEvent(
  params: StripeMeterEventParams,
): Promise<void> {
  const { stripeKey, stripeCustomerId, requestId, keyId, tool } = params;

  const url = "https://api.stripe.com/v1/billing/meter_events";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const body = new URLSearchParams({
      event_name: "layer2_call",
      payload: JSON.stringify({
        stripe_customer_id: stripeCustomerId,
        value: "1",
      }),
      identifier: requestId,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stripeKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Stripe meter event failed ${res.status}: ${text.slice(0, 300)}`,
      );
    }

    logger.info("layer2_call_metered", {
      key_id: keyId,
      tool,
      stripe_customer_id: stripeCustomerId,
    });
  } finally {
    clearTimeout(timeout);
  }
}
