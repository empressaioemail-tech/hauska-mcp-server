// LLM-first tool descriptions (GTM sprint M2).
// Tier + jurisdiction_key examples + typical failure modes per tool group.

export const PUBLIC_TIER =
  "Tier: public Layer 1 (no API key). Example jurisdiction_key: bastrop-tx, grand-county-co. " +
  "Typical failures: no_coverage (jurisdiction not in list_jurisdictions), empty_corpus, upstream_timeout. " +
  "Optional paid reads: send X-Hauska-Key header for public-paid atom visibility (per-atom accessPolicy, not package tier).";

export const BROKERAGE_TIER =
  "Tier: product read (authenticated reporting API key). " +
  "Example jurisdiction_key: bastrop-tx, cedar-hill-tx (Central TX pilot). " +
  "Typical failures: auth_reject (missing/invalid key), geocode_miss, no_coverage, upstream_timeout.";

export const CODEX_TIER =
  "Tier: product Layer 2 Codex (codex API key). Not anonymous. " +
  "Typical failures: auth_reject, upstream_timeout, 404 (submission/finding not found), 409 (override conflict).";

export const CORTEX_TIER =
  "Tier: product Layer 2 Cortex (cortex API key). Not anonymous. " +
  "Typical failures: auth_reject, upstream_timeout, 404 (engagement/snapshot missing).";

export const REPORTING_TIER =
  "Tier: product Layer 2 Reporting (reporting API key). Not anonymous. " +
  "Property briefs, encumbrances, L-surface deliverables, place/workspace reads. " +
  "Typical failures: auth_reject, upstream_timeout, 404 (engagement/workspace missing).";

export const MAP_TIER =
  "Tier: product Layer 2 Map (map API key). Not anonymous. " +
  "Parcel polygons, hazards, hydrology, topography, map-layer assembly. " +
  "Typical failures: auth_reject, no_coverage, upstream_timeout.";

