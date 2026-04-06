#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# SmartPerfetto Development Startup Script
# Starts both backend and frontend with persistent logging
#
# Usage:
#   ./start-dev.sh           # Full build and start
#   ./start-dev.sh --quick   # Skip build, just start services
#   ./start-dev.sh --clean   # Clean old logs before starting

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$PROJECT_ROOT/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
SKIP_BUILD=false
CLEAN_LOGS=false
BACKEND_PID=""
FRONTEND_PID=""

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
  if [ -z "${pid:-}" ]; then
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  echo "Stopping $name (PID: $pid)..."
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
  fi
}

kill_processes_on_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    return 0
  fi

  echo "Stopping processes on port $port: $pids"
  echo "$pids" | xargs kill 2>/dev/null || true
  sleep 1

  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

start_with_logs() {
  local pid_var="$1"
  local tag="$2"
  local log_file="$3"
  shift 3

  "$@" > >(
    tee -a "$log_file" | sed -l "s/^/[$tag] /" | tee -a "$COMBINED_LOG"
  ) 2>&1 &
  printf -v "$pid_var" '%s' "$!"
}

cleanup() {
  local code="${1:-0}"
  trap - EXIT SIGINT SIGTERM

  echo ""
  echo "Shutting down services..."
  kill_pid_and_children "$BACKEND_PID" "backend"
  kill_pid_and_children "$FRONTEND_PID" "frontend"

  # Clean up any child processes
  pkill -f "tsc.*perfetto.*watch" 2>/dev/null || true
  pkill -f "rollup.*perfetto.*watch" 2>/dev/null || true
  pkill -f "node.*perfetto/ui/build.js" 2>/dev/null || true

  # Remove PID files
  rm -f "$PROJECT_ROOT/.backend.pid" "$PROJECT_ROOT/.frontend.pid" 2>/dev/null || true

  echo "Cleanup complete."
  exit "$code"
}

on_exit() {
  local code=$?
  cleanup "$code"
}

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --quick|-q)
      SKIP_BUILD=true
      ;;
    --clean|-c)
      CLEAN_LOGS=true
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --quick, -q    Skip build, just start services"
      echo "  --clean, -c    Clean old logs (keep last 10) before starting"
      echo "  --help, -h     Show this help message"
      exit 0
      ;;
    *)
      echo "ERROR: unknown option '$1'"
      echo "Use --help to see available options."
      exit 1
      ;;
  esac
  shift
done

# Create logs directory
mkdir -p "$LOGS_DIR"

# Clean old logs if requested (keep last 10 of each type)
if [ "$CLEAN_LOGS" = true ]; then
  echo "Cleaning old log files (keeping last 10)..."
  for prefix in backend frontend combined; do
    ls -t "$LOGS_DIR"/${prefix}_*.log 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
  done
fi

# Log file names
BACKEND_LOG="$LOGS_DIR/backend_${TIMESTAMP}.log"
FRONTEND_LOG="$LOGS_DIR/frontend_${TIMESTAMP}.log"
COMBINED_LOG="$LOGS_DIR/combined_${TIMESTAMP}.log"

echo "=============================================="
echo "SmartPerfetto Development Server"
echo "=============================================="
echo "Timestamp: $TIMESTAMP"
echo "Mode: $([ "$SKIP_BUILD" = true ] && echo "Quick Start (skip build)" || echo "Full Build")"
echo "Backend log:  $BACKEND_LOG"
echo "Frontend log: $FRONTEND_LOG"
echo "Combined log: $COMBINED_LOG"
echo "=============================================="

# Perfetto's bundled tools (hermetic versions, NOT system-installed ones)
PERFETTO_DIR="$PROJECT_ROOT/perfetto"
PERFETTO_PNPM="$PERFETTO_DIR/tools/pnpm"
PERFETTO_NODE="$PERFETTO_DIR/tools/node"
UI_DIR="$PERFETTO_DIR/ui"

# Environment check
echo "Checking environment..."
require_command python3
require_command npm
require_command curl
require_command lsof
require_command pkill

