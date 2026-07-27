#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Shared SmartPerfetto service port resolution for source launch scripts.

smartperfetto_validate_port() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    echo "ERROR: $name must be a TCP port in the range 1..65535, got '$value'." >&2
    return 1
  fi
}

smartperfetto_env_file_value() {
  local key="$1"
  local file
  local line
  local value

  for file in \
    "${SMARTPERFETTO_ENV_FILE:-}" \
    "${PROJECT_ROOT:-}/backend/.env" \
    "${PROJECT_ROOT:-}/.env"; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue
    line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$key=" "$file" | tail -n 1 || true)
    [ -n "$line" ] || continue
    value="${line#*=}"
    value="${value%%#*}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s\n' "$value"
    return 0
  done
}

smartperfetto_env_value() {
  local key="$1"
  local value
  value="${!key:-}"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi
  smartperfetto_env_file_value "$key"
}

smartperfetto_resolve_backend_port() {
  local value
  value="$(smartperfetto_env_value SMARTPERFETTO_BACKEND_PORT)"
  if [ -z "$value" ]; then
    value="$(smartperfetto_env_value PORT)"
  fi
  value="${value:-3000}"
  smartperfetto_validate_port "SMARTPERFETTO_BACKEND_PORT" "$value"
  printf '%s\n' "$value"
}

smartperfetto_resolve_frontend_port() {
  local value
  value="$(smartperfetto_env_value SMARTPERFETTO_FRONTEND_PORT)"
  value="${value:-10000}"
  smartperfetto_validate_port "SMARTPERFETTO_FRONTEND_PORT" "$value"
  printf '%s\n' "$value"
}

smartperfetto_loopback_url() {
  local port="$1"
  local path="${2:-}"
  printf 'http://127.0.0.1:%s%s\n' "$port" "$path"
}

smartperfetto_init_service_ports() {
  BACKEND_PORT="$(smartperfetto_resolve_backend_port)"
  FRONTEND_PORT="$(smartperfetto_resolve_frontend_port)"
  if [ "$BACKEND_PORT" = "$FRONTEND_PORT" ]; then
    echo "ERROR: backend and frontend ports must be different (both are $BACKEND_PORT)." >&2
    return 1
  fi

  BACKEND_PUBLIC_URL="$(smartperfetto_env_value SMARTPERFETTO_BACKEND_PUBLIC_URL)"
  if [ -z "$BACKEND_PUBLIC_URL" ]; then
    BACKEND_PUBLIC_URL="$(smartperfetto_env_value SMARTPERFETTO_BACKEND_URL)"
  fi
  BACKEND_PUBLIC_PORT="$(smartperfetto_env_value SMARTPERFETTO_BACKEND_PUBLIC_PORT)"
  BACKEND_PUBLIC_PORT="${BACKEND_PUBLIC_PORT:-$BACKEND_PORT}"
  smartperfetto_validate_port "SMARTPERFETTO_BACKEND_PUBLIC_PORT" "$BACKEND_PUBLIC_PORT"
  BACKEND_LOOPBACK_URL="$(smartperfetto_loopback_url "$BACKEND_PORT")"
  FRONTEND_LOOPBACK_URL="$(smartperfetto_loopback_url "$FRONTEND_PORT")"
  BACKEND_URL="${BACKEND_PUBLIC_URL:-$(smartperfetto_loopback_url "$BACKEND_PUBLIC_PORT")}"
  FRONTEND_URL="$(smartperfetto_env_value FRONTEND_URL)"
  FRONTEND_URL="${FRONTEND_URL:-$FRONTEND_LOOPBACK_URL}"
  BACKEND_HEALTH_URL="$(smartperfetto_loopback_url "$BACKEND_PORT" "/health")"
  FRONTEND_HEALTH_URL="$(smartperfetto_loopback_url "$FRONTEND_PORT" "/health")"
  export \
    BACKEND_PORT \
    FRONTEND_PORT \
    BACKEND_PUBLIC_PORT \
    BACKEND_PUBLIC_URL \
    BACKEND_URL \
    FRONTEND_URL \
    BACKEND_LOOPBACK_URL \
    FRONTEND_LOOPBACK_URL \
    BACKEND_HEALTH_URL \
    FRONTEND_HEALTH_URL
}