export const TOOL_COPY = {
  search_atoms:
    "Search the ingested municipal code corpus for atoms matching a free-text query. " +
    "Returns ranked atom references with provenance (DID, source adapter, source URL, content hash). " +
    "Use for topics like setbacks, parking, or occupancy; follow with get_atom on a returned DID. " +
    PUBLIC_TIER,

  get_atom:
    "Retrieve one catalog atom by DID (code-section or property-chain types: zoning-fact, setback-rule, buildable-envelope, parcel-node) with full provenance. " +
    "Optional include_composition traverses atom-link children (definitions, cross-refs). " +
    "Per-atom accessPolicy enforced post-fetch; optional X-Hauska-Key for public-paid visibility. " +
    PUBLIC_TIER,

  get_property_atom_chain:
    "Retrieve the property reasoning-chain for a parcel: zoning-fact, setback-rule, and buildable-envelope atoms with stable DIDs. " +
    "Input parcel_node_id (county_fips:prop_id, e.g. 48209:156346) OR any chain atom_did — returns the same three slots. " +
    "Catalog-tool path: each atom filtered by its own accessPolicy (anonymous sees public-free only; public-paid envelope requires X-Hauska-Key with paid entitlement). " +
    "Honest atom_path_pending when PROPERTY_ATOM_PATH corpus rows are absent — never fabricates values. " +
    "Does not alter the reporting/map package path. " +
    PUBLIC_TIER,

  refresh_parcel_terrain_export:
    "Refresh and return the paid parcel-terrain-model atom (terrain-export spine) for county_fips:prop_id (e.g. 48021:27303). " +
    "Formats: glb, ifc, dxf-3dface, dxf-contour, landxml-tin (honest defer when not shipped). " +
    "USGS 3DEP sourced; accessPolicy public-paid. Catalog path — NOT the engagement map tool generate_parcel_terrain_model. " +
    "Requires X-Hauska-Key with paid entitlement; anonymous and free tiers are denied. " +
    "One SDK metering event (authorizePaidCall) per export request regardless of format count or optional download bytes. " +
    "Optional format param triggers artifact download (inline base64 when small; ref + downloadPath when large). " +
    PUBLIC_TIER,

  query_jurisdiction:
    "Per-jurisdiction status snapshot: loaded edition, quality bar, atom count, drift. " +
    "Confirm availability before search_atoms. Parcel-level zoning by address is not v1 — use resolve_place with a product key. " +
    PUBLIC_TIER,

  search_permit_atoms:
    "Layer 1 retrieval of permit-tagged code atoms for a project_type in a jurisdiction (e.g. single-family residence). " +
    "Does not infer permit lists — reason over returned atoms. End-to-end permit inference is Codex, not MCP Layer 1. " +
    PUBLIC_TIER,

  list_jurisdictions:
    "List jurisdictions loaded in Hauska Engine with quality bar and atom counts. " +
    "Anonymous callers see Path A public-free tenants only (e.g. bastrop-tx); authenticated keys may see platform-internal tenants. " +
    PUBLIC_TIER,

  resolve_place:
    "Resolve an address or lat/lng to placeKey, jurisdiction_key, optional ll_uuid and workspace DID. " +
    "Central TX pilot only — not a country-scale dossier. Requires authenticated brokerage/cortex API key. " +
    BROKERAGE_TIER,

  get_place_layers:
    "List place layers (parcel, zoning, code refs) for a placeKey with snapshot-first provenance per layer. " +
    "Requires authenticated brokerage/cortex API key. " +
    BROKERAGE_TIER,

  get_place_dossier:
    "Bounded place dossier: code inlineRefs (max 3), parcel/zoning layers, federal summary refs; every field cites source + asOf. " +
    "Not full G3 country graph. Requires authenticated brokerage/cortex API key. " +
    BROKERAGE_TIER,

  list_property_workspaces:
    "List property workspaces visible to the caller (owner or collaborator), newest-first. " +
    "Returns workspace ids, roles, timestamps, compact evidence refs. Requires authenticated API key (key_id as requester). " +
    BROKERAGE_TIER,

  get_property_workspace:
    "Fetch full property-workspace package by workspace_id when caller is owner or collaborator. " +
    BROKERAGE_TIER,

  list_workspace_share_edges:
    "List consent-aware share edges for a workspace (default: consent-visible only). Owner/collaborator access required. " +
    BROKERAGE_TIER,

  generate_property_brief:
    "Generate a Property Brief for an address: reasoning summary, lay summary, site-context layers, and cited code atoms. " +
    "Returns a brief-run atom (did:hauska:brief-run:<runId>). Layer 2 keystone — requires reporting product key. " +
    REPORTING_TIER,

  get_property_brief_run:
    "Fetch a stored Property Brief run by runId. Read companion to generate_property_brief. " +
    REPORTING_TIER,

  simulate_site_drainage:
    "Run site-drainage simulation for an engagement (D8 flow routing + rainfall forcing). " +
    "Engagement-scoped — requires engagement_id. Returns site-drainage ingest status. " +
    MAP_TIER,

  get_site_drainage:
    "Read the active site-drainage atom for an engagement. Optionally include NOAA Atlas 14 design-storm estimates. " +
    MAP_TIER,

  get_site_topography:
    "Read site-topography for an engagement (DEM, contours). Set refresh=true to trigger ingest first. " +
    MAP_TIER,

  generate_parcel_terrain_model:
    "Return the georeferenced 3D terrain mesh (GLB) and IFC4 model for a parcel/engagement. " +
    "Sourced from USGS 3DEP public elevation, coverage-honest (carries confidence estimate + source-resolution + provenance). " +
    "Layer 2 processed output: the assembled, import-ready mesh and IFC references plus their geometry metadata " +
    "(vertex/triangle counts, georef origin, IFC schema version, byte counts) and the topography coverage signals. " +
    "The mesh and IFC are produced during site-topography ingest and keyed to the engagement; " +
    "if they are not yet generated, this returns a not-yet-generated response instructing the caller to run site-topography refresh first (never fabricated geometry). " +
    "Optional formats filters the returned references to mesh, ifc, or both (default both). " +
    MAP_TIER,

  search_encumbrances:
    "List recorded-instrument and restriction-clause atoms uploaded to a property workspace. " +
    "Workspace-scoped via workspace_did. " +
    REPORTING_TIER,

  get_restrictions:
    "Fetch restriction-clause atoms for a property workspace (ADR-020/021). Workspace-scoped via workspace_did. " +
    REPORTING_TIER,

  get_property_detail:
    "Cotality property-characteristics adapter (DESIGNED, INERT until CoreLogic OAuth clears). " +
    "Returns credential-pending when credentials are absent — never fake data. atoms[] stays empty until OAuth materializes Cotality atoms. " +
    REPORTING_TIER,

  get_replacement_cost:
    "Cotality replacement-cost adapter (DESIGNED, INERT until CoreLogic OAuth clears). atoms[] empty until OAuth. " +
    REPORTING_TIER,

  get_hazard_profile:
    "Cotality hazard/climate adapter (DESIGNED, INERT until CoreLogic OAuth clears). atoms[] empty until OAuth. " +
    MAP_TIER,

  get_parcel_polygon:
    "Cotality parcel-polygon adapter (DESIGNED, INERT until CoreLogic OAuth clears). atoms[] empty until OAuth. " +
    MAP_TIER,

  compose_workspace:
    "Select and arrange Hauska cortex workspace tiles from a natural-language intent. Reads the live tile capability registry, filters to tiles whose requirements are satisfied by the engagement (when engagement_id is given), keyword-ranks against the intent, and returns a WorkspaceComposition { tiles, layoutId, engagementId?, why } that can be passed directly to the @hauska/tile-shell CortexShell. " +
    REPORTING_TIER,

  assemble_map_layers:
    "Assemble parcel-keyed map layers (parcel polygon, flood zone, zoning, and Max-tier wave-3 slots) " +
    "via engine-api gate-front proxy. Requires map product key with tenant binding. " +
    "Rich layers (floodway, dem, topography, opportunity-zone-tract) require Max-tier entitlement (team/embedder). " +
    MAP_TIER,

  atom_trace:
    "Parcel-to-atoms-to-lineage trace for one atom DID: context summary, provenance, citations, inbound+outbound graph. " +
    "Public catalog — anonymous OK. " +
    PUBLIC_TIER,

  atom_export:
    "Export a DownloadableAtom bundle (identity, context, read-contract, composition refs, citations, signed chain). " +
    "accessPolicy-gated: caller exports own tenant-private atoms plus public atoms composed by reference. " +
    "Requires authenticated API key. BLOCKED-54: tenant-leg compose enforcement is partial until tenant leg ships. " +
    REPORTING_TIER,

  read_atom_calibration:
    "Calibration-overlay read-contract-per-atom: widthed read-contract with overlay-adjusted confidence when engine overlay row exists. " +
    "Requires reporting product key. Falls back to catalog read-contract when overlay route is not yet deployed. " +
    REPORTING_TIER,
} as const;
