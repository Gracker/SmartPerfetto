#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# SmartPerfetto Development Stop Script
# Stops all SmartPerfetto services and cleans up processes

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=============================================="
echo "Stopping SmartPerfetto Services"
echo "=============================================="

# Kill processes from PID files if they exist
if [ -f "$PROJECT_ROOT/.backend.pid" ]; then
  BACKEND_PID=$(cat "$PROJECT_ROOT/.backend.pid")
  echo "Stopping backend (PID: $BACKEND_PID)..."
  kill "$BACKEND_PID" 2>/dev/null || true
  rm -f "$PROJECT_ROOT/.backend.pid"
fi

if [ -f "$PROJECT_ROOT/.frontend.pid" ]; then
  FRONTEND_PID=$(cat "$PROJECT_ROOT/.frontend.pid")
  echo "Stopping frontend (PID: $FRONTEND_PID)..."
  kill "$FRONTEND_PID" 2>/dev/null || true
  rm -f "$PROJECT_ROOT/.frontend.pid"
fi

# Kill processes on ports
echo "Cleaning up port 3000..."
PORT_3000_PIDS=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$PORT_3000_PIDS" ]; then
  echo "$PORT_3000_PIDS" | xargs kill -9 2>/dev/null || true
fi

echo "Cleaning up port 10000..."
PORT_10000_PIDS=$(lsof -ti:10000 2>/dev/null || true)
if [ -n "$PORT_10000_PIDS" ]; then
  echo "$PORT_10000_PIDS" | xargs kill -9 2>/dev/null || true
fi

# Kill zombie watch processes
echo "Cleaning up zombie watch processes..."
pkill -f "$PROJECT_ROOT/backend/node_modules/.bin/tsx watch src/index.ts" 2>/dev/null || true
pkill -f "tsc.*perfetto.*watch" 2>/dev/null || true
pkill -f "rollup.*perfetto.*watch" 2>/dev/null || true
pkill -f "node.*perfetto/ui/build.js" 2>/dev/null || true

# Kill orphan trace_processor_shell processes
echo "Cleaning up trace_processor_shell processes..."
pkill -f "trace_processor_shell.*httpd" 2>/dev/null || true

echo ""
echo "=============================================="
echo "All SmartPerfetto services stopped."
echo "=============================================="
