#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Update pre-built frontend after modifying the AI Assistant plugin.
#
# Run this after verifying the UI through ./scripts/start-dev.sh, stopping the
# dev server, and producing a standalone build with:
#   (cd perfetto && tools/node ui/build.mjs)
#
# Usage:
#   ./scripts/update-frontend.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${SMARTPERFETTO_FRONTEND_DIST_DIR:-$PROJECT_ROOT/perfetto/out/ui/ui/dist}"
FRONTEND_DIR="${SMARTPERFETTO_FRONTEND_DIR:-$PROJECT_ROOT/frontend}"

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

normalize_frontend_font_asset_paths() {
  local css_file="$1"
  local version_dir="$2"

  node - "$css_file" "$version_dir" <<'NODE'
const fs = require('fs');
const path = require('path');

const [cssPath, versionDir] = process.argv.slice(2);
const css = fs.readFileSync(cssPath, 'utf8');
let replacements = 0;
const normalized = css.replace(
  /url\(\s*(["']?)([^"')]+\.woff2(?:[?#][^"')]+)?)\1\s*\)/g,
  (full, quote, assetUrl) => {
    if (/^(?:data:|https?:|\/)/.test(assetUrl)) return full;
    const suffixIndex = assetUrl.search(/[?#]/);
    const pathname = suffixIndex === -1 ? assetUrl : assetUrl.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? '' : assetUrl.slice(suffixIndex);
    const basename = path.posix.basename(pathname);
    const assetPath = path.join(versionDir, 'assets', basename);
    if (!fs.existsSync(assetPath)) {
      throw new Error(`CSS font asset is missing: ${assetPath}`);
    }
    const expectedUrl = `assets/${basename}${suffix}`;
    if (assetUrl === expectedUrl) return full;
    replacements += 1;
    return `url(${quote}${expectedUrl}${quote})`;
  },
);
if (replacements > 0) {
  fs.writeFileSync(cssPath, normalized);
  console.log(`Normalized ${replacements} frontend font URL(s)`);
}
NODE
}

is_usable_runtime_bundle() {
  local bundle="$1"
  local candidate="$2"

  if [ ! -f "$candidate" ]; then
    return 1
  fi
  if [ "$(wc -c < "$candidate")" -lt 100000 ]; then
    return 1
  fi
  if [ "$bundle" = "engine_bundle.js" ] && ! grep -Fq '"trace_processor.wasm"' "$candidate"; then
    return 1
  fi

  return 0
}

# Find the versioned dist directory
VERSION_DIR=$(find "$DIST_DIR" -maxdepth 1 -type d -name 'v*' -print 2>/dev/null | sort -V | tail -n 1 || true)
if [ -z "$VERSION_DIR" ]; then
  echo "ERROR: No compiled frontend found at $DIST_DIR"
  echo "       Run ./scripts/start-dev.sh first to build the frontend."
  exit 1
fi

VERSION=$(basename "$VERSION_DIR")
echo "Found compiled frontend: $VERSION"

# Reject an incomplete quick/incremental build before touching the committed
# frontend. The sync below uses --delete, so validating after it would corrupt
# an otherwise usable prebuild before reporting the missing source artifact.
for REQUIRED_SOURCE in \
  "$DIST_DIR/index.html" \
  "$VERSION_DIR/frontend.css" \
  "$VERSION_DIR/frontend_bundle.js" \
  "$VERSION_DIR/manifest.json"; do
  if [ ! -f "$REQUIRED_SOURCE" ]; then
    echo "ERROR: Compiled frontend is incomplete; missing $REQUIRED_SOURCE" >&2
    echo "       Stop ./scripts/start-dev.sh, then run:" >&2
    echo "       (cd perfetto && tools/node ui/build.mjs)" >&2
    exit 1
  fi
done
for BUNDLE in engine_bundle.js traceconv_bundle.js; do
  if ! is_usable_runtime_bundle "$BUNDLE" "$VERSION_DIR/$BUNDLE"; then
    echo "ERROR: $BUNDLE is incomplete in the current frontend build." >&2
    echo "       Stop ./scripts/start-dev.sh, then run:" >&2
    echo "       (cd perfetto && tools/node ui/build.mjs)" >&2
    exit 1
  fi
done
SYNTAQLITE_ASSETS=(
  syntaqlite-perfetto.wasm
  syntaqlite-runtime.js
  syntaqlite-runtime.wasm
  syntaqlite-sqlite.wasm
)
SYNTAQLITE_SOURCE_PATHS=()
for ASSET in "${SYNTAQLITE_ASSETS[@]}"; do
  if [ -f "$VERSION_DIR/assets/$ASSET" ]; then
    SYNTAQLITE_SOURCE_PATHS+=("$VERSION_DIR/assets/$ASSET")
  elif [ -f "$VERSION_DIR/$ASSET" ]; then
    SYNTAQLITE_SOURCE_PATHS+=("$VERSION_DIR/$ASSET")
  else
    echo "ERROR: Compiled frontend is missing Syntaqlite asset $ASSET" >&2
    exit 1
  fi
done

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

