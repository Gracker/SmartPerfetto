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

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
NODE_ENV_HELPERS="$PROJECT_ROOT/scripts/node-env.sh"
SERVICE_PORT_HELPERS="$PROJECT_ROOT/scripts/service-ports.sh"
SERVICE_LIFECYCLE_HELPERS="$PROJECT_ROOT/scripts/service-lifecycle.sh"
# shellcheck source=scripts/node-env.sh
. "$NODE_ENV_HELPERS"
# shellcheck source=scripts/service-ports.sh
. "$SERVICE_PORT_HELPERS"
# shellcheck source=scripts/service-lifecycle.sh
. "$SERVICE_LIFECYCLE_HELPERS"
LOGS_DIR="$PROJECT_ROOT/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
CLEAN_LOGS=false
BACKEND_PID=""
FRONTEND_PID=""
BACKEND_PORT=""
FRONTEND_PORT=""
BACKEND_URL=""
FRONTEND_URL=""
BACKEND_GENERATION=""
FRONTEND_GENERATION=""
BACKEND_CWD="$PROJECT_ROOT/backend"
FRONTEND_CWD="$PROJECT_ROOT/frontend"
FRONTEND_DEV_CWD="$PROJECT_ROOT/perfetto/ui"
BACKEND_PID_FILE="$PROJECT_ROOT/.backend.pid"
FRONTEND_PID_FILE="$PROJECT_ROOT/.frontend.pid"

smartperfetto_init_service_ports

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

start_with_logs() {
  local pid_var="$1"
  local prefix="$2"
  local log_file="$3"
  shift 3
  "$@" > >(while IFS= read -r line; do echo "[${prefix}] $line" | tee -a "$log_file"; done) 2>&1 &
  printf -v "$pid_var" '%s' "$!"
}

# shellcheck disable=SC2317,SC2329 # Invoked indirectly by traps.
cleanup() {
  local code="${1:-0}"
  trap - EXIT SIGINT SIGTERM
  set +e
  echo ""
  echo "Shutting down services..."
  if [ -n "$FRONTEND_PID" ]; then
    smartperfetto_terminate_process_tree "$FRONTEND_PID" "frontend"
  fi
  if [ -n "$BACKEND_PID" ]; then
    smartperfetto_terminate_process_tree "$BACKEND_PID" "backend"
  fi
  if [ -n "$FRONTEND_GENERATION" ]; then
    smartperfetto_remove_pid_file_if_generation "$FRONTEND_PID_FILE" "$FRONTEND_GENERATION"
  fi
  if [ -n "$BACKEND_GENERATION" ]; then
    smartperfetto_remove_pid_file_if_generation "$BACKEND_PID_FILE" "$BACKEND_GENERATION"
  fi
  echo "Cleanup complete."
  exit "$code"
}

# shellcheck disable=SC2317,SC2329 # Invoked indirectly by traps.
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
  echo "     The file MUST be named exactly 'trace_processor_shell' (no extension)."
  echo "     Names like 'trace_processor_shell.bin' or 'trace_processor_shell.1' will NOT be"
  echo "     detected. After placing it, make it executable: chmod +x \"$dest\""
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
    return 1
  fi
  if [ ! -x "$path" ]; then
    echo "ERROR: trace_processor_shell is not executable:"
    echo "  $path"
    echo ""
    echo "Run:"
    echo "  chmod +x \"$path\""
    return 1
  fi
  if ! "$path" --version >/dev/null 2>&1; then
    echo "ERROR: trace_processor_shell failed the --version smoke test:"
    echo "  $path"
    print_macos_trace_processor_permission_help "$path"
    return 1
  fi
}

resolve_trace_processor_pin() {
  local pin_env="$PROJECT_ROOT/scripts/trace-processor-pin.env"
  local os
  local arch

  if [ ! -f "$pin_env" ]; then
    echo "ERROR: trace processor pin file not found: $pin_env" >&2
    return 1
  fi
  # shellcheck source=scripts/trace-processor-pin.env
  . "$pin_env"

  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux) os=linux ;;
    *) echo "ERROR: Unsupported OS: $(uname -s). Use Docker or WSL2 on Windows." >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "ERROR: Unsupported architecture: $(uname -m)" >&2; return 1 ;;
  esac

  TRACE_PROCESSOR_PLATFORM="${os}-${arch}"
  case "$TRACE_PROCESSOR_PLATFORM" in
    linux-amd64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_LINUX_AMD64:-}" ;;
    linux-arm64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_LINUX_ARM64:-}" ;;
    mac-amd64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_MAC_AMD64:-}" ;;
    mac-arm64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_MAC_ARM64:-}" ;;
  esac
  if [ -z "$TRACE_PROCESSOR_EXPECTED_SHA" ]; then
    echo "ERROR: missing pinned trace processor SHA for $TRACE_PROCESSOR_PLATFORM." >&2
    return 1
  fi
}

