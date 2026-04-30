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

# Verify API key is configured
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
if { [ -z "$ANTHROPIC_KEY" ] || [ "$ANTHROPIC_KEY" = "your_anthropic_api_key_here" ] || [ "$ANTHROPIC_KEY" = "sk-ant-xxx" ]; } && \
   [ "${AI_SERVICE:-}" != "openai" ] && [ "${AI_SERVICE:-}" != "deepseek" ]; then
  echo "WARNING: ANTHROPIC_API_KEY is missing or still uses the example placeholder."
  echo "AI analysis will not work without an API key."
  echo "Set it in .env or pass via: docker compose run -e ANTHROPIC_API_KEY=sk-..."
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

# shellcheck disable=SC2317 # Invoked indirectly by trap.
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
