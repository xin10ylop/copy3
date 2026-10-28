# syntax=docker/dockerfile:1.7
# One image for every HoodSniper service (indexer, tracker, agent, telegram, sniper, db migrations).
# The whole pnpm workspace is installed once; the container picks its service from $SERVICE and runs
# `pnpm --filter @hood/$SERVICE start` (services run TypeScript directly through tsx).
#
#   docker build -f infra/Dockerfile -t hoodsniper/app:local .
#   docker run --rm -e SERVICE=telegram --env-file .env hoodsniper/app:local

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.28.0

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NODE_OPTIONS=--enable-source-maps
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app

# ---------------------------------------------------------------------------------------------
# Resolve and download every package in the lockfile without needing the sources (cache friendly).
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm fetch

# ---------------------------------------------------------------------------------------------
FROM fetch AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --offline --frozen-lockfile
# Compile PonsSniper (solc-js, no network) when the contracts package ships its compile script.
RUN if [ -f contracts/script/compile.mjs ]; then pnpm --filter @hood/contracts build; fi
# Fail the image build on type errors, so a broken service never reaches the server.
ARG TYPECHECK=1
RUN if [ "$TYPECHECK" = "1" ]; then pnpm -r run typecheck; fi

# ---------------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    REPORTS_DIR=/reports \
    HEALTH_PORT=8080
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /reports && chown node:node /reports
USER node
EXPOSE 8080
# Overridden per service in infra/docker-compose.yml (environment: SERVICE=...).
ENV SERVICE=""
CMD ["sh", "-c", "test -n \"$SERVICE\" || { echo 'set SERVICE (indexer|tracker|agent|telegram|sniper)' >&2; exit 64; }; exec pnpm --filter \"@hood/$SERVICE\" start"]
