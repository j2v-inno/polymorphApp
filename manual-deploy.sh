#!/bin/bash
# ============================================
# Temporary manual deploy script for transapp — same role as uw-fe/uw-be's own
# manual-deploy.sh: used until transapp's self-hosted GitHub Actions runner is
# registered and deploy.yml can take over automatically. Mirrors what that
# workflow does: pull the image already built by CI from GHCR, retag it to the
# name docker-compose.deploy.yml expects, recreate the container, health-check
# it. Unlike uw-fe/uw-be (one service per repo), transapp has two services in
# one compose file — --app selects which one to deploy.
#
# Run from inside this repo's root on the box — `docker compose` resolves
# docker-compose.deploy.yml via cwd.
#
# Usage:
#   ./manual-deploy.sh --app fe --tag dev
#   ./manual-deploy.sh --app be --tag sha-<commit> --env dev
#
#   --app       fe | be                      (required)
#   --tag       GHCR image tag to deploy     (default: dev)
#   --env       deploy environment           (default: dev)
# ============================================

set -euo pipefail

APP=""
TAG="dev"
ENVIRONMENT="dev"

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

case "$APP" in
  fe)
    GHCR_IMAGE="ghcr.io/j2v-inno/transapp-frontend"
    SERVICE="frontend"
    PORT="${PORT:-9100}"
    HEALTH_PATH="${BASE_PATH:-/ext/app/wa}/index.html"
    ;;
  be)
    GHCR_IMAGE="ghcr.io/j2v-inno/transapp-backend"
    SERVICE="backend"
    PORT="${PORT:-4100}"
    HEALTH_PATH="/health"
    ;;
  *)
    echo "Usage: $0 --app <fe|be> [--tag TAG] [--env ENV]" >&2
    exit 1
    ;;
esac

PROJECT="transapp-${ENVIRONMENT}"

echo "Deploying ${GHCR_IMAGE}:${TAG} as ${PROJECT} (${SERVICE}, port ${PORT})..."

sudo docker pull "${GHCR_IMAGE}:${TAG}"

export IMAGE_TAG="$TAG"
export DEPLOY_ENV="$ENVIRONMENT"
if [ "$APP" = "fe" ]; then
  export FRONTEND_PORT="$PORT"
else
  export BACKEND_PORT="$PORT"
fi

# UWBE_BASE_URL/UWBE_API_TOKEN (backend) are required by docker-compose.deploy.yml
# even when deploying --app fe (compose interpolates the whole file before
# filtering by service) — must already be exported in this shell, or set in
# deploy.env in this directory. Deliberately NOT named .env: see
# https://github.com/j2v-inno/workflow-platform-api PR #9 — a compose-
# interpolation file named .env once collided with and overwrote a live app's
# real .env on this same box's uw-be deployment.
#
# EXTRA_HOST_ENTRY (optional, same deploy.env) — set to e.g.
# "rnd-be-orion.innodata.com:host-gateway" to hairpin the backend's
# UWBE_BASE_URL calls straight to this box instead of out through
# CloudFront/WAF. See README.md "Bypassing CloudFront/WAF for backend→uw-be
# calls". No-op if unset.
sudo -E docker compose -f docker-compose.deploy.yml --env-file deploy.env -p "$PROJECT" up -d --remove-orphans "$SERVICE"

echo "Waiting for health check..."
ok=0
for i in $(seq 1 12); do
  if curl -fsS "http://localhost:${PORT}${HEALTH_PATH}" >/dev/null; then
    ok=1
    break
  fi
  sleep 5
done

if [ "$ok" != "1" ]; then
  echo "Health check FAILED"
  sudo -E docker compose -f docker-compose.deploy.yml --env-file deploy.env -p "$PROJECT" logs --tail=100 "$SERVICE"
  exit 1
fi

sudo docker image prune -f

echo "Deployed ${GHCR_IMAGE}:${TAG} to ${PROJECT}"
