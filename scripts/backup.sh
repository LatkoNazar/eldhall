#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=${1:?Usage: backup.sh /absolute/deploy/root}
[[ "$root" =~ ^/[a-zA-Z0-9/_-]+$ && "$root" != / ]] || exit 2
release=$(readlink -f "$root/current")
export APP_IMAGE
APP_IMAGE=$(cat "$release/image.ref")
mkdir -p "$root/backups"
output="$root/backups/manual-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --project-name comp-prep --env-file "$root/.env" -f "$release/compose.yaml" -f "$release/compose.prod.yaml" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$output"
test -s "$output"
echo "$output"
