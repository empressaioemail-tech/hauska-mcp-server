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

export const MAP_TOOLS = new Set([
  "assemble_map_layers",
  "get_parcel_polygon",
  "get_hazard_profile",
  "simulate_site_drainage",
  "get_site_drainage",
  "get_site_topography",
  "generate_parcel_terrain_model",
]);

export const REPORTING_TOOLS = new Set([
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
  "list_smart_file_folders",
  "list_smart_file_folder_files",
  "read_smart_file",
  "list_smart_file_placements",
  "create_smart_file_folder",
  "upload_smart_file",
  "share_smart_file_folder",
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

export const PUBLIC_CATALOG_TOOLS = new Set([
  "search_atoms",
  "get_atom",
  "get_property_atom_chain",
  "refresh_parcel_terrain_export",
  "refresh_parcel_site_plan_export",
  "refresh_parcel_dossier_export",
  "download_parcel_terrain_export",
  "download_parcel_site_plan_export",
  "download_parcel_dossier_export",
  "query_jurisdiction",
  "search_permit_atoms",
  "list_jurisdictions",
  "atom_trace",
  "dashboards_list_lenses",
]);

/** Public-product tools that require an identified caller (not anonymous, not a product SKU). */
export const IDENTIFIED_CALLER_TOOLS = new Set([
  "dashboards_get_city_pack",
]);

export const CODEX_TOOLS = new Set([
  "codex_finding_generation",
  "codex_override_write",
  "codex_briefing_fetch",
  "codex_findings_fetch",
  "codex_snapshot_ingest",
  "plan_review_get_letter",
  "plan_review_get_code",
  "plan_review_get_map_context",
  "icc_activity_list",
]);

/** Product required to invoke a gated tool (undefined = no product gate). */
export function requiredProductForTool(tool: string): Product | undefined {
  if (PUBLIC_CATALOG_TOOLS.has(tool)) return undefined;
  if (CODEX_TOOLS.has(tool) || tool.startsWith("codex_") || tool.startsWith("plan_review_") || tool === "icc_activity_list") return "codex";
  if (MAP_TOOLS.has(tool)) return "map";
  if (REPORTING_TOOLS.has(tool)) return "reporting";
  if (tool.startsWith("codex_")) return "codex";
  if (tool.startsWith("cortex_")) return "reporting";
  return undefined;
}

export function toolGateMetadata(name: string): ToolProductGate {
  if (name === "refresh_parcel_terrain_export") {
    return {
      product: "public",
      gate: "access_policy",
      gate_summary:
        "Public catalog paid terrain export (public-paid). Requires X-Hauska-Key with paid entitlement; anonymous/free denied. One SDK meter per export request via authorizePaidCall.",
      anonymous_ok: false,
    };
  }
  if (name === "refresh_parcel_site_plan_export") {
    return {
      product: "public",
      gate: "access_policy",
      gate_summary:
        "Public catalog paid site-plan export (public-paid) — sibling of refresh_parcel_terrain_export, same gate shape. Requires X-Hauska-Key with paid entitlement; anonymous/free denied. One SDK meter per export request via authorizePaidCall.",
      anonymous_ok: false,
    };
  }
  if (name === "refresh_parcel_dossier_export") {
    return {
      product: "public",
      gate: "access_policy",
      gate_summary:
        "Public catalog paid property-dossier PDF export (public-paid) — sibling of refresh_parcel_site_plan_export, same gate shape. Requires X-Hauska-Key with paid entitlement; anonymous/free denied. One SDK meter per export request via authorizePaidCall.",
      anonymous_ok: false,
    };
  }
  if (name === "download_parcel_terrain_export") {
    return {
      product: "public",
      gate: "access_policy",
      gate_summary:
        "Public catalog paid terrain download (public-paid). Second hop of refresh_parcel_terrain_export; identified caller required; anonymous/free denied. Not separately metered.",
      anonymous_ok: false,
    };
  }
  if (name === "download_parcel_site_plan_export") {
    return {
      product: "public",
      gate: "access_policy",
      gate_summary:
        "Public catalog paid site-plan download (public-paid). Second hop of refresh_parcel_site_plan_export; identified caller required; anonymous/free denied. Not separately metered.",
      anonymous_ok: false,
    };
  }
  if (name === "download_parcel_dossier_export") {
    return {
      product: "public",
      gate: "access_policy",
      gate_summary:
        "Public catalog paid dossier download (public-paid). Second hop of refresh_parcel_dossier_export; identified caller required; anonymous/free denied. Not separately metered.",
      anonymous_ok: false,
    };
  }
  if (name === "dashboards_get_city_pack") {
    return {
      product: "public",
      gate: "identified_caller",
      gate_summary:
        "Requires authenticated API key. Tenant city pack, not the public lens catalog. Anonymous refused.",
      anonymous_ok: false,
    };
  }
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

export function cataloguedToolNames(): Set<string> {
  return new Set([
    ...PUBLIC_CATALOG_TOOLS,
    ...CODEX_TOOLS,
    ...MAP_TOOLS,
    ...REPORTING_TOOLS,
    ...IDENTIFIED_CALLER_TOOLS,
  ]);
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
