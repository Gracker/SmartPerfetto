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
#   ./start-dev.sh           # Full UI/wasm build and start
#   ./start-dev.sh --quick   # Skip compilation; still verify canonical deps
#   ./start-dev.sh --clean   # Clean old logs before starting

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
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
SKIP_BUILD=false
CLEAN_LOGS=false
BUILD_FROM_SOURCE=false
PREBUILT_ONLY=false
BACKEND_PID=""
FRONTEND_PID=""
BACKEND_PORT=""
FRONTEND_PORT=""
BACKEND_URL=""
FRONTEND_URL=""
BACKEND_GENERATION=""
FRONTEND_GENERATION=""
BACKEND_CWD="$PROJECT_ROOT/backend"
FRONTEND_CWD="$PROJECT_ROOT/perfetto/ui"
FRONTEND_SOURCE_CWD="$PROJECT_ROOT/frontend"
BACKEND_PID_FILE="$PROJECT_ROOT/.backend.pid"
FRONTEND_PID_FILE="$PROJECT_ROOT/.frontend.pid"

smartperfetto_init_service_ports

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
  echo "Then re-run the script and choose Open if macOS asks again."
  echo ""
  echo "For a binary you trust, you can also remove the quarantine attribute:"
  echo "  xattr -dr com.apple.quarantine \"$path\""
  echo "  chmod +x \"$path\""
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
      echo "  --quick, -q             Skip compilation; still verify/install canonical UI deps"
      echo "  --clean, -c             Clean old logs (keep last 10) before starting"
      echo "  --build-from-source     Skip prebuilt trace_processor_shell, build from source"
      echo "                          (alias: --no-prebuilt; env: TRACE_PROCESSOR_PREBUILT=0)"
      echo "  --prebuilt-only         Refuse to fall back to source build if prebuilt fails"
      echo "  --help, -h              Show this help message"
      echo ""
      echo "Environment:"
      echo "  TRACE_PROCESSOR_PATH           Use an existing trace_processor_shell"
      echo "  TRACE_PROCESSOR_DOWNLOAD_BASE  Mirror base with Perfetto LUCI path layout"
      echo "  TRACE_PROCESSOR_DOWNLOAD_URL   Exact trace_processor_shell URL for this platform"
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
if [ "$PREBUILT_ONLY" = true ] && [ "${TRACE_PROCESSOR_PREBUILT:-1}" = "0" ]; then
  echo "ERROR: --prebuilt-only conflicts with TRACE_PROCESSOR_PREBUILT=0."
  exit 1
fi

smartperfetto_ensure_node "$PROJECT_ROOT"

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
echo "Mode: $([ "$SKIP_BUILD" = true ] && echo "Quick Start (skip compilation)" || echo "Full UI Build")"
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
require_command pgrep

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

ensure_trace_processor_path() {
  local path="$1"
  if [ ! -f "$path" ] || [ ! -x "$path" ]; then
    echo "ERROR: trace_processor_shell is not an executable file: $path" >&2
    return 1
  fi
  if ! "$path" --version >/dev/null 2>&1; then
    echo "ERROR: trace_processor_shell failed the --version smoke test: $path" >&2
    print_macos_trace_processor_permission_help "$path"
    return 1
  fi
}

resolve_trace_processor_pin() {
  local pin_file="$PROJECT_ROOT/scripts/trace-processor-pin.env"
  local os
  local arch
  if [ ! -f "$pin_file" ]; then
    echo "Prebuilt: pin file not found at $pin_file" >&2
    return 1
  fi
  # shellcheck source=scripts/trace-processor-pin.env
  . "$pin_file"

  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux) os=linux ;;
    *) echo "Prebuilt: unsupported OS '$(uname -s)'" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "Prebuilt: unsupported arch '$(uname -m)'" >&2; return 1 ;;
  esac
  TRACE_PROCESSOR_PLATFORM="${os}-${arch}"
  case "$TRACE_PROCESSOR_PLATFORM" in
    linux-amd64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_LINUX_AMD64:-}" ;;
    linux-arm64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_LINUX_ARM64:-}" ;;
    mac-amd64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_MAC_AMD64:-}" ;;
    mac-arm64) TRACE_PROCESSOR_EXPECTED_SHA="${PERFETTO_SHELL_SHA256_MAC_ARM64:-}" ;;
  esac
  if [ -z "$TRACE_PROCESSOR_EXPECTED_SHA" ]; then
    echo "Prebuilt: pin file missing SHA256 for $TRACE_PROCESSOR_PLATFORM" >&2
    return 1
  fi
}

