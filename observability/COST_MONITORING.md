# Cost monitoring — Hauska MCP Server

Stream 2C.3. How the MCP server's running cost is attributed across tiers,
and the shape of the free-cost-versus-paid-revenue dashboard.

## What it costs to run

The MCP server has four infrastructure cost lines:

- **Cloud Run** compute. `min-instances=1` (one always-warm instance to
  avoid cold starts on the first agent call) plus autoscale under load.
  This is the dominant line at launch volume.
- **Neon Postgres**. The `hauska_mcp` database (api_keys plus
  request_log). Shares the cortex-prod Neon cluster.
- **Upstash Redis**. Rate-limit counters, REST API, pay-per-command.
- **GCS**. The NDJSON log archive. Storage plus write operations.

There is no per-request billing meter. Infrastructure cost arrives as a
monthly lump from each provider.

## Attribution method (v1)

The server does the same work per request regardless of the caller's
tier, so **request share is the cost key**. Each tier's attributed cost
is its share of trailing-30-day requests times the month's total infra
cost.

`queries/cost_attribution.sql` computes the request share per tier and
the free-versus-paid split. To get attributed dollars, multiply `share`
by the summed monthly infra bill. This is deliberately simple and
honest; a heavier-weight model (CPU-seconds per tool, storage growth per
tier) is not justified at launch volume and would over-claim precision.

## Free-cost-versus-paid-revenue dashboard

Two series on one chart, monthly:

- **Free-tier cost** = free-tier request share times total infra cost.
  Live from day one.
- **Paid-tier revenue** = sum of active paid-subscription MRR.
  **Empty until Wave 2.** Paid Layer 2 billing (Stripe, self-serve
  signup) is out of scope for this sprint. The panel is built now so the
  series renders the moment Wave 2 lands; until then it reads zero.

The decision signal: free-tier cost is an investment in distribution and
the training corpus. It is acceptable for it to exceed paid revenue
through Wave 1 and the early Wave 2 ramp. The dashboard exists so that
trade is visible and deliberate, not accidental.

## GCP billing budget

Independent of attribution, set a GCP **billing budget alert** on the
MCP server's project so absolute spend cannot drift unnoticed:

```
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT_ID" \
  --display-name="hauska-mcp-server monthly" \
  --budget-amount=200USD \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```

The 200 USD figure is a v1 placeholder aligned to the portfolio
cost-per-jurisdiction discipline; tune it against the first month of
real Cloud Run and Neon bills.
