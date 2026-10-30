#!/usr/bin/env bash
# Application rollback only. Database schema stays at its current version.
set -Eeuo pipefail
umask 077
root=${1:?Usage: rollback.sh /absolute/deploy/root}
source "$(dirname "${BASH_SOURCE[0]}")/project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/release.sh"
validate_deploy_root "$root"
exec 9>"$root/.deploy.lock"
flock -w 600 9
test -f "$root/previous/image.ref" || { echo 'No previous release is available' >&2; exit 1; }
target=$(readlink -f "$root/previous")
current=$(readlink -f "$root/current")
test -f "$target/image.ref"
[[ "$target" != "$current" ]] || { echo 'Previous release is already current' >&2; exit 1; }
export APP_IMAGE
APP_IMAGE=$(cat "$target/image.ref")
project_name=$(project_from_image "$APP_IMAGE")
compose=(docker compose --env-file "$root/.env" -f "$target/compose.yaml" -f "$target/compose.prod.yaml")
if [[ -f "$root/.use-caddy" || -f "$root/.use-public-sites" ]]; then compose+=(-f "$target/infra/compose.caddy.yaml"); fi
if [[ -f "$root/.use-public-sites" && -f "$target/infra/compose.public-sites.yaml" ]]; then compose+=(-f "$target/infra/compose.public-sites.yaml"); fi
assert_compose_project "$project_name" "${compose[@]}"
assert_current_project "$root" "$project_name"
services=$("${compose[@]}" config --services)
export FRONTEND_IMAGE
FRONTEND_IMAGE=$(frontend_image_for_release "$target" "$APP_IMAGE" "$services")
export LANDING_IMAGE
LANDING_IMAGE=$(landing_image_for_release "$target" "$APP_IMAGE" "$services")
current_compose=(docker compose --env-file "$root/.env" -f "$current/compose.yaml" -f "$current/compose.prod.yaml")
if [[ -f "$root/.use-caddy" || -f "$root/.use-public-sites" ]]; then current_compose+=(-f "$current/infra/compose.caddy.yaml"); fi
if [[ -f "$root/.use-public-sites" && -f "$current/infra/compose.public-sites.yaml" ]]; then current_compose+=(-f "$current/infra/compose.public-sites.yaml"); fi
assert_compose_project "$project_name" "${current_compose[@]}"
current_services=$("${current_compose[@]}" config --services)
current_image=$(cat "$current/image.ref")
current_frontend_image=$(frontend_image_for_release "$current" "$current_image" "$current_services")
current_landing_image=$(landing_image_for_release "$current" "$current_image" "$current_services")
docker image inspect "$APP_IMAGE" >/dev/null
if has_service "$services" frontend; then docker image inspect "$FRONTEND_IMAGE" >/dev/null; fi
if has_service "$services" landing; then docker image inspect "$LANDING_IMAGE" >/dev/null; fi
recover_current() {
  result=$?
  trap - ERR
  echo 'Rollback failed; restoring the current release images and proxy.' >&2
  export APP_IMAGE="$current_image" FRONTEND_IMAGE="$current_frontend_image" LANDING_IMAGE="$current_landing_image"
  if start_application "$current" "$current_services" "${current_compose[@]}"; then
    remove_absent_web_services "$current_services" "$services" "${compose[@]}" || true
    ln -sfn "$current" "$root/current"
    ln -sfn "$target" "$root/previous"
  else
    echo 'Current release could not be restored; inspect the release manually.' >&2
  fi
  exit "$result"
}
trap recover_current ERR
start_application "$target" "$services" "${compose[@]}"
remove_absent_web_services "$services" "$current_services" "${current_compose[@]}"
ln -sfn "$target" "$root/current"
ln -sfn "$current" "$root/previous"
trap - ERR
echo "Rolled application back to $APP_IMAGE. Database unchanged."
