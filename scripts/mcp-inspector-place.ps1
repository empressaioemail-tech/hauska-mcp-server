# MCP Inspector smoke — public catalog + place tool (GTM E9).
# Usage:
#   $env:HAUSKA_DEV_MODE='true'
#   $env:PLACE_API_ENABLED='true'
#   pnpm dev
#   .\scripts\mcp-inspector-place.ps1

param(
  [string]$McpUrl = "http://localhost:3000/mcp",
  [string]$PilotAddress = "1311 Main St, Bastrop, TX 78602"
)

Write-Host "Inspector: $McpUrl"
Write-Host "1) list_jurisdictions (public)"
npx --yes @modelcontextprotocol/inspector $McpUrl --cli list_jurisdictions

Write-Host "2) resolve_place (requires HAUSKA_KEY + PLACE_API_ENABLED on server)"
if (-not $env:HAUSKA_KEY) {
  Write-Warning "Skip resolve_place: set HAUSKA_KEY for product tool probe"
  exit 0
}
npx --yes @modelcontextprotocol/inspector $McpUrl --cli resolve_place --address $PilotAddress
