-- Hauska MCP Server — analytical dashboard queries (Stream 2C.3).
--
-- Source: the request_log table (migration 003) in the MCP server's
-- Postgres. One row per /mcp request.
--
-- Each statement below backs one dashboard panel. Wire them into Looker
-- Studio with the native PostgreSQL connector pointed at the hauska_mcp
-- database (one "custom query" data source per panel), or run them ad hoc.
--
-- Free tier   = tier IN ('free_anonymous', 'free')
-- Paid tier   = tier IN ('developer_pro', 'team', 'embedder')
-- A request with tool IS NULL is a non-tool call (initialize, tools/list).

-- ---------------------------------------------------------------------
-- Panel: calls per day by tool
-- ---------------------------------------------------------------------
SELECT date_trunc('day', ts) AS day,
       tool,
       count(*)              AS calls
FROM request_log
WHERE tool IS NOT NULL
  AND ts >= now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

-- ---------------------------------------------------------------------
-- Panel: calls per day by jurisdiction
-- ---------------------------------------------------------------------
SELECT date_trunc('day', ts) AS day,
       jurisdiction,
       count(*)              AS calls
FROM request_log
WHERE jurisdiction IS NOT NULL
  AND ts >= now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

-- ---------------------------------------------------------------------
-- Panel: calls per day by tier
-- ---------------------------------------------------------------------
SELECT date_trunc('day', ts) AS day,
       coalesce(tier, 'unknown') AS tier,
       count(*)                  AS calls
FROM request_log
WHERE ts >= now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

-- ---------------------------------------------------------------------
-- Panel: top tools (last 30 days)
-- ---------------------------------------------------------------------
SELECT tool,
       count(*)                                        AS calls,
       round(100.0 * avg((is_error)::int), 2)          AS error_pct,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)) AS p95_ms
FROM request_log
WHERE tool IS NOT NULL
  AND ts >= now() - interval '30 days'
GROUP BY 1
ORDER BY 2 DESC;

-- ---------------------------------------------------------------------
-- Panel: top jurisdictions queried (last 30 days)
-- ---------------------------------------------------------------------
SELECT jurisdiction,
       count(*) AS calls
FROM request_log
WHERE jurisdiction IS NOT NULL
  AND ts >= now() - interval '30 days'
GROUP BY 1
ORDER BY 2 DESC;

-- ---------------------------------------------------------------------
-- Panel: error rate (daily)
-- ---------------------------------------------------------------------
SELECT date_trunc('day', ts)                   AS day,
       count(*)                                AS requests,
       count(*) FILTER (WHERE is_error)        AS errors,
       round(100.0 * avg((is_error)::int), 3)  AS error_pct
FROM request_log
WHERE ts >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;

-- ---------------------------------------------------------------------
-- Panel: latency histogram (daily p50 / p95 / p99)
-- ---------------------------------------------------------------------
SELECT date_trunc('day', ts) AS day,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)) AS p50_ms,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)) AS p95_ms,
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)) AS p99_ms,
       max(latency_ms)                                                 AS max_ms
FROM request_log
WHERE latency_ms IS NOT NULL
  AND ts >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;

-- ---------------------------------------------------------------------
-- Panel: new free-tier IPs (first seen in the last 24h)
-- A potential-commercial-use leading indicator.
-- ---------------------------------------------------------------------
SELECT ip,
       min(ts) AS first_seen,
       count(*) AS calls_so_far
FROM request_log
WHERE tier IN ('free_anonymous', 'free')
  AND ip IS NOT NULL
GROUP BY ip
HAVING min(ts) >= now() - interval '24 hours'
ORDER BY first_seen DESC;

-- ---------------------------------------------------------------------
-- Panel: high-volume free-tier IPs (last 7 days)
-- Commercial-use detection — surface for BD outreach.
-- ---------------------------------------------------------------------
SELECT ip,
       count(*)            AS calls_7d,
       count(DISTINCT tool) AS distinct_tools,
       min(ts)             AS first_seen,
       max(ts)             AS last_seen
FROM request_log
WHERE tier IN ('free_anonymous', 'free')
  AND ip IS NOT NULL
  AND ts >= now() - interval '7 days'
GROUP BY ip
HAVING count(*) >= 500
ORDER BY calls_7d DESC;

-- ---------------------------------------------------------------------
-- Panel: per-key usage (paid tier)
-- Returns empty until paid keys exist (Wave 2). key_hash is the
-- SHA-256 of the key and is safe to display.
-- ---------------------------------------------------------------------
SELECT key_hash,
       tier,
       count(*)                         AS calls_30d,
       count(*) FILTER (WHERE is_error)  AS errors_30d,
       max(ts)                           AS last_call
FROM request_log
WHERE key_hash IS NOT NULL
  AND ts >= now() - interval '30 days'
GROUP BY key_hash, tier
ORDER BY calls_30d DESC;
