#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_ENV_HELPERS="$PROJECT_ROOT/scripts/node-env.sh"
# shellcheck source=scripts/node-env.sh
. "$NODE_ENV_HELPERS"

TARGET_ARCH="${SMARTPERFETTO_WINDOWS_ARCH:-x64}"
OUT_ROOT="${SMARTPERFETTO_WINDOWS_OUT_DIR:-$PROJECT_ROOT/dist/windows-exe}"
CACHE_DIR="${SMARTPERFETTO_WINDOWS_CACHE_DIR:-$PROJECT_ROOT/.cache/smartperfetto-windows}"
NODE_MAJOR="${SMARTPERFETTO_WINDOWS_NODE_MAJOR:-24}"

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' is not installed." >&2
    exit 1
  fi
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    node -e "const fs=require('fs');const crypto=require('crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$file"
  fi
}

pin_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$PROJECT_ROOT/scripts/trace-processor-pin.env" | head -n 1
}

download_checked() {
  local url="$1"
  local dest="$2"
  local expected_sha="$3"

  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ]; then
    local actual
    actual="$(sha256_file "$dest")"
    if [ "$actual" = "$expected_sha" ]; then
      return 0
    fi
    echo "Cached file hash mismatch; replacing $dest"
    rm -f "$dest"
  fi

  echo "Downloading $url"
  curl -fL --retry 3 --connect-timeout 15 --max-time 300 "$url" -o "$dest"
  local actual
  actual="$(sha256_file "$dest")"
  if [ "$actual" != "$expected_sha" ]; then
    rm -f "$dest"
    echo "ERROR: SHA256 mismatch for $url" >&2
    echo "  expected: $expected_sha" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

assert_pe_binary() {
  local file="$1"
  local label="$2"
  node - "$file" "$label" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const label = process.argv[3];
const bytes = fs.readFileSync(file);
if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
  console.error(`ERROR: ${label} is not a Windows PE binary: ${file}`);
  process.exit(1);
}
NODE
}

resolve_node_release() {
  local shasums="$CACHE_DIR/node-latest-v${NODE_MAJOR}.x-SHASUMS256.txt"
  mkdir -p "$CACHE_DIR"
  curl -fsSL --connect-timeout 15 --max-time 60 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" -o "$shasums"

  local entry
  entry="$(awk '/win-x64\.zip$/ {print $1, $2; exit}' "$shasums")"
  if [ -z "$entry" ]; then
    echo "ERROR: could not resolve latest Node ${NODE_MAJOR} Windows x64 zip." >&2
    exit 1
  fi
  echo "$entry"
}

copy_dir() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  rsync -a --delete "$src"/ "$dest"/
}

case "$TARGET_ARCH" in
  x64) ;;
  *)
    echo "ERROR: only Windows x64 packaging is supported for now." >&2
    exit 1
    ;;
esac

require_command curl
require_command go
require_command git
require_command npm
require_command node
require_command rsync
require_command unzip
require_command zip

smartperfetto_ensure_node "$PROJECT_ROOT"
smartperfetto_ensure_backend_deps "$PROJECT_ROOT"
node "$PROJECT_ROOT/scripts/sync-version.cjs" --check
PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$PROJECT_ROOT/package.json")"
PACKAGE_NAME="smartperfetto-v${PACKAGE_VERSION}-windows-${TARGET_ARCH}"
PACKAGE_DIR="$OUT_ROOT/$PACKAGE_NAME"
ZIP_PATH="$OUT_ROOT/$PACKAGE_NAME.zip"
LEGACY_PACKAGE_NAME="smartperfetto-windows-${TARGET_ARCH}"
LEGACY_PACKAGE_DIR="$OUT_ROOT/$LEGACY_PACKAGE_NAME"
LEGACY_ZIP_PATH="$OUT_ROOT/$LEGACY_PACKAGE_NAME.zip"
GIT_COMMIT="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
GIT_DIRTY=false
if [ -n "$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=normal)" ]; then
  GIT_DIRTY=true