verify_pinned_trace_processor() {
  local path="$1"
  local actual_sha
  resolve_trace_processor_pin || return 1
  [ -f "$path" ] || return 1
  actual_sha=$(hash_sha256 "$path")
  if [ "$actual_sha" != "$TRACE_PROCESSOR_EXPECTED_SHA" ]; then
    echo "Prebuilt: cached binary does not match the pinned SHA: $path" >&2
    return 1
  fi
  ensure_trace_processor_path "$path"
}

# Extract frontend version directory from Perfetto index.html
# e.g. data-perfetto_version='{"stable":"v53.0-xxxx"}'
# shellcheck disable=SC2317,SC2329 # Invoked through is_dev_frontend_ready.
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
# - versioned manifest.json responds 200, proving the HTTP server is serving
#   the generated dist directory
# - Vite can transform the frontend TypeScript entry, proving its in-memory
#   development server completed the first build
# shellcheck disable=SC2317,SC2329 # Invoked through is_dev_frontend_ready.
is_frontend_runtime_ready() {
  local version="$1"
  local manifest_url="http://localhost:$FRONTEND_PORT/$version/manifest.json"
  if ! curl -fsS -o /dev/null "$manifest_url" 2>/dev/null; then
    return 1
  fi
  curl -fsS -o /dev/null \
    "http://localhost:$FRONTEND_PORT/frontend/index.ts" 2>/dev/null
}

# shellcheck disable=SC2317,SC2329 # Passed as a readiness predicate.
is_dev_frontend_ready() {
  local index_html
  local version
  index_html=$(curl -fsS "http://localhost:$FRONTEND_PORT/" 2>/dev/null || true)
  [ -n "$index_html" ] || return 1
  version=$(extract_frontend_version "$index_html" || true)
  [ -n "$version" ] || return 1
  is_frontend_runtime_ready "$version" || return 1
  FRONTEND_VERSION="$version"
}

# Ensure Perfetto's C++ build toolchain (gn, ninja, clang, sysroot) is on disk.
# tools/gn and tools/ninja are Python wrappers around hermetic prebuilts that
# tools/install-build-deps fetches from storage.googleapis.com/perfetto/ into
# either third_party/<tool>/<tool> or buildtools/<os>/<tool>. The submodule
# itself does NOT carry the binaries, so first-run users hit FileNotFoundError
# from os.execl() inside run_buildtools_binary.py if we skip this step.
ensure_cpp_toolchain() (
  cd "$PERFETTO_DIR"
  echo "Checking/installing Perfetto C++ build dependencies..."
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
  local url tmp actual_sha rc
  resolve_trace_processor_pin || return 1

  local url_base="${TRACE_PROCESSOR_DOWNLOAD_BASE:-${PERFETTO_LUCI_URL_BASE}}"
  url="${TRACE_PROCESSOR_DOWNLOAD_URL:-${url_base%/}/${PERFETTO_VERSION}/${TRACE_PROCESSOR_PLATFORM}/trace_processor_shell}"
  tmp=$(mktemp -t trace_processor_shell.XXXXXX) || return 1

  echo "Prebuilt: downloading ${TRACE_PROCESSOR_PLATFORM} ${PERFETTO_VERSION}..."
  echo "Prebuilt: url ${url}"
  rc=0
  curl -fL --max-time 60 -o "$tmp" "$url" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "Prebuilt: download failed (curl exit $rc)."
    echo ""
    echo "Common fixes:"
    echo "  - Set TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell"
    echo "  - Set TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts"
    echo "  - Set TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell"
    echo "  - Use --build-from-source if the perfetto submodule and build deps are available"
    rm -f "$tmp"
    return 1
  fi

  actual_sha=$(hash_sha256 "$tmp")
  if [ "$actual_sha" != "$TRACE_PROCESSOR_EXPECTED_SHA" ]; then
    echo "Prebuilt: SHA256 MISMATCH (security warning)"
    echo "  expected: $TRACE_PROCESSOR_EXPECTED_SHA"
    echo "  actual:   $actual_sha"
    rm -f "$tmp"
    return 1
  fi

  chmod +x "$tmp"
  if ! "$tmp" --version >/dev/null 2>&1; then
    echo "Prebuilt: --version smoke test failed (binary may be incompatible with this host)"
    print_macos_trace_processor_permission_help "$tmp"
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
  echo "Prebuilt: ✅ verified ${TRACE_PROCESSOR_PLATFORM} ${PERFETTO_VERSION} → $dest"
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
  ensure_trace_processor_path "$PERFETTO_DIR/out/ui/trace_processor_shell"
}

