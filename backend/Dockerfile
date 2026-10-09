# syntax=docker/dockerfile:1.7
# Multi-stage build: node:24-bookworm-slim builder → distroless/nodejs24:nonroot
# runtime. node:sqlite is a Node 24 built-in (flag-free) so no native compile is needed.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# Phase 1: dependency manifests only — this layer survives source edits.
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile=false

# Phase 2: source
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

ARG APP_VERSION=dev
ARG BUILD_TIME=unknown
ENV APP_VERSION=${APP_VERSION} \
    APP_BUILD_TIME=${BUILD_TIME}

RUN pnpm build

# Drop dev dependencies so the runtime stage copies only what the server needs.
RUN pnpm prune --prod

# Runtime stage — distroless/nodejs24 has no shell, no package manager.
# UID 65532 is the distroless nonroot user.
FROM gcr.io/distroless/nodejs24-debian12:nonroot

ENV TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle

USER nonroot

EXPOSE 8080

CMD ["dist/server.js"]
