-- Hauska MCP Server — pay-per-query demo view (ICC PoC / Criterion 3).
--
-- Thin metering layer over ICC-scoped content usage. PoC forbids commercial
-- use: every row is charge_state = NOT-CHARGED. No calibration or atom
-- internals — content usage only (ICC atom counts, surface, query).
--
-- Demo placeholder: DEMO_CENTS_PER_ATOM (0.01 USD per atom returned per query).

-- ---------------------------------------------------------------------
-- View: per-query ICC content meter (would-charge, never a payment record)
-- ---------------------------------------------------------------------
WITH params AS (
  SELECT
    now() - interval '30 days' AS since,
    0.01::numeric              AS demo_cents_per_atom
),
icc_request_atoms AS (
  SELECT
    r.request_id,
    r.ts,
    coalesce(r.product, 'unknown') AS surface,
    r.tool,
    r.jurisdiction,
    r.key_hash,
    r.tier,
    atom_id,
    regexp_replace(atom_id, '^did:hauska:code-section:[^/]+/', '') AS section_ref
  FROM request_log r
  CROSS JOIN LATERAL unnest(coalesce(r.atom_ids_returned, '{}'::text[])) AS atom_id
  CROSS JOIN params p
  WHERE r.ts >= p.since
    AND r.tool IS NOT NULL
    AND r.is_error IS FALSE
    AND atom_id LIKE 'did:hauska:code-section:%'
    AND (
      atom_id LIKE 'did:hauska:code-section:icc-%'
      OR split_part(
           regexp_replace(atom_id, '^did:hauska:code-section:', ''),
           '/',
           1
         ) = 'icc-model-code'
    )
),
per_query AS (
  SELECT
    request_id,
    min(ts)                      AS ts,
    max(surface)                 AS surface,
    max(tool)                    AS tool,
    max(jurisdiction)            AS jurisdiction,
    count(*)                     AS icc_atoms_returned,
    count(DISTINCT section_ref)  AS icc_sections_returned,
    array_agg(DISTINCT section_ref ORDER BY section_ref) AS section_refs
  FROM icc_request_atoms
  GROUP BY request_id
)
SELECT
  pq.request_id,
  pq.ts,
  pq.surface,
  pq.tool,
  pq.jurisdiction,
  pq.icc_atoms_returned,
  pq.icc_sections_returned,
  pq.section_refs,
  pq.icc_atoms_returned * p.demo_cents_per_atom / 100.0 AS would_charge_usd,
  'NOT-CHARGED'::text AS charge_state
FROM per_query pq
CROSS JOIN params p
ORDER BY pq.ts DESC;

-- ---------------------------------------------------------------------
-- Panel: ICC content usage summary by surface (demo rollup)
-- ---------------------------------------------------------------------
WITH params AS (
  SELECT
    now() - interval '30 days' AS since,
    0.01::numeric              AS demo_cents_per_atom
),
icc_hits AS (
  SELECT
    r.request_id,
    coalesce(r.product, 'unknown') AS surface,
    r.tool,
    atom_id
  FROM request_log r
  CROSS JOIN LATERAL unnest(coalesce(r.atom_ids_returned, '{}'::text[])) AS atom_id
  CROSS JOIN params p
  WHERE r.ts >= p.since
    AND r.tool IS NOT NULL
    AND r.is_error IS FALSE
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
  surface,
  tool,
  count(*)                     AS icc_atom_hits,
  count(DISTINCT request_id)   AS icc_queries,
  count(*) * p.demo_cents_per_atom / 100.0 AS would_charge_usd,
  'NOT-CHARGED'::text          AS charge_state
FROM icc_hits
CROSS JOIN params p
GROUP BY surface, tool, p.demo_cents_per_atom
ORDER BY icc_atom_hits DESC;
