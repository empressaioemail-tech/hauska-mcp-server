// Adaptive workspace composition — pure logic (no I/O).
//
// Given a natural-language intent and an already-fetched tile
// capability registry, select and arrange the cortex workspace tiles
// that best serve the intent. Every function here is deterministic and
// side-effect free so it can be unit-tested without the network. The
// tool handler in tools.ts fetches the registry (and any engagement
// context) and calls composeWorkspace over the fetched data.

import type { TileCapability } from "./legacy-client.js";

export interface WorkspaceComposition {
  tiles: string[];
  layoutId: string;
  engagementId?: string;
  why: string;
}

export interface ComposeWorkspaceInput {
  intent: string;
  engagementId?: string;
  availableTileIds?: string[];
  maxTiles?: number;
}

export interface EngagementContext {
  id?: string;
  apn?: boolean;
  jurisdiction?: boolean;
  hasDocuments?: boolean;
  hasFindings?: boolean;
}

// Valid layout keys understood by @hauska/tile-shell CortexShell.
// "1" | "2h" | "2v" | "3l" | "3r" | "4" | "6"
const LAYOUTS = {
  "1": true,
  "2h": true,
  "2v": true,
  "3l": true,
  "3r": true,
  "4": true,
  "6": true,
} as const;

export type LayoutId = keyof typeof LAYOUTS;

/**
 * Map a tile count onto a valid layout key. Never crashes: counts <= 0
 * resolve to "1", counts >= 5 resolve to "6".
 */
export function pickLayout(count: number): string {
  if (count <= 1) return "1";
  if (count === 2) return "2h";
  if (count === 3) return "3l";
  if (count === 4) return "4";
  return "6";
}

/**
 * Whether the engagement context satisfies a tile's requirements. A
 * missing required capability returns false; a tile with no
 * requirements is always satisfied.
 */
export function isSatisfied(
  requires: TileCapability["requires"],
  ctx: EngagementContext,
): boolean {
  if (requires.engagementId && !ctx.id) return false;
  if (requires.apn && !ctx.apn) return false;
  if (requires.jurisdiction && !ctx.jurisdiction) return false;
  if (requires.uploadedDocuments && !ctx.hasDocuments) return false;
  if (requires.completedFindings && !ctx.hasFindings) return false;
  return true;
}

// Tokens that flag a spatial/geographic intent. When any intent token
// is one of these and a "map" tile exists, the map tile is force-kept.
export const SPATIAL_KEYWORDS = [
  "map",
  "location",
  "parcel",
  "zone",
  "zoning",
  "flood",
  "site",
] as const;

// Common English function words carry no ranking signal and, matched as
// substrings, are pure noise (e.g. "a" is a substring of "map",
// "Hazard"; "me" of "Document"). They are dropped during tokenization.
const STOP_WORDS = new Set([
  "the",
  "for",
  "and",
  "with",
  "show",
  "get",
  "see",
  "give",
  "want",
  "need",
  "please",
  "this",
  "that",
  "these",
  "those",
  "from",
  "into",
  "about",
  "over",
  "some",
  "any",
  "all",
  "you",
  "your",
  "our",
  "let",
  "run",
]);

/**
 * Tokenize an intent into ranking-significant terms. Splits on
 * non-alphanumeric runs, lowercases, drops stop-words and any token
 * shorter than three characters (single letters and two-letter
 * function words like "me"/"an" are substring noise, not signal).
 */
