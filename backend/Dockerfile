# Build context is the repo root (see docker-compose.deploy.yml / ci.yml) —
# needed because this is a pnpm workspace and the lockfile is workspace-wide.
FROM node:20-alpine AS base

ENV PNPM_HOME="/usr/local/bin"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /app

# Every workspace member's package.json is needed to resolve pnpm-lock.yaml
# correctly, even though backend has no dependency on frontend/mock-uwbe.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY mock-uwbe/package.json mock-uwbe/package.json

FROM base AS builder
RUN pnpm install --frozen-lockfile
COPY backend backend
RUN pnpm --filter transapp-backend build

# ---- Runtime: prod deps only, compiled JS, no source/TypeScript ----
FROM base AS runner
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter transapp-backend
COPY --from=builder /app/backend/dist backend/dist

EXPOSE 4100
WORKDIR /app/backend
CMD ["node", "dist/server.js"]
