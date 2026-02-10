#!/bin/bash
# SmartPerfetto Development Startup Script
# Starts both backend and frontend with persistent logging
#
# Usage:
#   ./start-dev.sh           # Full build and start
#   ./start-dev.sh --quick   # Skip build, just start services
#   ./start-dev.sh --clean   # Clean old logs before starting

set -e
set -o pipefail  # 【S1 Fix】确保管道中的命令失败能被正确检测

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$PROJECT_ROOT/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
SKIP_BUILD=false
CLEAN_LOGS=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --quick|-q)
      SKIP_BUILD=true
      shift
      ;;
    --clean|-c)
      CLEAN_LOGS=true
      shift
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
  esac
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
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required but not installed."; exit 1; }

# Verify Perfetto's bundled tools exist
if [ ! -f "$PERFETTO_PNPM" ]; then
  echo "ERROR: Perfetto's bundled pnpm not found at $PERFETTO_PNPM"
  echo "       Is the perfetto submodule initialized? Try: git submodule update --init"
  exit 1
fi

# Validate UI lockfile format (must be pnpm v8 / lockfileVersion '6.0')
validate_ui_lockfile() {
  local lockfile="$UI_DIR/pnpm-lock.yaml"
  if [ ! -f "$lockfile" ]; then
    echo "ERROR: UI lockfile not found at $lockfile"
    return 1
  fi
  local version
  version=$(head -1 "$lockfile" | grep -o "'[^']*'" | tr -d "'")
  if [ "$version" != "6.0" ]; then
    echo "=============================================="
    echo "ERROR: UI pnpm-lock.yaml has incompatible format!"
    echo "  Found: lockfileVersion '$version'"
    echo "  Expected: lockfileVersion '6.0' (pnpm v8)"
    echo ""
    echo "  This usually happens when you run 'pnpm install' with a"
    echo "  system-installed pnpm (v9/v10) instead of Perfetto's bundled pnpm v8."
    echo ""
    echo "  Fix: git checkout -- ui/pnpm-lock.yaml"
    echo "  Then re-run this script."
    echo "=============================================="
    return 1
  fi
  return 0
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
    echo "  1. Restore lockfile: git checkout -- ui/pnpm-lock.yaml"
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

# 【S4 Fix】Ensure data directories exist
mkdir -p "$PROJECT_ROOT/backend/data/sessions"

# Cleanup function for graceful exit
cleanup() {
  echo ""
  echo "Shutting down services..."
  [ -n "$BACKEND_PID" ] && kill $BACKEND_PID 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill $FRONTEND_PID 2>/dev/null || true

  # Clean up any child processes
  pkill -f "tsc.*perfetto.*watch" 2>/dev/null || true
  pkill -f "rollup.*perfetto.*watch" 2>/dev/null || true
  pkill -f "node.*perfetto/ui/build.js" 2>/dev/null || true

  # Remove PID files
  rm -f "$PROJECT_ROOT/.backend.pid" "$PROJECT_ROOT/.frontend.pid" 2>/dev/null || true

  echo "Cleanup complete."
  exit 0
}

# Trap Ctrl+C and other termination signals
trap cleanup SIGINT SIGTERM

# Kill existing processes on ports 3000 and 10000
echo "Stopping existing processes..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:10000 | xargs kill -9 2>/dev/null || true

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
  # Generate skill types (YAML -> TypeScript)
  echo "Generating skill types..."
  cd "$PROJECT_ROOT/backend"
  npm run generate-types 2>&1 | tee -a "$BACKEND_LOG" || echo "Warning: Skill type generation failed, continuing..."
  npm run sync-types 2>&1 | tee -a "$BACKEND_LOG" || echo "Warning: Type sync failed, continuing..."

  # Generate frontend types from data contract
  echo "Generating frontend types from data contract..."
  npm run generate:frontend-types 2>&1 | tee -a "$BACKEND_LOG" || echo "Warning: Frontend type generation failed, continuing..."

  # Build backend
  echo "Building backend..."
  cd "$PROJECT_ROOT/backend"
  npm run build 2>&1 | tee -a "$BACKEND_LOG"
  if [ $? -ne 0 ]; then
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
  if [ ! -f "$UI_DIR/node_modules/.last_install" ]; then
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
npm run dev 2>&1 | tee "$BACKEND_LOG" | sed 's/^/[BACKEND] /' | tee -a "$COMBINED_LOG" &
BACKEND_PID=$!

# Wait for backend to start and verify health
echo "Waiting for backend to start..."
BACKEND_READY=false
for i in {1..30}; do
  if curl -s http://localhost:3000/health >/dev/null 2>&1; then
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
./run-dev-server 2>&1 | tee "$FRONTEND_LOG" | sed 's/^/[FRONTEND] /' | tee -a "$COMBINED_LOG" &
FRONTEND_PID=$!

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
