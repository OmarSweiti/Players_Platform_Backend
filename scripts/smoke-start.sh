#!/usr/bin/env bash
# The production image starts and answers (0.2.6). Builds it from this checkout
# (or takes IMAGE), starts it beside a throwaway PostgreSQL 18, with the roles
# every environment has (0.4.2), and Valkey, on a network of their own; waits
# until it is live; then runs the image's test (test/image) against it. Every
# request is made inside the container, so no port is published: the same on
# Docker Desktop, Colima and CI. Everything it started is removed on exit.
#
#   bash scripts/smoke-start.sh                          build, then test
#   IMAGE=sadara-backend:ci bash scripts/smoke-start.sh  test an image already built
set -euo pipefail
cd "$(dirname "$0")/.."

POSTGRES=postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722
VALKEY=valkey/valkey:9.1.2-alpine@sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11
image=${IMAGE:-sadara-backend:smoke}
run=sadara-smoke-$$

if [ -z "${IMAGE:-}" ]; then
  echo "smoke-start: building $image"
  docker build -q -t "$image" . >/dev/null
fi

cleanup() {
  docker rm -f "$run-api" "$run-db" "$run-valkey" >/dev/null 2>&1 || true
  docker network rm "$run" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$run" >/dev/null
docker run -d --name "$run-db" --network "$run" \
  -e POSTGRES_USER=smoke -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=smoke \
  -e POSTGRES_INITDB_ARGS="--locale-provider=builtin --locale=C.UTF-8" "$POSTGRES" >/dev/null
docker run -d --name "$run-valkey" --network "$run" "$VALKEY" >/dev/null
# -h: the init phase listens on the socket only; ready means TCP answers
until docker exec "$run-db" pg_isready -h 127.0.0.1 -U smoke -d smoke >/dev/null 2>&1; do sleep 1; done
# A disposable database's passwords, not secrets
docker exec -i -e SADARA_MIGRATOR_PASSWORD=smoke-migrator -e SADARA_APP_PASSWORD=smoke-app \
  "$run-db" psql -q -U smoke -d smoke -f - <scripts/database-roles.sql >/dev/null

# Production mode, every setting from the environment: the runtime role, never
# a privileged one (the API refuses those).
docker run -d --name "$run-api" --network "$run" \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://sadara_app:smoke-app@$run-db:5432/smoke" \
  -e REDIS_HOST="$run-valkey" \
  -e CORS_ORIGIN=https://app.agency.test \
  -e MAIL_FROM=no-reply@agency.test \
  -e OIDC_ISSUER=https://idp.agency.test/realms/sadara \
  -e OIDC_CLIENT_ID=sadara-api -e OIDC_CLIENT_SECRET=not-a-secret-not-a-secret \
  -e OIDC_ADMIN_CLIENT_ID=sadara-admin -e OIDC_ADMIN_CLIENT_SECRET=not-a-secret-not-a-secret \
  -e CSRF_SECRET=not-a-secret-not-a-secret-not-a-secret \
  "$image" >/dev/null
export SMOKE_CONTAINER="$run-api"

live='fetch("http://127.0.0.1:3000/health/live").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'
for attempt in $(seq 1 60); do
  docker exec "$run-api" node -e "$live" 2>/dev/null && break
  if [ "$attempt" -eq 60 ]; then
    echo "smoke-start: the image never answered /health/live; its last lines:" >&2
    docker logs --tail 20 "$run-api" >&2
    exit 1
  fi
  sleep 1
done
echo "smoke-start: $image is live in $run-api"
npx --no-install vitest run --project image
