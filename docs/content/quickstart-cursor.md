# Quickstart: Cursor

Connect Cursor to the Hauska MCP Server.

## Configure

Edit the Cursor MCP config:

- Project: `.cursor/mcp.json` in the project root.
- Global: `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "hauska": {
      "url": "https://mcp.hauska.dev/mcp"
    }
  }
}
```

Cursor picks up the change; the Hauska tools appear under Settings > MCP.

## Verify

In the Cursor chat, with agent mode on:

> Use the Hauska tools to list jurisdictions and search one for egress
> requirements, then cite the code section.

## With an API key

The public catalog needs no key. For a higher tier or the Codex and
Cortex product tools, add the key as a header:

```json
{
  "mcpServers": {
    "hauska": {
      "url": "https://mcp.hauska.dev/mcp",
      "headers": { "X-Hauska-Key": "hk_your_key_here" }
    }
  }
}
```

The header name must be exactly `X-Hauska-Key` — not `Authorization` and
not `Bearer`. A wrong header name is the most common misconfiguration:
the connection looks healthy, but every product-gated call is refused
because the request was silently served as the free public tier.
