// API key generation, hashing, and parsing.
//
// Wire format: hk_<tier-prefix>_<43-char-base64url-random>
//   hk_free_<rand>     free-tier registered key
//   hk_pro_<rand>      Developer Pro
//   hk_team_<rand>     Team
//   hk_emb_<rand>      Embedder License
//
// 32 random bytes encoded as base64url gives 43 characters of entropy.
// Total wire length: 3 (hk_) + 3-4 (tier prefix) + 1 (_) + 43 = 50-51 chars.
//
// We store only the SHA-256 hash of the full key. Raw keys are surfaced
// to the caller exactly once at mint time and never logged.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { tierFromPrefix, tierPrefix, type Tier } from "./tiers.js";

const KEY_NAMESPACE = "hk";
const KEY_REGEX = /^hk_(free|pro|team|emb)_([A-Za-z0-9_-]{43})$/;

export interface GeneratedKey {
  raw: string;
  hash: string;
  tier: Tier;
}

export function generateKey(tier: Tier): GeneratedKey {
  const random = randomBytes(32).toString("base64url");
  const raw = `${KEY_NAMESPACE}_${tierPrefix(tier)}_${random}`;
  return { raw, hash: hashKey(raw), tier };
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Cheap structural validation before we hit the DB. Rejects garbage at
// the gate so the auth log captures shape failures separately from
// "valid shape, not in DB" failures.
export function parseKey(raw: string): { tier: Tier; hash: string } | null {
  const match = KEY_REGEX.exec(raw);
  if (!match) return null;
  const prefix = match[1];
  if (prefix === undefined) return null;
  const tier = tierFromPrefix(prefix);
  if (!tier) return null;
  return { tier, hash: hashKey(raw) };
}

// Constant-time comparison for the admin bootstrap key check. Avoids
// timing-side-channel leak even though the bootstrap key is set by the
// operator, not user input.
export function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
