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
#
# trace_processor_shell overrides:
#   TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell ./start.sh
#   TRACE_PROCESSOR_DOWNLOAD_BASE=https://mirror/perfetto-luci-artifacts ./start.sh
#   TRACE_PROCESSOR_DOWNLOAD_URL=https://mirror/trace_processor_shell ./start.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_ENV_HELPERS="$PROJECT_ROOT/scripts/node-env.sh"
# shellcheck source=scripts/node-env.sh
. "$NODE_ENV_HELPERS"
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

print_macos_trace_processor_permission_help() {
  local path="$1"
  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi

  echo ""
  echo "macOS may have blocked trace_processor_shell because it was downloaded from the internet."
  echo "Fix it from System Settings:"
  echo "  Privacy & Security -> Security -> Allow Anyway for trace_processor_shell"
  echo "Then re-run ./start.sh and choose Open if macOS asks again."
  echo ""
  echo "For a binary you trust, you can also remove the quarantine attribute:"
  echo "  xattr -dr com.apple.quarantine \"$path\""
  echo "  chmod +x \"$path\""
}

hash_sha256() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  node -e "const fs=require('fs');const crypto=require('crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$file"
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
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
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

print_trace_processor_download_help() {
  local url="$1"
  local dest="$2"

  echo "=============================================="
  echo "ERROR: Failed to download trace_processor_shell."
  echo ""
  echo "Attempted URL:"
  echo "  $url"
  echo ""
  echo "This usually means the network cannot reach Google's Perfetto LUCI artifact bucket."
  echo ""
  echo "Fix options:"
  echo "  1. Use the Docker image (recommended for users):"
  echo "     docker compose -f docker-compose.hub.yml pull"
  echo "     docker compose -f docker-compose.hub.yml up -d"
  echo ""
  echo "  2. If you already have trace_processor_shell, run:"
  echo "     TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell ./start.sh"
  echo ""
  echo "  3. Or place the pinned binary here and re-run ./start.sh:"
  echo "     $dest"
  echo ""
  echo "  4. If you have a mirror with the same path layout, run:"
  echo "     TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts ./start.sh"
  echo ""
  echo "  5. If you have an exact binary URL for this platform, run:"
  echo "     TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell ./start.sh"
  echo "=============================================="
}

ensure_trace_processor_path() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "ERROR: trace_processor_shell not found at TRACE_PROCESSOR_PATH:"
    echo "  $path"
    exit 1
  fi
  if [ ! -x "$path" ]; then
    echo "ERROR: trace_processor_shell is not executable:"
    echo "  $path"
    echo ""
    echo "Run:"
    echo "  chmod +x \"$path\""
    exit 1
  fi
  if ! "$path" --version >/dev/null 2>&1; then
    echo "ERROR: trace_processor_shell failed the --version smoke test:"
    echo "  $path"
    print_macos_trace_processor_permission_help "$path"
    exit 1
  fi
}