verify_pinned_trace_processor() {
  local path="$1"
  local actual_sha
  resolve_trace_processor_pin
  [ -f "$path" ] || return 1
  actual_sha=$(hash_sha256 "$path")
  if [ "$actual_sha" != "$TRACE_PROCESSOR_EXPECTED_SHA" ]; then
    echo "WARNING: cached trace_processor_shell does not match the pinned SHA: $path" >&2
    return 1
  fi
  ensure_trace_processor_path "$path"
}

download_trace_processor_prebuilt() {
  local dest="$1"
  local url_base url tmp actual_sha

  resolve_trace_processor_pin
  url_base="${TRACE_PROCESSOR_DOWNLOAD_BASE:-${PERFETTO_LUCI_URL_BASE:-https://commondatastorage.googleapis.com/perfetto-luci-artifacts}}"
  url="${TRACE_PROCESSOR_DOWNLOAD_URL:-${url_base%/}/${PERFETTO_VERSION}/${TRACE_PROCESSOR_PLATFORM}/trace_processor_shell}"
  tmp=$(mktemp -t trace_processor_shell.XXXXXX)

  echo "trace_processor_shell not found. Downloading pinned prebuilt..."
  echo "  platform: $TRACE_PROCESSOR_PLATFORM"
  echo "  version:  $PERFETTO_VERSION"
  echo "  url:      $url"

  if ! curl -fL --retry 3 --connect-timeout 15 --max-time 120 "$url" -o "$tmp"; then
    rm -f "$tmp"
    print_trace_processor_download_help "$url" "$dest"
    exit 1
  fi

  actual_sha=$(hash_sha256 "$tmp")
  if [ "$actual_sha" != "$TRACE_PROCESSOR_EXPECTED_SHA" ]; then
    rm -f "$tmp"
    echo "ERROR: trace_processor_shell SHA256 mismatch."
    echo "  expected: $TRACE_PROCESSOR_EXPECTED_SHA"
    echo "  actual:   $actual_sha"
    echo ""
    echo "If you intentionally use a custom binary, set TRACE_PROCESSOR_PATH instead."
    exit 1
  fi

  chmod +x "$tmp"
  if ! ensure_trace_processor_path "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mkdir -p "$(dirname "$dest")"
  mv "$tmp" "$dest"
  echo "Downloaded: $("$dest" --version 2>/dev/null | head -1)"
}

trace_processor_prebuilt_candidate() {
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64|Linux:amd64)
      echo "$PROJECT_ROOT/backend/prebuilts/trace_processor/linux-x64/trace_processor_shell"
      ;;
    Darwin:arm64|Darwin:aarch64)
      echo "$PROJECT_ROOT/backend/prebuilts/trace_processor/darwin-arm64/trace_processor_shell"
      ;;
    *)
      echo ""
      ;;
  esac
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
      echo "  SMARTPERFETTO_NO_OPEN=1        Do not open a browser after readiness succeeds"
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
require_command pgrep

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
  echo "NOTICE: backend/.env not found."
  echo "This is OK if Claude Code already works in this terminal."
  echo "For direct API, Docker, or a different provider:"
  echo "  cp backend/.env.example backend/.env"
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

# ── Stop only a previous launcher-owned instance ──────────────────────────────

echo "Stopping existing processes..."
smartperfetto_stop_owned_pid_file \
  "$BACKEND_PID_FILE" "backend" "$PROJECT_ROOT" "$BACKEND_CWD"
smartperfetto_stop_owned_pid_file_for_allowed_cwds \
  "$FRONTEND_PID_FILE" "frontend" "$PROJECT_ROOT" "$FRONTEND_CWD" "$FRONTEND_DEV_CWD"
smartperfetto_assert_port_available "$BACKEND_PORT" "backend"
smartperfetto_assert_port_available "$FRONTEND_PORT" "frontend"

# ── trace_processor_shell ─────────────────────────────────────────────────────

# An explicit path is a user-owned override: validate it, but never chmod,
# replace, download into, or compare it with SmartPerfetto's pinned artifact.
if [ -n "${TRACE_PROCESSOR_PATH:-}" ]; then
  TRACE_PROCESSOR="$TRACE_PROCESSOR_PATH"
  ensure_trace_processor_path "$TRACE_PROCESSOR" || exit 1
  TRACE_PROCESSOR="$(cd "$(dirname "$TRACE_PROCESSOR")" && pwd -P)/$(basename "$TRACE_PROCESSOR")"
  echo "trace_processor_shell: custom override $("$TRACE_PROCESSOR" --version 2>/dev/null | head -1)"
