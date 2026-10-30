# syntax=docker/dockerfile:1
#
# One container; SQLite files in /data (club.db for a single club, or platform.db + clubs/
# in hosted mode). Also what Fly.io builds (fly.toml).
#   docker build -t comedy-booking .
#   docker run -p 3000:3000 -v comedy-data:/data comedy-booking

# ---- deps: full install (dev dependencies are needed to build) ----------------
FROM node:24-slim AS deps
WORKDIR /app
# Toolchain for compiling better-sqlite3 when no prebuilt binary matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: client (vite → dist/client) + server (tsup → dist/server) ---------
FROM deps AS build
COPY . .
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund \
  # Make sure the native SQLite binding loads here; compile it from source if not.
  && (node -e "require('better-sqlite3')(':memory:').close()" \
      || (cd node_modules/better-sqlite3 && npx --yes node-gyp rebuild --release \
          && node -e "require('better-sqlite3')(':memory:').close()"))

# ---- runtime -------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/cbp-entrypoint
RUN mkdir -p /data && chown node:node /data
# Starts as root only to fix the data folder's owner, then runs the app as `node`
# (scripts/docker-entrypoint.sh).
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Migrations run automatically on boot.
ENTRYPOINT ["cbp-entrypoint"]
CMD ["node", "dist/server/index.js"]