fi

echo "Building backend runtime..."
(cd "$PROJECT_ROOT/backend" && npm run build)

echo "Preparing package directory..."
rm -rf "$PACKAGE_DIR" "$ZIP_PATH" "$LEGACY_PACKAGE_DIR" "$LEGACY_ZIP_PATH"
mkdir -p "$PACKAGE_DIR"

echo "Resolving Node.js Windows runtime..."
read -r node_sha node_file < <(resolve_node_release)
node_dir="${node_file%.zip}"
node_runtime_version="${node_file#node-v}"
node_runtime_version="${node_runtime_version%-win-x64.zip}"

copy_dir "$PROJECT_ROOT/frontend" "$PACKAGE_DIR/frontend"

mkdir -p "$PACKAGE_DIR/backend"
copy_dir "$PROJECT_ROOT/backend/dist" "$PACKAGE_DIR/backend/dist"
copy_dir "$PROJECT_ROOT/backend/data" "$PACKAGE_DIR/backend/data"
copy_dir "$PROJECT_ROOT/backend/public" "$PACKAGE_DIR/backend/public"
copy_dir "$PROJECT_ROOT/backend/skills" "$PACKAGE_DIR/backend/skills"
copy_dir "$PROJECT_ROOT/backend/strategies" "$PACKAGE_DIR/backend/strategies"
copy_dir "$PROJECT_ROOT/backend/sql" "$PACKAGE_DIR/backend/sql"
cp "$PROJECT_ROOT/backend/package.json" "$PACKAGE_DIR/backend/package.json"
cp "$PROJECT_ROOT/backend/package-lock.json" "$PACKAGE_DIR/backend/package-lock.json"
cp "$PROJECT_ROOT/backend/.env.example" "$PACKAGE_DIR/backend/.env.example"
cp "$PROJECT_ROOT/backend/LICENSE" "$PACKAGE_DIR/backend/LICENSE"
mkdir -p "$PACKAGE_DIR/backend/uploads/traces" "$PACKAGE_DIR/backend/logs" "$PACKAGE_DIR/backend/data/sessions"

echo "Installing Windows production dependencies..."
(
  cd "$PACKAGE_DIR/backend"
  npm ci --omit=dev --include=optional --os=win32 --cpu=x64 --ignore-scripts
  (
    cd node_modules/better-sqlite3
    rm -rf build
    npm_config_platform=win32 \
    npm_config_arch=x64 \
    npm_config_target="$node_runtime_version" \
    ../.bin/prebuild-install
  )
)

echo "Validating Windows native dependencies..."
better_sqlite3_node="$(find "$PACKAGE_DIR/backend/node_modules/better-sqlite3" -name '*.node' -print -quit)"
if [ -z "$better_sqlite3_node" ]; then
  echo "ERROR: better-sqlite3 native module was not installed." >&2
  exit 1
fi
assert_pe_binary "$better_sqlite3_node" "better-sqlite3 native module"
if [ ! -f "$PACKAGE_DIR/backend/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe" ]; then
  echo "ERROR: Claude Agent SDK Windows x64 binary was not installed." >&2
  exit 1
fi
assert_pe_binary "$PACKAGE_DIR/backend/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe" "Claude Agent SDK native binary"

echo "Downloading Node.js Windows runtime..."
node_zip="$CACHE_DIR/$node_file"
download_checked "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$node_file" "$node_zip" "$node_sha"
rm -rf "$CACHE_DIR/${node_dir:?}"
unzip -q "$node_zip" -d "$CACHE_DIR"
mkdir -p "$PACKAGE_DIR/runtime"
copy_dir "$CACHE_DIR/$node_dir" "$PACKAGE_DIR/runtime/node"

