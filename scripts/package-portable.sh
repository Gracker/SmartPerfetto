#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_ENV_HELPERS="$PROJECT_ROOT/scripts/node-env.sh"
# shellcheck source=scripts/node-env.sh
. "$NODE_ENV_HELPERS"

OUT_ROOT="${SMARTPERFETTO_PORTABLE_OUT_DIR:-$PROJECT_ROOT/dist/portable}"
CACHE_DIR="${SMARTPERFETTO_PORTABLE_CACHE_DIR:-$PROJECT_ROOT/.cache/smartperfetto-portable}"
NODE_RUNTIME_PIN_FILE="$PROJECT_ROOT/scripts/node-runtime-pin.env"
LINUX_GLIBC_MINIMUM_VERSION="2.34"
MACOS_MINIMUM_SYSTEM_VERSION="13.5"
WINDOWS_MINIMUM_SYSTEM_VERSION="10.0"
DEFAULT_TARGETS=("windows-x64" "macos-arm64" "linux-x64")
TARGETS=()

usage() {
  cat <<'USAGE'
Usage:
  npm run package:portable -- [options]

Options:
  --targets LIST       Comma-separated targets. Default: windows-x64,macos-arm64,linux-x64.
  --target TARGET      Add one target. May be repeated.

Supported targets:
  windows-x64
  macos-arm64
  linux-x64

macOS signing/notarization:
  SMARTPERFETTO_MACOS_SIGN_IDENTITY="Developer ID Application: ..."
  SMARTPERFETTO_MACOS_NOTARY_PROFILE="notarytool-keychain-profile"
USAGE
}

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

copy_dir() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  rsync -a --delete "$src"/ "$dest"/
}

copy_tracked_tree() {
  local relative_root="$1"
  local destination_root="$2"
  rm -rf "${destination_root:?}/$relative_root"
  mkdir -p "$destination_root/$relative_root"
  (
    cd "$PROJECT_ROOT"
    git ls-files -z "$relative_root" |
      rsync -a --from0 --files-from=- ./ "$destination_root"/
  )
}

assert_staging_tree_safe() {
  local package_dir="$1"
  node "$PROJECT_ROOT/scripts/verify-portable-staging-tree.cjs" "$package_dir"
}

copy_backend_data_payload() {
  local resources_dir="$1"
  local data_dir="$resources_dir/backend/data"
  mkdir -p "$data_dir"
  (
    cd "$PROJECT_ROOT"
    git ls-files -z backend/data | rsync -a --from0 --files-from=- ./ "$resources_dir"/
  )
  if [ -e "$data_dir/agent-runtime" ] || [ -e "$data_dir/sessions.db" ]; then
    echo "ERROR: portable package data payload contains runtime state under backend/data." >&2
    exit 1
  fi
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

target_field() {
  local target="$1"
  local field="$2"
  case "$target:$field" in
    windows-x64:os_name) echo "windows" ;;
    windows-x64:arch_name) echo "x64" ;;
    windows-x64:npm_os) echo "win32" ;;
    windows-x64:npm_cpu) echo "x64" ;;
    windows-x64:goos) echo "windows" ;;
    windows-x64:goarch) echo "amd64" ;;
    windows-x64:node_pattern) echo "win-x64.zip" ;;
    windows-x64:node_dir_suffix) echo "win-x64" ;;
    windows-x64:perfetto_platform) echo "windows-amd64" ;;
    windows-x64:perfetto_sha_key) echo "PERFETTO_SHELL_SHA256_WINDOWS_AMD64" ;;
    windows-x64:trace_prebuilt_key) echo "win32-x64" ;;
    windows-x64:trace_name) echo "trace_processor_shell.exe" ;;
    windows-x64:asset_ext) echo "zip" ;;
    windows-x64:launcher_name) echo "SmartPerfetto.exe" ;;
    windows-x64:claude_pkg) echo "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe" ;;
    windows-x64:opencode_pkg) echo "opencode-windows-x64-baseline" ;;
    windows-x64:opencode_bin) echo "bin/opencode.exe" ;;
    windows-x64:binary_kind) echo "pe" ;;
    windows-x64:prebuild_dir) echo "win32-x64" ;;

    macos-arm64:os_name) echo "macos" ;;
    macos-arm64:arch_name) echo "arm64" ;;
    macos-arm64:npm_os) echo "darwin" ;;
    macos-arm64:npm_cpu) echo "arm64" ;;
    macos-arm64:goos) echo "darwin" ;;
    macos-arm64:goarch) echo "arm64" ;;
    macos-arm64:node_pattern) echo "darwin-arm64.tar.gz" ;;
    macos-arm64:node_dir_suffix) echo "darwin-arm64" ;;
    macos-arm64:perfetto_platform) echo "mac-arm64" ;;
    macos-arm64:perfetto_sha_key) echo "PERFETTO_SHELL_SHA256_MAC_ARM64" ;;
    macos-arm64:trace_prebuilt_key) echo "darwin-arm64" ;;
    macos-arm64:trace_name) echo "trace_processor_shell" ;;
    macos-arm64:asset_ext) echo "zip" ;;
    macos-arm64:launcher_name) echo "SmartPerfetto" ;;
    macos-arm64:claude_pkg) echo "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" ;;
    macos-arm64:opencode_pkg) echo "opencode-darwin-arm64" ;;
    macos-arm64:opencode_bin) echo "bin/opencode" ;;
    macos-arm64:binary_kind) echo "macho" ;;
    macos-arm64:prebuild_dir) echo "darwin-arm64" ;;

    linux-x64:os_name) echo "linux" ;;
    linux-x64:arch_name) echo "x64" ;;
    linux-x64:npm_os) echo "linux" ;;
    linux-x64:npm_cpu) echo "x64" ;;
    linux-x64:goos) echo "linux" ;;
    linux-x64:goarch) echo "amd64" ;;
    linux-x64:node_pattern) echo "linux-x64.tar.xz" ;;
    linux-x64:node_dir_suffix) echo "linux-x64" ;;
    linux-x64:perfetto_platform) echo "linux-amd64" ;;
    linux-x64:perfetto_sha_key) echo "PERFETTO_SHELL_SHA256_LINUX_AMD64" ;;
    linux-x64:trace_prebuilt_key) echo "linux-x64" ;;
    linux-x64:trace_name) echo "trace_processor_shell" ;;
    linux-x64:asset_ext) echo "tar.gz" ;;
    linux-x64:launcher_name) echo "SmartPerfetto" ;;
    linux-x64:claude_pkg) echo "@anthropic-ai/claude-agent-sdk-linux-x64/claude" ;;
    linux-x64:opencode_pkg) echo "opencode-linux-x64-baseline" ;;
    linux-x64:opencode_bin) echo "bin/opencode" ;;
    linux-x64:binary_kind) echo "elf" ;;
    linux-x64:prebuild_dir) echo "linux-x64" ;;
    *)
      echo "ERROR: unsupported target or field: $target $field" >&2
      exit 2
      ;;
  esac
}

