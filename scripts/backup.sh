#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=${1:?Usage: backup.sh /absolute/deploy/root}
source "$(dirname "${BASH_SOURCE[0]}")/project.sh"
source "$(dirname "${BASH_SOURCE[0]}")/release.sh"
validate_deploy_root "$root"
release=$(readlink -f "$root/current")
export APP_IMAGE
APP_IMAGE=$(cat "$release/image.ref")
project_name=$(project_from_image "$APP_IMAGE")
compose=(docker compose --env-file "$root/.env" -f "$release/compose.yaml" -f "$release/compose.prod.yaml")
assert_compose_project "$project_name" "${compose[@]}"
analytics_release=''
if [[ -e "$root/analytics-current" || -L "$root/analytics-current" ]]; then
  analytics_release=$(analytics_release_for_root "$root")
elif has_service "$("${compose[@]}" config --services)" umami; then
  analytics_release=$release
fi
if [[ -n "$analytics_release" ]]; then
  analytics=(docker compose --env-file "$root/.env" -f "$analytics_release/compose.yaml" -f "$analytics_release/compose.prod.yaml")
  assert_compose_project "$project_name" "${analytics[@]}"
fi
mkdir -p "$root/backups"
output="$root/backups/manual-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$output"
test -s "$output"
echo "$output"
if [[ -n "$analytics_release" ]]; then
  analytics_output="${output%.dump}-umami.dump"
  "${analytics[@]}" exec -T umami-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$analytics_output"
  test -s "$analytics_output"
  echo "$analytics_output"
fi
