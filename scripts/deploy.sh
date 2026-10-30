#!/usr/bin/env bash
# The caller uploads a release bundle and optional image.tar.gz beforehand.
set -Eeuo pipefail
umask 077
root=${1:?Usage: deploy.sh /absolute/deploy/root release-sha project-name}
sha=${2:?Missing release SHA}
project_name=${3:?Missing project name}
source "$(dirname "${BASH_SOURCE[0]}")/project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/release.sh"
validate_project_name "$project_name"
validate_deploy_root "$root"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected full Git commit SHA'; exit 2; }
release="$root/releases/$sha"
test -f "$root/.env"
test -f "$release/compose.yaml"
export APP_IMAGE="$project_name:$sha"
export FRONTEND_IMAGE="$project_name-frontend:$sha"
export LANDING_IMAGE="$project_name-landing:$sha"
compose=(docker compose --env-file "$root/.env" -f "$release/compose.yaml" -f "$release/compose.prod.yaml")
if [[ -f "$root/.use-caddy" || -f "$root/.use-public-sites" ]]; then
  compose+=(-f "$release/infra/compose.caddy.yaml")
fi
if [[ -f "$root/.use-public-sites" && -f "$release/infra/compose.public-sites.yaml" ]]; then
  compose+=(-f "$release/infra/compose.public-sites.yaml")
fi
assert_compose_project "$project_name" "${compose[@]}"
services=$("${compose[@]}" config --services)
assert_current_project "$root" "$project_name"
exec 9>"$root/.deploy.lock"
flock -w 600 9
assert_current_project "$root" "$project_name"
previous=''
old_services=''
old_frontend_image=''
old_landing_image=''
if [[ -f "$root/current/compose.yaml" ]]; then
  previous=$(readlink -f "$root/current")
  old_image=$(cat "$previous/image.ref")
  old=(docker compose --env-file "$root/.env" -f "$previous/compose.yaml" -f "$previous/compose.prod.yaml")
  if [[ -f "$root/.use-caddy" || -f "$root/.use-public-sites" ]]; then old+=(-f "$previous/infra/compose.caddy.yaml"); fi
  if [[ -f "$root/.use-public-sites" && -f "$previous/infra/compose.public-sites.yaml" ]]; then old+=(-f "$previous/infra/compose.public-sites.yaml"); fi
  assert_compose_project "$project_name" "${old[@]}"
  old_services=$("${old[@]}" config --services)
  old_frontend_image=$(frontend_image_for_release "$previous" "$old_image" "$old_services")
  old_landing_image=$(landing_image_for_release "$previous" "$old_image" "$old_services")
fi
analytics_previous=''
if [[ -e "$root/analytics-current" || -L "$root/analytics-current" ]]; then
  analytics_previous=$(analytics_release_for_root "$root")
elif has_service "$old_services" umami; then
  analytics_previous=$previous
fi
if [[ -n "$analytics_previous" ]]; then
  analytics_old=(docker compose --env-file "$root/.env" -f "$analytics_previous/compose.yaml" -f "$analytics_previous/compose.prod.yaml")
  assert_compose_project "$project_name" "${analytics_old[@]}"
  if has_service "$services" umami; then
    for analytics_service in umami umami-db; do
      previous_analytics_image=$(analytics_image "$analytics_service" "${analytics_old[@]}")
      next_analytics_image=$(analytics_image "$analytics_service" "${compose[@]}")
      if [[ -z "$previous_analytics_image" || -z "$next_analytics_image" || "$previous_analytics_image" != "$next_analytics_image" ]]; then
        echo 'Umami/analytics DB image changes require a separate backed-up analytics upgrade; app deployment will not downgrade or migrate them implicitly.' >&2
        exit 2
      fi
    done
  fi
fi
mkdir -p "$root/backups"
if [[ -f "$release/image.tar.gz" ]]; then
  docker load --input "$release/image.tar.gz"
  rm -- "$release/image.tar.gz"
fi
docker image inspect "$APP_IMAGE" >/dev/null
if has_service "$services" frontend; then docker image inspect "$FRONTEND_IMAGE" >/dev/null; fi
if has_service "$services" landing; then docker image inspect "$LANDING_IMAGE" >/dev/null; fi

rollback_on_error() {
  result=$?
  trap - ERR
  echo 'Deployment failed. Database migrations are NOT automatically reversed.' >&2
  "${compose[@]}" ps >&2 || true
  "${compose[@]}" logs --tail 60 >&2 || true
  if [[ -n "$previous" && "$previous" != "$release" && -f "$previous/image.ref" ]]; then
    echo 'Restoring previous application image (requires backward-compatible migrations).' >&2
    export APP_IMAGE="$old_image" FRONTEND_IMAGE="$old_frontend_image" LANDING_IMAGE="$old_landing_image"
    if assert_compose_project "$project_name" "${old[@]}"; then
      if start_application "$previous" "$old_services" "${old[@]}"; then
        remove_absent_web_services "$old_services" "$services" "${compose[@]}" || true
      else
        echo 'Previous application could not be restored; inspect the release manually.' >&2
      fi
    fi
  elif [[ -z "$previous" ]]; then
    remove_absent_web_services '' "$services" "${compose[@]}" || true
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
if [[ -n "$analytics_previous" ]]; then
  analytics_backup="$root/backups/pre-$sha-$(date -u +%Y%m%dT%H%M%SZ)-umami.dump"
  "${analytics_old[@]}" exec -T umami-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$analytics_backup"
  test -s "$analytics_backup"
fi
start_analytics "$services" "${compose[@]}"
if has_service "$services" umami; then ln -sfn "$release" "$root/analytics-current"; fi
"${compose[@]}" run --rm --no-deps migrate
start_application "$release" "$services" "${compose[@]}"
printf '%s\n' "$APP_IMAGE" > "$release/image.ref"
if has_service "$services" frontend; then printf '%s\n' "$FRONTEND_IMAGE" > "$release/frontend-image.ref"; fi
if has_service "$services" landing; then printf '%s\n' "$LANDING_IMAGE" > "$release/landing-image.ref"; fi
if [[ -n "$previous" && "$previous" != "$release" ]]; then ln -sfn "$previous" "$root/previous"; fi
ln -sfn "$release" "$root/current"
trap - ERR
echo "Deployed $sha successfully."
