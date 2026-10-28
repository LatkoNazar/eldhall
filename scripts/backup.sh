#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=${1:?Usage: backup.sh /absolute/deploy/root}
source "$(dirname "${BASH_SOURCE[0]}")/project.sh"
validate_deploy_root "$root"
release=$(readlink -f "$root/current")
export APP_IMAGE
APP_IMAGE=$(cat "$release/image.ref")
project_name=$(project_from_image "$APP_IMAGE")
compose=(docker compose --env-file "$root/.env" -f "$release/compose.yaml" -f "$release/compose.prod.yaml")
assert_compose_project "$project_name" "${compose[@]}"
mkdir -p "$root/backups"
output="$root/backups/manual-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$output"
test -s "$output"
echo "$output"
