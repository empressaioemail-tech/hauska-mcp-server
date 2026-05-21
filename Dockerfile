# Hauska MCP Server — container image.
#
# Multi-stage: a build stage compiles TypeScript to dist/, a slim runtime
# stage carries only dist/ plus production dependencies. Node 20 base per
# the package.json engines floor and the Stream 2D dispatch.

# --- build stage ------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Install all dependencies (dev included) against the committed lockfile
# for a reproducible build. Copied separately from src so the dependency
# layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Compile the server and build the static docs site (docs/site/).
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs/content ./docs/content
RUN npm run build && npm run build:docs

# --- runtime stage ----------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# Compiled server and the built docs site.
COPY --from=build /app/dist ./dist
COPY --from=build /app/docs/site ./docs/site

# Cloud Run injects PORT (default 8080) and the server reads it; EXPOSE
# is documentation only. The process drops to the unprivileged node user.
EXPOSE 8080
USER node

# The server installs a SIGTERM handler (graceful log-sink flush), so
# Node as PID 1 handles Cloud Run's stop signal correctly.
CMD ["node", "dist/index.js"]
