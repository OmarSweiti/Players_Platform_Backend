# The API as production runs it (0.2.6), and the worker (0.7.6) from the same
# image with another command (`node dist/worker.js`, its own health check):
# built in one stage, run in a second
# that holds only the compiled code and the production dependencies, as the
# base image's unprivileged user. Nothing secret is built in: every setting
# comes from the environment when the container starts (src/config/env.schema.ts),
# and the API refuses to boot without the ones it needs.
#
#   docker build -t sadara-backend .
#   bash scripts/smoke-start.sh        build, start beside PostgreSQL and Valkey, prove it answers
#
# Node is the version CI tests on (.nvmrc), pinned by digest. Prisma 7 runs its
# query compiler as WebAssembly, so the image needs no native engine.
ARG NODE_IMAGE=node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY nest-cli.json tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# The client is generated for this platform, the code compiled to dist/main.js,
# then the development dependencies dropped; the generated client stays.
RUN npx --no-install prisma generate \
  && npm run build \
  && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# The base image's security updates, and none of its package managers: the
# process runs node alone, and npm's own bundled dependencies are where the
# scan's findings were (tar, undici and others).
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# Owned by root and only readable by the process: it cannot rewrite its own code.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The one directory the process writes: the local file store the quarantined
# storage service opens at startup, until the object store replaces it.
RUN mkdir uploads && chown node:node uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/live" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
