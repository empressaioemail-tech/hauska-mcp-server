# Quickstart: Claude Code

Connect Claude Code to the Hauska MCP Server.

## Add the server

```
claude mcp add --transport http hauska https://mcp.hauska.dev/mcp
```

That registers the server for the current project. Use `--scope user` to
register it for every project.

## Verify

```
claude mcp list
```

`hauska` shows as connected. In a session, ask Claude to use the tools:

> List the jurisdictions Hauska has loaded, then search one for parking
> requirements and cite the section.

## With an API key

The public catalog needs no key. For a higher tier or the product tools,
pass the key as a header:

```
claude mcp add --transport http hauska https://mcp.hauska.dev/mcp \
  --header "X-Hauska-Key: hk_your_key_here"
```

The header name must be exactly `X-Hauska-Key`. A missing or misnamed
header is served as the free public tier rather than rejected.

## Remove

```
claude mcp remove hauska
```
