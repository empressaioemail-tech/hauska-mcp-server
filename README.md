# Hauska MCP Server

The verified ground truth layer that AI agents call when they operate on buildings, land, permits, code, zoning, or municipal records.

This is the v1 framework. It runs locally, exposes five tools against the Hauska atom corpus, and is structured for deployment to Vercel, Cloudflare Workers, or any Node.js host. The framework is designed to be ready to extend the moment Nick clones it.

## Architecture decisions baked in

Transport. Streamable HTTP, introduced in MCP protocol version 2025-03-26. This is the right transport for a public, agent-callable server. The stdio transport is for local-only tooling and not what we need.

SDK. Official TypeScript SDK from the Linux Foundation Agentic AI Foundation. Package name `@modelcontextprotocol/sdk`. We pin to a recent stable version.

Validation. Zod for all tool input schemas. Critical because LLMs hallucinate parameter names and shapes. Server-side validation is non-negotiable.

Auth. API key via header for v1. Free tier accepts an unregistered or shared public key. Paid tier and OAuth 2.1 land in v2.

Backend connection. The `hauska-client.ts` stub is an interface, not an implementation. Nick wires it to the existing atom query layer that Cortex and Codex already use. The MCP server should not duplicate query logic.

Logging. Every request and response is logged to a structured store. This is the training data capture pipeline. Implement it on day one, not later.

## What this v1 ships

Five tools.

1. `search_atoms`. Free-text search over the ingested code corpus.
2. `get_atom`. Retrieve a specific atom by ID with provenance metadata.
3. `query_jurisdiction`. Get jurisdiction-specific info (zoning, setbacks, use restrictions) by parcel ID or address.
4. `get_permit_requirements`. Return required permits for a project type in a jurisdiction.
5. `list_jurisdictions`. Discovery tool. Returns the jurisdictions currently ingested and queryable.

Bastrop, TX is the only jurisdiction in v1. The framework is multi-jurisdiction from the start so adding cities is a configuration change, not a refactor.

## Setup

Prerequisites. Node.js 20 or higher. npm 10 or higher. A working backend at the URL configured in the env file (or use the mocked client for development).

Steps.

```
git clone <this repo> hauska-mcp-server
cd hauska-mcp-server
npm install
cp .env.example .env
# Edit .env to point HAUSKA_BACKEND_URL at your atom query layer
npm run dev
```

The server starts on port 3000. The MCP endpoint is `http://localhost:3000/mcp`.

## Test it with MCP Inspector

The official inspector lets you call tools and see responses without writing an agent client.

```
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

Open the URL it prints. Connect. The five tools should appear in the tool list. Call each one with sample inputs.

## Test it with Claude Desktop

Edit your Claude Desktop config at the standard path for your OS.

```json
{
  "mcpServers": {
    "hauska": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Restart Claude Desktop. Ask Claude a Bastrop-specific question. It should call your tools.

## Deployment options

For v1, pick one of these. All work with the Streamable HTTP transport in the scaffold.

Vercel. Simplest. The server runs as a Vercel serverless function. `vercel deploy`. Done.

Cloudflare Workers. More performant, lower cost at scale. Requires light refactor to use the Workers runtime, but the SDK supports it.

Replit Agent. Spin up the host, paste the repo, deploy. Useful for the first public version while you decide on the long-term home.

AWS Lambda or Azure Container Apps. Fine if Empressa already has infra there. Standard patterns work.

## Recommended day-by-day plan

Day 1. Clone, install, run locally. Replace the mocked Hauska client with the real backend connection. Confirm the five tools return real Bastrop data.

Day 2. Authentication. Implement API key validation. Set up the key issuance flow (even if manual to start).

Day 3. Rate limiting. Free tier limit. Paid tier slot ready even if no paid keys yet.

Day 4. Logging infrastructure. Every query and response captured for training data. Database, blob store, or queue. Decide and ship.

Day 5. Deploy to chosen host. Get a public URL.

Day 6. Cross-platform testing. Claude Desktop, Claude Code, Cursor, MCP Inspector. Each platform has quirks.

Day 7. Documentation site. Public manifest, example queries, the schema, an OpenAPI-style doc for tool reference.

Day 8 to 10. Listing submissions. Anthropic's MCP directory, awesome-mcp lists on GitHub, any relevant agent platform marketplaces. Press announcement coordination.

Day 11 to 14. Bug fixes, polish, second-round testing across edge cases, and the launch announcement.

## What ships in v2 (60 to 90 days)

OAuth 2.1 authentication. Paid tier billing infrastructure (Stripe). Multi-jurisdiction coverage across the next 20 Texas cities. Enterprise SSO. Audit-grade logging. Formal SLA. Resources and Prompts primitives in addition to Tools.

## Open decisions for Nick before he starts

1. Hosting target for the public deployment. Vercel, Cloudflare Workers, Replit, or other.
2. Logging destination for training data capture. Postgres, S3, Snowflake, or other.
3. API key issuance system. Manual to start, or automated from day one.
4. Whether v1 exposes Resources in addition to Tools. Tools is sufficient; Resources is optional for v1.

These all stay inside Nick's decision rights per the project decision matrix.

## File map

```
hauska-mcp-server/
  README.md                   This file
  package.json                Dependencies and scripts
  tsconfig.json               TypeScript configuration
  .env.example                Environment variable template
  src/
    index.ts                  Server entry point. Streamable HTTP transport. Express.
    tools.ts                  The five tool definitions with Zod schemas.
    hauska-client.ts          Interface to the atom query backend. Stub today, real tomorrow.
    auth.ts                   API key validation middleware.
    logger.ts                 Structured query and response logging.
```
