#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# SmartPerfetto Docker entrypoint
# Starts both backend and frontend services

set -euo pipefail

BACKEND_PID=""
FRONTEND_PID=""

echo "=============================================="
echo "SmartPerfetto (Docker)"
echo "=============================================="

validate_port() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    echo "ERROR: $name must be a TCP port in the range 1..65535, got '$value'." >&2
    exit 1
  fi
}

wait_for_service() {
  local pid="$1"
  local label="$2"
  local url="$3"
  local timeout_seconds="$4"
  local attempt=1

  while [ "$attempt" -le "$timeout_seconds" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      local exit_code
      if wait "$pid" 2>/dev/null; then
        exit_code=0
      else
        exit_code=$?
      fi
      echo "ERROR: $label exited before becoming ready (exit $exit_code)." >&2
      return 1
    fi
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "$label ready (${attempt}s)"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "ERROR: $label did not become ready within ${timeout_seconds}s." >&2
  return 1
}

# shellcheck disable=SC2317,SC2329 # Invoked indirectly by traps.
shutdown() {
  local code="${1:-0}"
  trap - EXIT SIGTERM SIGINT
  set +e
  if [ -n "$FRONTEND_PID" ]; then
    kill -TERM "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ]; then
    kill -TERM "$BACKEND_PID" 2>/dev/null || true
  fi
  [ -z "$FRONTEND_PID" ] || wait "$FRONTEND_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || wait "$BACKEND_PID" 2>/dev/null || true
  exit "$code"
}

# shellcheck disable=SC2317,SC2329 # Invoked indirectly by traps.
on_exit() {
  local code=$?
  shutdown "$code"
}

trap on_exit EXIT
# SIGTERM from Docker is an intentional shutdown and should return success.
trap 'shutdown 0' SIGTERM SIGINT

BACKEND_PORT="${SMARTPERFETTO_BACKEND_PORT:-${PORT:-3000}}"
FRONTEND_PORT="${SMARTPERFETTO_FRONTEND_PORT:-10000}"
validate_port "SMARTPERFETTO_BACKEND_PORT" "$BACKEND_PORT"
validate_port "SMARTPERFETTO_FRONTEND_PORT" "$FRONTEND_PORT"
if [ "$BACKEND_PORT" = "$FRONTEND_PORT" ]; then
  echo "ERROR: backend and frontend ports must be different (both are $BACKEND_PORT)." >&2
  exit 1
fi

# Verify LLM credentials are configured for Docker runs. Docker cannot use the
# host's Claude Code login, but health/UI smoke checks still work without AI.
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}"
ANTHROPIC_BASE="${ANTHROPIC_BASE_URL:-}"
OPENAI_KEY="${OPENAI_API_KEY:-}"
OPENAI_BASE="${OPENAI_BASE_URL:-}"
AGENT_RUNTIME="${SMARTPERFETTO_AGENT_RUNTIME:-claude-agent-sdk}"
PROVIDER_DATA_DIR="${PROVIDER_DATA_DIR_OVERRIDE:-/app/backend/data}"
PROVIDERS_FILE="$PROVIDER_DATA_DIR/providers.json"
HAS_ACTIVE_PROVIDER_PROFILE=false
ACTIVE_PROVIDER_SUMMARY=""
if [ -s "$PROVIDERS_FILE" ]; then
  ACTIVE_PROVIDER_SUMMARY="$(
    node - "$PROVIDERS_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const providers = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(providers)) process.exit(0);
  const active = providers.find((provider) => provider && provider.isActive);
  if (!active) process.exit(0);
  const runtime = active.connection?.agentRuntime || 'auto';
  const model = active.models?.primary || 'unknown-model';
  console.log(`${active.name || active.id || 'unnamed'} (${active.type || 'unknown'}, ${runtime}, ${model})`);
} catch {
  process.exit(0);
}
NODE
  )"
fi
if [ -n "$ACTIVE_PROVIDER_SUMMARY" ]; then
  HAS_ACTIVE_PROVIDER_PROFILE=true
fi

has_concrete_env_value() {
  local value="${1:-}"
  case "${value,,}" in
    ""|your_*|replace_with_*|example_*|sk-ant-xxx|sk-proxy-xxx|xxx|placeholder)
      return 1
      ;;
  esac
  [[ ! "$value" =~ ^\<[^[:space:]]+\>$ ]]
}

