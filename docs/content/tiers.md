# Tiers and limits

The public catalog is free. Higher tiers raise the rate limits for
production agents and embedders.

## Catalog tiers

| Tier | Daily limit | Burst | Who it is for |
|---|---|---|---|
| **Free, unauthenticated** | 1,000 calls / day / IP | 60 / min | Trying it out; low-volume agents |
| **Free, registered key** | 10,000 calls / day / key | 120 / min | Hobby and side-project agents |
| **Developer Pro** | 50,000 calls / day | 600 / min | Indie developers, AI startups |
| **Team** | 500,000 calls / day | 3,000 / min | Small firms, agent companies |
| **Embedder License** | Unmetered | per agreement | PropTech platforms embedding the catalog |

Limits are enforced on two windows at once: a per-minute burst cap and a
per-day quota. Crossing either returns a `429` naming which band tripped.

The free, unauthenticated tier needs no account: just call the endpoint.
A free registered key raises the daily limit ten-fold and is keyed to you
rather than to a shared IP. Paid tiers are issued per-key.

## Commercial use

The free tier permits non-commercial use and small-scale commercial use.
Commercial use above a stated threshold of monthly active users on the
consuming product requires a paid tier. See the
[Terms of Service](terms.html) for the boundary.

## Product surfaces beyond the catalog

The catalog described here is the public Layer 1 surface. The server also
carries the **Codex** (plan review) and **Cortex** (design accelerator)
tool surfaces. Those are product-keyed and not part of the public
catalog; access is arranged through the Empressa product teams, not
self-serve. The catalog is what this documentation covers.

## Pricing

Paid-tier price points are being finalized. See [Pricing](pricing.html).
