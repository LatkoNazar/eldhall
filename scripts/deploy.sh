#!/usr/bin/env bash
# The caller uploads a release bundle and optional image.tar.gz beforehand.
set -Eeuo pipefail
umask 077
root=${1:?Usage: deploy.sh /absolute/deploy/root release-sha project-name}
sha=${2:?Missing release SHA}
project_name=${3:?Missing project name}
source "$(dirname "${BASH_SOURCE[0]}")/project.sh"
validate_project_name "$project_name"
validate_deploy_root "$root"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected full Git commit SHA'; exit 2; }
release="$root/releases/$sha"
test -f "$root/.env"
test -f "$release/compose.yaml"
export APP_IMAGE="$project_name:$sha"
compose=(docker compose --env-file "$root/.env" -f "$release/compose.yaml" -f "$release/compose.prod.yaml")
if [[ -f "$root/.use-caddy" ]]; then
  compose+=(-f "$release/infra/compose.caddy.yaml")
fi
assert_compose_project "$project_name" "${compose[@]}"
assert_current_project "$root" "$project_name"
exec 9>"$root/.deploy.lock"
flock -w 600 9
assert_current_project "$root" "$project_name"
mkdir -p "$root/backups"
previous=''
if [[ -f "$root/current/compose.yaml" ]]; then
  previous=$(readlink -f "$root/current")
fi
if [[ -f "$release/image.tar.gz" ]]; then
  docker load --input "$release/image.tar.gz"
  rm -- "$release/image.tar.gz"
fi
docker image inspect "$APP_IMAGE" >/dev/null

rollback_on_error() {
  result=$?
  trap - ERR
  echo 'Deployment failed. Database migrations are NOT automatically reversed.' >&2
  "${compose[@]}" ps >&2 || true
  "${compose[@]}" logs --tail 60 api worker >&2 || true
  if [[ -n "$previous" && "$previous" != "$release" && -f "$previous/image.ref" ]]; then
    echo 'Restoring previous application image (requires backward-compatible migrations).' >&2
    APP_IMAGE=$(cat "$previous/image.ref")
    export APP_IMAGE
    old=(docker compose --env-file "$root/.env" -f "$previous/compose.yaml" -f "$previous/compose.prod.yaml")
    if [[ -f "$root/.use-caddy" ]]; then old+=(-f "$previous/infra/compose.caddy.yaml"); fi
    if assert_compose_project "$project_name" "${old[@]}"; then
      "${old[@]}" up -d --no-build --pull never --wait --wait-timeout 180 api worker || true
      if [[ -f "$root/.use-caddy" ]]; then
        "${old[@]}" up -d --no-build --wait --wait-timeout 120 caddy || true
      fi
    fi
  fi
  exit "$result"
}
trap rollback_on_error ERR
"${compose[@]}" up -d --wait --wait-timeout 180 postgres redis rabbitmq
if [[ -n "$previous" && -f "$previous/compose.yaml" ]]; then
  backup="$root/backups/pre-$sha-$(date -u +%Y%m%dT%H%M%SZ).dump"
  "${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
  test -s "$backup"
fi
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180 api worker
"${compose[@]}" exec -T api python - < "$release/apps/backend/scripts/smoke.py"
if [[ -f "$root/.use-caddy" ]]; then
  "${compose[@]}" up -d --no-build --wait --wait-timeout 120 caddy
fi
printf '%s\n' "$APP_IMAGE" > "$release/image.ref"
if [[ -n "$previous" && "$previous" != "$release" ]]; then ln -sfn "$previous" "$root/previous"; fi
ln -sfn "$release" "$root/current"
trap - ERR
echo "Deployed $sha successfully."
