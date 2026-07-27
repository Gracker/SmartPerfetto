#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Quick backend-only restart (no frontend rebuild)
# Use this when you need to force-restart the backend without touching the frontend.
#
# Most backend changes DON'T need this — tsx watch auto-restarts on file save.
# Use this only for: .env changes, npm install, or if tsx watch gets stuck.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
NODE_ENV_HELPERS="$PROJECT_ROOT/scripts/node-env.sh"
SERVICE_PORT_HELPERS="$PROJECT_ROOT/scripts/service-ports.sh"
SERVICE_LIFECYCLE_HELPERS="$PROJECT_ROOT/scripts/service-lifecycle.sh"
DETACHED_PROCESS_LAUNCHER="$PROJECT_ROOT/scripts/launch-detached.mjs"
# shellcheck source=scripts/node-env.sh
. "$NODE_ENV_HELPERS"
# shellcheck source=scripts/service-ports.sh
. "$SERVICE_PORT_HELPERS"
# shellcheck source=scripts/service-lifecycle.sh
. "$SERVICE_LIFECYCLE_HELPERS"

smartperfetto_ensure_node "$PROJECT_ROOT"
for required_command in curl lsof pgrep; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "ERROR: required command '$required_command' is not installed." >&2
    exit 1
  fi
done
BACKEND_PORT="$(smartperfetto_resolve_backend_port)"
FRONTEND_PORT="$(smartperfetto_resolve_frontend_port)"
FRONTEND_URL="$(smartperfetto_env_value FRONTEND_URL)"
FRONTEND_URL="${FRONTEND_URL:-$(smartperfetto_loopback_url "$FRONTEND_PORT")}"
BACKEND_HEALTH_URL="$(smartperfetto_loopback_url "$BACKEND_PORT" "/health")"
BACKEND_PID_FILE="$PROJECT_ROOT/.backend.pid"
BACKEND_CWD="$PROJECT_ROOT/backend"

# Stop only a backend previously recorded by this repository launcher.
echo "Stopping backend..."
smartperfetto_stop_owned_pid_file \
  "$BACKEND_PID_FILE" "backend" "$PROJECT_ROOT" "$BACKEND_CWD"
smartperfetto_assert_port_available "$BACKEND_PORT" "backend"

smartperfetto_ensure_backend_deps "$PROJECT_ROOT"

# Start backend with tsx watch (hot-reload enabled)
echo "Starting backend (tsx watch — auto-reloads on file changes)..."
cd "$PROJECT_ROOT/backend"

LOGS_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOGS_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKEND_LOG="$LOGS_DIR/backend_${TIMESTAMP}.log"

# Launch into a separate process group with closed stdin. This keeps the watcher
# alive after both interactive terminals and headless command runners return.
NEW_PID=$(
  PORT="$BACKEND_PORT" \
  SMARTPERFETTO_BACKEND_PORT="$BACKEND_PORT" \
  SMARTPERFETTO_FRONTEND_PORT="$FRONTEND_PORT" \
  FRONTEND_URL="$FRONTEND_URL" \
  SMARTPERFETTO_LOCK_SERVICE_PORTS=1 \
  node "$DETACHED_PROCESS_LAUNCHER" \
    --cwd "$BACKEND_CWD" --log "$BACKEND_LOG" -- npm run dev
)
BACKEND_GENERATION="$(smartperfetto_new_launch_generation backend)"
if ! smartperfetto_write_pid_file \
  "$BACKEND_PID_FILE" "$NEW_PID" "backend" "$PROJECT_ROOT" "$BACKEND_CWD" "$BACKEND_GENERATION"; then
  smartperfetto_terminate_process_tree "$NEW_PID" "backend"
  exit 1
fi
ln -sf "$BACKEND_LOG" "$LOGS_DIR/backend_latest.log"

# Wait for health check
echo "Waiting for backend..."
if ! smartperfetto_wait_for_http \
  "$NEW_PID" "Backend" "$BACKEND_HEALTH_URL" 15 "$BACKEND_LOG"; then
  smartperfetto_terminate_process_tree "$NEW_PID" "backend"
  smartperfetto_remove_pid_file_if_generation "$BACKEND_PID_FILE" "$BACKEND_GENERATION"
  exit 1
fi

echo "Backend ready! PID: $NEW_PID"
echo "Log: $BACKEND_LOG"
echo ""
echo "tsx watch is active — backend auto-restarts on .ts file changes."
