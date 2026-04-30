#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# SmartPerfetto Quick Start
# Uses pre-built frontend (no Perfetto submodule required) + backend with tsx watch.
#
# This is the recommended script for most users.
#
# For AI plugin UI development (modifying ai_panel.ts etc.), use: ./scripts/start-dev.sh
#
# Usage:
#   ./start.sh           # Start with pre-built frontend
#   ./start.sh --clean   # Clean old logs before starting

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS_DIR="$PROJECT_ROOT/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
CLEAN_LOGS=false
BACKEND_PID=""
FRONTEND_PID=""

# ── Helpers ──────────────────────────────────────────────────────────────────

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' is not installed."
    exit 1
  fi
}

kill_pid_and_children() {
  local pid="$1"
  local name="$2"
  [ -z "${pid:-}" ] && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  echo "Stopping $name (PID: $pid)..."
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  sleep 1
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
}

kill_processes_on_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Stopping processes on port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

start_with_logs() {
  local pid_var="$1"
  local prefix="$2"
  local log_file="$3"
  shift 3
  "$@" > >(while IFS= read -r line; do echo "[${prefix}] $line" | tee -a "$log_file"; done) 2>&1 &
  printf -v "$pid_var" '%s' "$!"
}

cleanup() {
  local code="${1:-0}"
  echo ""
  echo "Shutting down services..."
  kill_pid_and_children "$BACKEND_PID" "backend"
  kill_pid_and_children "$FRONTEND_PID" "frontend"
  rm -f "$PROJECT_ROOT/.backend.pid" "$PROJECT_ROOT/.frontend.pid" 2>/dev/null || true
  echo "Cleanup complete."
  exit "$code"
}

on_exit() {
  local code=$?
  cleanup "$code"
}

# ── Parse args ────────────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN_LOGS=true ;;
    --help|-h)
      echo "Usage: ./start.sh [--clean]"
      echo ""
      echo "  --clean   Remove old log files before starting"
      echo ""
      echo "For AI plugin development (with hot reload), use: ./scripts/start-dev.sh"
      exit 0
      ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# ── Pre-flight checks ─────────────────────────────────────────────────────────

require_command node
require_command npm
require_command curl
require_command lsof
require_command pkill

FRONTEND_SERVER="$PROJECT_ROOT/frontend/server.js"
if [ ! -f "$FRONTEND_SERVER" ]; then
  echo "ERROR: Pre-built frontend not found at $FRONTEND_SERVER"
  echo ""
  echo "To build the frontend from source:"
  echo "  git submodule update --init --recursive"
  echo "  ./scripts/start-dev.sh"
  echo "  ./scripts/update-frontend.sh"
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/backend/.env" ]; then
  echo "=============================================="
  echo "WARNING: backend/.env not found!"
  echo "AI features require an API key."
  echo "Copy and edit: cp backend/.env.example backend/.env"
  echo "=============================================="
fi

# ── Setup ─────────────────────────────────────────────────────────────────────

mkdir -p "$LOGS_DIR"

if [ "$CLEAN_LOGS" = true ]; then
  echo "Cleaning old logs..."
  rm -f "$LOGS_DIR"/backend_*.log "$LOGS_DIR"/frontend_*.log "$LOGS_DIR"/combined_*.log 2>/dev/null || true
fi

BACKEND_LOG="$LOGS_DIR/backend_${TIMESTAMP}.log"
FRONTEND_LOG="$LOGS_DIR/frontend_${TIMESTAMP}.log"

echo "=============================================="
echo "SmartPerfetto"
echo "=============================================="
echo "Timestamp: $TIMESTAMP"
echo "Backend log:  $BACKEND_LOG"
echo "Frontend log: $FRONTEND_LOG"
echo "=============================================="
echo ""
echo "  💡 For AI plugin development (hot reload), use: ./scripts/start-dev.sh"
echo ""

# ── Trap signals ─────────────────────────────────────────────────────────────

trap on_exit EXIT
trap 'cleanup 130' SIGINT SIGTERM

# ── Kill existing processes ───────────────────────────────────────────────────

echo "Stopping existing processes..."
kill_processes_on_port 3000
kill_processes_on_port 10000
pkill -f "$PROJECT_ROOT/backend/node_modules/.bin/tsx watch src/index.ts" 2>/dev/null || true
sleep 1

# ── trace_processor_shell ─────────────────────────────────────────────────────

TRACE_PROCESSOR="$PROJECT_ROOT/perfetto/out/ui/trace_processor_shell"
if [ -f "$TRACE_PROCESSOR" ]; then
  echo "trace_processor_shell: $("$TRACE_PROCESSOR" --version 2>/dev/null | head -1)"
