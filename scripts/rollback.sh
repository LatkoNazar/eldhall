#!/usr/bin/env bash
# Application rollback only. Database schema stays at its current version.
set -Eeuo pipefail
umask 077
root=${1:?Usage: rollback.sh /absolute/deploy/root}
[[ "$root" =~ ^/[a-zA-Z0-9/_-]+$ && "$root" != / ]] || exit 2
exec 9>"$root/.deploy.lock"
flock -w 600 9
test -f "$root/previous/image.ref" || { echo 'No previous release is available' >&2; exit 1; }
target=$(readlink -f "$root/previous")
current=$(readlink -f "$root/current")
test -f "$target/image.ref"
[[ "$target" != "$current" ]] || { echo 'Previous release is already current' >&2; exit 1; }
export APP_IMAGE
APP_IMAGE=$(cat "$target/image.ref")
compose=(docker compose --project-name comp-prep --env-file "$root/.env" -f "$target/compose.yaml" -f "$target/compose.prod.yaml")
if [[ -f "$root/.use-caddy" ]]; then compose+=(-f "$target/infra/compose.caddy.yaml"); fi
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180 api worker
"${compose[@]}" exec -T api python - < "$target/apps/backend/scripts/smoke.py"
if [[ -f "$root/.use-caddy" ]]; then
  "${compose[@]}" up -d --no-build --wait --wait-timeout 120 caddy
fi
ln -sfn "$target" "$root/current"
ln -sfn "$current" "$root/previous"
echo "Rolled application back to $APP_IMAGE. Database unchanged."
