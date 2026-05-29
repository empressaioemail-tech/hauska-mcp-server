# Start hauska-mcp-server for local Cursor MCP (port 3000).
# Keep this window open while using hauska-cortex / hauska-codex in Cursor.
#
# Full catalog (30 jurisdictions): .env must set
#   HAUSKA_BACKEND_URL=https://hauska-retrieval-api-h7gvu7rgcq-uc.a.run.app
#   HAUSKA_ENGINE_API_KEY=<from hauska-prod Secret Manager HAUSKA_ENGINE_API_KEY>
# localhost:8080 only works if you also run hauska-engine retrieval-api locally.
Set-Location $PSScriptRoot\..
$env:NODE_OPTIONS = "--use-system-ca"
Write-Host "Starting MCP server on http://127.0.0.1:3000 (health: /health)" -ForegroundColor Cyan
Write-Host "Backend: $($env:HAUSKA_BACKEND_URL ?? '(from .env)')" -ForegroundColor DarkGray
pnpm dev
