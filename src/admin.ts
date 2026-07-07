// Admin router. All routes mount under /admin and are gated by
// adminAuthMiddleware which expects the X-Hauska-Admin-Key header.
//
// POST   /admin/keys           mint a new key (raw key returned ONCE)
// GET    /admin/keys           list all keys (never returns raw key or hash)
// PATCH  /admin/keys/:key_id   update tier, status, or notes
// DELETE /admin/keys/:key_id   revoke (soft delete: status -> 'revoked')
//
// MCP introspection (operator console, read-only catalog + live probes):
// GET    /admin/introspection/tools
// GET    /admin/introspection/tools/:name
// POST   /admin/introspection/tools/:name/call

import { Router } from "express";
import { z } from "zod";

import {
  insertKey,
  listKeys,
  revokeKey,
  updateKey,
  type KeyStatus,
} from "./db.js";
import { generateKey } from "./keys.js";
import {
  callIntrospectionTool,
  getIntrospectionTool,
  listIntrospectionTools,
} from "./mcp-introspection.js";
import { logger } from "./logger.js";
import { PRODUCTS, type Product } from "./products.js";
import { TIERS, type Tier } from "./tiers.js";

const TIER_ENUM = z.enum(TIERS as readonly [Tier, ...Tier[]]);

const PRODUCT_ENUM = z.enum(PRODUCTS as readonly [Product, ...Product[]]);

const STATUS_ENUM = z.enum([
  "active",
  "revoked",
  "past_due",
  "canceled",
] as const satisfies readonly KeyStatus[]);

const CreateBody = z.object({
  tier: TIER_ENUM,
  // Default 'public' so existing operator scripts that mint substrate
  // keys without specifying product keep working unchanged.
  product: PRODUCT_ENUM.default("public"),
  jurisdiction_tenant: z.string().min(1).max(200).nullable().optional(),
  platform_internal: z.boolean().optional().default(false),
  owner_email: z.string().email(),
  owner_name: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
});

const PatchBody = z
  .object({
    tier: TIER_ENUM.optional(),
    product: PRODUCT_ENUM.optional(),
    jurisdiction_tenant: z.string().min(1).max(200).nullable().optional(),
    platform_internal: z.boolean().optional(),
    status: STATUS_ENUM.optional(),
    notes: z.string().max(2000).nullable().optional(),
    stripe_customer_id: z.string().min(1).max(200).nullable().optional(),
  })
  .refine(
    (v) =>
      v.tier !== undefined ||
      v.product !== undefined ||
      v.jurisdiction_tenant !== undefined ||
      v.platform_internal !== undefined ||
      v.status !== undefined ||
      v.notes !== undefined ||
      v.stripe_customer_id !== undefined,
    "At least one of tier, product, jurisdiction_tenant, platform_internal, status, notes, stripe_customer_id must be provided.",
  );

export function buildAdminRouter(): Router {
  const router = Router();

  router.post("/keys", async (req, res) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const generated = generateKey(parsed.data.tier);
    try {
      const row = await insertKey({
        key_hash: generated.hash,
        tier: parsed.data.tier,
        product: parsed.data.product,
        jurisdiction_tenant: parsed.data.jurisdiction_tenant ?? null,
        platform_internal: parsed.data.platform_internal,
        owner_email: parsed.data.owner_email,
        owner_name: parsed.data.owner_name ?? null,
        notes: parsed.data.notes ?? null,
      });
      logger.info("admin_key_minted", {
        key_id: row.key_id,
        tier: row.tier,
        product: row.product,
        owner_email: row.owner_email,
      });
      // raw is returned ONCE here. Never logged, never stored after this.
      return res.status(201).json({
        ...row,
        raw_key: generated.raw,
        warning:
          "The raw_key field is shown only on creation. Store it now; it cannot be retrieved later.",
      });
    } catch (err) {
      logger.error("admin_key_mint_failed", { error: String(err) });
      return res.status(500).json({ error: "Mint failed." });
    }
  });

  router.get("/keys", async (_req, res) => {
    try {
      const rows = await listKeys();
      return res.json({ keys: rows });
    } catch (err) {
      logger.error("admin_key_list_failed", { error: String(err) });
      return res.status(500).json({ error: "List failed." });
    }
  });

  router.patch("/keys/:key_id", async (req, res) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.flatten() });
    }
    try {
      const row = await updateKey(req.params.key_id, parsed.data);
      if (!row) return res.status(404).json({ error: "Key not found." });
      logger.info("admin_key_patched", {
        key_id: row.key_id,
        patch: parsed.data,
      });
      return res.json(row);
    } catch (err) {
      logger.error("admin_key_patch_failed", { error: String(err) });
      return res.status(500).json({ error: "Patch failed." });
    }
  });

  router.delete("/keys/:key_id", async (req, res) => {
    try {
      const row = await revokeKey(req.params.key_id);
      if (!row) return res.status(404).json({ error: "Key not found." });
      logger.info("admin_key_revoked", { key_id: row.key_id });
      return res.json(row);
    } catch (err) {
      logger.error("admin_key_revoke_failed", { error: String(err) });
      return res.status(500).json({ error: "Revoke failed." });
    }
  });

  const IntrospectionAuth = z
    .object({
      product: PRODUCT_ENUM.optional(),
      tier: z.union([TIER_ENUM, z.literal("free_anonymous")]).optional(),
      key_id: z.string().min(1).optional(),
      key_hash: z.string().min(1).optional(),
      jurisdiction_tenant: z.string().min(1).max(200).nullable().optional(),
      platform_internal: z.boolean().optional(),
    })
    .optional();

  const IntrospectionCallBody = z.object({
    arguments: z.record(z.unknown()).default({}),
    auth: IntrospectionAuth,
  });

  router.get("/introspection/tools", async (_req, res) => {
    try {
      const catalog = await listIntrospectionTools();
      return res.json(catalog);
    } catch (err) {
      logger.error("admin_introspection_list_failed", { error: String(err) });
      return res.status(500).json({ error: "Introspection list failed." });
    }
  });

  router.get("/introspection/tools/:name", async (req, res) => {
    try {
      const tool = await getIntrospectionTool(req.params.name);
      if (!tool) {
        return res.status(404).json({ error: "Tool not found." });
      }
      return res.json(tool);
    } catch (err) {
      logger.error("admin_introspection_get_failed", {
        tool: req.params.name,
        error: String(err),
      });
      return res.status(500).json({ error: "Introspection get failed." });
    }
  });

  router.post("/introspection/tools/:name/call", async (req, res) => {
    const parsed = IntrospectionCallBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.flatten() });
    }
    try {
      const outcome = await callIntrospectionTool(
        req.params.name,
        parsed.data.arguments,
        parsed.data.auth,
      );
      logger.info("admin_introspection_call", {
        tool: req.params.name,
        product: outcome.auth.product,
        tier: outcome.auth.tier,
        latency_ms: outcome.latency_ms,
        is_error: outcome.is_error,
      });
      return res.json(outcome);
    } catch (err) {
      logger.error("admin_introspection_call_failed", {
        tool: req.params.name,
        error: String(err),
      });
      return res.status(500).json({ error: "Introspection call failed." });
    }
  });

  return router;
}
