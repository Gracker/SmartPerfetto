#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# SmartPerfetto Frontend Development Script
# Builds Perfetto UI from source (requires perfetto submodule) + starts backend with watch.
# Use this when modifying the AI Assistant plugin code (ai_panel.ts, styles.scss, etc.)
#
# For regular use (no submodule needed), run: ./start.sh
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
BUILD_FROM_SOURCE=false
PREBUILT_ONLY=false
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
    tee -a "$log_file" | sed -u "s/^/[$tag] /" | tee -a "$COMBINED_LOG"
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
  pkill -f "$PROJECT_ROOT/backend/node_modules/.bin/tsx watch src/index.ts" 2>/dev/null || true
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
    --build-from-source|--no-prebuilt)
      BUILD_FROM_SOURCE=true
      ;;
    --prebuilt-only)
      PREBUILT_ONLY=true
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --quick, -q             Skip build, just start services"
      echo "  --clean, -c             Clean old logs (keep last 10) before starting"
      echo "  --build-from-source     Skip prebuilt trace_processor_shell, build from source"
      echo "                          (alias: --no-prebuilt; env: TRACE_PROCESSOR_PREBUILT=0)"
      echo "  --prebuilt-only         Refuse to fall back to source build if prebuilt fails"
      echo "  --help, -h              Show this help message"
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

if [ "$BUILD_FROM_SOURCE" = true ] && [ "$PREBUILT_ONLY" = true ]; then
  echo "ERROR: --build-from-source and --prebuilt-only are mutually exclusive."
  exit 1
fi

# Create logs directory
mkdir -p "$LOGS_DIR"

# Clean old logs if requested (keep last 10 of each type)
if [ "$CLEAN_LOGS" = true ]; then
  echo "Cleaning old log files (keeping last 10)..."
  for prefix in backend frontend combined; do
    find "$LOGS_DIR" -maxdepth 1 -type f -name "${prefix}_*.log" -print 2>/dev/null \
      | sort -r \
      | tail -n +11 \
      | while IFS= read -r old_log; do
          rm -f "$old_log"
        done
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

# Verify Perfetto's bundled tools exist (required for frontend dev mode)
if [ ! -x "$PERFETTO_PNPM" ]; then
  echo "ERROR: Perfetto's bundled pnpm not found at $PERFETTO_PNPM"
  echo "       Is the perfetto submodule initialized? Try: git submodule update --init --recursive"
  echo ""
  echo "  TIP: For regular use without submodule, run: ./start.sh"
  exit 1
fi
if [ ! -x "$PERFETTO_NODE" ]; then
  echo "ERROR: Perfetto's bundled node not found at $PERFETTO_NODE"
  echo "       Is the perfetto submodule initialized? Try: git submodule update --init --recursive"
  echo ""
  echo "  TIP: For regular use without submodule, run: ./start.sh"
  exit 1
fi
if [ ! -x "$UI_DIR/run-dev-server" ]; then
  echo "ERROR: frontend runner not found at $UI_DIR/run-dev-server"
  echo "       Sync the perfetto submodule and ensure scripts are executable."
  echo ""
  echo "  TIP: For regular use without submodule, run: ./start.sh"
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
# - index.html responds 200 and exposes the current version directory
# - local versioned frontend_bundle.js exists and is reasonably large
# - versioned manifest.json responds 200, proving the HTTP server is serving
#   the same dist directory without downloading the 20MB+ frontend bundle
is_frontend_bundle_ready() {
  local version="$1"
  local bundle_file=""
  local manifest_url="http://localhost:10000/$version/manifest.json"

  for candidate in \
    "$PERFETTO_DIR/out/ui/ui/dist/$version/frontend_bundle.js" \
    "$PERFETTO_DIR/out/ui/dist/$version/frontend_bundle.js"; do
    if [ -f "$candidate" ]; then
      bundle_file="$candidate"
      break
    fi
  done

  if [ -z "$bundle_file" ]; then
    return 1
  fi

  local size
  size=$(wc -c < "$bundle_file" 2>/dev/null || echo 0)
  if [ "${size:-0}" -lt 5000000 ]; then
    return 1
  fi

  if ! curl -fsS -o /dev/null "$manifest_url" 2>/dev/null; then
    return 1
  fi

  return 0
}