# Acquire a pinned prebuilt at $dest, with an explicit source-build fallback.
# TRACE_PROCESSOR_RESULT records the actual selected path because source output
# lives under perfetto/out/ui rather than the downloaded cache.
fetch_or_build_trace_processor() {
  local dest="$1"
  TRACE_PROCESSOR_RESULT=""

  if [ -f "$dest" ]; then
    if verify_pinned_trace_processor "$dest"; then
      echo "trace_processor_shell pinned cache found: $dest"
      TRACE_PROCESSOR_RESULT="$dest"
      return 0
    fi
    echo "Removing invalid SmartPerfetto-managed trace processor cache."
    rm -f "$dest"
  fi

  echo "=============================================="
  echo "trace_processor_shell not found. Acquiring..."
  echo "=============================================="

  if [ "${TRACE_PROCESSOR_PREBUILT:-1}" != "0" ]; then
    if download_trace_processor_prebuilt "$dest"; then
      TRACE_PROCESSOR_RESULT="$dest"
      return 0
    fi
    if [ "$PREBUILT_ONLY" = true ]; then
      echo "ERROR: --prebuilt-only set; refusing to fall back to source build."
      return 1
    fi
    echo "Falling back to source build..."
  else
    echo "Prebuilt: skipped (TRACE_PROCESSOR_PREBUILT=0)"
  fi

  build_trace_processor_from_source || return 1
  TRACE_PROCESSOR_RESULT="$PERFETTO_DIR/out/ui/trace_processor_shell"
}

trace_processor_prebuilt_candidate() {
  local candidate=""
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64|Linux:amd64)
      candidate="$PROJECT_ROOT/backend/prebuilts/trace_processor/linux-x64/trace_processor_shell"
      ;;
    Darwin:arm64|Darwin:aarch64)
      candidate="$PROJECT_ROOT/backend/prebuilts/trace_processor/darwin-arm64/trace_processor_shell"
      ;;
  esac
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    echo "$candidate"
  else
    echo ""
  fi
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
    echo "  1. Resolve any tracked ui/pnpm-lock.yaml change against the current submodule commit."
    echo "  2. Clean reinstall: rm -rf ui/node_modules && re-run."
    echo "  3. NEVER use system pnpm for ui/. Always use Perfetto's tools/pnpm."
    echo "The launcher will not checkout or rewrite tracked source files for you."
    echo "=============================================="
    return 1
  fi
}

# 【S3 Fix】Check for .env file
if [ ! -f "$PROJECT_ROOT/backend/.env" ]; then
  echo "=============================================="
  echo "NOTICE: backend/.env not found."
  echo "This is OK if Claude Code already works in this terminal."
  echo "For direct API, Docker, or a different provider:"
  echo "  cp backend/.env.example backend/.env"
  echo "=============================================="
fi

# Trap Ctrl+C and other termination signals
trap on_exit EXIT
trap 'cleanup 130' SIGINT SIGTERM

# Stop only a previous launcher-owned instance.
echo "Stopping existing processes..."
smartperfetto_stop_owned_pid_file \
  "$BACKEND_PID_FILE" "backend" "$PROJECT_ROOT" "$BACKEND_CWD"
smartperfetto_stop_owned_pid_file_for_allowed_cwds \
  "$FRONTEND_PID_FILE" "frontend" "$PROJECT_ROOT" "$FRONTEND_SOURCE_CWD" "$FRONTEND_CWD"
smartperfetto_assert_port_available "$BACKEND_PORT" "backend"
smartperfetto_assert_port_available "$FRONTEND_PORT" "frontend"

# Check/install backend dependencies after old watchers have been stopped.
# Native modules are tied to Node's ABI, so this also repairs node_modules
# after switching between Node 20/24/25.
smartperfetto_ensure_backend_deps "$PROJECT_ROOT"

# Acquire trace_processor_shell. Explicit paths are user-owned and are only
# smoke-tested. SmartPerfetto-owned prebuilt/cache paths must match the pin.
if [ -n "${TRACE_PROCESSOR_PATH:-}" ]; then
  TRACE_PROCESSOR="$TRACE_PROCESSOR_PATH"
  ensure_trace_processor_path "$TRACE_PROCESSOR" || exit 1
  TRACE_PROCESSOR="$(cd "$(dirname "$TRACE_PROCESSOR")" && pwd -P)/$(basename "$TRACE_PROCESSOR")"
  echo "trace_processor_shell found via TRACE_PROCESSOR_PATH: $TRACE_PROCESSOR"
elif [ "$BUILD_FROM_SOURCE" = true ] || [ "${TRACE_PROCESSOR_PREBUILT:-1}" = "0" ]; then
  echo "Building trace_processor_shell from the current Perfetto source..."
  build_trace_processor_from_source || exit 1
  TRACE_PROCESSOR="$PERFETTO_DIR/out/ui/trace_processor_shell"
