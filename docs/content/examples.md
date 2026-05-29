# Example queries

## Place dossier agent (product key)

Full flow `search_atoms` → `get_atom` → `resolve_place` → `get_place_dossier`:

https://github.com/empressaioemail-tech/hauska-mcp-server/tree/main/examples/place-dossier-agent


A full discovery-to-citation flow against the public catalog. Every call
is a standard MCP `tools/call`; the snippets below show the tool name and
arguments your agent passes.

## 1. Discover jurisdictions

```
list_jurisdictions { "quality_bar_only": true }
```

Returns the loaded jurisdictions with their code edition, atom count, and
eval-harness quality bar. Start here when you do not know which
jurisdictions are available.

## 2. Search the code

```
search_atoms {
  "query": "rear setback for accessory structures",
  "jurisdiction": "bastrop-tx",
  "limit": 10
}
```

Returns ranked atom references. Each carries a DID, a snippet, a relevance
score, and the source. Narrow with `entity_type` (for example
`code-section`) when you want one kind of atom.

## 3. Retrieve the full atom

```
get_atom {
  "atom_id": "did:hauska:code-section:bastrop-tx/udc-2024/5.04",
  "include_composition": true
}
```

Returns the full atom body plus provenance (source adapter, source URL,
fetched-at, content hash). With `include_composition` set, it also
returns the atoms reached through composition edges: cross-references,
definitions, and amendments. This is the cross-reference traversal step.

## 4. Confirm a jurisdiction before a run

```
query_jurisdiction { "jurisdiction": "bastrop-tx" }
```

Returns the loaded edition, atom count, last-refreshed timestamp, and
drift status. Use it to confirm a jurisdiction is current before issuing
a batch of `search_atoms` calls.

## 5. Find permit-relevant code

```
search_permit_atoms {
  "jurisdiction": "bastrop-tx",
  "project_type": "single-family residence"
}
```

Returns permit-tagged code atoms matching the project type. This is
honest Layer 1 retrieval: the agent reasons over the returned atoms to
identify permit requirements. End-to-end permit inference is not part of
the public catalog.

## Reading a response

Every tool returns an envelope:

- `data` — the engine payload (results, the atom, the snapshot).
- `atoms` — provenance entries: DID, content hash, source adapter and URL.
- `meta` — including the free-tier `attribution` string.

Cite atoms from `atoms` by DID. That is the chain back to the code text.
