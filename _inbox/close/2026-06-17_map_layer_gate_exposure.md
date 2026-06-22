# Close: map-layers gate exposure (cc-agent-M)

**Dispatch:** `_dispatches/2026-06-17_cc-agent-M_map_layer_gate_exposure.md`  
**Contract:** `hauska-engine/services/engine-api/docs/map-layers-contract.md`  
**Status:** closed  
**Date:** 2026-06-17

## Summary

Registered the `map-layers` package on hauska-mcp-server and exposed it as the
`assemble_map_layers` MCP tool. The gate enforces cortex product key,
accessPolicy-derived gate-front tier, tenant binding (`X-Hauska-Tenant-Id` from
`jurisdiction_tenant` on the API key), and Max-tier entitlement before proxying
to engine-api `POST /v1/map-layers/assemble`.

## Delivered

| Item | Location |
|------|----------|
| Package registry + Max-tier / cross-tenant gates | `src/gate-packages.ts` |
| Gate-front header builder | `src/gate-front.ts` |
| engine-api HTTP client | `src/engine-api-client.ts` |
| Wire contract mirror | `src/map-layers-contract.ts` |
| MCP tool | `assemble_map_layers` in `src/tools.ts` |
| Gate tests | `tests/map-layers-gate.test.ts` |
| Proxy header tests | `tests/engine-api-client.test.ts` |
| Env vars | `HAUSKA_ENGINE_API_URL`, `HAUSKA_ENGINE_API_GATE_TOKEN` in `.env.example` |

## Gate semantics

1. **Product key:** `cortex` product only (`assertMapLayersPackageGate`).
2. **accessPolicy / access tier:** resolved to `tenant-private` when the key has
   `jurisdiction_tenant`, `platform-internal` for operator keys, `public-paid`
   for other paid keys. Tiers outside `public-paid`, `platform-internal`,
   `tenant-private` are denied.
3. **Tenant scope:** `X-Hauska-Tenant-Id` is set from the key's
   `jurisdiction_tenant`. Cross-tenant denial when `jurisdiction.localKey` does
   not match the caller tenant, and when the engine response `tenantScope`
   mismatches the caller partition.
4. **Max-tier entitlement:** basic layers (`parcel-polygon`, `flood-zone`,
   `zoning`) on `developer_pro`; rich wave-3 layers (`floodway`, `dem`,
   `topography`, `opportunity-zone-tract`) require `team` / `embedder` or
   `platform_internal`.

## Proof: cross-tenant denial

`tests/map-layers-gate.test.ts`:

- `cross-tenant denial: localKey bastrop-tx denied for mox-living key`
- `cross-tenant denial: response tenantScope mismatch rejected`

## Coordination

- **cc-agent-E:** engine-api `/v1/map-layers/assemble` is the upstream; gate
  sends full gate-front header set + bearer.
- **cc-agent-C:** consumers should migrate from cortex-api `generate-layers` to
  gate-proxied assemble per contract.

## Acceptance

- [x] Package `map-layers` registered on gate
- [x] accessPolicy + product-key + tenant scope enforced pre-proxy
- [x] Max-tier blocks rich layer set on non-Max keys
- [x] Cross-tenant denial covered by unit tests
- [x] Proxies to `POST /v1/map-layers/assemble` with gate-front headers
