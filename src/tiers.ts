// Tier definitions for the four-band rate-limit shape from
// doc_repo/29_mcp_surface_tier_model.md substrate-MCP section.
//
//   Free / public        1K calls/day/IP, 10K/day/key
//   Developer Pro        50K calls/day per key
//   Team                 500K calls/day per key
//   Embedder License     Unmetered; per-jurisdiction terms
//
// Per-tier limits live in env vars so Nick can shift caps without redeploy.
// A limit of 0 means "unmetered" (Embedder default).
//
// Both a per-minute burst cap and a per-day quota cap are enforced. The
// dispatch named RPM in env vars; the canonical tier model names daily caps.
// Shipping both: burst stops short-window abuse, daily quota is the
// accounting unit that maps to the customer-facing presentation.

export type Tier = "free" | "developer_pro" | "team" | "embedder";

export const TIERS: readonly Tier[] = [
  "free",
  "developer_pro",
  "team",
  "embedder",
] as const;

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

// Key prefix tag per tier. Full key string looks like
//   hk_<prefix>_<43-char-base64url-random>
// Audit-grep friendly without exposing tier in transport headers.
const TIER_PREFIX: Record<Tier, string> = {
  free: "free",
  developer_pro: "pro",
  team: "team",
  embedder: "emb",
};

export function tierPrefix(tier: Tier): string {
  return TIER_PREFIX[tier];
}

// Reverse map for parsing a raw key back to a tier hint. Used by the
// admin endpoints when displaying which tier a freshly minted key belongs
// to without re-hitting the DB.
export function tierFromPrefix(prefix: string): Tier | null {
  for (const t of TIERS) {
    if (TIER_PREFIX[t] === prefix) return t;
  }
  return null;
}

export interface RateLimits {
  // Per-minute burst cap. 0 means unmetered on this axis.
  rpm: number;
  // Per-day quota cap. 0 means unmetered on this axis.
  daily: number;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(
      `Invalid value for ${name}: expected non-negative integer, got "${raw}".`,
    );
  }
  return n;
}

// Free tier without a key is gated on IP; with a free-tier key the limits
// are higher (per the 29 doc 1K/IP/day vs 10K/key/day). Burst defaults
// chosen to give legitimate agents room without exposing the surface to
// trivial spam.
export function freeIpLimits(): RateLimits {
  return {
    rpm: readInt("HAUSKA_FREE_IP_RPM", 60),
    daily: readInt("HAUSKA_FREE_IP_DAILY", 1_000),
  };
}

export function limitsForTier(tier: Tier): RateLimits {
  switch (tier) {
    case "free":
      return {
        rpm: readInt("HAUSKA_FREE_KEY_RPM", 120),
        daily: readInt("HAUSKA_FREE_KEY_DAILY", 10_000),
      };
    case "developer_pro":
      return {
        rpm: readInt("HAUSKA_DEVELOPER_PRO_RPM", 600),
        daily: readInt("HAUSKA_DEVELOPER_PRO_DAILY", 50_000),
      };
    case "team":
      return {
        rpm: readInt("HAUSKA_TEAM_RPM", 3_000),
        daily: readInt("HAUSKA_TEAM_DAILY", 500_000),
      };
    case "embedder":
      // Embedder License is unmetered by default per the canonical model.
      // Operator can still set non-zero env values for soft enforcement
      // during a trial window.
      return {
        rpm: readInt("HAUSKA_EMBEDDER_RPM", 0),
        daily: readInt("HAUSKA_EMBEDDER_DAILY", 0),
      };
  }
}
