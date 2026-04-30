#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Update pre-built frontend after modifying the AI Assistant plugin.
#
# Run this after ./scripts/start-dev.sh has compiled the frontend and
# you have verified your changes in the browser.
#
# Usage:
#   ./scripts/update-frontend.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/perfetto/out/ui/ui/dist"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

# Find the versioned dist directory
VERSION_DIR=$(find "$DIST_DIR" -maxdepth 1 -type d -name 'v54.0-*' -print -quit 2>/dev/null || true)
if [ -z "$VERSION_DIR" ]; then
  echo "ERROR: No compiled frontend found at $DIST_DIR"
  echo "       Run ./scripts/start-dev.sh first to build the frontend."
  exit 1
fi

VERSION=$(basename "$VERSION_DIR")
echo "Found compiled frontend: $VERSION"
echo "Updating frontend/ ..."

# Copy top-level files
cp "$DIST_DIR/index.html"          "$FRONTEND_DIR/index.html"
cp "$DIST_DIR/service_worker.js"   "$FRONTEND_DIR/service_worker.js" 2>/dev/null || true

# Sync versioned directory (exclude source maps to keep repo lean)
rsync -a --delete \
  --exclude="*.map" \
  "$VERSION_DIR/" \
  "$FRONTEND_DIR/$VERSION/"

echo "✅ frontend/ updated to $VERSION"
echo ""
echo "Next steps:"
echo "  git add frontend/"
echo "  git commit -m 'chore(frontend): update prebuilt to $VERSION'"
