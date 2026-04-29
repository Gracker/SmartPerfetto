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
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ "${AI_SERVICE:-}" != "openai" ] && [ "${AI_SERVICE:-}" != "deepseek" ]; then
  echo "WARNING: ANTHROPIC_API_KEY is not set."
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

# Start frontend (Perfetto UI dev server)
echo "Starting frontend on port 10000..."
cd /app/perfetto/ui
./run-dev-server &
FRONTEND_PID=$!

echo ""
echo "=============================================="
echo "SmartPerfetto is running!"
echo "  Perfetto UI: http://localhost:10000"
echo "  Backend API: http://localhost:${PORT:-3000}"
echo "=============================================="

# Handle shutdown gracefully
trap 'kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0' SIGTERM SIGINT

# Wait for either process to exit
wait -n $BACKEND_PID $FRONTEND_PID
EXIT_CODE=$?

# If one exits, stop the other
kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
exit $EXIT_CODE