append_targets_csv() {
  local csv="$1"
  local item
  IFS=',' read -r -a parsed <<< "$csv"
  for item in "${parsed[@]}"; do
    item="${item//[[:space:]]/}"
    if [ -n "$item" ]; then
      TARGETS+=("$item")
    fi
  done
}

resolve_node_release() {
  local target="$1"
  local version sha_key sha file
  version="$(sed -n 's/^NODE_RUNTIME_VERSION=//p' "$NODE_RUNTIME_PIN_FILE" | head -n 1)"
  case "$target" in
    windows-x64) sha_key="NODE_RUNTIME_SHA256_WINDOWS_X64" ;;
    macos-arm64) sha_key="NODE_RUNTIME_SHA256_MACOS_ARM64" ;;
    linux-x64) sha_key="NODE_RUNTIME_SHA256_LINUX_X64" ;;
    *)
      echo "ERROR: unsupported Node runtime target: $target" >&2
      exit 2
      ;;
  esac
  sha="$(sed -n "s/^${sha_key}=//p" "$NODE_RUNTIME_PIN_FILE" | head -n 1)"
  file="node-v${version}-$(target_field "$target" node_pattern)"
  if ! [[ "$version" =~ ^24\.[0-9]+\.[0-9]+$ ]] || ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: invalid Node runtime pin for $target in $NODE_RUNTIME_PIN_FILE." >&2
    exit 1
  fi
  echo "$sha $file"
}

extract_node_runtime() {
  local archive="$1"
  local node_dir="$2"
  local target="$3"
  rm -rf "$CACHE_DIR/${node_dir:?}"
  case "$(target_field "$target" node_pattern)" in
    *.zip) unzip -q "$archive" -d "$CACHE_DIR" ;;
    *.tar.gz) tar -xzf "$archive" -C "$CACHE_DIR" ;;
    *.tar.xz) tar -xJf "$archive" -C "$CACHE_DIR" ;;
    *)
      echo "ERROR: unsupported Node archive: $archive" >&2
      exit 1
      ;;
  esac
}

