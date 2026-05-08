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

inject_smartperfetto_static_assets() {
  local index_file="$1"
  if grep -q 'assistant-flamegraph.js' "$index_file"; then
    return 0
  fi

  local insert_before
  if grep -q '</head>' "$index_file"; then
    insert_before='</head>'
  elif grep -q '</body>' "$index_file"; then
    insert_before='</body>'
  elif grep -q '</html>' "$index_file"; then
    insert_before='</html>'
  else
    echo "ERROR: Could not find an insertion point for SmartPerfetto static assets in $index_file" >&2
    return 2
  fi

  local tmp
  tmp="$(mktemp)"
  awk -v insert_before="$insert_before" '
    index($0, insert_before) && !inserted {
      print "  <link rel=\"stylesheet\" href=\"/assistant-flamegraph.css\">";
      print "  <script defer src=\"/assistant-flamegraph.js\"></script>";
      print "  <script defer src=\"/assistant-critical-path.js\"></script>";
      inserted=1;
    }
    { print }
    END { if (!inserted) exit 2 }
  ' "$index_file" > "$tmp"
  mv "$tmp" "$index_file"
}

# Find the versioned dist directory
VERSION_DIR=$(find "$DIST_DIR" -maxdepth 1 -type d -name 'v54.0-*' -print -quit 2>/dev/null || true)
if [ -z "$VERSION_DIR" ]; then
  echo "ERROR: No compiled frontend found at $DIST_DIR"
  echo "       Run ./scripts/start-dev.sh first to build the frontend."
  exit 1
fi

VERSION=$(basename "$VERSION_DIR")
echo "Found compiled frontend: $VERSION"

# Remember stale version directories. We remove them after restoring the JS
# engine bundles because a --only-wasm-memory64 build may need to copy those
# bundles from the previous committed version.
STALE_DIRS=$(find "$FRONTEND_DIR" -maxdepth 1 -type d -name 'v*' ! -name "$VERSION" 2>/dev/null || true)
if [ -n "$STALE_DIRS" ]; then
  echo "Stale version directories found:"
  while IFS= read -r stale_dir; do
    printf '     %s\n' "$stale_dir"
  done <<< "$STALE_DIRS"
  echo ""
fi

echo "Updating frontend/ ..."

# Copy top-level files
cp "$DIST_DIR/index.html"          "$FRONTEND_DIR/index.html"
inject_smartperfetto_static_assets "$FRONTEND_DIR/index.html"
cp "$DIST_DIR/service_worker.js"   "$FRONTEND_DIR/service_worker.js" 2>/dev/null || true

# Sync versioned directory.
# Exclude source maps (repo size) and JS engine bundles — the --only-wasm-memory64
# build produces 38KB stubs for engine_bundle.js and traceconv_bundle.js instead
# of the real 244KB bundles, so we preserve those from git.
# WASM files ARE real products of the --only-wasm-memory64 build and must be copied.
rsync -a --delete \
  --exclude="*.map" \
  --exclude="engine_bundle.js" \
  --exclude="traceconv_bundle.js" \
  "$VERSION_DIR/" \
  "$FRONTEND_DIR/$VERSION/"

# Restore JS engine bundles if they are missing (e.g. first-time copy of a new
# version directory). The real bundles live in the previous versioned directory
# committed in git; stubs from --only-wasm-memory64 are ~38KB and must not be used.
for BUNDLE in engine_bundle.js traceconv_bundle.js; do
  TARGET="$FRONTEND_DIR/$VERSION/$BUNDLE"
  if [ ! -f "$TARGET" ] || [ "$(wc -c < "$TARGET")" -lt 100000 ]; then
    PREV=$(find "$FRONTEND_DIR" -maxdepth 2 -name "$BUNDLE" ! -path "$TARGET" 2>/dev/null | head -1)
    if [ -n "$PREV" ]; then
      echo "  Restoring $BUNDLE from previous build: $(basename "$(dirname "$PREV")")"
      cp "$PREV" "$TARGET"
    else
      echo "  ⚠️  $BUNDLE not found in any previous version — a full GN+ninja build may be required."
    fi
  fi
done

if [ -n "$STALE_DIRS" ]; then
  echo "Removing stale frontend version directories..."
  while IFS= read -r stale_dir; do
    rm -rf "$stale_dir"
    printf '  Removed %s\n' "$stale_dir"
  done <<< "$STALE_DIRS"
fi

echo "✅ frontend/ updated to $VERSION"
echo ""
echo "Next steps:"
echo "  git add frontend/"
echo "  git commit -m 'chore(frontend): update prebuilt to $VERSION'"
