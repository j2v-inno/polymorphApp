# Build context is the repo root (see docker-compose.deploy.yml / ci.yml) —
# needed because this is a pnpm workspace and the lockfile is workspace-wide.
FROM node:20-alpine AS builder

ENV PNPM_HOME="/usr/local/bin"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /app

# Every workspace member's package.json is needed to resolve pnpm-lock.yaml
# correctly, even though frontend has no dependency on backend/mock-uwbe.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY mock-uwbe/package.json mock-uwbe/package.json
RUN pnpm install --frozen-lockfile

COPY frontend frontend

# Baked into the client bundle at build time via webpack.DefinePlugin
# (frontend/webpack.config.js, frontend/src/config.ts) — cannot be changed by
# setting this on the container later, same constraint uw-fe's
# NEXT_PUBLIC_BACKEND_API_URL has (see its Dockerfile/ci.yml).
ARG BACKEND_URL
ENV BACKEND_URL=${BACKEND_URL}

RUN pnpm --filter transapp-frontend build

# ---- Runtime: static files only, no Node process ----
# standalone-single-spa-webpack-plugin's HTML generation is dev-server-only
# (confirmed: a plain production build emits no index.html at all) and even
# when it does run, hardcodes an absolute "/<bundle>" script src that breaks
# under a subpath — deploy/index.html replaces it with a version that knows
# its own subpath. Nesting the build output under that same subpath inside
# the image means plain nginx defaults serve it correctly with zero custom
# location config, matching how requests arrive unstripped from the host
# nginx (see nginx/rnd-fe-unifiedworkflow.snippet.conf).
FROM nginx:alpine AS runner

ARG BASE_PATH=/ext/app/wa
COPY --from=builder /app/frontend/dist /usr/share/nginx/html${BASE_PATH}/
COPY frontend/deploy/index.html /usr/share/nginx/html${BASE_PATH}/index.html
RUN sed -i "s#BASE_PATH_PLACEHOLDER#${BASE_PATH}#g" /usr/share/nginx/html${BASE_PATH}/index.html

EXPOSE 80
