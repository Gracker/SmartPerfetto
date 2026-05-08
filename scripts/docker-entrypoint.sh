#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# SmartPerfetto Docker entrypoint
# Starts both backend and frontend services

set -euo pipefail

echo "=============================================="
echo "SmartPerfetto (Docker)"
echo "=============================================="

# Verify LLM credentials are configured for Docker runs. Docker cannot use the
# host's Claude Code login, but health/UI smoke checks still work without AI.
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}"
OPENAI_KEY="${OPENAI_API_KEY:-}"
OPENAI_BASE="${OPENAI_BASE_URL:-}"
AGENT_RUNTIME="${SMARTPERFETTO_AGENT_RUNTIME:-claude-agent-sdk}"
PROVIDER_DATA_DIR="${PROVIDER_DATA_DIR_OVERRIDE:-/app/backend/data}"
PROVIDERS_FILE="$PROVIDER_DATA_DIR/providers.json"
HAS_ACTIVE_PROVIDER_PROFILE=false
if [ -s "$PROVIDERS_FILE" ] && grep -q '"isActive"[[:space:]]*:[[:space:]]*true' "$PROVIDERS_FILE"; then
  HAS_ACTIVE_PROVIDER_PROFILE=true
fi

if [ "$HAS_ACTIVE_PROVIDER_PROFILE" != true ] && \
   { [ -z "$ANTHROPIC_KEY" ] || [[ "$ANTHROPIC_KEY" == your_* ]] || [ "$ANTHROPIC_KEY" = "sk-ant-xxx" ]; } && \
   { [ -z "$ANTHROPIC_TOKEN" ] || [[ "$ANTHROPIC_TOKEN" == your_* ]]; } && \
   [ -z "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && \
   { [ "$AGENT_RUNTIME" != "openai-agents-sdk" ] || { [ -z "$OPENAI_KEY" ] && [ -z "$OPENAI_BASE" ]; }; }; then
  echo "WARNING: LLM credentials are missing or still use an example placeholder."
  echo "AI analysis needs credentials for the selected agent runtime."
  echo "Set a Provider Manager profile or matching Claude/OpenAI env block before running real AI analysis."
  echo ""
fi

# Start backend
echo "Starting backend on port ${PORT:-3000}..."
cd /app/backend
node dist/index.js &
BACKEND_PID=$!

# Wait for backend health
echo "Waiting for backend..."
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT:-3000}/health" >/dev/null 2>&1; then
    echo "Backend ready (${i}s)"
    break
  fi
  sleep 1
done

# Start frontend (pre-built Perfetto UI static server)
echo "Starting frontend on port 10000..."
cd /app/perfetto/out/ui/ui
PORT=10000 node server.js &
FRONTEND_PID=$!

echo ""
echo "=============================================="
echo "SmartPerfetto is running!"
echo "  Perfetto UI: http://localhost:10000"
echo "  Backend API: http://localhost:${PORT:-3000}"
echo "=============================================="

# shellcheck disable=SC2317,SC2329 # Invoked indirectly by trap.
shutdown() {
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}

# Handle shutdown gracefully
trap shutdown SIGTERM SIGINT

# Wait for either process to exit
set +e
wait -n "$BACKEND_PID" "$FRONTEND_PID"
EXIT_CODE=$?
set -e

# If one exits, stop the other
kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
exit "$EXIT_CODE"
