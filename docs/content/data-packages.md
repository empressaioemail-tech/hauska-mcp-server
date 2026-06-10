# Data packages

Hauska sells **reasoning over a domain**, cited, with a confidence score and timestamp.
Raw national and federal data underneath stays Layer 1 free. A package is never a
raw-data resale SKU.

Aligned with `gtm_public_capability_matrix_v1.yaml` v1.1 and
[76d GTM data-package go-to-market](https://github.com/empressaioemail-tech/doc_repo/blob/main/76d_gtm_data_package_go_to_market.md).

## Corpus honesty (all packages)

- **Public-free Layer 1:** ~478 atoms across 2 jurisdictions (Bastrop 193 on the B3
  edition, Grand County/Moab 285) plus the `federal-accessibility-standards` tenant
  (ADA 2010 + FHA Design Manual, public-free).
- **Platform-internal:** 32 of 34 ingested jurisdictions; never marketed as public-free.
- **Confidence:** cited scores are the raw LLM emission; calibration is in progress.

## Subsurface

**Message:** Soils, geology, seismic and groundwater context for any US site, reasoned
and cited.

**Reasoning verb:** assess bearing, shrink-swell, hydric, liquefaction and karst risk
for a parcel, with the source layer cited.

**What stays Layer 1 free / not sold:** raw SSURGO map units and USGS geology rasters
are Layer 1 federal public-records baseline, not a resale SKU; the paid surface is the
site-level subsurface assessment over them.

**Status:** adapters merged (PR #145), deploy-pending; Cotality mineral/utility inert
pending CoreLogic OAuth.

## Hydrology / flood

**Message:** What happens to this site when it rains, reasoned from the terrain.

**Reasoning verb:** simulate site drainage and flood exposure from the DEM and
design-storm forcing, cited to NOAA and FEMA.

**What stays Layer 1 free / not sold:** FEMA flood-zone lookup and NOAA design-storm
tables are Layer 1; the paid surface is the drainage simulation and the cited flood-risk
reasoning, not the raw federal layers.

**Status:** live (PR #142); pysheds sidecar not yet baked into the Cloud Run image (TS
fallback works); Cotality flood-depth overlay inert.

## Parcel / property

**Message:** Everything that bears on a parcel, reasoned into a brief.

**Reasoning verb:** produce the property brief and encumbrance/restriction reasoning,
cited.

**What stays Layer 1 free / not sold:** Regrid parcel geometry and public-records
baseline are not resold as a tile SKU; the paid surface is the brief reasoning and the
restriction analysis. Regrid/Cotality are national public-records aggregation; no city
operational data is in this package.

**Status:** brief pipeline live (UI/extension; `generate_property_brief` wrap
deploy-pending); Cotality primary but inert pending OAuth.

## Code / plan-review

**Message:** Free ADA and FHA atoms; paid is the reconciliation that tells you which
standard governs at this door.

**Reasoning verb:** resolve most-stringent-governs precedence across accessibility
standards and the I-Code family, cited.

**What stays Layer 1 free / not sold:** ADA 2010, FHA Design Manual, and public-free
city code are Layer 1; the paid surface is the precedence reasoning and the
per-discipline plan-set findings. The conf-0.91 number on the combine-A117.1-ADA-FHA
demo is a cited confidence score; calibration is in progress.

**Status:** richest package; precedence engine (PR #147) + plan-set decomposition
(PR #146) + accessibility corpus (PR #66) merged; A117.1 + I-Codes credential-pending
(ICC OAuth).

## Environmental

**Message (roadmap):** Environmental-justice and habitat context, reasoned and cited.
Honest claim today: EJ context only, sourced and timestamped, with the frozen-mirror
freshness caveat surfaced.

**Reasoning verb:** (deferred — hold from headline launch)

**What stays Layer 1 free / not sold:** EPA EJScreen is Layer 1 federal data; no paid
SKU yet.

**Status:** EJ teaser only; FCC broadband gated (WAF); no wetlands/species/air adapters.
Listed as roadmap on the capability matrix; do not feature in registry copy until the
package has more than a frozen EJScreen mirror.
