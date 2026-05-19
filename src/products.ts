// Product dimension for the MCP tool surface.
//
// Orthogonal to tier. A key's tier governs rate-limit bands; its
// product governs which tool namespaces it may call.
//
//   public  — substrate catalog tools (search_atoms, get_atom,
//             list_jurisdictions, query_jurisdiction, search_permit_atoms).
//   codex   — Empressa Codex (plan-review) tools, per Lane B dispatch.
//   cortex  — Empressa Cortex (design accelerator) tools, per Lane B
//             dispatch.
//
// Per 29_mcp_surface_tier_model.md, Codex and Cortex are per-product
// MCP surfaces with their own buyer + tier semantics distinct from the
// substrate four-band model. Modeling them as a separate dimension
// avoids conflating the substrate tier axis with per-product seats.

export type Product = "public" | "codex" | "cortex";

export const PRODUCTS: readonly Product[] = [
  "public",
  "codex",
  "cortex",
] as const;

export function isProduct(value: string): value is Product {
  return (PRODUCTS as readonly string[]).includes(value);
}