export function tokenizeIntent(intent: string): string[] {
  return intent
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

// Whole-word / word-prefix match so a term counts only when it aligns to
// a word boundary in the haystack, not as an interior substring. This
// keeps "compliance" matching "Compliance Run" and "hazard" matching
// "Hazard Profile" while refusing spurious interior hits.
function haystackHasTerm(haystack: string, term: string): boolean {
  return new RegExp(`\\b${term}`).test(haystack);
}

function scoreCandidate(tokens: string[], tile: TileCapability): number {
  const haystacks = [
    tile.label.toLowerCase(),
    tile.category.toLowerCase(),
    ...tile.mcpTools.map((t) => t.toLowerCase()),
  ];
  let score = 0;
  for (const token of tokens) {
    if (haystacks.some((h) => haystackHasTerm(h, token))) score += 1;
  }
  return score;
}

function tileMatchesTerm(tile: TileCapability, term: string): boolean {
  const haystacks = [
    tile.label.toLowerCase(),
    tile.category.toLowerCase(),
    ...tile.mcpTools.map((t) => t.toLowerCase()),
  ];
  return haystacks.some((h) => haystackHasTerm(h, term));
}

/**
 * Pure keyword ranking of candidate tiles against an intent.
 *
 * A tile's score is the number of ranking-significant intent tokens
 * (stop-words and sub-3-char terms dropped) that word-boundary-match
 * its label, category, or any of its mcpTools.
 *
 * Selection is coverage-first, then score-fill. A multi-topic intent
 * like "compliance and hazard" names two distinct terms; ranking by
 * score alone lets the several tiles that match the more common term
 * ("compliance") crowd out the tile that uniquely matches the rarer
 * term ("hazard"). To prevent that, we first walk the intent terms in
 * order and, for each, pull the highest-scoring not-yet-selected tile
 * that matches it (one representative per named term). We then fill any
 * remaining slots by overall score. Ties break on original registry
 * order throughout.
 *
 * Spatial rule: if any intent token is a SPATIAL_KEYWORDS entry and a
 * candidate with id "map" exists, the map tile is reserved a slot and
 * always included (even at score 0). Zero-score tiles are preferred
 * over an empty result: when candidates exist, the return is never
 * empty.
 */
export function selectTiles(
  intent: string,
  candidates: TileCapability[],
  maxTiles: number,
): TileCapability[] {
  const cap = maxTiles < 1 ? 1 : maxTiles;
  if (candidates.length === 0) return [];

  const tokens = tokenizeIntent(intent);

  // Decorate with original index and score; stable order = score desc,
  // then registry order.
  const ranked = candidates
    .map((tile, index) => ({ tile, index, score: scoreCandidate(tokens, tile) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const spatial =
    tokens.some((t) => (SPATIAL_KEYWORDS as readonly string[]).includes(t)) &&
    candidates.some((t) => t.id === "map");

  // Reserve one slot for the map tile when the intent is spatial.
  const mapReserve = spatial ? 1 : 0;
  const fillCap = Math.max(cap - mapReserve, mapReserve > 0 ? 0 : 1);

  const selected: TileCapability[] = [];
  const chosen = new Set<string>();
  const take = (r: { tile: TileCapability }) => {
    if (chosen.has(r.tile.id)) return;
    chosen.add(r.tile.id);
    selected.push(r.tile);
  };

  // Pass 1 — coverage: one representative per named intent term, in the
  // order the terms appear. Skip the map tile here (it has its own
  // reserved slot under the spatial rule).
  for (const term of tokens) {
    if (selected.length >= fillCap) break;
    const rep = ranked.find(
      (r) =>
        !chosen.has(r.tile.id) &&
        r.tile.id !== "map" &&
        r.score > 0 &&
        tileMatchesTerm(r.tile, term),
    );
    if (rep) take(rep);
  }

  // Pass 2 — score-fill remaining slots (still excluding the map tile,
  // whose slot is handled below).
  for (const r of ranked) {
    if (selected.length >= fillCap) break;
    if (r.tile.id === "map") continue;
    take(r);
  }

  // Map slot: append the reserved map tile when the intent is spatial.
  if (spatial && !chosen.has("map")) {
    const mapTile = candidates.find((t) => t.id === "map")!;
    selected.push(mapTile);
    chosen.add("map");
  }

  return selected.slice(0, cap);
}

/**
 * Orchestrate composition over already-fetched data (no I/O).
 *
 * Filters the registry to renderable tiles (live/partial), then to any
 * caller-supplied availableTileIds, then to tiles whose requirements
 * are satisfied by the engagement context (when one is supplied), ranks
 * the survivors against the intent, and returns a WorkspaceComposition.
 */
export function composeWorkspace(
  input: ComposeWorkspaceInput,
  registry: TileCapability[],
  ctx?: EngagementContext,
): WorkspaceComposition {
  const maxTiles = input.maxTiles ?? 4;

  let candidates = registry.filter(
    (t) => t.status === "live" || t.status === "partial",
  );

  if (input.availableTileIds?.length) {
    candidates = candidates.filter((t) =>
      input.availableTileIds!.includes(t.id),
    );
  }

  if (ctx) {
    candidates = candidates.filter((t) => isSatisfied(t.requires, ctx));
  }

  const selected = selectTiles(input.intent, candidates, maxTiles);
  const layoutId = pickLayout(selected.length);
  const labels = selected.map((t) => t.label).join(", ") || "no tiles";
  const why = `Selected ${labels} for: "${input.intent}"`;

  return {
    tiles: selected.map((t) => t.id),
    layoutId,
    engagementId: input.engagementId,
    why,
  };
}
