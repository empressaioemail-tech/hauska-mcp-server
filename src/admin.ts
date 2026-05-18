// Admin router. All routes mount under /admin and are gated by
// adminAuthMiddleware which expects the X-Hauska-Admin-Key header.
//
// POST   /admin/keys           mint a new key (raw key returned ONCE)
// GET    /admin/keys           list all keys (never returns raw key or hash)
// PATCH  /admin/keys/:key_id   update tier, status, or notes
// DELETE /admin/keys/:key_id   revoke (soft delete: status -> 'revoked')

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
import { logger } from "./logger.js";
import { TIERS, type Tier } from "./tiers.js";

const TIER_ENUM = z.enum(TIERS as readonly [Tier, ...Tier[]]);

const STATUS_ENUM = z.enum([
  "active",
  "revoked",
  "past_due",
  "canceled",
] as const satisfies readonly KeyStatus[]);

const CreateBody = z.object({
  tier: TIER_ENUM,
  owner_email: z.string().email(),
  owner_name: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
});

const PatchBody = z
  .object({
    tier: TIER_ENUM.optional(),
    status: STATUS_ENUM.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (v) => v.tier !== undefined || v.status !== undefined || v.notes !== undefined,
    "At least one of tier, status, notes must be provided.",
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
        owner_email: parsed.data.owner_email,
        owner_name: parsed.data.owner_name ?? null,
        notes: parsed.data.notes ?? null,
      });
      logger.info("admin_key_minted", {
        key_id: row.key_id,
        tier: row.tier,
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

  return router;
}