# Verify Perfetto's bundled tools exist
if [ ! -x "$PERFETTO_PNPM" ]; then
  echo "ERROR: Perfetto's bundled pnpm not found at $PERFETTO_PNPM"
  echo "       Is the perfetto submodule initialized? Try: git submodule update --init"
  exit 1
fi
if [ ! -x "$PERFETTO_NODE" ]; then
  echo "ERROR: Perfetto's bundled node not found at $PERFETTO_NODE"
  echo "       Is the perfetto submodule initialized? Try: git submodule update --init"
  exit 1
fi
if [ ! -x "$UI_DIR/run-dev-server" ]; then
  echo "ERROR: frontend runner not found at $UI_DIR/run-dev-server"
  echo "       Sync the perfetto submodule and ensure scripts are executable."
  exit 1
fi

# Validate UI lockfile is compatible with Perfetto's bundled pnpm.
# Auto-fixes incompatible lockfiles caused by system pnpm after upstream merges.
#
# pnpm major version → lockfileVersion mapping:
#   pnpm 8.x → lockfileVersion '6.0'
#   pnpm 9.x → lockfileVersion '9.0'
get_lockfile_version() {
  awk -F: '/^[[:space:]]*lockfileVersion[[:space:]]*:/ { v=$2; gsub(/[[:space:]'\''"]/, "", v); print v; exit }' "$1"
}

get_expected_lockfile_version() {
  local pnpm_version
  pnpm_version=$("$PERFETTO_PNPM" --version 2>/dev/null || echo "0.0.0")
  local major="${pnpm_version%%.*}"
  case "$major" in
    8) echo "6.0" ;;
    9) echo "9.0" ;;
    *) echo "unknown" ;;
  esac
}

