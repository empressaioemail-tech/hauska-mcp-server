# Repo notes

This repo holds the Hauska MCP Server. It is the public Layer 1 MCP
surface for the Hauska catalog per doc_repo 50_hauska_mcp_server.md
and the v1 sprint plan at doc_repo 51_substrate_v1_sprint.md.

Repo placement and substrate layer per:
- doc_repo 80_adrs/adr_008_engine_factor_out.md (Hauska commercial
  layer, alongside hauska-sdk and the planned hauska-engine)
- doc_repo 80_adrs/adr_018_atom_contract_substrate_layer.md (atom
  contract is Hauska substrate, peer to the Hauska SDK; this server
  consumes @hauska/atom-contract directly, not via the SDK)

Decision records for this repo's creation:
- doc_repo _decisions/2026-05-18_hauska_mcp_server_dedicated_repo.md
- doc_repo _decisions/2026-05-18_atom_contract_hauska_namespace.md

Session origin:
- doc_repo _sessions/2026-05-18_atom_contract_hauska_namespace_and_mcp_repo_split_claude_code.md

When the M2-C extraction lands and @hauska/atom-contract is published,
update package.json dependencies to consume it (replacing whatever
mock or stub is in hauska-client.ts today).
