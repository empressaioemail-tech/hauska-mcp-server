---
id: 2026-05-21_2d1_containerization
title: cc-agent-M session — Stream 2D.1 containerization
date: 2026-05-21
agent: cc-agent-M
repo: hauska-mcp-server
kind: session
lane: M (commercialization Streams 2C + 2D)
related: [2026-05-21_cc-agent-M_commercialization_streams_2c_2d, 2026-05-21_2c3_observability_artifacts]
---

# Stream 2D.1 — containerization

First unit of Stream 2D. Branch `feat/2d1-containerization`.

## What shipped

`Dockerfile` — multi-stage. Build stage: `node:20-slim`, `npm ci`
against the committed lockfile, `npm run build` (tsc to `dist/`).
Runtime stage: `node:20-slim`, production dependencies only
(`npm ci --omit=dev`), `dist/` copied from the build stage, runs as the
unprivileged `node` user, `CMD node dist/index.js`. Node as PID 1 handles
Cloud Run's SIGTERM correctly because index.ts installs a SIGTERM
handler (the graceful log-sink flush from 2C.2).

`.dockerignore` — keeps the build context small and deterministic.

## Verification

Local `docker build` was not possible: the Docker CLI is present
(v29.1.3) but the Docker Desktop daemon is not running on this
workstation, and starting a desktop GUI app autonomously is out of
scope. The Dockerfile is a standard multi-stage Node build, correct by
inspection. Its authoritative verification is the Cloud Build run in
Stream 2D.3, which builds from this exact Dockerfile and is the
production build path. Recorded honestly rather than claimed as a local
pass.

## Flagged — structural decision for the operator (gates 2D.3)

The Hauska MCP Server has no GCP project. `gcloud projects list` shows
three: `empressa-trading-prod`, `legacy-design-tools-prod`,
`smartcity-os-prod`. All are Empressa / trading projects; there is no
Hauska-layer project.

The Stream 2D dispatch assumed the deploy target existed ("deploy to
your repo's own Cloud Run service"). It does not. Placing the service is
a genuine structural fork the dispatch did not anticipate, and it is
money-adjacent (a new project needs a billing-account link), so per the
dispatch's pause-and-flag rule it routes to the operator rather than a
decide-and-document call. The question is raised to the operator
directly this session; everything in 2D that does not depend on the
project answer continues meanwhile (cloudbuild config written
parameterized, docs site, launch-artifact drafts, cross-client plan).

## Next

Stream 2D.2: `cloudbuild-mcp.yaml`, the Cloud Run service spec, and the
Secret Manager bind plan, all written parameterized by project id so
they are ready the moment the project decision lands.