# Ensure Perfetto's C++ build toolchain (gn, ninja, clang, sysroot) is on disk.
# tools/gn and tools/ninja are Python wrappers around hermetic prebuilts that
# tools/install-build-deps fetches from storage.googleapis.com/perfetto/ into
# either third_party/<tool>/<tool> or buildtools/<os>/<tool>. The submodule
# itself does NOT carry the binaries, so first-run users hit FileNotFoundError
# from os.execl() inside run_buildtools_binary.py if we skip this step.
ensure_cpp_toolchain() (
  # Subshell: cd here does not leak to caller's cwd.
  cd "$PERFETTO_DIR"

  sys_dir=""
  case "$(uname -s)" in
    Darwin) sys_dir="mac" ;;
    Linux)  sys_dir="linux64" ;;
    *)
      echo "WARNING: Unsupported OS '$(uname -s)' for trace_processor_shell build"
      sys_dir="unknown"
      ;;
  esac

  gn_ok=false
  ninja_ok=false
  if [ -x "third_party/gn/gn" ] || [ -x "buildtools/${sys_dir}/gn" ]; then
    gn_ok=true
  fi
  if [ -x "third_party/ninja/ninja" ] || [ -x "buildtools/${sys_dir}/ninja" ]; then
    ninja_ok=true
  fi

  if [ "$gn_ok" = true ] && [ "$ninja_ok" = true ]; then
    return 0
  fi

  echo "C++ build toolchain not found (gn_ok=$gn_ok, ninja_ok=$ninja_ok)."
  echo "Running tools/install-build-deps to fetch gn / ninja / clang / sysroot..."
  if ! tools/install-build-deps 2>&1 | tee -a "$BACKEND_LOG"; then
    echo "=============================================="
    echo "ERROR: tools/install-build-deps failed."
    echo ""
    echo "Possible causes:"
    echo "  - Network blocked from storage.googleapis.com (try a proxy / VPN)"
    echo "  - Disk full (toolchain + sysroot needs ~1 GB free)"
    echo "  - python3 missing"
    echo ""
    echo "Tip: re-run without --build-from-source to use the version-pinned"
    echo "     LUCI prebuilt (scripts/trace-processor-pin.env)."
    echo "=============================================="
    return 1
  fi
)

# Try to download a prebuilt trace_processor_shell from Perfetto's LUCI artifacts
# (version-pinned via scripts/trace-processor-pin.env, SHA256-verified).
# Returns 0 on success, non-zero on any failure (caller falls back to source build).
download_trace_processor_prebuilt() {
  local dest="$1"
  local os arch platform expected_sha url tmp actual_sha rc

  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux)  os=linux ;;
    *) echo "Prebuilt: unsupported OS '$(uname -s)'"; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "Prebuilt: unsupported arch '$(uname -m)'"; return 1 ;;
  esac
  platform="${os}-${arch}"

  local pin_file="$PROJECT_ROOT/scripts/trace-processor-pin.env"
  if [ ! -f "$pin_file" ]; then
    echo "Prebuilt: pin file not found at $pin_file"
    return 1
  fi
  # shellcheck disable=SC1090
  . "$pin_file"

  case "$platform" in
    linux-amd64) expected_sha="${PERFETTO_SHELL_SHA256_LINUX_AMD64:-}" ;;
    linux-arm64) expected_sha="${PERFETTO_SHELL_SHA256_LINUX_ARM64:-}" ;;
    mac-amd64)   expected_sha="${PERFETTO_SHELL_SHA256_MAC_AMD64:-}" ;;
    mac-arm64)   expected_sha="${PERFETTO_SHELL_SHA256_MAC_ARM64:-}" ;;
  esac
  if [ -z "$expected_sha" ]; then
    echo "Prebuilt: pin file missing SHA256 for $platform"
    return 1
  fi

  url="${PERFETTO_LUCI_URL_BASE}/${PERFETTO_VERSION}/${platform}/trace_processor_shell"
  tmp=$(mktemp -t trace_processor_shell.XXXXXX) || return 1

  echo "Prebuilt: downloading ${platform} ${PERFETTO_VERSION}..."
  rc=0
  curl -fL --max-time 60 -o "$tmp" "$url" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "Prebuilt: download failed (curl exit $rc)."
    rm -f "$tmp"
    return 1
  fi

  actual_sha=$(hash_sha256 "$tmp")
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "Prebuilt: SHA256 MISMATCH (security warning)"
    echo "  expected: $expected_sha"
    echo "  actual:   $actual_sha"
    rm -f "$tmp"
    return 1
  fi

  chmod +x "$tmp"
  if ! "$tmp" --version >/dev/null 2>&1; then
    echo "Prebuilt: --version smoke test failed (binary may be incompatible with this host)"
    rm -f "$tmp"
    return 1
  fi

  if ! mkdir -p "$(dirname "$dest")"; then
    echo "Prebuilt: mkdir -p $(dirname "$dest") failed."
    rm -f "$tmp"
    return 1
  fi
  if ! mv "$tmp" "$dest"; then
    echo "Prebuilt: mv to $dest failed (permissions / disk full?)"
    rm -f "$tmp"
    return 1
  fi
  echo "Prebuilt: ✅ verified ${platform} ${PERFETTO_VERSION} → $dest"
  return 0
}

