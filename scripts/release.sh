#!/usr/bin/env bash
# Shared release operations; sourced after project.sh by deploy and rollback.

has_service() {
  [[ $'\n'"$1"$'\n' == *$'\n'"$2"$'\n'* ]]
}

validate_frontend_image() {
  validate_web_image frontend "$1" "$2"
}

validate_web_image() {
  local kind=$1 image=$2 api_image=$3
  [[ "$image" == "${api_image%:*}-$kind:${api_image##*:}" ]] || {
    echo "$kind image must match the API project and release SHA" >&2
    return 2
  }
}

frontend_image_for_release() {
  web_image_for_release frontend "$@"
}

landing_image_for_release() {
  web_image_for_release landing "$@"
}

web_image_for_release() {
  local kind=$1 release=$2 api_image=$3 services=$4 image
  if has_service "$services" "$kind"; then
    test -f "$release/$kind-image.ref" || {
      echo "$kind release image reference is missing" >&2
      return 2
    }
    image=$(cat "$release/$kind-image.ref") || return
    validate_web_image "$kind" "$image" "$api_image" || return
    printf '%s\n' "$image"
  fi
}

api_smoke_for_release() {
  local release=$1
  if [[ -f "$release/apps/api/scripts/smoke.mjs" ]]; then
    printf '%s\n' "$release/apps/api/scripts/smoke.mjs"
  elif [[ -f "$release/apps/api/scripts/smoke.py" ]]; then
    printf '%s\n' "$release/apps/api/scripts/smoke.py"
  else
    # Historical archived releases keep their original backend folder.
    test -f "$release/apps/backend/scripts/smoke.py" || return
    printf '%s\n' "$release/apps/backend/scripts/smoke.py"
  fi
}

analytics_release_for_root() {
  local root=$1 release
  release=$(readlink -f "$root/analytics-current") || return
  [[ "$release" == "$root/releases/"* && "${release##*/}" =~ ^[a-f0-9]{40}$ ]] &&
    test -f "$release/compose.yaml" && test -f "$release/compose.prod.yaml" || {
      echo 'Analytics release reference must stay inside this deploy root' >&2
      return 2
    }
  printf '%s\n' "$release"
}

analytics_image() {
  local service=$1
  shift
  "$@" config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"][sys.argv[1]]["image"])' "$service"
}

start_analytics() {
  local services=$1
  shift
  if has_service "$services" umami; then
    # Registry images are independent of the locally built application image bundle.
    "$@" up -d --wait --wait-timeout 180 umami-db umami || return
  fi
}

start_dependencies() {
  local services=$1 dependency
  shift
  local dependencies=()
  # Archived Python/AMQP releases declare rabbitmq; current BullMQ releases do not.
  for dependency in postgres redis rabbitmq; do
    if has_service "$services" "$dependency"; then dependencies+=("$dependency"); fi
  done
  if (( ${#dependencies[@]} )); then
    "$@" up -d --wait --wait-timeout 180 "${dependencies[@]}" || return
  fi
}

start_application() {
  local release=$1 services=$2 smoke extension
  shift 2
  smoke=$(api_smoke_for_release "$release") || return
  extension=${smoke##*.}
  local runner=(python -)
  if [[ "$extension" == mjs ]]; then runner=(node --input-type=module -); fi
  start_dependencies "$services" "$@" || return
  local application=(api worker)
  if has_service "$services" frontend; then application+=(frontend); fi
  if has_service "$services" landing; then application+=(landing); fi
  "$@" up -d --no-build --pull never --wait --wait-timeout 180 "${application[@]}" || return
  if has_service "$services" frontend; then
    "$@" exec -T -e SMOKE_BASE_URL=http://frontend:8080 -e SMOKE_HOST=localhost api "${runner[@]}" < "$release/scripts/frontend-smoke.$extension" || return
    "$@" exec -T -e SMOKE_BASE_URL=http://frontend:8080 -e SMOKE_HOST=localhost api "${runner[@]}" < "$smoke" || return
  else
    "$@" exec -T api "${runner[@]}" < "$smoke" || return
  fi
  if has_service "$services" landing; then
    "$@" exec -T -e SMOKE_BASE_URL=http://landing:8080 api "${runner[@]}" < "$release/scripts/landing-smoke.$extension" || return
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

remove_absent_web_services() {
  local target_services=$1 current_services=$2 kind
  shift 2
  for kind in frontend landing; do
    if ! has_service "$target_services" "$kind" && has_service "$current_services" "$kind"; then
      "$@" stop "$kind" || return
      "$@" rm -f "$kind" || return
    fi
  done
  # Analytics deliberately outlives app rollback. Never delete its storage here.
}
