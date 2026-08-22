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
# the image means plain nginx defaults serve real files (the JS bundle,
# index.html itself) correctly with zero custom config — but mode-path.ts's
# client-side routes (/acquisition, /batch-split, etc., see uw-be's
# external_app_integration URLs) aren't real files, so the default config's
# root+index (no fallback) 404s on those. deploy/nginx.conf.template adds the
# SPA fallback nginx:alpine doesn't have out of the box.
FROM nginx:alpine AS runner

ARG BASE_PATH=/ext/app/wa
COPY --from=builder /app/frontend/dist /usr/share/nginx/html${BASE_PATH}/
COPY frontend/deploy/index.html /usr/share/nginx/html${BASE_PATH}/index.html
RUN sed -i "s#BASE_PATH_PLACEHOLDER#${BASE_PATH}#g" /usr/share/nginx/html${BASE_PATH}/index.html

COPY frontend/deploy/nginx.conf.template /etc/nginx/conf.d/default.conf
RUN sed -i "s#BASE_PATH_PLACEHOLDER#${BASE_PATH}#g" /etc/nginx/conf.d/default.conf

EXPOSE 80
