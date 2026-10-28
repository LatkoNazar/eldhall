#!/usr/bin/env bash
# Shared release operations; sourced after project.sh by deploy and rollback.

has_service() {
  [[ $'\n'"$1"$'\n' == *$'\n'"$2"$'\n'* ]]
}

validate_frontend_image() {
  [[ "$1" == "${2%:*}-frontend:${2##*:}" ]] || {
    echo 'Frontend image must match the backend project and release SHA' >&2
    return 2
  }
}

frontend_image_for_release() {
  local release=$1 backend=$2 services=$3 image
  if has_service "$services" frontend; then
    test -f "$release/frontend-image.ref" || {
      echo 'Frontend release image reference is missing' >&2
      return 2
    }
    image=$(cat "$release/frontend-image.ref") || return
    validate_frontend_image "$image" "$backend" || return
    printf '%s\n' "$image"
  fi
}

start_application() {
  local release=$1 services=$2
  shift 2
  local application=(api worker)
  if has_service "$services" frontend; then application+=(frontend); fi
  "$@" up -d --no-build --pull never --wait --wait-timeout 180 "${application[@]}" || return
  if has_service "$services" frontend; then
    "$@" exec -T -e SMOKE_BASE_URL=http://frontend:8080 api python - < "$release/scripts/frontend-smoke.py" || return
    "$@" exec -T -e SMOKE_BASE_URL=http://frontend:8080 api python - < "$release/apps/backend/scripts/smoke.py" || return
  else
    "$@" exec -T api python - < "$release/apps/backend/scripts/smoke.py" || return
  fi
  if has_service "$services" caddy; then
    "$@" up -d --no-build --wait --wait-timeout 120 caddy || return
  fi
}

remove_frontend() {
  local services=$1
  shift
  if has_service "$services" frontend; then
    # Remove only this project's application container; preserve every volume.
    "$@" stop frontend || return
    "$@" rm -f frontend || return
  fi
}