assert_binary_kind() {
  local file="$1"
  local label="$2"
  local kind="$3"
  node - "$file" "$label" "$kind" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const label = process.argv[3];
const kind = process.argv[4];
const bytes = fs.readFileSync(file);
const hex = [...bytes.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('');
const ok = kind === 'pe'
  ? bytes[0] === 0x4d && bytes[1] === 0x5a
  : kind === 'elf'
    ? bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
    : ['cffaedfe', 'cafebabe', 'feedfacf', 'feedface'].includes(hex);
if (!ok) {
  console.error(`ERROR: ${label} is not a ${kind} binary: ${file}`);
  process.exit(1);
}
NODE
}

copy_backend_payload() {
  local resources_dir="$1"
  copy_tracked_tree "frontend" "$resources_dir"

  mkdir -p "$resources_dir/backend"
  copy_dir "$PROJECT_ROOT/backend/dist" "$resources_dir/backend/dist"
  copy_backend_data_payload "$resources_dir"
  copy_tracked_tree "backend/public" "$resources_dir"
  copy_tracked_tree "backend/skills" "$resources_dir"
  copy_tracked_tree "backend/strategies" "$resources_dir"
  copy_tracked_tree "backend/knowledge" "$resources_dir"
  copy_tracked_tree "backend/sql" "$resources_dir"
  cp "$PROJECT_ROOT/backend/package.json" "$resources_dir/backend/package.json"
  cp "$PROJECT_ROOT/backend/package-lock.json" "$resources_dir/backend/package-lock.json"
  cp "$PROJECT_ROOT/backend/.env.example" "$resources_dir/backend/.env.example"
  cp "$PROJECT_ROOT/backend/LICENSE" "$resources_dir/backend/LICENSE"
}

assert_backend_runtime_clean() {
  node - "$PROJECT_ROOT/backend/dist" <<'NODE'
const fs = require('fs');
const path = require('path');

const dist = process.argv[2];
const forbiddenNames = [
  'traceAnalysisSkill',
  'traceAnalysisSkillConfig',
  'advancedAIRoutes',
  'autoAnalysis',
  'advancedAIController',
  'autoAnalysisController',
  'advancedAIService',
  'autoAnalysisService',
  'aiService',
  'enterpriseLegacyAiGuard',
];
const forbiddenText = [
  'TraceAnalysisSkill',
  'traceAnalysisSkill',
  'trace-analysis-system',
  'TRACE_ANALYSIS',
  'DeepSeek API not configured on server',
  '/api/advanced-ai',
  '/api/auto-analysis',
];

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(dist)) {
  fail(`backend runtime is missing: ${dist}`);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

for (const file of walk(dist)) {
  const rel = path.relative(dist, file);
  if (forbiddenNames.some(name => rel.includes(name))) {
    fail(`backend runtime contains stale legacy AI artifact: ${rel}`);
  }
  if (!/\.(js|mjs|cjs|json|map|d\.ts)$/.test(rel)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const forbidden = forbiddenText.find(value => text.includes(value));
  if (forbidden) {
    fail(`backend runtime contains stale provider-specific code in ${rel}: ${forbidden}`);
  }
}
NODE
}

install_target_dependencies() {
  local target="$1"
  local backend_dir="$2"
  local node_runtime_version="$3"
  local npm_os npm_cpu binary_kind claude_rel claude_bin claude_pkg_name better_sqlite3_node
  local opencode_pkg_name opencode_pkg_bin opencode_source opencode_dest
  npm_os="$(target_field "$target" npm_os)"
  npm_cpu="$(target_field "$target" npm_cpu)"
  binary_kind="$(target_field "$target" binary_kind)"
  claude_rel="$(target_field "$target" claude_pkg)"
  claude_pkg_name="$(node -e "const rel=process.argv[1]; console.log(rel.startsWith('@') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0]);" "$claude_rel")"
  opencode_pkg_name="$(target_field "$target" opencode_pkg)"
  opencode_pkg_bin="$(target_field "$target" opencode_bin)"

  echo "Installing $target production dependencies..."
  (
    cd "$backend_dir"
    npm ci --omit=dev --include=optional --os="$npm_os" --cpu="$npm_cpu" --ignore-scripts
    (
      cd node_modules/better-sqlite3
      rm -rf build
      local attempt
      for attempt in 1 2 3; do
        sleep 1
        if npm_config_platform="$npm_os" \
          npm_config_arch="$npm_cpu" \
          npm_config_target="$node_runtime_version" \
          ../.bin/prebuild-install --verbose; then
          break
        fi
        if [ "$attempt" = 3 ]; then
          exit 1
        fi
        echo "better-sqlite3 prebuild install failed for $target; retrying ($attempt/3)..."
        sleep 2
      done
    )
  )

  better_sqlite3_node="$(find "$backend_dir/node_modules/better-sqlite3" -name '*.node' -print -quit)"
  if [ -z "$better_sqlite3_node" ]; then
    echo "ERROR: better-sqlite3 native module was not installed for $target." >&2
    exit 1
  fi
  assert_binary_kind "$better_sqlite3_node" "better-sqlite3 native module" "$binary_kind"

  claude_bin="$backend_dir/node_modules/$claude_rel"
  if [ ! -f "$claude_bin" ]; then
    echo "Installing $target Claude Agent SDK native package explicitly..."
    (
      cd "$backend_dir"
      local claude_version pack_dir pack_json pack_file pkg_parent pkg_dest
      claude_version="$(node -e "console.log(require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)")"
      pack_dir="$(mktemp -d)"
      pack_json="$pack_dir/pack.json"
      npm pack "$claude_pkg_name@$claude_version" --json --pack-destination "$pack_dir" > "$pack_json"
      pack_file="$(node -e "const path=require('path'); const items=require(process.argv[1]); console.log(path.join(process.argv[2], items[0].filename));" "$pack_json" "$pack_dir")"
      pkg_parent="$(dirname "node_modules/$claude_pkg_name")"
      pkg_dest="node_modules/$claude_pkg_name"
      mkdir -p "$pkg_parent"
      rm -rf "$pkg_dest"
      mkdir -p "$pkg_dest"
      tar -xzf "$pack_file" -C "$pkg_dest" --strip-components=1
      rm -rf "$pack_dir"
    )
  fi
  if [ ! -f "$claude_bin" ]; then
    echo "ERROR: Claude Agent SDK native binary was not installed for $target: $claude_bin" >&2
    exit 1
  fi
  assert_binary_kind "$claude_bin" "Claude Agent SDK native binary" "$binary_kind"
  if [ "$(target_field "$target" os_name)" != "windows" ]; then
    chmod +x "$claude_bin"
  fi

  # npm ci uses --ignore-scripts for cross-target safety, so opencode-ai's
  # postinstall cannot replace its error stub. Copy the target-native optional
  # package explicitly; x64 uses the baseline build for wider CPU support.
  opencode_source="$backend_dir/node_modules/$opencode_pkg_name/$opencode_pkg_bin"
  if [ ! -f "$opencode_source" ]; then
    echo "Installing $target OpenCode native package explicitly..."
    (
      cd "$backend_dir"
      local opencode_version pack_dir pack_json pack_file pkg_dest
      opencode_version="$(node -e "console.log(require('./node_modules/opencode-ai/package.json').version)")"
      pack_dir="$(mktemp -d)"
      pack_json="$pack_dir/pack.json"
      npm pack "$opencode_pkg_name@$opencode_version" --json --pack-destination "$pack_dir" > "$pack_json"
      pack_file="$(node -e "const path=require('path'); const items=require(process.argv[1]); console.log(path.join(process.argv[2], items[0].filename));" "$pack_json" "$pack_dir")"
      pkg_dest="node_modules/$opencode_pkg_name"
      rm -rf "$pkg_dest"
      mkdir -p "$pkg_dest"
      tar -xzf "$pack_file" -C "$pkg_dest" --strip-components=1
      rm -rf "$pack_dir"
    )
  fi
  if [ ! -f "$opencode_source" ]; then
    echo "ERROR: OpenCode native binary was not installed for $target: $opencode_source" >&2
    exit 1
  fi
  opencode_dest="$backend_dir/node_modules/opencode-ai/bin/opencode.exe"
  mkdir -p "$(dirname "$opencode_dest")"
  cp "$opencode_source" "$opencode_dest"
  assert_binary_kind "$opencode_dest" "OpenCode native binary" "$binary_kind"
  if [ "$(target_field "$target" os_name)" != "windows" ]; then
    chmod +x "$opencode_dest"
  fi

  # Some dependencies publish every platform prebuild inside one npm package.
  # Retain only the directory matching this archive so foreign iOS, Android,
  # Windows, macOS, or Linux binaries cannot masquerade as target payload.
  node - "$backend_dir/node_modules" "$(target_field "$target" prebuild_dir)" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2]);