else
  PREBUILT_TRACE_PROCESSOR="$(trace_processor_prebuilt_candidate)"
  TRACE_PROCESSOR=""
  if [ -n "$PREBUILT_TRACE_PROCESSOR" ] && verify_pinned_trace_processor "$PREBUILT_TRACE_PROCESSOR"; then
    TRACE_PROCESSOR="$PREBUILT_TRACE_PROCESSOR"
  fi
  if [ -z "$TRACE_PROCESSOR" ]; then
    TRACE_PROCESSOR_CACHE="$PROJECT_ROOT/backend/bin/trace_processor_shell"
    fetch_or_build_trace_processor "$TRACE_PROCESSOR_CACHE" || exit 1
    TRACE_PROCESSOR="$TRACE_PROCESSOR_RESULT"
  fi
fi

"$TRACE_PROCESSOR" --version | head -n 1 || true
export TRACE_PROCESSOR_PATH="$TRACE_PROCESSOR"

# Perfetto's installer is the canonical dependency check. It covers hermetic
# tools, UI node_modules, Python support, and test data; the old lockfile-only
# marker check could report "current" while run-dev-server still rejected the
# checkout. This runs in quick mode too because quick skips compilation, not
# dependency correctness.
echo "Checking/installing canonical Perfetto UI dependencies..."
install_ui_deps || exit 1

if [ "$SKIP_BUILD" = false ]; then
  # Launchers diagnose generated-contract drift but never rewrite tracked source.
  echo "Checking frontend types..."
  cd "$PROJECT_ROOT/backend"
  if npm run check:types 2>&1 | tee -a "$BACKEND_LOG"; then
    echo "Frontend types are already in sync."
  else
    echo "ERROR: Frontend generated types are out of sync."
    echo "Run: cd backend && npm run generate:frontend-types"
    echo "Review and commit the generated source change, then retry."
    exit 1
  fi

  # Build backend
  echo "Building backend..."
  cd "$PROJECT_ROOT/backend"
  if ! npm run build 2>&1 | tee -a "$BACKEND_LOG"; then
    echo "Backend build failed!"
    exit 1
  fi

  # Build frontend using Perfetto's build system
  echo "Building frontend..."
  cd "$PERFETTO_DIR"
  if ! "$PERFETTO_NODE" ui/build.mjs 2>&1 | tee -a "$FRONTEND_LOG"; then
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
  echo "Skipping compilation (--quick mode)..."
  # Verify that build artifacts exist
  # Perfetto UI build output lives under out/ui/ui/ (see ui/build.mjs ensureDir()).
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

# Wait for backend to start and verify health
echo "Waiting for backend to start..."
if ! smartperfetto_wait_for_http \
  "$BACKEND_PID" "Backend" "http://localhost:$BACKEND_PORT/health" 30 "$BACKEND_LOG"; then
  exit 1
fi

# Start frontend (Perfetto run-dev-server with watch mode)
echo "Starting frontend..."
cd "$UI_DIR"
FRONTEND_GENERATION="$(smartperfetto_new_launch_generation frontend)"
start_with_logs FRONTEND_PID "FRONTEND" "$FRONTEND_LOG" env \
  SMARTPERFETTO_BACKEND_PORT="$BACKEND_PORT" \
  SMARTPERFETTO_BACKEND_PUBLIC_PORT="$BACKEND_PUBLIC_PORT" \
  SMARTPERFETTO_BACKEND_PUBLIC_URL="$BACKEND_PUBLIC_URL" \
  SMARTPERFETTO_FRONTEND_PORT="$FRONTEND_PORT" \
  ./run-dev-server --serve-port "$FRONTEND_PORT"
if ! smartperfetto_write_pid_file \
  "$FRONTEND_PID_FILE" "$FRONTEND_PID" "frontend" "$PROJECT_ROOT" "$FRONTEND_CWD" "$FRONTEND_GENERATION"; then
  exit 1
fi

# Wait for frontend to start and verify health
echo "Waiting for frontend to start..."
FRONTEND_VERSION=""
if ! smartperfetto_wait_for_predicate \
  "$FRONTEND_PID" "Frontend" 90 "$FRONTEND_LOG" is_dev_frontend_ready; then
  exit 1
fi

echo ""
echo "=============================================="
echo "Services started!"
echo "Backend PID:  $BACKEND_PID ✅"
echo "Frontend PID: $FRONTEND_PID ✅"
echo "Frontend version: $FRONTEND_VERSION"
echo ""
echo "URLs:"
echo "  Perfetto UI: http://localhost:$FRONTEND_PORT"
echo "  Backend API: http://localhost:$BACKEND_PORT"
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

# Wait for either required service to exit, then fail and clean up the other.
set +e
smartperfetto_wait_for_services \
  "$BACKEND_PID" "Backend" "$FRONTEND_PID" "Frontend"
SERVICE_EXIT_CODE=$?
set -e
exit "$SERVICE_EXIT_CODE"
