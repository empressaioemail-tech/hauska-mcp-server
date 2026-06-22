-- Hauska MCP Server — per-atom content usage (ICC PoC / Criterion 3).
--
-- Source: request_log.atom_ids_returned (TEXT[] of gate-returned DIDs) in the
-- MCP Postgres index (migration 003). One unnested row per atom per request.
--
-- ICC scope marker (coordinate with cc-agent-E):
--   - DID prefix did:hauska:code-section:icc-
--   - jurisdiction tenant segment icc-model-code in the code-section local id
-- Section labels are parsed from the DID local id (trailing path segment) so
-- dashboards do not join the engine for titles.

-- ---------------------------------------------------------------------
-- Panel: per-atom usage — all catalog atoms (30-day window)
-- Groups by atom, surface (product), and tool.
-- ---------------------------------------------------------------------
WITH params AS (
  SELECT now() - interval '30 days' AS since
)
SELECT
  atom_id,
  regexp_replace(atom_id, '^did:hauska:code-section:[^/]+/', '') AS section_ref,
  coalesce(product, 'unknown') AS surface,
  tool,
  count(*)                   AS hits,
  count(DISTINCT request_id) AS distinct_queries,
  min(ts)                    AS first_seen,
  max(ts)                    AS last_seen
FROM request_log r
CROSS JOIN LATERAL unnest(coalesce(r.atom_ids_returned, '{}'::text[])) AS atom_id
CROSS JOIN params p
WHERE r.ts >= p.since
  AND r.tool IS NOT NULL
  AND atom_id IS NOT NULL
  AND atom_id <> ''
GROUP BY 1, 2, 3, 4
ORDER BY hits DESC, atom_id, surface, tool;

-- ---------------------------------------------------------------------
-- Panel: per-atom rollup (atom grain only)
-- ---------------------------------------------------------------------
WITH params AS (
  SELECT now() - interval '30 days' AS since
),
atom_hits AS (
  SELECT
    r.request_id,
    atom_id,
    coalesce(r.product, 'unknown') AS surface,
    r.tool
  FROM request_log r
  CROSS JOIN LATERAL unnest(coalesce(r.atom_ids_returned, '{}'::text[])) AS atom_id
  CROSS JOIN params p
  WHERE r.ts >= p.since
    AND r.tool IS NOT NULL
    AND atom_id IS NOT NULL
    AND atom_id <> ''
)
SELECT
  atom_id,
  regexp_replace(atom_id, '^did:hauska:code-section:[^/]+/', '') AS section_ref,
  count(*)                   AS hit_count,
  count(DISTINCT request_id) AS query_count,
  count(DISTINCT surface)    AS surface_count,
  count(DISTINCT tool)       AS tool_count
FROM atom_hits
GROUP BY atom_id
ORDER BY hit_count DESC, atom_id;

-- ---------------------------------------------------------------------
-- Panel: ICC-derived atoms only (icc-model-code / icc- DID prefix)
-- ---------------------------------------------------------------------
WITH params AS (
  SELECT now() - interval '30 days' AS since
),
icc_atoms AS (
  SELECT
    r.request_id,
    r.ts,
    coalesce(r.product, 'unknown') AS surface,
    r.tool,
    r.jurisdiction,
    atom_id,
    regexp_replace(atom_id, '^did:hauska:code-section:[^/]+/', '') AS section_ref
  FROM request_log r
  CROSS JOIN LATERAL unnest(coalesce(r.atom_ids_returned, '{}'::text[])) AS atom_id
  CROSS JOIN params p
  WHERE r.ts >= p.since
    AND r.tool IS NOT NULL
    AND atom_id LIKE 'did:hauska:code-section:%'
    AND (
      atom_id LIKE 'did:hauska:code-section:icc-%'
      OR split_part(
           regexp_replace(atom_id, '^did:hauska:code-section:', ''),
           '/',
           1
         ) = 'icc-model-code'
    )
)
SELECT
  atom_id,
  section_ref,
  surface,
  tool,
  count(*)                   AS hits,
  count(DISTINCT request_id) AS distinct_queries,
  min(ts)                    AS first_seen,
  max(ts)                    AS last_seen
FROM icc_atoms
GROUP BY atom_id, section_ref, surface, tool
ORDER BY hits DESC, section_ref, surface, tool;
