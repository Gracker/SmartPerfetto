#!/bin/bash
# SmartPerfetto Development Startup Script
# Starts both backend and frontend with persistent logging
#
# Usage:
#   ./start-dev.sh           # Full build and start
#   ./start-dev.sh --quick   # Skip build, just start services
#   ./start-dev.sh --clean   # Clean old logs before starting

set -e

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

# Environment check
echo "Checking environment..."
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required but not installed."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm is required but not installed."; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required but not installed."; exit 1; }

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
TRACE_PROCESSOR="$PROJECT_ROOT/perfetto/out/ui/trace_processor_shell"
if [ ! -f "$TRACE_PROCESSOR" ]; then
  echo "=============================================="
  echo "trace_processor_shell not found. Building..."
  echo "=============================================="

  cd "$PROJECT_ROOT/perfetto"

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
    echo "  cd $PROJECT_ROOT/perfetto"
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
  npm run types 2>&1 | tee -a "$BACKEND_LOG" || echo "Warning: Type generation failed, continuing..."

  # Build backend
  echo "Building backend..."
  cd "$PROJECT_ROOT/backend"
  npm run build 2>&1 | tee -a "$BACKEND_LOG"
  if [ $? -ne 0 ]; then
    echo "Backend build failed!"
    exit 1
  fi

  # Update UI build dependencies (needed after git sync from upstream)
  echo "Checking UI build dependencies..."
  cd "$PROJECT_ROOT/perfetto"
  if ! tools/install-build-deps --ui 2>&1 | tee -a "$FRONTEND_LOG"; then
    echo "Warning: install-build-deps failed, trying to continue..."
  fi

  # Build frontend
  echo "Building frontend..."
  cd "$PROJECT_ROOT/perfetto/ui"
  node build.js 2>&1 | tee -a "$FRONTEND_LOG"
  if [ $? -ne 0 ]; then
    echo "Frontend build failed!"
    exit 1
  fi
else
  echo "Skipping build (--quick mode)..."
  # Verify that build artifacts exist
  if [ ! -d "$PROJECT_ROOT/perfetto/out/ui/dist" ]; then
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

# Start frontend
echo "Starting frontend..."
cd "$PROJECT_ROOT/perfetto/ui"
./run-dev-server 2>&1 | tee "$FRONTEND_LOG" | sed 's/^/[FRONTEND] /' | tee -a "$COMBINED_LOG" &
FRONTEND_PID=$!

# Wait for frontend to start and verify health
echo "Waiting for frontend to start..."
FRONTEND_READY=false
for i in {1..60}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:10000 2>/dev/null | grep -q "200"; then
    FRONTEND_READY=true
    echo "Frontend is ready! (took ${i}s)"
    break
  fi
  sleep 1
done

if [ "$FRONTEND_READY" = false ]; then
  echo "WARNING: Frontend health check failed after 60s. It may still be building..."
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
