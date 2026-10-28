#!/usr/bin/env bash
# Shared input and identity guards. This file never loads .env as shell code.

validate_project_name() {
  [[ ${#1} -ge 1 && ${#1} -le 63 && "$1" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || {
    echo 'Project name must be a lowercase slug of 1 to 63 characters' >&2
    return 2
  }
}

validate_deploy_root() {
  [[ "$1" =~ ^/[a-zA-Z0-9/_-]+$ && "$1" != / ]] || {
    echo 'Invalid absolute deploy root' >&2
    return 2
  }
}

project_from_image() {
  local image=$1 project=${1%:*} tag=${1##*:}
  validate_project_name "$project" || return
  [[ "$image" == "$project:$tag" && "$tag" =~ ^[a-f0-9]{40}$ ]] || {
    echo 'Invalid stored release image reference' >&2
    return 2
  }
  printf '%s\n' "$project"
}

assert_compose_project() {
  local expected=$1 actual
  shift
  validate_project_name "$expected" || return
  # Only the name leaves the JSON parser; resolved credentials never reach logs.
  actual=$("$@" config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["name"])') || return
  [[ "$actual" == "$expected" ]] || {
    echo "Compose project '$actual' does not match expected '$expected'; refusing to switch data" >&2
    return 2
  }
}

assert_current_project() {
  local root=$1 expected=$2 current_project current_image
  if [[ -e "$root/current" || -L "$root/current" ]]; then
    test -f "$root/current/compose.yaml" && test -f "$root/current/image.ref" || {
      echo 'Current release is incomplete; refusing to replace its identity' >&2
      return 2
    }
    current_image=$(cat "$root/current/image.ref") || return
    current_project=$(project_from_image "$current_image") || return
    if [[ -f "$root/current/frontend-image.ref" ]]; then
      [[ "$(cat "$root/current/frontend-image.ref")" == "${current_image%:*}-frontend:${current_image##*:}" ]] || {
        echo 'Current frontend image does not match its backend release' >&2
        return 2
      }
    fi
    [[ "$current_project" == "$expected" ]] || {
      echo "Deploy root belongs to '$current_project', not '$expected'; use a separate deploy root" >&2
      return 2
    }
  fi
}