download_trace_processor_prebuilt() {
  local dest="$1"
  local pin_env="$PROJECT_ROOT/scripts/trace-processor-pin.env"
  local os arch plat sha url_base url tmp actual_sha

  if [ -f "$pin_env" ]; then
    # shellcheck source=scripts/trace-processor-pin.env
    . "$pin_env"
  fi

  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux)  os=linux ;;
    *) echo "ERROR: Unsupported OS: $(uname -s). Use Docker or WSL2 on Windows."; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "ERROR: Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  plat="${os}-${arch}"

  case "$plat" in
    linux-amd64) sha="${PERFETTO_SHELL_SHA256_LINUX_AMD64:-a7aa1f738bbe2926a70f0829d00837f5720be8cafe26de78f962094fa24a3da4}" ;;
    linux-arm64) sha="${PERFETTO_SHELL_SHA256_LINUX_ARM64:-53af6216259df603115f1eefa94f034eef9c29cf851df15302ad29160334ca81}" ;;
    mac-amd64)   sha="${PERFETTO_SHELL_SHA256_MAC_AMD64:-a15360712875344d8bb8e4c461cd7ce9ec250f71a76f89e6ae327c5185eb4855}" ;;
    mac-arm64)   sha="${PERFETTO_SHELL_SHA256_MAC_ARM64:-23638faac4ca695e86039a01fade05ff4a38ffa89672afc7a4e4077318603507}" ;;
  esac

  PERFETTO_VERSION="${PERFETTO_VERSION:-v54.0}"
  url_base="${TRACE_PROCESSOR_DOWNLOAD_BASE:-${PERFETTO_LUCI_URL_BASE:-https://commondatastorage.googleapis.com/perfetto-luci-artifacts}}"
  url="${TRACE_PROCESSOR_DOWNLOAD_URL:-${url_base%/}/${PERFETTO_VERSION}/${plat}/trace_processor_shell}"
  tmp=$(mktemp -t trace_processor_shell.XXXXXX)

  echo "trace_processor_shell not found. Downloading pinned prebuilt..."
  echo "  platform: $plat"
  echo "  version:  $PERFETTO_VERSION"
  echo "  url:      $url"

  if ! curl -fL --retry 3 --connect-timeout 15 --max-time 120 "$url" -o "$tmp"; then
    rm -f "$tmp"
    print_trace_processor_download_help "$url" "$dest"
    exit 1
  fi

  actual_sha=$(hash_sha256 "$tmp")
  if [ "$actual_sha" != "$sha" ]; then
    rm -f "$tmp"
    echo "ERROR: trace_processor_shell SHA256 mismatch."
    echo "  expected: $sha"
    echo "  actual:   $actual_sha"
    echo ""
    echo "If you intentionally use a custom binary, set TRACE_PROCESSOR_PATH instead."
    exit 1
  fi

  chmod +x "$tmp"
  ensure_trace_processor_path "$tmp"
  mkdir -p "$(dirname "$dest")"
  mv "$tmp" "$dest"
  echo "Downloaded: $("$dest" --version 2>/dev/null | head -1)"
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
      echo "Environment:"
      echo "  TRACE_PROCESSOR_PATH           Use an existing trace_processor_shell"
      echo "  TRACE_PROCESSOR_DOWNLOAD_BASE  Mirror base with Perfetto LUCI path layout"
      echo "  TRACE_PROCESSOR_DOWNLOAD_URL   Exact trace_processor_shell URL for this platform"
      echo ""
      echo "For AI plugin development (with hot reload), use: ./scripts/start-dev.sh"
      exit 0
      ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# ── Pre-flight checks ─────────────────────────────────────────────────────────

smartperfetto_ensure_node "$PROJECT_ROOT"

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

TRACE_PROCESSOR_DEFAULT="$PROJECT_ROOT/perfetto/out/ui/trace_processor_shell"
TRACE_PROCESSOR="${TRACE_PROCESSOR_PATH:-$TRACE_PROCESSOR_DEFAULT}"
if [ -n "${TRACE_PROCESSOR_PATH:-}" ]; then
  ensure_trace_processor_path "$TRACE_PROCESSOR"
  echo "trace_processor_shell: $("$TRACE_PROCESSOR" --version 2>/dev/null | head -1)"
else
  if [ -f "$TRACE_PROCESSOR" ]; then
    chmod +x "$TRACE_PROCESSOR" 2>/dev/null || true
    if "$TRACE_PROCESSOR" --version >/dev/null 2>&1; then
      echo "trace_processor_shell: $("$TRACE_PROCESSOR" --version 2>/dev/null | head -1)"
    else
      echo "Existing trace_processor_shell is invalid; replacing it."
      rm -f "$TRACE_PROCESSOR"
      download_trace_processor_prebuilt "$TRACE_PROCESSOR"
    fi
  else
    download_trace_processor_prebuilt "$TRACE_PROCESSOR"
  fi
fi

# ── Install backend deps if needed ────────────────────────────────────────────

smartperfetto_ensure_backend_deps "$PROJECT_ROOT"

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
