# Show HN — draft

DRAFT. Do not publish; operator-gated. Show HN posts are best submitted
by the operator from an established account.

## Title

```
Show HN: Hauska MCP Server – cited municipal building-code answers for agents
```

(HN titles are short. Alternative:
`Show HN: A free MCP server for municipal building code, with citations`)

## URL

`https://mcp.hauska.dev`

## Text (the first comment)

```
Hi HN. This is a public MCP server that gives AI agents grounded
answers about municipal building codes and zoning.

The thing we cared about building: every result is traceable. A query
returns "atoms" — units of code each with a stable id, a content hash,
and the source document. The agent cites the atom by id; it doesn't
paraphrase from training data. If you read the answer you can follow
the id back to the code text.

It speaks MCP over Streamable HTTP, so it drops into Claude Desktop,
Claude Code, Cursor, or a custom SDK agent. The public catalog is free
and needs no key — point a client at https://mcp.hauska.dev/mcp and
call list_jurisdictions.

Five catalog tools: search, get-atom (with cross-reference traversal),
list-jurisdictions, jurisdiction-status, permit-relevant search.

Docs and quickstarts: https://mcp.hauska.dev/docs
A runnable example agent is in the repo.

Happy to answer questions about the atom model, the provenance chain,
or how jurisdictions get ingested.
```

> [GTM-SESSION] Confirm the title, and add one concrete coverage detail
> (a jurisdiction or two) once the launch corpus is live. Keep the tone
> plain; HN dislikes marketing voice.
