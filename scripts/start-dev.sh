#!/bin/bash
# SmartPerfetto Development Startup Script
# Starts both backend and frontend with persistent logging

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$PROJECT_ROOT/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Create logs directory
mkdir -p "$LOGS_DIR"

# Log file names
BACKEND_LOG="$LOGS_DIR/backend_${TIMESTAMP}.log"
FRONTEND_LOG="$LOGS_DIR/frontend_${TIMESTAMP}.log"
COMBINED_LOG="$LOGS_DIR/combined_${TIMESTAMP}.log"

echo "=============================================="
echo "SmartPerfetto Development Server"
echo "=============================================="
echo "Timestamp: $TIMESTAMP"
echo "Backend log:  $BACKEND_LOG"
echo "Frontend log: $FRONTEND_LOG"
echo "Combined log: $COMBINED_LOG"
echo "=============================================="

# Kill existing processes on ports 3000 and 10000
echo "Stopping existing processes..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:10000 | xargs kill -9 2>/dev/null || true
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

# Start backend
echo "Starting backend..."
cd "$PROJECT_ROOT/backend"
npm run dev 2>&1 | tee "$BACKEND_LOG" | sed 's/^/[BACKEND] /' | tee -a "$COMBINED_LOG" &
BACKEND_PID=$!

# Wait for backend to start
sleep 3

# Start frontend
echo "Starting frontend..."
cd "$PROJECT_ROOT/perfetto/ui"
./run-dev-server 2>&1 | tee "$FRONTEND_LOG" | sed 's/^/[FRONTEND] /' | tee -a "$COMBINED_LOG" &
FRONTEND_PID=$!

echo ""
echo "=============================================="
echo "Services started!"
echo "Backend PID:  $BACKEND_PID"
echo "Frontend PID: $FRONTEND_PID"
echo ""
echo "URLs:"
echo "  Perfetto UI: http://localhost:10000"
echo "  Backend API: http://localhost:3000"
echo ""
echo "Logs:"
echo "  tail -f $BACKEND_LOG"
echo "  tail -f $FRONTEND_LOG"
echo "  tail -f $COMBINED_LOG"
echo "=============================================="

# Create symlinks to latest logs
ln -sf "$BACKEND_LOG" "$LOGS_DIR/backend_latest.log"
ln -sf "$FRONTEND_LOG" "$LOGS_DIR/frontend_latest.log"
ln -sf "$COMBINED_LOG" "$LOGS_DIR/combined_latest.log"

# Wait for both processes
wait