# Build trace_processor_shell from source. Wrapper around the existing
# install-build-deps + tools/gn gen + tools/ninja flow.
build_trace_processor_from_source() {
  if ! ensure_cpp_toolchain; then
    return 1
  fi

  cd "$PERFETTO_DIR"

  if [ ! -f "out/ui/build.ninja" ]; then
    echo "Generating build configuration..."
    tools/gn gen out/ui --args='is_debug=false'
  fi

  echo "Compiling trace_processor_shell from source (this may take a few minutes)..."
  if ! tools/ninja -C out/ui trace_processor_shell; then
    echo "=============================================="
    echo "ERROR: Failed to build trace_processor_shell from source"
    echo ""
    echo "You can try building manually:"
    echo "  cd $PERFETTO_DIR"
    echo "  tools/ninja -C out/ui trace_processor_shell"
    echo "=============================================="
    cd "$PROJECT_ROOT"
    return 1
  fi

  echo "trace_processor_shell: built from source"
  cd "$PROJECT_ROOT"
  return 0
}

# Acquire trace_processor_shell at $dest. Order:
#   1. If $dest already exists → reuse (pinned-local-artifact).
#   2. Try prebuilt download (unless opted out).
#   3. Fall back to source build (unless --prebuilt-only).
fetch_or_build_trace_processor() {
  local dest="$1"

  if [ -f "$dest" ]; then
    echo "trace_processor_shell found: $dest"
    return 0
  fi

  echo "=============================================="
  echo "trace_processor_shell not found. Acquiring..."
  echo "=============================================="

  local skip_prebuilt=false
  if [ "$BUILD_FROM_SOURCE" = true ] || [ "${TRACE_PROCESSOR_PREBUILT:-1}" = "0" ]; then
    skip_prebuilt=true
    echo "Prebuilt: skipped (--build-from-source or TRACE_PROCESSOR_PREBUILT=0)"
  fi

  if [ "$skip_prebuilt" = false ]; then
    if download_trace_processor_prebuilt "$dest"; then
      return 0
    fi
    if [ "$PREBUILT_ONLY" = true ]; then
      echo "ERROR: --prebuilt-only set; refusing to fall back to source build."
      return 1
    fi
    echo "Falling back to source build..."
  fi

  build_trace_processor_from_source
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
pkill -f "$PROJECT_ROOT/backend/node_modules/.bin/tsx watch src/index.ts" 2>/dev/null || true
pkill -f "tsc.*perfetto.*watch" 2>/dev/null || true
pkill -f "rollup.*perfetto.*watch" 2>/dev/null || true
pkill -f "node.*perfetto/ui/build.js" 2>/dev/null || true

# Kill orphan trace_processor_shell processes (except the one we'll use)
echo "Cleaning up orphan trace_processor_shell processes..."
pkill -f "trace_processor_shell.*httpd" 2>/dev/null || true
sleep 1

# Acquire trace_processor_shell. Default = download version-pinned prebuilt
# from Perfetto's LUCI artifacts (SHA256-verified, ~5s); fall back to source
# build if download / verification / smoke test fails. Pin source of truth:
# scripts/trace-processor-pin.env. Use --build-from-source or
# TRACE_PROCESSOR_PREBUILT=0 to skip prebuilt; --prebuilt-only to disable
# the fallback. The binary is then treated as a pinned local artifact —
# delete it to re-acquire after a perfetto submodule upgrade.
TRACE_PROCESSOR="$PERFETTO_DIR/out/ui/trace_processor_shell"
if ! fetch_or_build_trace_processor "$TRACE_PROCESSOR"; then
  exit 1
fi

"$TRACE_PROCESSOR" --version | head -n 1 || true

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

# Start frontend (Perfetto run-dev-server with watch mode)
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