echo "Downloading Windows trace_processor_shell..."
perfetto_version="$(pin_value PERFETTO_VERSION)"
perfetto_url_base="$(pin_value PERFETTO_LUCI_URL_BASE)"
tp_sha="$(pin_value PERFETTO_SHELL_SHA256_WINDOWS_AMD64)"
if [ -z "$perfetto_version" ] || [ -z "$perfetto_url_base" ] || [ -z "$tp_sha" ]; then
  echo "ERROR: missing Windows trace_processor_shell pin values." >&2
  exit 1
fi
tp_url="${perfetto_url_base%/}/${perfetto_version}/windows-amd64/trace_processor_shell.exe"
tp_cache="$CACHE_DIR/trace_processor_shell-${perfetto_version}-windows-amd64.exe"
download_checked "$tp_url" "$tp_cache" "$tp_sha"
mkdir -p "$PACKAGE_DIR/bin"
cp "$tp_cache" "$PACKAGE_DIR/bin/trace_processor_shell.exe"

echo "Building SmartPerfetto.exe launcher..."
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=$PACKAGE_VERSION" -o "$PACKAGE_DIR/SmartPerfetto.exe" "$PROJECT_ROOT/scripts/windows-launcher/main.go"

cat > "$PACKAGE_DIR/README-WINDOWS.txt" <<'README'
SmartPerfetto Windows x64 package
Version: __SMARTPERFETTO_VERSION__

Run:
  1. Extract the zip to a normal local path, for example C:\SmartPerfetto.
  2. Double-click SmartPerfetto.exe.
  3. Open http://localhost:10000 if the browser does not open automatically.

AI analysis needs either a Provider profile configured in the UI or env credentials
in backend\.env. To use env credentials, copy backend\.env.example to backend\.env,
edit one provider block, then restart SmartPerfetto.exe.

Keep the launcher window open while using SmartPerfetto. Press Ctrl+C in that
window to stop backend, frontend, and trace_processor_shell child processes.

Logs:
  logs\backend.log
  logs\frontend.log
README
node -e "const fs=require('fs'); const p=process.argv[1]; const v=process.argv[2]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('__SMARTPERFETTO_VERSION__', v));" "$PACKAGE_DIR/README-WINDOWS.txt" "$PACKAGE_VERSION"

node - "$PACKAGE_DIR/PACKAGE-MANIFEST.json" \
  "$PACKAGE_VERSION" "$PACKAGE_NAME" "$TARGET_ARCH" "$GIT_COMMIT" "$GIT_DIRTY" \
  "$node_runtime_version" "$node_file" "$node_sha" "$perfetto_version" "$tp_sha" <<'NODE'
const fs = require('fs');
const [
  manifestPath,
  version,
  packageName,
  targetArch,
  gitCommit,
  gitDirty,
  nodeRuntimeVersion,
  nodeRuntimeFile,
  nodeRuntimeSha256,
  perfettoVersion,
  traceProcessorSha256,
] = process.argv.slice(2);

const manifest = {
  name: 'smartperfetto',
  version,
  packageName,
  target: {
    os: 'windows',
    arch: targetArch,
  },
  gitCommit,
  gitDirty: gitDirty === 'true',
  builtAt: new Date().toISOString(),
  nodeRuntime: {
    version: nodeRuntimeVersion,
    file: nodeRuntimeFile,
    sha256: nodeRuntimeSha256,
  },
  traceProcessor: {
    version: perfettoVersion,
    sha256: traceProcessorSha256,
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

echo "Creating zip..."
(
  cd "$OUT_ROOT"
  zip -qr "$ZIP_PATH" "$PACKAGE_NAME"
)

node "$PROJECT_ROOT/scripts/verify-windows-package.cjs" \
  --zip "$ZIP_PATH" \
  --version "$PACKAGE_VERSION" \
  --commit "$GIT_COMMIT"

echo ""
echo "Windows package ready:"
echo "  $PACKAGE_DIR/SmartPerfetto.exe"
echo "  $ZIP_PATH"
