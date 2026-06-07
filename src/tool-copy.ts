// LLM-first tool descriptions (GTM sprint M2).
// Tier + jurisdiction_key examples + typical failure modes per tool group.

export const PUBLIC_TIER =
  "Tier: public Layer 1 (no API key). Example jurisdiction_key: bastrop-tx, grand-county-co. " +
  "Typical failures: no_coverage (jurisdiction not in list_jurisdictions), empty_corpus, upstream_timeout.";

export const BROKERAGE_TIER =
  "Tier: product read (authenticated API key — cortex or brokerage product). " +
  "Example jurisdiction_key: bastrop-tx, cedar-hill-tx (Central TX pilot). " +
  "Typical failures: auth_reject (missing/invalid key), geocode_miss, no_coverage, upstream_timeout.";

export const CODEX_TIER =
  "Tier: product Layer 2 Codex (codex API key). Not anonymous. " +
  "Typical failures: auth_reject, upstream_timeout, 404 (submission/finding not found), 409 (override conflict).";

export const CORTEX_TIER =
  "Tier: product Layer 2 Cortex (cortex API key). Not anonymous. " +
  "Typical failures: auth_reject, upstream_timeout, 404 (engagement/snapshot missing).";

export const TOOL_COPY = {
  search_atoms:
    "Search the ingested municipal code corpus for atoms matching a free-text query. " +
    "Returns ranked atom references with provenance (DID, source adapter, source URL, content hash). " +
    "Use for topics like setbacks, parking, or occupancy; follow with get_atom on a returned DID. " +
    PUBLIC_TIER,

  get_atom:
    "Retrieve one code atom by DID (e.g. did:hauska:code-section:bastrop-tx/udc-2024/5.04) with full provenance. " +
    "Optional include_composition traverses atom-link children (definitions, cross-refs). " +
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
    "Returns a brief-run atom (did:hauska:brief-run:<runId>). Layer 2 keystone — requires cortex product key. " +
    CORTEX_TIER,

  get_property_brief_run:
    "Fetch a stored Property Brief run by runId. Read companion to generate_property_brief. " +
    CORTEX_TIER,

  simulate_site_drainage:
    "Run site-drainage simulation for an engagement (D8 flow routing + rainfall forcing). " +
    "Engagement-scoped — requires engagement_id. Returns site-drainage ingest status. " +
    CORTEX_TIER,

  get_site_drainage:
    "Read the active site-drainage atom for an engagement. Optionally include NOAA Atlas 14 design-storm estimates. " +
    CORTEX_TIER,

  get_site_topography:
    "Read site-topography for an engagement (DEM, contours). Set refresh=true to trigger ingest first. " +
    CORTEX_TIER,

  search_encumbrances:
    "List recorded-instrument and restriction-clause atoms uploaded to a property workspace. " +
    "Workspace-scoped via workspace_did. " +
    CORTEX_TIER,

  get_restrictions:
    "Fetch restriction-clause atoms for a property workspace (ADR-020/021). Workspace-scoped via workspace_did. " +
    CORTEX_TIER,

  get_property_detail:
    "Cotality property-characteristics adapter (DESIGNED, INERT until CoreLogic OAuth clears). " +
    "Returns credential-pending when credentials are absent — never fake data. " +
    CORTEX_TIER,

  get_replacement_cost:
    "Cotality replacement-cost adapter (DESIGNED, INERT until CoreLogic OAuth clears). " +
    CORTEX_TIER,

  get_hazard_profile:
    "Cotality hazard/climate adapter (DESIGNED, INERT until CoreLogic OAuth clears). " +
    CORTEX_TIER,

  get_parcel_polygon:
    "Cotality parcel-polygon adapter (DESIGNED, INERT until CoreLogic OAuth clears). " +
    CORTEX_TIER,
} as const;