validate_ui_lockfile() {
  local lockfile="$UI_DIR/pnpm-lock.yaml"
  if [ ! -f "$lockfile" ]; then
    echo "ERROR: UI lockfile not found at $lockfile"
    return 1
  fi

  local expected
  expected=$(get_expected_lockfile_version)
  if [ "$expected" = "unknown" ]; then
    echo "WARNING: Cannot determine expected lockfile version from bundled pnpm. Skipping check."
    return 0
  fi

  local version
  version=$(get_lockfile_version "$lockfile")
  if [ "$version" = "$expected" ]; then
    return 0
  fi

  echo "=============================================="
  echo "WARNING: UI pnpm-lock.yaml has lockfileVersion '$version' (expected '$expected')"
  echo "  Bundled pnpm: $($PERFETTO_PNPM --version 2>/dev/null)"
  echo "  Auto-fixing: restoring upstream lockfile + regenerating with bundled pnpm..."
  echo "=============================================="

  # Step 1: Restore lockfile from upstream (origin/main in the perfetto submodule)
  cd "$PERFETTO_DIR"
  if git cat-file -e origin/main:ui/pnpm-lock.yaml 2>/dev/null; then
    git checkout origin/main -- ui/pnpm-lock.yaml
    echo "  Restored ui/pnpm-lock.yaml from origin/main"
  else
    echo "  origin/main not available, fetching upstream..."
    git fetch origin main --depth=1 2>/dev/null || true
    if git cat-file -e origin/main:ui/pnpm-lock.yaml 2>/dev/null; then
      git checkout origin/main -- ui/pnpm-lock.yaml
      echo "  Restored ui/pnpm-lock.yaml from origin/main"
    else
      echo "ERROR: Cannot restore lockfile — origin/main not reachable."
      echo "  Manual fix: cd perfetto && git checkout origin/main -- ui/pnpm-lock.yaml"
      return 1
    fi
  fi

  # Step 2: If fork has extra deps in package.json, regenerate lockfile with bundled pnpm
  # (--shamefully-hoist matches Perfetto's install-build-deps behavior)
  if git diff origin/main -- ui/package.json | grep -q '^+'; then
    echo "  Fork has extra UI dependencies — regenerating lockfile with bundled pnpm..."
    yes | "$PERFETTO_PNPM" install --shamefully-hoist --no-frozen-lockfile --dir ui 2>&1 | tail -5
  fi

  # Step 3: Verify
  version=$(get_lockfile_version "$lockfile")
  if [ "$version" != "$expected" ]; then
    echo "ERROR: Auto-fix failed — lockfileVersion is '$version', expected '$expected'"
    echo "  Bundled pnpm version: $($PERFETTO_PNPM --version 2>/dev/null || echo 'unknown')"
    return 1
  fi

  # Step 4: Clear stale install marker so deps get properly installed later
  rm -f "$UI_DIR/node_modules/.last_install" 2>/dev/null || true

  echo "  ✅ Lockfile fixed to lockfileVersion '$expected'"
  cd "$PROJECT_ROOT"
  return 0
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
  python3 - "$file" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

is_ui_deps_current() {
  local lockfile="$UI_DIR/pnpm-lock.yaml"
  local marker="$UI_DIR/node_modules/.last_install"

  if [ ! -f "$lockfile" ] || [ ! -f "$marker" ]; then
    return 1
  fi

  local expected
  local actual
  expected=$(hash_sha256 "$lockfile")
  actual=$(tr -d '[:space:]' < "$marker")
  [ "$expected" = "$actual" ]
}

# Extract frontend version directory from Perfetto index.html
# e.g. data-perfetto_version='{"stable":"v53.0-xxxx"}'
extract_frontend_version() {
  local index_html="$1"
  local version
  version=$(echo "$index_html" | sed -n "s/.*data-perfetto_version='[^']*\"stable\":\"\\([^\"]*\\)\"[^']*'.*/\\1/p" | head -n 1)
  if [ -z "$version" ]; then
    return 1
  fi
  echo "$version"
}

# Strong readiness check for Perfetto frontend:
# - index.html responds 200
# - versioned frontend_bundle.js responds 200
# - bundle is reasonably large (guard against truncated output)
# - bundle tail contains sourceMappingURL marker
is_frontend_bundle_ready() {
  local version="$1"
  local bundle_url="http://localhost:10000/$version/frontend_bundle.js"
  local tmp_file="/tmp/smartperfetto_frontend_bundle_$$.js"

  local code
  code=$(curl -sS -o "$tmp_file" -w "%{http_code}" "$bundle_url" 2>/dev/null || echo "000")
  if [ "$code" != "200" ]; then
    rm -f "$tmp_file" 2>/dev/null || true
    return 1
  fi

  local size
  size=$(wc -c < "$tmp_file" 2>/dev/null || echo 0)
  if [ "${size:-0}" -lt 5000000 ]; then
    rm -f "$tmp_file" 2>/dev/null || true
    return 1
  fi

  if ! tail -c 256 "$tmp_file" | grep -q "sourceMappingURL=frontend_bundle.js.map"; then
    rm -f "$tmp_file" 2>/dev/null || true
    return 1
  fi

  rm -f "$tmp_file" 2>/dev/null || true
  return 0
}

# Install UI node_modules using Perfetto's bundled pnpm
install_ui_deps() {
  echo "Installing UI dependencies with Perfetto's bundled pnpm..."
  cd "$PERFETTO_DIR"
  if ! tools/install-build-deps --ui 2>&1 | tee -a "$FRONTEND_LOG"; then
    echo "=============================================="
    echo "ERROR: UI dependency installation failed!"
    echo ""
    echo "Common fixes:"
    echo "  1. Restore lockfile: cd perfetto && git checkout origin/main -- ui/pnpm-lock.yaml"
    echo "  2. Clean reinstall: rm -rf ui/node_modules && re-run"
    echo "  3. NEVER use system pnpm for ui/. Always use: tools/pnpm"
    echo "=============================================="
    return 1
  fi
}

# 【S2 Fix】Check and install dependencies if needed
if [ ! -d "$PROJECT_ROOT/backend/node_modules" ]; then
  echo "Backend dependencies not found. Installing..."
  cd "$PROJECT_ROOT/backend" && npm install
fi

# 【S3 Fix】Check for .env file
if [ ! -f "$PROJECT_ROOT/backend/.env" ]; then
  echo "=============================================="
  echo "WARNING: backend/.env not found!"
  echo "AI features may not work without API keys."
  echo "Please copy .env.example to .env and configure."
  echo "=============================================="
fi

# Trap Ctrl+C and other termination signals
trap on_exit EXIT
trap 'cleanup 130' SIGINT SIGTERM

# Kill existing processes on ports 3000 and 10000
echo "Stopping existing processes..."
kill_processes_on_port 3000
kill_processes_on_port 10000

# Kill any zombie tsc/rollup watch processes from previous runs
echo "Cleaning up zombie watch processes..."
pkill -f "tsc.*perfetto.*watch" 2>/dev/null || true
pkill -f "rollup.*perfetto.*watch" 2>/dev/null || true
pkill -f "node.*perfetto/ui/build.js" 2>/dev/null || true

# Kill orphan trace_processor_shell processes (except the one we'll use)
echo "Cleaning up orphan trace_processor_shell processes..."
pkill -f "trace_processor_shell.*httpd" 2>/dev/null || true
sleep 1

# Check and build trace_processor_shell if needed
TRACE_PROCESSOR="$PERFETTO_DIR/out/ui/trace_processor_shell"
if [ ! -f "$TRACE_PROCESSOR" ]; then
  echo "=============================================="
  echo "trace_processor_shell not found. Building..."
  echo "=============================================="

  cd "$PERFETTO_DIR"

  # Generate build config if needed
  if [ ! -f "out/ui/build.ninja" ]; then
    echo "Generating build configuration..."
    tools/gn gen out/ui --args='is_debug=false'
  fi

  # Build trace_processor_shell
  echo "Compiling trace_processor_shell (this may take a few minutes)..."
  if ! tools/ninja -C out/ui trace_processor_shell; then
    echo "=============================================="
    echo "ERROR: Failed to build trace_processor_shell"
    echo ""
    echo "You can try building manually:"
    echo "  cd $PERFETTO_DIR"
    echo "  tools/ninja -C out/ui trace_processor_shell"
    echo ""
    echo "Or download a pre-built binary:"
    echo "  curl -LOk https://get.perfetto.dev/trace_processor"
    echo "  chmod +x trace_processor"
    echo "  mv trace_processor $TRACE_PROCESSOR"
    echo "=============================================="
    exit 1
  fi

  echo "trace_processor_shell built successfully!"
else
  echo "trace_processor_shell found: $TRACE_PROCESSOR"
fi

if [ "$SKIP_BUILD" = false ]; then
  # Generate frontend types from backend data contract
  echo "Generating frontend types..."
  cd "$PROJECT_ROOT/backend"
  npm run generate:frontend-types 2>&1 | tee -a "$BACKEND_LOG" || echo "Warning: Frontend type generation failed, continuing..."

  # Build backend
  echo "Building backend..."
  cd "$PROJECT_ROOT/backend"
  if ! npm run build 2>&1 | tee -a "$BACKEND_LOG"; then
    echo "Backend build failed!"
    exit 1
  fi

  # Validate UI lockfile format before installing deps
  echo "Validating UI lockfile format..."
  if ! validate_ui_lockfile; then
    exit 1
  fi

  # Install UI build dependencies (uses Perfetto's bundled pnpm v8)
  # .last_install is a marker file created by install-build-deps containing lockfile hash
  echo "Checking UI build dependencies..."
  if ! is_ui_deps_current; then
    if [ -f "$UI_DIR/node_modules/.last_install" ]; then
      echo "UI dependency marker is stale. Reinstalling dependencies..."
    fi
    if ! install_ui_deps; then
      exit 1
    fi
  else
    echo "UI node_modules up to date."
  fi

  # Build frontend using Perfetto's build system
  echo "Building frontend..."
  cd "$PERFETTO_DIR"
  if ! "$PERFETTO_NODE" ui/build.js 2>&1 | tee -a "$FRONTEND_LOG"; then
    echo "=============================================="
    echo "Frontend build failed!"
    echo ""
    echo "If you see 'Cannot find module' errors:"
    echo "  rm -rf ui/node_modules"
    echo "  Then re-run this script."
    echo ""
    echo "IMPORTANT: Never run 'pnpm install' directly in ui/."
    echo "           Always use: tools/pnpm install --shamefully-hoist"
    echo "=============================================="
    exit 1
  fi
else
  echo "Skipping build (--quick mode)..."
  # Verify that build artifacts exist
  # Perfetto UI build output lives under out/ui/ui/ (see ui/build.js ensureDir()).
  if [ ! -d "$PERFETTO_DIR/out/ui/ui/dist" ] && [ ! -d "$PERFETTO_DIR/out/ui/dist" ]; then
    echo "ERROR: Frontend build artifacts not found. Run without --quick first."
    exit 1
  fi
  if [ ! -d "$PROJECT_ROOT/backend/dist" ]; then
    echo "ERROR: Backend build artifacts not found. Run without --quick first."
    exit 1
  fi
fi

# Start backend
echo "Starting backend..."
cd "$PROJECT_ROOT/backend"
start_with_logs BACKEND_PID "BACKEND" "$BACKEND_LOG" npm run dev

# Wait for backend to start and verify health
echo "Waiting for backend to start..."
BACKEND_READY=false
for i in {1..30}; do
  if curl -fsS http://localhost:3000/health >/dev/null 2>&1; then
    BACKEND_READY=true
    echo "Backend is ready! (took ${i}s)"
    break
  fi
  sleep 1
done

if [ "$BACKEND_READY" = false ]; then
  echo "WARNING: Backend health check failed after 30s. It may still be starting..."
fi

# Start frontend (uses Perfetto's bundled node via run-dev-server)
echo "Starting frontend..."
cd "$UI_DIR"
start_with_logs FRONTEND_PID "FRONTEND" "$FRONTEND_LOG" ./run-dev-server

# Wait for frontend to start and verify health
echo "Waiting for frontend to start..."
FRONTEND_READY=false
FRONTEND_VERSION=""
for i in {1..90}; do
  INDEX_HTML=$(curl -fsS http://localhost:10000/ 2>/dev/null || true)
  if [ -n "$INDEX_HTML" ]; then
    FRONTEND_VERSION=$(extract_frontend_version "$INDEX_HTML" || true)
    if [ -n "$FRONTEND_VERSION" ] && is_frontend_bundle_ready "$FRONTEND_VERSION"; then
      FRONTEND_READY=true
      echo "Frontend is ready! (took ${i}s, version: $FRONTEND_VERSION)"
      break
    fi
  fi
  sleep 1
done

if [ "$FRONTEND_READY" = false ]; then
  echo "WARNING: Frontend readiness check failed after 90s. It may still be building..."
  echo "         If browser shows 'Unexpected end of input', try hard refresh (Ctrl+Shift+R)"
  echo "         and disable browser extensions on localhost before retrying."
fi

echo ""
echo "=============================================="
echo "Services started!"
echo "Backend PID:  $BACKEND_PID $([ "$BACKEND_READY" = true ] && echo "✅" || echo "⏳")"
echo "Frontend PID: $FRONTEND_PID $([ "$FRONTEND_READY" = true ] && echo "✅" || echo "⏳")"
echo ""
echo "URLs:"
echo "  Perfetto UI: http://localhost:10000"
echo "  Backend API: http://localhost:3000"
echo ""
echo "Logs:"
echo "  tail -f $BACKEND_LOG"
echo "  tail -f $FRONTEND_LOG"
echo "  tail -f $COMBINED_LOG"
echo ""
echo "Quick commands:"
echo "  ./scripts/start-dev.sh --quick   # Restart without rebuild"
echo "  ./scripts/start-dev.sh --clean   # Clean old logs"
echo "=============================================="

# Create symlinks to latest logs
ln -sf "$BACKEND_LOG" "$LOGS_DIR/backend_latest.log"
ln -sf "$FRONTEND_LOG" "$LOGS_DIR/frontend_latest.log"
ln -sf "$COMBINED_LOG" "$LOGS_DIR/combined_latest.log"

# Write PID file for easy process management
echo "$BACKEND_PID" > "$PROJECT_ROOT/.backend.pid"
echo "$FRONTEND_PID" > "$PROJECT_ROOT/.frontend.pid"

# Wait for both processes
wait