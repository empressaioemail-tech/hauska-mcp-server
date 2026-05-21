-- Hauska MCP Server — per-tier cost attribution (Stream 2C.3).
--
-- The MCP server has no per-request billing meter. Infrastructure cost
-- (Cloud Run compute, Neon Postgres, Upstash, GCS) is a monthly lump.
-- This query attributes that lump across tiers by request share, which
-- is the honest v1 proxy: the server does the same work per request
-- regardless of tier, so request share is a fair cost key.
--
-- See COST_MONITORING.md for the methodology and the free-tier-cost vs
-- paid-tier-revenue dashboard spec.

-- Request share by tier over the trailing 30 days. Multiply `share`
-- by the month's total infra cost to get attributed cost per tier.
WITH windowed AS (
  SELECT coalesce(tier, 'unknown') AS tier, count(*) AS requests
  FROM request_log
  WHERE ts >= now() - interval '30 days'
  GROUP BY 1
)
SELECT
  tier,
  requests,
  round(100.0 * requests / nullif(sum(requests) OVER (), 0), 2) AS share_pct,
  CASE
    WHEN tier IN ('free_anonymous', 'free') THEN 'free'
    ELSE 'paid'
  END AS tier_class
FROM windowed
ORDER BY requests DESC;

-- Free vs paid request split (the cost-side input to the
-- free-cost-vs-paid-revenue dashboard; the revenue side is empty until
-- Wave 2 billing lands).
SELECT
  CASE
    WHEN tier IN ('free_anonymous', 'free') THEN 'free'
    ELSE 'paid'
  END AS tier_class,
  count(*)                                                   AS requests_30d,
  round(100.0 * count(*) / nullif(sum(count(*)) OVER (), 0), 2) AS share_pct
FROM request_log
WHERE ts >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1;
