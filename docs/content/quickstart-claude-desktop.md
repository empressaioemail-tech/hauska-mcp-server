# Quickstart: Claude Desktop

Connect Claude Desktop to the Hauska MCP Server.

## Configure

Open the Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server:

```json
{
  "mcpServers": {
    "hauska": {
      "url": "https://mcp.hauska.dev/mcp"
    }
  }
}
```

Restart Claude Desktop. The Hauska tools appear in the tool list.

## Verify

Ask a jurisdiction question, for example:

> Using the Hauska tools, list the loaded jurisdictions, then search for
> rear setback rules in one of them and cite the code section.

Claude calls `list_jurisdictions`, then `search_atoms`, then `get_atom`,
and answers with a DID-cited code section.

## With an API key

The public catalog needs no key. For a higher tier, or for the Codex and
Cortex product tools, add the key as the `X-Hauska-Key` header:

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

The header name must be exactly `X-Hauska-Key`. A wrong or missing header
is not an error: the request is silently served as the free public tier.