const expected = process.argv[3];
const pending = [root];
while (pending.length > 0) {
  const current = pending.pop();
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(current, entry.name);
    if (entry.name === 'prebuilds') {
      for (const prebuild of fs.readdirSync(candidate, {withFileTypes: true})) {
        if (prebuild.isDirectory() && prebuild.name !== expected) {
          fs.rmSync(path.join(candidate, prebuild.name), {recursive: true});
        }
      }
      continue;
    }
    pending.push(candidate);
  }
}
NODE

  # npm's command shims are install-time conveniences, not portable runtime
  # inputs. Removing them keeps final archives link-free on every target so the
  # verifier can reject symlink/hardlink extraction attacks without exceptions.
  find "$backend_dir/node_modules" -type d -name .bin -prune -exec rm -rf {} +
  local remaining_link
  remaining_link="$(find "$backend_dir/node_modules" -type l -print -quit)"
  if [ -n "$remaining_link" ]; then
    echo "ERROR: portable dependency tree contains an unexpected symlink: $remaining_link" >&2
    exit 1
  fi
}

materialize_portable_links() {
  local root="$1"
  local canonical_root link_path link_target resolved_target materialized_path
  canonical_root="$(cd "$root" && pwd -P)"

  while IFS= read -r link_path; do
    link_target="$(readlink "$link_path")"
    resolved_target="$(
      node -e '
        const path = require("path");
        console.log(path.resolve(path.dirname(process.argv[1]), process.argv[2]));
      ' "$link_path" "$link_target"
    )"
    case "$resolved_target" in
      "$canonical_root"/*) ;;
      *)
        echo "ERROR: portable symlink escapes its payload root: $link_path -> $link_target" >&2
        exit 1
        ;;
    esac
    if [ ! -f "$resolved_target" ] || [ -L "$resolved_target" ]; then
      echo "ERROR: portable symlink does not resolve directly to a regular file: $link_path -> $link_target" >&2
      exit 1
    fi

    materialized_path="${link_path}.smartperfetto-materialized"
    cp "$resolved_target" "$materialized_path"
    rm "$link_path"
    mv "$materialized_path" "$link_path"
  done < <(find "$root" -type l -print)

  link_path="$(find "$root" -type l -print -quit)"
  if [ -n "$link_path" ]; then
    echo "ERROR: portable payload still contains an unexpected symlink: $link_path" >&2
    exit 1
  fi
}

write_manifest() {
  local manifest_path="$1"
  local version="$2"
  local package_name="$3"
  local target="$4"
  local git_commit="$5"
  local git_dirty="$6"
  local node_runtime_version="$7"
  local node_file="$8"
  local node_sha="$9"
  local perfetto_version="${10}"
  local trace_processor_source_sha="${11}"
  local trace_processor_sha="${12}"
  local signed="${13}"
  local notarized="${14}"
  local signing_mode="${15}"
  local macos_minimum_system_version="${16}"
  local os_name arch_name
  os_name="$(target_field "$target" os_name)"
  arch_name="$(target_field "$target" arch_name)"

  node - "$manifest_path" \
    "$version" "$package_name" "$os_name" "$arch_name" "$target" "$git_commit" "$git_dirty" \
    "$node_runtime_version" "$node_file" "$node_sha" "$perfetto_version" \
    "$trace_processor_source_sha" "$trace_processor_sha" "$signed" "$notarized" \
    "$signing_mode" "$WINDOWS_MINIMUM_SYSTEM_VERSION" \
    "$LINUX_GLIBC_MINIMUM_VERSION" "$macos_minimum_system_version" <<'NODE'
const fs = require('fs');
const [
  manifestPath,
  version,
  packageName,
  os,
  arch,
  targetId,
  gitCommit,
  gitDirty,
  nodeRuntimeVersion,
  nodeRuntimeFile,
  nodeRuntimeSha256,
  perfettoVersion,
  traceProcessorSourceSha256,
  traceProcessorSha256,
  signed,
  notarized,
  signingMode,
  windowsMinimumSystemVersion,
  linuxGlibcMinimumVersion,
  macosMinimumSystemVersion,
] = process.argv.slice(2);

const manifest = {
  schemaVersion: 3,
  name: 'smartperfetto',
  version,
  packageName,
  distribution: 'portable',
  channel: 'stable',
  signingMode,
  target: {
    os,
    arch,
    id: targetId,
    ...(targetId === 'windows-x64'
      ? {minimumSystemVersion: windowsMinimumSystemVersion}
      : {}),
    ...(targetId === 'linux-x64'
      ? {libc: {family: 'glibc', minimumVersion: linuxGlibcMinimumVersion}}
      : {}),
    ...(targetId === 'macos-arm64'
      ? {minimumSystemVersion: macosMinimumSystemVersion}
      : {}),
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
    sourceSha256: traceProcessorSourceSha256,
    sha256: traceProcessorSha256,
  },
  macos: {
    signed: signed === 'true',
    notarized: notarized === 'true',
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

write_readme() {
  local package_dir="$1"
  local target="$2"
  local version="$3"
  local notarized="${4:-false}"
  local macos_minimum_system_version="${5:-}"
  case "$target" in
    windows-x64)
      cat > "$package_dir/README-WINDOWS.txt" <<README
SmartPerfetto Windows x64 package
Version: $version
Minimum OS: Windows 10 or Windows Server 2016

Run:
  1. Extract the zip to a normal local path, for example C:\\SmartPerfetto.
  2. Double-click SmartPerfetto.exe.
  3. Open http://127.0.0.1:10000 if the browser does not open automatically.

User data and logs:
  %LOCALAPPDATA%\\SmartPerfetto
  %LOCALAPPDATA%\\SmartPerfetto\\logs

On first launch, SmartPerfetto migrates data from an older package's data
directory when it is in the current or a sibling extracted package. To choose
the old package explicitly:
  SmartPerfetto.exe --migrate-from "C:\\path\\to\\old-package"

The old data is preserved. To keep data beside the executable instead, set
SMARTPERFETTO_PORTABLE_MODE=1 before launching; automatic migration is disabled.

AI analysis needs either a Provider profile configured in the UI or env credentials.
To use env credentials, create %LOCALAPPDATA%\\SmartPerfetto\\env with provider
settings, then restart SmartPerfetto.exe.

Logs:
  %LOCALAPPDATA%\\SmartPerfetto\\logs\\backend.log
  %LOCALAPPDATA%\\SmartPerfetto\\logs\\frontend.log
README
      ;;
    macos-arm64)
      local gatekeeper_guidance
      if [ "$notarized" = true ]; then
        gatekeeper_guidance="This package is Developer ID signed and notarized by Apple."
      else
        gatekeeper_guidance="If macOS blocks this non-notarized build, Control-click SmartPerfetto.app and
choose Open. For a package you trust, you can also remove quarantine with:
  xattr -dr com.apple.quarantine SmartPerfetto.app"
      fi
      cat > "$package_dir/README-MACOS.txt" <<README
SmartPerfetto macOS arm64 package
Version: $version
System requirement: macOS $macos_minimum_system_version or newer on Apple silicon.

Run:
  1. Extract the zip.
  2. Double-click SmartPerfetto.app.
  3. Open http://127.0.0.1:10000 if the browser does not open automatically.

$gatekeeper_guidance

User data:
  ~/Library/Application Support/SmartPerfetto

Logs:
  ~/Library/Logs/SmartPerfetto

AI analysis needs either a Provider profile configured in the UI or env credentials.
To use env credentials, create ~/Library/Application Support/SmartPerfetto/env,
then restart SmartPerfetto.app.
README
      ;;
    linux-x64)
      cat > "$package_dir/README-LINUX.txt" <<README
SmartPerfetto Linux x64 package
Version: $version
System requirement: glibc 2.34 or newer. musl-based distributions such as
Alpine Linux are not supported by this archive.

Run:
  1. Extract the tar.gz.
  2. Run ./SmartPerfetto.
  3. Open http://127.0.0.1:10000 if the browser does not open automatically.

User data:
  \${XDG_DATA_HOME:-~/.local/share}/smartperfetto

Logs:
  \${XDG_STATE_HOME:-~/.local/state}/smartperfetto/logs

AI analysis needs either a Provider profile configured in the UI or env credentials.
To use env credentials, create \${XDG_DATA_HOME:-~/.local/share}/smartperfetto/env,
then restart SmartPerfetto.
README
      ;;
  esac
}

create_macos_app_bundle() {
  local package_dir="$1"
  local app_dir="$package_dir/SmartPerfetto.app"
  local resources_dir="$app_dir/Contents/Resources"
  mkdir -p "$app_dir/Contents/MacOS" "$resources_dir"
  cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>SmartPerfetto</string>
  <key>CFBundleIdentifier</key>
  <string>com.gracker.smartperfetto</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>SmartPerfetto</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>__VERSION__</string>
  <key>CFBundleVersion</key>
  <string>__VERSION__</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.5</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
  node -e "const fs=require('fs');const p=process.argv[1];const v=process.argv[2];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('__VERSION__',v));" "$app_dir/Contents/Info.plist" "$PACKAGE_VERSION"
  printf 'APPL????' > "$app_dir/Contents/PkgInfo"
}

sign_macos_payloads() {
  local app_dir="$1"
  local identity="${SMARTPERFETTO_MACOS_SIGN_IDENTITY:-}"
  local sign_args=(--force --options runtime)
  require_command codesign
  if [ -n "$identity" ]; then
    echo "Signing macOS app with identity: $identity"
    sign_args+=(--timestamp --sign "$identity")
  else
    echo "Ad-hoc signing macOS app bundle..."
    sign_args+=(--sign -)
  fi
  while IFS= read -r -d '' file; do
    if codesign --display "$file" >/dev/null 2>&1; then
      codesign "${sign_args[@]}" \
        --preserve-metadata=identifier,entitlements \
        "$file"
    else
      codesign "${sign_args[@]}" "$file"
    fi
  done < <(node "$PROJECT_ROOT/scripts/find-macho-files.cjs" --null "$app_dir/Contents")
}

sign_macos_container() {
  local app_dir="$1"
  local identity="${SMARTPERFETTO_MACOS_SIGN_IDENTITY:-}"
  local sign_args=(--force --options runtime)
  require_command codesign
  if [ -n "$identity" ]; then
    sign_args+=(--timestamp --sign "$identity")
  else
    sign_args+=(--sign -)
  fi
  codesign "${sign_args[@]}" "$app_dir"
  codesign --verify --deep --strict "$app_dir"
}

notarize_macos_zip() {
  local zip_path="$1"
  local app_dir="$2"
  local receipt_path="$3"
  local profile="${SMARTPERFETTO_MACOS_NOTARY_PROFILE:-}"
  local submit_result="${zip_path}.submit-result.json"
  local info_result="${zip_path}.info-result.json"
  local submission_id=""
  if [ -z "$profile" ]; then
    return 0
  fi
  if [ -z "${SMARTPERFETTO_MACOS_SIGN_IDENTITY:-}" ]; then
    echo "ERROR: SMARTPERFETTO_MACOS_NOTARY_PROFILE requires SMARTPERFETTO_MACOS_SIGN_IDENTITY." >&2
    return 1
  fi
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "ERROR: required command 'xcrun' is not installed." >&2
    return 1
  fi
  echo "Submitting macOS package for notarization..."
  rm -f "$submit_result" "$info_result" "$receipt_path"
  if ! xcrun notarytool submit \
    "$zip_path" \
    --keychain-profile "$profile" \
    --wait \
    --output-format json > "$submit_result"; then
    rm -f "$submit_result" "$info_result" "$receipt_path"
    return 1
  fi
  if ! submission_id="$(
    node - "$submit_result" <<'NODE'
const fs = require('fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (
  response.status !== 'Accepted' ||
  typeof response.id !== 'string' ||
  !/^[0-9a-f-]{36}$/i.test(response.id)
) {
  throw new Error(`notarytool submit did not return Accepted: ${JSON.stringify(response)}`);
}
process.stdout.write(response.id);
NODE
  )"; then
    rm -f "$submit_result" "$info_result" "$receipt_path"
    return 1
  fi
  if ! xcrun notarytool info \
    "$submission_id" \
    --keychain-profile "$profile" \
    --output-format json > "$info_result"; then
    rm -f "$submit_result" "$info_result" "$receipt_path"
    return 1
  fi
  if ! node - "$info_result" "$receipt_path" "$submission_id" <<'NODE'
const fs = require('fs');
const [infoPath, receiptPath, expectedId] = process.argv.slice(2);
const response = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
if (response.status !== 'Accepted' || response.id !== expectedId) {
  throw new Error(`notarytool info did not confirm Accepted: ${JSON.stringify(response)}`);
}
fs.writeFileSync(receiptPath, `${JSON.stringify({
  schemaVersion: 1,
  submissionId: response.id,
  status: response.status,
}, null, 2)}\n`, {mode: 0o600});
NODE
  then
    rm -f "$submit_result" "$info_result" "$receipt_path"
    return 1
  fi
  rm -f "$submit_result" "$info_result"
  xcrun stapler staple "$app_dir" || return 1
}

archive_package() {
  local package_dir="$1"
  local package_name="$2"
  local target="$3"
  local asset_path="$4"
  case "$(target_field "$target" asset_ext)" in
    zip)
      (
        cd "$OUT_ROOT"
        zip -qry "$asset_path" "$package_name"
      )
      ;;
    tar.gz)
      "$PROJECT_ROOT/scripts/create-portable-tar.sh" \
        "$OUT_ROOT" \
        "$package_name" \
        "$asset_path"
      ;;
    *)
      echo "ERROR: unsupported archive extension for $target" >&2
      exit 1
      ;;
  esac
}

archive_package_atomically() {
  local package_dir="$1"
  local package_name="$2"
  local target="$3"
  local asset_path="$4"
  local partial_path="${asset_path}.partial"
  assert_staging_tree_safe "$package_dir"
  rm -f "$partial_path"
  if ! archive_package "$package_dir" "$package_name" "$target" "$partial_path"; then
    rm -f "$partial_path"
    return 1
  fi
  mv "$partial_path" "$asset_path"
}

package_target() {
  local target="$1"
  local os_name arch_name package_name package_dir resources_dir asset_ext asset_path
  local node_sha node_file node_dir node_runtime_version node_archive node_dir_suffix
  local perfetto_version tp_sha_key tp_sha trace_name trace_prebuilt_key tp_prebuilt tp_actual_sha
  local packaged_tp_sha
  local signed=false notarized=false signing_mode=unsigned
  local macos_resources_dir notary_submission_path=""
  local macos_minimum_system_version=""

  os_name="$(target_field "$target" os_name)"
  arch_name="$(target_field "$target" arch_name)"
  package_name="smartperfetto-v${PACKAGE_VERSION}-${os_name}-${arch_name}"
  package_dir="$OUT_ROOT/$package_name"
  asset_ext="$(target_field "$target" asset_ext)"
  asset_path="$OUT_ROOT/$package_name.$asset_ext"
  if [ "$target" = "macos-arm64" ]; then
    notary_submission_path="$OUT_ROOT/$package_name.notary-submission.$asset_ext"
  fi

  echo ""
  echo "Packaging $target..."
  rm -rf "$package_dir"
  rm -f "$asset_path"
  if [ -n "$notary_submission_path" ]; then
    rm -f "$notary_submission_path"
  fi
  mkdir -p "$package_dir"

  resources_dir="$package_dir"
  if [ "$target" = "macos-arm64" ]; then
    resources_dir="$package_dir/.staging-resources"
    signed=true
    signing_mode=macos-adhoc
    if [ -n "${SMARTPERFETTO_MACOS_SIGN_IDENTITY:-}" ]; then
      signing_mode=macos-developer-id
    fi
    if [ -n "${SMARTPERFETTO_MACOS_NOTARY_PROFILE:-}" ]; then
      notarized=true
      signing_mode=macos-developer-id-notarized
    fi
  fi

  echo "Resolving Node.js runtime for $target..."
  read -r node_sha node_file < <(resolve_node_release "$target")
  node_dir="${node_file%.zip}"
  node_dir="${node_dir%.tar.gz}"
  node_dir="${node_dir%.tar.xz}"
  node_dir_suffix="$(target_field "$target" node_dir_suffix)"
  node_runtime_version="$(echo "$node_file" | sed -E "s/^node-v//; s/-${node_dir_suffix}\\.(zip|tar\\.gz|tar\\.xz)$//")"

  copy_backend_payload "$resources_dir"
  install_target_dependencies "$target" "$resources_dir/backend" "$node_runtime_version"

  echo "Downloading Node.js runtime for $target..."
  node_archive="$CACHE_DIR/$node_file"
  download_checked "https://nodejs.org/dist/v${node_runtime_version}/$node_file" "$node_archive" "$node_sha"
  extract_node_runtime "$node_archive" "$node_dir" "$target"
  mkdir -p "$resources_dir/runtime"
  copy_dir "$CACHE_DIR/$node_dir" "$resources_dir/runtime/node"
  materialize_portable_links "$resources_dir/runtime/node"

  echo "Copying bundled trace_processor_shell for $target..."
  perfetto_version="$(pin_value PERFETTO_VERSION)"
  tp_sha_key="$(target_field "$target" perfetto_sha_key)"
  tp_sha="$(pin_value "$tp_sha_key")"
  trace_name="$(target_field "$target" trace_name)"
  trace_prebuilt_key="$(target_field "$target" trace_prebuilt_key)"
  if [ -z "$perfetto_version" ] || [ -z "$tp_sha" ]; then
    echo "ERROR: missing trace_processor_shell pin values for $target." >&2
    exit 1
  fi
  tp_prebuilt="$PROJECT_ROOT/backend/prebuilts/trace_processor/$trace_prebuilt_key/$trace_name"
  if [ ! -f "$tp_prebuilt" ]; then
    echo "ERROR: missing bundled trace_processor_shell for $target: $tp_prebuilt" >&2
    echo "Run: npm run trace-processor:sync-prebuilts" >&2
    exit 1
  fi
  tp_actual_sha="$(sha256_file "$tp_prebuilt")"
  if [ "$tp_actual_sha" != "$tp_sha" ]; then
    echo "ERROR: bundled trace_processor_shell SHA256 mismatch for $target." >&2
    echo "  expected: $tp_sha" >&2
    echo "  actual:   $tp_actual_sha" >&2
    echo "Run: npm run trace-processor:sync-prebuilts" >&2
    exit 1
  fi
  mkdir -p "$resources_dir/bin"
  cp "$tp_prebuilt" "$resources_dir/bin/$trace_name"
  if [ "$target" != "windows-x64" ]; then
    chmod +x "$resources_dir/bin/$trace_name"
  fi

  if [ "$target" = "macos-arm64" ]; then
    macos_resources_dir="$package_dir/SmartPerfetto.app/Contents/Resources"
    create_macos_app_bundle "$package_dir"
    rm -rf "$macos_resources_dir"
    mv "$resources_dir" "$macos_resources_dir"
    resources_dir="$macos_resources_dir"
  fi

  echo "Building launcher for $target..."
  if [ "$target" = "macos-arm64" ]; then
    (
      cd "$PROJECT_ROOT/scripts/portable-launcher"
      GO111MODULE=off GOOS="$(target_field "$target" goos)" GOARCH="$(target_field "$target" goarch)" \
        go build -trimpath -ldflags="-s -w -X main.version=$PACKAGE_VERSION -X main.gitCommit=$GIT_COMMIT -X main.packageTarget=$target -X main.signingMode=$signing_mode" \
        -o "$package_dir/SmartPerfetto.app/Contents/MacOS/SmartPerfetto" .
    )
  else
    (
      cd "$PROJECT_ROOT/scripts/portable-launcher"
      GO111MODULE=off GOOS="$(target_field "$target" goos)" GOARCH="$(target_field "$target" goarch)" \
        go build -trimpath -ldflags="-s -w -X main.version=$PACKAGE_VERSION -X main.gitCommit=$GIT_COMMIT -X main.packageTarget=$target -X main.signingMode=$signing_mode" \
        -o "$package_dir/$(target_field "$target" launcher_name)" .
    )
  fi

  if [ "$target" = "macos-arm64" ]; then
    macos_minimum_system_version="$(
      node "$PROJECT_ROOT/scripts/native-runtime-compat.cjs" \
        --update-macos-info \
        "$package_dir/SmartPerfetto.app" \
        "$MACOS_MINIMUM_SYSTEM_VERSION"
    )"
    echo "macOS minimum system version: $macos_minimum_system_version"
    sign_macos_payloads "$package_dir/SmartPerfetto.app"
  fi
  write_readme \
    "$package_dir" \
    "$target" \
    "$PACKAGE_VERSION" \
    "$notarized" \
    "$macos_minimum_system_version"
  packaged_tp_sha="$(sha256_file "$resources_dir/bin/$trace_name")"
  write_manifest "$package_dir/PACKAGE-MANIFEST.json" \
    "$PACKAGE_VERSION" "$package_name" "$target" "$GIT_COMMIT" "$GIT_DIRTY" \
    "$node_runtime_version" "$node_file" "$node_sha" "$perfetto_version" "$tp_sha" \
    "$packaged_tp_sha" "$signed" "$notarized" "$signing_mode" \
    "$macos_minimum_system_version"
  if [ "$target" = "macos-arm64" ]; then
    cp "$package_dir/PACKAGE-MANIFEST.json" "$resources_dir/PACKAGE-MANIFEST.json"
    sign_macos_container "$package_dir/SmartPerfetto.app"
  fi

  echo "Creating archive for $target..."
  if [ "$target" = "macos-arm64" ] && [ -n "${SMARTPERFETTO_MACOS_NOTARY_PROFILE:-}" ]; then
    if ! archive_package_atomically \
      "$package_dir" "$package_name" "$target" "$notary_submission_path"; then
      rm -f "$notary_submission_path" "$asset_path"
      return 1
    fi
    if ! notarize_macos_zip \
      "$notary_submission_path" \
      "$package_dir/SmartPerfetto.app" \
      "$package_dir/NOTARIZATION-RECEIPT.json"; then
      rm -f "$notary_submission_path" "$asset_path"
      echo "ERROR: macOS notarization failed; no final release archive was created." >&2
      return 1
    fi
    rm -f "$notary_submission_path"
    archive_package_atomically "$package_dir" "$package_name" "$target" "$asset_path"
  else
    archive_package_atomically "$package_dir" "$package_name" "$target" "$asset_path"
  fi

  if [ "$target" = "macos-arm64" ] && [ "$notarized" = true ]; then
    node "$PROJECT_ROOT/scripts/verify-portable-package.cjs" \
      --asset "$asset_path" \
      --target "$target" \
      --version "$PACKAGE_VERSION" \
      --commit "$GIT_COMMIT" \
      --public-release
  else
    node "$PROJECT_ROOT/scripts/verify-portable-package.cjs" \
      --asset "$asset_path" \
      --target "$target" \
      --version "$PACKAGE_VERSION" \
      --commit "$GIT_COMMIT"
  fi

  echo "Portable package ready:"
  echo "  $asset_path"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --targets)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --targets requires a comma-separated argument." >&2
        exit 2
      fi
      append_targets_csv "$2"
      shift 2
      ;;
    --target)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --target requires an argument." >&2
        exit 2
      fi
      TARGETS+=("$2")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

require_command curl
require_command git
require_command go
require_command node
require_command npm
require_command rsync
require_command tar
require_command unzip
require_command zip

smartperfetto_ensure_node "$PROJECT_ROOT"
smartperfetto_ensure_backend_deps "$PROJECT_ROOT"
node "$PROJECT_ROOT/scripts/sync-version.cjs" --check
PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$PROJECT_ROOT/package.json")"
GIT_COMMIT="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
GIT_DIRTY=false
if [ -n "$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=normal)" ]; then
  GIT_DIRTY=true
fi

echo "Checking frontend prebuild..."
node "$PROJECT_ROOT/scripts/check-frontend-prebuild.cjs"

echo "Verifying bundled Android Internals Knowledge Pack..."
(cd "$PROJECT_ROOT/backend" && npm run knowledge-pack:fetch)

echo "Building backend runtime from a clean output directory..."
(cd "$PROJECT_ROOT/backend" && npm run build)
echo "Checking backend runtime..."
assert_backend_runtime_clean

mkdir -p "$OUT_ROOT" "$CACHE_DIR"
for target in "${TARGETS[@]}"; do
  package_target "$target"
done