else
  # Implicit candidates are SmartPerfetto-owned pinned artifacts.
  PREBUILT_TRACE_PROCESSOR="$(trace_processor_prebuilt_candidate)"
  TRACE_PROCESSOR=""
  if [ -n "$PREBUILT_TRACE_PROCESSOR" ] && verify_pinned_trace_processor "$PREBUILT_TRACE_PROCESSOR"; then
    TRACE_PROCESSOR="$PREBUILT_TRACE_PROCESSOR"
  fi

  TRACE_PROCESSOR_CACHE="$PROJECT_ROOT/backend/bin/trace_processor_shell"
  if [ -z "$TRACE_PROCESSOR" ] && [ -f "$TRACE_PROCESSOR_CACHE" ]; then
    if verify_pinned_trace_processor "$TRACE_PROCESSOR_CACHE"; then
      TRACE_PROCESSOR="$TRACE_PROCESSOR_CACHE"
    else
      echo "Removing invalid SmartPerfetto-managed trace processor cache."
      rm -f "$TRACE_PROCESSOR_CACHE"
    fi
  fi

  if [ -z "$TRACE_PROCESSOR" ]; then
    TRACE_PROCESSOR="$TRACE_PROCESSOR_CACHE"
    mkdir -p "$(dirname "$TRACE_PROCESSOR")"
    download_trace_processor_prebuilt "$TRACE_PROCESSOR"
  fi
  echo "trace_processor_shell: $("$TRACE_PROCESSOR" --version 2>/dev/null | head -1)"
fi
export TRACE_PROCESSOR_PATH="$TRACE_PROCESSOR"

# ── Install backend deps if needed ────────────────────────────────────────────

smartperfetto_ensure_backend_deps "$PROJECT_ROOT"

# ── Start backend ─────────────────────────────────────────────────────────────

echo "Starting backend..."
cd "$PROJECT_ROOT/backend"
BACKEND_GENERATION="$(smartperfetto_new_launch_generation backend)"
start_with_logs BACKEND_PID "BACKEND" "$BACKEND_LOG" env \
  PORT="$BACKEND_PORT" \
  SMARTPERFETTO_BACKEND_PORT="$BACKEND_PORT" \
  SMARTPERFETTO_FRONTEND_PORT="$FRONTEND_PORT" \
  FRONTEND_URL="$FRONTEND_URL" \
  SMARTPERFETTO_LOCK_SERVICE_PORTS=1 \
  npm run dev
if ! smartperfetto_write_pid_file \
  "$BACKEND_PID_FILE" "$BACKEND_PID" "backend" "$PROJECT_ROOT" "$BACKEND_CWD" "$BACKEND_GENERATION"; then
  exit 1
fi

echo "Waiting for backend..."
if ! smartperfetto_wait_for_http \
  "$BACKEND_PID" "Backend" "$BACKEND_HEALTH_URL" 30 "$BACKEND_LOG"; then
  exit 1
fi

# ── Start frontend ────────────────────────────────────────────────────────────

echo "Starting frontend..."
cd "$PROJECT_ROOT/frontend"
FRONTEND_GENERATION="$(smartperfetto_new_launch_generation frontend)"
start_with_logs FRONTEND_PID "FRONTEND" "$FRONTEND_LOG" env \
  PORT="$FRONTEND_PORT" \
  SMARTPERFETTO_BACKEND_PORT="$BACKEND_PORT" \
  SMARTPERFETTO_BACKEND_PUBLIC_PORT="$BACKEND_PUBLIC_PORT" \
  SMARTPERFETTO_BACKEND_PUBLIC_URL="$BACKEND_PUBLIC_URL" \
  SMARTPERFETTO_FRONTEND_PORT="$FRONTEND_PORT" \
  node server.js
if ! smartperfetto_write_pid_file \
  "$FRONTEND_PID_FILE" "$FRONTEND_PID" "frontend" "$PROJECT_ROOT" "$FRONTEND_CWD" "$FRONTEND_GENERATION"; then
  exit 1
fi

echo "Waiting for frontend..."
if ! smartperfetto_wait_for_http \
  "$FRONTEND_PID" "Frontend" "$FRONTEND_HEALTH_URL" 15 "$FRONTEND_LOG"; then
  exit 1
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "SmartPerfetto is running!"
echo "=============================================="
echo "  Frontend:  $FRONTEND_URL"
echo "  Backend:   $BACKEND_URL"
echo "  Backend PID:  $BACKEND_PID"
echo "  Frontend PID: $FRONTEND_PID"
echo ""
echo "  💡 To develop the AI plugin UI: ./scripts/start-dev.sh"
echo "  💡 Press Ctrl+C to stop"
echo "=============================================="

# Open browser automatically unless a headless caller opts out.
if [ "${SMARTPERFETTO_NO_OPEN:-0}" != "1" ]; then
  if command -v open >/dev/null 2>&1; then
    open "$FRONTEND_URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$FRONTEND_URL"
  fi
fi

# Keep running until either required service exits. A clean child exit is still
# unexpected here and therefore maps to a non-zero launcher status.
set +e
smartperfetto_wait_for_services \
  "$BACKEND_PID" "Backend" "$FRONTEND_PID" "Frontend"
SERVICE_EXIT_CODE=$?
set -e
exit "$SERVICE_EXIT_CODE"