else
  # Download prebuilt
  echo "=============================================="
  echo "trace_processor_shell not found. Downloading prebuilt..."
  echo "=============================================="
  PIN_ENV="$PROJECT_ROOT/scripts/trace-processor-pin.env"
  if [ -f "$PIN_ENV" ]; then
    # shellcheck source=scripts/trace-processor-pin.env
    . "$PIN_ENV"
    # pin.env uses PERFETTO_VERSION / PERFETTO_SHELL_SHA256_* variable names
    TRACE_PROCESSOR_VERSION="${PERFETTO_VERSION:-v54.0}"
    TRACE_PROCESSOR_SHA256_MAC_ARM64="${PERFETTO_SHELL_SHA256_MAC_ARM64:-23638faac4ca695e86039a01fade05ff4a38ffa89672afc7a4e4077318603507}"
    TRACE_PROCESSOR_SHA256_MAC_AMD64="${PERFETTO_SHELL_SHA256_MAC_AMD64:-a15360712875344d8bb8e4c461cd7ce9ec250f71a76f89e6ae327c5185eb4855}"
  else
    TRACE_PROCESSOR_VERSION="v54.0"
    TRACE_PROCESSOR_SHA256_MAC_ARM64="23638faac4ca695e86039a01fade05ff4a38ffa89672afc7a4e4077318603507"
    TRACE_PROCESSOR_SHA256_MAC_AMD64="a15360712875344d8bb8e4c461cd7ce9ec250f71a76f89e6ae327c5185eb4855"
    PERFETTO_SHELL_SHA256_LINUX_AMD64="a7aa1f738bbe2926a70f0829d00837f5720be8cafe26de78f962094fa24a3da4"
    PERFETTO_SHELL_SHA256_LINUX_ARM64="53af6216259df603115f1eefa94f034eef9c29cf851df15302ad29160334ca81"
  fi
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$OS" in
    darwin)
      case "$ARCH" in
        arm64)         PLAT="mac-arm64";   SHA256="$TRACE_PROCESSOR_SHA256_MAC_ARM64" ;;
        x86_64|amd64)  PLAT="mac-amd64";   SHA256="$TRACE_PROCESSOR_SHA256_MAC_AMD64" ;;
        *) echo "ERROR: Unsupported Mac architecture: $ARCH"; exit 1 ;;
      esac
      ;;
    linux)
      case "$ARCH" in
        x86_64|amd64)  PLAT="linux-amd64"; SHA256="${PERFETTO_SHELL_SHA256_LINUX_AMD64:-a7aa1f738bbe2926a70f0829d00837f5720be8cafe26de78f962094fa24a3da4}" ;;
        arm64|aarch64) PLAT="linux-arm64"; SHA256="${PERFETTO_SHELL_SHA256_LINUX_ARM64:-53af6216259df603115f1eefa94f034eef9c29cf851df15302ad29160334ca81}" ;;
        *) echo "ERROR: Unsupported Linux architecture: $ARCH"; exit 1 ;;
      esac
      ;;
    *)
      echo "ERROR: Unsupported OS: $OS. Use Docker or WSL2 on Windows."
      exit 1
      ;;
  esac
  URL="https://commondatastorage.googleapis.com/perfetto-luci-artifacts/${TRACE_PROCESSOR_VERSION}/${PLAT}/trace_processor_shell"
  mkdir -p "$(dirname "$TRACE_PROCESSOR")"
  curl -fL --retry 3 "$URL" -o "$TRACE_PROCESSOR"
  echo "$SHA256  $TRACE_PROCESSOR" | shasum -a 256 -c || { echo "SHA256 mismatch!"; rm -f "$TRACE_PROCESSOR"; exit 1; }
  chmod +x "$TRACE_PROCESSOR"
  echo "Downloaded: $("$TRACE_PROCESSOR" --version 2>/dev/null | head -1)"
fi

# ── Install backend deps if needed ────────────────────────────────────────────

if [ ! -d "$PROJECT_ROOT/backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  cd "$PROJECT_ROOT/backend" && npm install
fi

# ── Start backend ─────────────────────────────────────────────────────────────

echo "Starting backend..."
cd "$PROJECT_ROOT/backend"
start_with_logs BACKEND_PID "BACKEND" "$BACKEND_LOG" npm run dev

echo "Waiting for backend..."
for i in {1..30}; do
  if curl -fs http://localhost:3000/health >/dev/null 2>&1 || \
     curl -fs http://localhost:3000/api/traces/stats >/dev/null 2>&1; then
    echo "Backend is ready! (took ${i}s)"
    break
  fi
  sleep 1
done

# ── Start frontend ────────────────────────────────────────────────────────────

echo "Starting frontend..."
cd "$PROJECT_ROOT/frontend"
start_with_logs FRONTEND_PID "FRONTEND" "$FRONTEND_LOG" node server.js

echo "Waiting for frontend..."
for i in {1..15}; do
  if curl -fs http://localhost:10000/ >/dev/null 2>&1; then
    echo "Frontend is ready! (took ${i}s)"
    break
  fi
  sleep 1
done

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "SmartPerfetto is running!"
echo "=============================================="
echo "  Frontend:  http://localhost:10000"
echo "  Backend:   http://localhost:3000"
echo "  Backend PID:  $BACKEND_PID"
echo "  Frontend PID: $FRONTEND_PID"
echo ""
echo "  💡 To develop the AI plugin UI: ./scripts/start-dev.sh"
echo "  💡 Press Ctrl+C to stop"
echo "=============================================="

echo "$BACKEND_PID"  > "$PROJECT_ROOT/.backend.pid"
echo "$FRONTEND_PID" > "$PROJECT_ROOT/.frontend.pid"

# Keep running
wait "$BACKEND_PID" 2>/dev/null || true
