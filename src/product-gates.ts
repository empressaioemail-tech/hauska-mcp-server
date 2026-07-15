// Tool → product gate registry (Architecture-Homes Track C).
//
// Single source of truth for requireProduct() and operator introspection.

import type { Product } from "./products.js";

export type ToolGateKind =
  | "access_policy"
  | "identified_caller"
  | "product_codex"
  | "product_reporting"
  | "product_map";

export interface ToolProductGate {
  product: Product;
  gate: ToolGateKind;
  gate_summary: string;
  anonymous_ok: boolean;
}

const MAP_TOOLS = new Set([
  "assemble_map_layers",
  "get_parcel_polygon",
  "get_hazard_profile",
  "simulate_site_drainage",
  "get_site_drainage",
  "get_site_topography",
  "generate_parcel_terrain_model",
]);

const REPORTING_TOOLS = new Set([
  "compose_workspace",
  "atom_export",
  "read_atom_calibration",
  "generate_property_brief",
  "get_property_brief_run",
  "search_encumbrances",
  "get_restrictions",
  "get_property_detail",
  "get_replacement_cost",
  "list_property_workspaces",
  "get_property_workspace",
  "list_workspace_share_edges",
  "resolve_place",
  "get_place_layers",
  "get_place_dossier",
  "cortex_snapshot_register",
  "cortex_ifc_ingest",
  "cortex_briefing_emit",
  "cortex_bim_model_query",
  "cortex_response_task_create",
  "cortex_response_task_update_state",
  "cortex_response_task_list",
  "cortex_response_task_link",
  "cortex_sheet_content_extraction_trigger",
  "cortex_sheet_content_extraction_fetch",
  "cortex_attached_document_list",
  "cortex_attached_document_fetch",
  "cortex_deliverable_letter_create",
  "cortex_deliverable_letter_update_section",
  "cortex_deliverable_letter_attach_provenance",
  "cortex_deliverable_letter_completeness_check",
  "cortex_deliverable_letter_send",
  "cortex_detail_callout_spec_create",
  "cortex_detail_callout_spec_update_push_state",
  "cortex_detail_callout_spec_attach_aps_ref",
  "cortex_detail_callout_spec_list",
  "cortex_detail_callout_spec_get",
  "cortex_product_spec_reference_create",
  "cortex_product_spec_reference_refresh_status",
  "cortex_product_spec_reference_list",
  "cortex_product_spec_reference_get",
  "cortex_deliverable_letter_render",
  "cortex_deliverable_letter_renders_list",
  "cortex_deliverable_letter_list",
  "cortex_deliverable_letter_fetch",
  "cortex_deliverable_letter_render_download",
]);

const PUBLIC_CATALOG_TOOLS = new Set([
  "search_atoms",
  "get_atom",
  "query_jurisdiction",
  "search_permit_atoms",
  "list_jurisdictions",
  "atom_trace",
]);

const CODEX_TOOLS = new Set([
  "codex_finding_generation",
  "codex_override_write",
  "codex_briefing_fetch",
  "codex_findings_fetch",
  "codex_snapshot_ingest",
]);

/** Product required to invoke a gated tool (undefined = no product gate). */
export function requiredProductForTool(tool: string): Product | undefined {
  if (PUBLIC_CATALOG_TOOLS.has(tool)) return undefined;
  if (CODEX_TOOLS.has(tool)) return "codex";
  if (MAP_TOOLS.has(tool)) return "map";
  if (REPORTING_TOOLS.has(tool)) return "reporting";
  if (tool.startsWith("codex_")) return "codex";
  if (tool.startsWith("cortex_")) return "reporting";
  return undefined;
}

export function toolGateMetadata(name: string): ToolProductGate {
  if (PUBLIC_CATALOG_TOOLS.has(name)) {
    return {
      product: "public",
      gate: "access_policy",
      gate_summary:
        "Public catalog; anonymous OK. Atom reads filtered by access-policy post-fetch.",
      anonymous_ok: true,
    };
  }
  if (CODEX_TOOLS.has(name) || name.startsWith("codex_")) {
    return {
      product: "codex",
      gate: "product_codex",
      gate_summary: 'Requires codex-product API key (requireProduct("codex")).',
      anonymous_ok: false,
    };
  }
  if (MAP_TOOLS.has(name)) {
    return {
      product: "map",
      gate: "product_map",
      gate_summary: 'Requires map-product API key (requireProduct("map")).',
      anonymous_ok: false,
    };
  }
  if (REPORTING_TOOLS.has(name)) {
    return {
      product: "reporting",
      gate: "product_reporting",
      gate_summary:
        'Requires reporting-product API key (requireProduct("reporting")).',
      anonymous_ok: false,
    };
  }
  if (
    name.startsWith("cortex_") ||
    name.startsWith("list_property_") ||
    name.startsWith("get_property_") ||
    name.startsWith("resolve_place") ||
    name.startsWith("get_place_")
  ) {
    return {
      product: "reporting",
      gate: "product_reporting",
      gate_summary:
        'Requires reporting-product API key (requireProduct("reporting")).',
      anonymous_ok: false,
    };
  }
  return {
    product: "public",
    gate: "identified_caller",
    gate_summary: "Requires authenticated API key.",
    anonymous_ok: false,
  };
}

/** Full tool → gate mapping for operator close reports. */
export function allToolProductGates(
  toolNames: readonly string[],
): Record<string, Product> {
  const out: Record<string, Product> = {};
  for (const name of toolNames) {
    out[name] = toolGateMetadata(name).product;
  }
  return out;
}