# Upstream Vite emits shared runtime assets at dist/assets/. Some bundled
# plugins load them with relative "assets/..." URLs, so the committed prebuild
# must ship these top-level assets alongside the versioned directory.
if [ -d "$DIST_DIR/assets" ]; then
  mkdir -p "$FRONTEND_DIR/assets"
  rsync -a --delete "$DIST_DIR/assets/" "$FRONTEND_DIR/assets/"
fi

# Sync versioned directory.
# Exclude source maps (repo size). JS engine bundles are copied from the same
# complete build output and validated below.
# WASM files ARE real products of the build and must be copied.
rsync -a --delete \
  --exclude="*.map" \
  "$VERSION_DIR/" \
  "$FRONTEND_DIR/$VERSION/"

# Full upstream builds emit Syntaqlite assets inside the version directory,
# while dev builds can also expose them under dist/assets/. Always derive the
# public top-level copies from this exact versioned build so a refresh cannot
# retain stale assets from an earlier Perfetto revision.
mkdir -p "$FRONTEND_DIR/assets"
for INDEX in "${!SYNTAQLITE_ASSETS[@]}"; do
  cp \
    "${SYNTAQLITE_SOURCE_PATHS[$INDEX]}" \
    "$FRONTEND_DIR/assets/${SYNTAQLITE_ASSETS[$INDEX]}"
done

# Some upstream UI builds emit only the memory64 trace processor into
# ui/dist/<version>/ while the classic wasm is left under the GN output wasm/
# directory. The prebuild still needs both assets for older browser/runtime
# paths, so copy the classic wasm from the same out tree when dist omits it.
if [ ! -f "$FRONTEND_DIR/$VERSION/trace_processor.wasm" ]; then
  OUT_ROOT="$(cd "$VERSION_DIR/../../.." && pwd)"
  TRACE_PROCESSOR_WASM="$OUT_ROOT/wasm/trace_processor.wasm"
  if [ -f "$TRACE_PROCESSOR_WASM" ]; then
    cp "$TRACE_PROCESSOR_WASM" "$FRONTEND_DIR/$VERSION/trace_processor.wasm"
  fi
fi

# Vite/Rolldown can preserve a font URL relative to each importing SCSS
# module before concatenating all module CSS into frontend.css. Those paths
# then escape the version directory (for example ../assets/assets/*.woff2).
# Canonicalize them at the committed-prebuild boundary and let the manifest
# refresh below cover the generated CSS bytes.
normalize_frontend_font_asset_paths \
  "$FRONTEND_DIR/$VERSION/frontend.css" \
  "$FRONTEND_DIR/$VERSION"

# Rollup and upstream runtime assets can emit indented blank lines. Keep
# checked-in generated text artifacts compatible with git diff --check.
for TEXT_ARTIFACT in \
  "$FRONTEND_DIR/$VERSION/frontend_bundle.js" \
  "$FRONTEND_DIR/$VERSION/assets/mermaid.min.js" \
  "$FRONTEND_DIR/$VERSION/assets/syntaqlite-runtime.js" \
  "$FRONTEND_DIR/$VERSION/syntaqlite-runtime.js" \
  "$FRONTEND_DIR/assets/syntaqlite-runtime.js"; do
  if [ -f "$TEXT_ARTIFACT" ]; then
    perl -pi -e 's/[ \t]+$//' "$TEXT_ARTIFACT"
  fi
done

# Reject partial builds instead of pairing current WASM files with JavaScript
# glue from a previous version. A committed prebuild must come from one complete
# build so the Emscripten constants and loader ABI stay synchronized.
for BUNDLE in engine_bundle.js traceconv_bundle.js; do
  TARGET="$FRONTEND_DIR/$VERSION/$BUNDLE"
  if ! is_usable_runtime_bundle "$BUNDLE" "$TARGET"; then
    echo "ERROR: $BUNDLE is incomplete in the current frontend build." >&2
    echo "       Run a full frontend build that emits classic wasm loader glue before updating frontend/." >&2
    exit 1
  fi
done

# Refresh generated manifest hashes after normalizing committed artifacts so
# the checked-in prebuild is internally consistent.
node - "$FRONTEND_DIR/$VERSION/manifest.json" "$FRONTEND_DIR/$VERSION" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [manifestPath, versionDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.resources ??= {};
for (const required of ['trace_processor.wasm', 'trace_processor_memory64.wasm']) {
  const filePath = path.join(versionDir, required);
  if (fs.existsSync(filePath)) {
    const hash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('base64');
    manifest.resources[required] = `sha256-${hash}`;
  }
}
for (const name of Object.keys(manifest.resources ?? {})) {
  const filePath = path.join(versionDir, name);
  if (!fs.existsSync(filePath)) continue;
  const hash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('base64');
  manifest.resources[name] = `sha256-${hash}`;
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

if [ -n "$STALE_DIRS" ]; then
  echo "Removing stale frontend version directories..."
  while IFS= read -r stale_dir; do
    rm -rf "$stale_dir"
    printf '  Removed %s\n' "$stale_dir"
  done <<< "$STALE_DIRS"
fi

node "$PROJECT_ROOT/scripts/check-frontend-prebuild.cjs"

echo "✅ frontend/ updated to $VERSION"
echo ""
echo "Next steps:"
echo "  git add frontend/"
echo "  git commit -m 'chore(frontend): update prebuilt to $VERSION'"
