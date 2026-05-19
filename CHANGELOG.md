# Changelog

All notable changes to the Hauska MCP Server. v1 is in active development;
breaking changes are common until the 1.0.0 release.

## [Unreleased]

### Added
- `@hauska/atom-contract@^1.0.0` pin (Sync 1 fold-in).
- `hauska-client.ts` rewritten as a real HTTP client against the
  `hauska-engine` retrieval API per Sync 3 contract. Five endpoints
  wired: `/search`, `/atoms/:did`, `/jurisdictions`,
  `/jurisdictions/:id`, `/jurisdictions/:id/permits`. Bearer-token auth
  via `HAUSKA_ENGINE_API_KEY`; base URL via `HAUSKA_BACKEND_URL`.
- `src/atom-shape.ts` builds a consistent envelope for every tool
  response: original engine payload under `data`, provenance entries
  (DID, content hash, source adapter, source URL, fetched-at) under
  `atoms`, free-tier attribution under `meta.attribution`.
- `src/request-context.ts` threads the caller's tier through
  `AsyncLocalStorage` so tool handlers can read per-tier behavior without
  access to the Express request.
- Free-tier responses now carry the verbatim attribution string
  `Powered by Hauska Engine — hauska.dev`. Embedder-tier responses
  omit it per 50 §Free-tier-attribution.

### Changed
- **BREAKING:** `get_permit_requirements` renamed to `search_permit_atoms`
  per Phase 0 of the substrate v1 sprint. The new tool returns permit-tagged
  atom references (honest Layer 1 retrieval) instead of inferring permit
  requirements (engine-side reasoning, deferred to Codex 1b paid tier).
  Migration: rename tool calls; the input now takes `jurisdiction` plus
  `project_type` only.
- **BREAKING:** `query_jurisdiction` no longer accepts `parcel_id` or
  `address` parameters. Parcel-level atoms (parcel-record,
  constraint-overlay) are Bump 2 per the engine evolution plan and are
  out of v1 scope. The tool now returns a per-jurisdiction status
  snapshot (loaded edition, quality bar, atom count, drift). For per-parcel
  lookups, use `search_atoms` with the jurisdiction filter.
- `search_atoms` now accepts an optional `entity_type` filter
  (`code-section`, `code-definition`, `code-amendment`,
  `code-cross-reference`, `code-edition`, `jurisdiction-corpus`) and a
  `limit` up to 100 (was 50). Default limit raised from 10 to 25 to match
  the engine default.
- `get_atom` parameter `atom_id` is now validated as a Hauska DID
  (`did:hauska:<entityType>:<localId>`) at the Zod layer. Mocked-stub
  IDs no longer pass validation.
- `list_jurisdictions` accepts an optional `quality_bar_only` filter.
- `.env.example`: renamed `HAUSKA_BACKEND_API_KEY` to
  `HAUSKA_ENGINE_API_KEY` for clarity. The two variables served different
  purposes in Stream 2B (admin bootstrap) vs Stream 2A (retrieval-API
  bearer token); the rename disambiguates.

### Fixed
- Tool responses surface atom DID, content hash, source adapter, and
  source URL consistently. Previously the mocked stub returned a
  free-form shape per tool.

## [0.1.0] — 2026-05-18

### Added
- Stream 2B foundations: Postgres `api_keys` schema, Upstash Redis
  dual-window rate limit, admin endpoints under `/admin/keys`. Per
  doc_repo `_sessions/2026-05-18_hauska_mcp_stream_2b_cc-agent-M.md`.
- Initial v1 starter scaffold (commit `d00586b`): five tool stubs,
  Streamable HTTP transport, Express host, Zod validation, in-memory
  rate-limit, stdout logger.