is_enabled_env_flag() {
  local value="${1:-}"
  has_concrete_env_value "$value" || return 1
  case "${value,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

HAS_ENV_CREDENTIALS=false
HAS_BEDROCK_ENV=false
if is_enabled_env_flag "${CLAUDE_CODE_USE_BEDROCK:-}"; then
  HAS_BEDROCK_ENV=true
fi
if has_concrete_env_value "$ANTHROPIC_KEY" || \
   has_concrete_env_value "$ANTHROPIC_TOKEN" || \
   has_concrete_env_value "$ANTHROPIC_BASE" || \
   has_concrete_env_value "$OPENAI_KEY" || \
   has_concrete_env_value "$OPENAI_BASE" || \
   [ "$HAS_BEDROCK_ENV" = true ]; then
  HAS_ENV_CREDENTIALS=true
fi

if [ "$HAS_ACTIVE_PROVIDER_PROFILE" = true ]; then
  echo "AI credential source: Provider Manager active provider: $ACTIVE_PROVIDER_SUMMARY"
  if [ "$HAS_ENV_CREDENTIALS" = true ]; then
    echo "NOTE: Docker environment credentials are present, but the active Provider Manager profile takes priority."
    echo "      Deactivate the provider in AI Assistant settings to use .env / environment fallback."
  fi
else
  echo "AI credential source: Docker .env / environment fallback"
fi

if [ "$HAS_ACTIVE_PROVIDER_PROFILE" != true ] && \
   ! has_concrete_env_value "$ANTHROPIC_KEY" && \
   ! has_concrete_env_value "$ANTHROPIC_TOKEN" && \
   ! has_concrete_env_value "$ANTHROPIC_BASE" && \
   [ "$HAS_BEDROCK_ENV" != true ] && \
   { [ "$AGENT_RUNTIME" != "openai-agents-sdk" ] || { ! has_concrete_env_value "$OPENAI_KEY" && ! has_concrete_env_value "$OPENAI_BASE"; }; }; then
  echo "WARNING: LLM credentials are missing or still use an example placeholder."
  echo "AI analysis needs credentials for the selected agent runtime."
  echo "Set a Provider Manager profile or matching Claude/OpenAI env block before running real AI analysis."
  echo ""
fi

# Start backend
echo "Starting backend on port ${BACKEND_PORT}..."
cd /app/backend
PORT="$BACKEND_PORT" \
SMARTPERFETTO_BACKEND_PORT="$BACKEND_PORT" \
SMARTPERFETTO_FRONTEND_PORT="$FRONTEND_PORT" \
SMARTPERFETTO_BIND_HOST="${SMARTPERFETTO_BIND_HOST:-0.0.0.0}" \
node dist/index.js &
BACKEND_PID=$!

# Wait for backend health
echo "Waiting for backend..."
if ! wait_for_service \
  "$BACKEND_PID" "Backend" "http://127.0.0.1:${BACKEND_PORT}/health" 30; then
  exit 1
fi

# Start frontend (pre-built Perfetto UI static server)
echo "Starting frontend on port ${FRONTEND_PORT}..."
cd /app/perfetto/out/ui/ui
PORT="$FRONTEND_PORT" \
SMARTPERFETTO_BACKEND_PORT="$BACKEND_PORT" \
SMARTPERFETTO_BACKEND_PUBLIC_PORT="${SMARTPERFETTO_BACKEND_PUBLIC_PORT:-$BACKEND_PORT}" \
SMARTPERFETTO_BACKEND_PUBLIC_URL="${SMARTPERFETTO_BACKEND_PUBLIC_URL:-${SMARTPERFETTO_BACKEND_URL:-}}" \
SMARTPERFETTO_FRONTEND_PORT="$FRONTEND_PORT" \
SMARTPERFETTO_FRONTEND_BIND_HOST="${SMARTPERFETTO_FRONTEND_BIND_HOST:-0.0.0.0}" \
node server.js &
FRONTEND_PID=$!

echo "Waiting for frontend..."
if ! wait_for_service \
  "$FRONTEND_PID" "Frontend" "http://127.0.0.1:${FRONTEND_PORT}/health" 30; then
  exit 1
fi

echo ""
echo "=============================================="
echo "SmartPerfetto is running!"
echo "  Perfetto UI: http://localhost:${FRONTEND_PORT}"
echo "  Backend API: http://localhost:${BACKEND_PORT}"
echo "=============================================="

# Wait for either process to exit
set +e
wait -n "$BACKEND_PID" "$FRONTEND_PID"
EXIT_CODE=$?
set -e

# Both services are required. Even an unexpected clean child exit is a
# container failure so restart policies and health monitoring can react.
if [ "$EXIT_CODE" -eq 0 ]; then
  EXIT_CODE=1
fi
echo "ERROR: a required SmartPerfetto service exited (exit $EXIT_CODE)." >&2
exit "$EXIT_CODE"
