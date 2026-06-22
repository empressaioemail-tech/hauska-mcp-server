// Product dimension for the MCP tool surface.
//
// Orthogonal to tier. A key's tier governs rate-limit bands; its
// product governs which tool namespaces it may call.
//
//   public    — substrate catalog (search_atoms, get_atom, atom_trace, …).
//   codex     — Empressa Codex plan-review; also spans public catalog reads.
//   reporting — property briefs, encumbrances, L-surface deliverables, place/workspace.
//   map       — parcel polygons, hazards, hydrology, topography, map-layer assembly.
//
// Legacy `cortex` keys are normalized to `reporting` at read time (migration 003).

export type Product = "public" | "codex" | "reporting" | "map";

/** @deprecated Use reporting or map. Accepted only when normalizing stored keys. */
export type LegacyProduct = "cortex";

export const PRODUCTS: readonly Product[] = [
  "public",
  "codex",
  "reporting",
  "map",
] as const;

const PRODUCT_SET = new Set<string>(PRODUCTS);

export function isProduct(value: string): value is Product {
  return PRODUCT_SET.has(value);
}

/** Map stored api_keys.product to the live gate union (incl. legacy cortex). */
export function normalizeStoredProduct(value: string): Product {
  if (isProduct(value)) return value;
  if (value === "cortex") return "reporting";
  return "public";
}
