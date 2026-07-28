#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Shared Node.js bootstrap for local SmartPerfetto scripts.
# The project intentionally runs on Node 24 LTS. Native modules such as
# better-sqlite3 are ABI-bound, so reusing node_modules across Node 20/25/24
# can crash the backend at runtime.

SMARTPERFETTO_NODE_MAJOR="${SMARTPERFETTO_NODE_MAJOR:-24}"

smartperfetto_node_spec() {
  local project_root="$1"
  if [ -f "$project_root/.nvmrc" ]; then
    tr -d '[:space:]' < "$project_root/.nvmrc"
  else
    printf '%s\n' "$SMARTPERFETTO_NODE_MAJOR"
  fi
}

smartperfetto_node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0\n'
}

smartperfetto_node_modules_abi() {
  node -p "process.versions.modules" 2>/dev/null || printf 'unknown\n'
}

smartperfetto_prepend_path_once() {
  local dir="$1"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) export PATH="$dir:$PATH" ;;
  esac
}

smartperfetto_find_volta() {
  local candidate
  if command -v volta >/dev/null 2>&1; then
    command -v volta
    return 0
  fi

  for candidate in "$HOME/.volta/bin/volta" "/opt/homebrew/bin/volta" "/usr/local/bin/volta"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

smartperfetto_load_nvm() {
  local nvm_sh=""
  if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
    nvm_sh="$NVM_DIR/nvm.sh"
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    nvm_sh="$HOME/.nvm/nvm.sh"
  elif [ -s "/opt/homebrew/opt/nvm/nvm.sh" ]; then
    nvm_sh="/opt/homebrew/opt/nvm/nvm.sh"
  elif [ -s "/usr/local/opt/nvm/nvm.sh" ]; then
    nvm_sh="/usr/local/opt/nvm/nvm.sh"
  fi

  if [ -z "$nvm_sh" ]; then
    return 1
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  # shellcheck source=/dev/null
  . "$nvm_sh"
  command -v nvm >/dev/null 2>&1
}

smartperfetto_try_switch_volta() {
  local project_root="$1"
  local node_spec="$2"
  local volta_bin

  volta_bin="$(smartperfetto_find_volta)" || return 1

  export VOLTA_HOME="${VOLTA_HOME:-$HOME/.volta}"
  smartperfetto_prepend_path_once "$VOLTA_HOME/bin"

  echo "Switching to Node.js $node_spec via Volta..."
  "$volta_bin" fetch "node@$node_spec" >/dev/null 2>&1 || true

  (
    cd "$project_root" || exit 1
    [ "$(smartperfetto_node_major)" = "$SMARTPERFETTO_NODE_MAJOR" ]
  )
}

smartperfetto_try_switch_node() {
  local project_root="$1"
  local node_spec="$2"

  if smartperfetto_try_switch_volta "$project_root" "$node_spec"; then
    return 0
  fi

  if smartperfetto_load_nvm; then
    echo "Switching to Node.js $node_spec via nvm..."
    unset npm_config_prefix
    nvm install "$node_spec" || return 1
    nvm use "$node_spec" || return 1
    return 0
  fi

  if command -v fnm >/dev/null 2>&1; then
    echo "Switching to Node.js $node_spec via fnm..."
    eval "$(fnm env --shell bash)"
    fnm install "$node_spec" || return 1
    fnm use "$node_spec" || return 1
    return 0
  fi

  return 1
}

smartperfetto_ensure_node() {
  local project_root="$1"
  local node_spec
  local current_major

  node_spec="$(smartperfetto_node_spec "$project_root")"
  current_major="$(smartperfetto_node_major)"

  if [ "$current_major" = "$SMARTPERFETTO_NODE_MAJOR" ]; then
    return 0
  fi

  echo "=============================================="
  echo "SmartPerfetto requires Node.js $SMARTPERFETTO_NODE_MAJOR LTS."
  if command -v node >/dev/null 2>&1; then
    echo "Current node: $(node -v) ($(command -v node))"
    echo "Current ABI:  $(smartperfetto_node_modules_abi)"
  else
    echo "Current node: not found"
  fi
  echo "=============================================="

  if smartperfetto_try_switch_node "$project_root" "$node_spec"; then
    current_major="$(smartperfetto_node_major)"
    if [ "$current_major" = "$SMARTPERFETTO_NODE_MAJOR" ]; then
      echo "Using node: $(node -v) ($(command -v node))"
      return 0
    fi
  fi

  echo "ERROR: failed to activate Node.js $SMARTPERFETTO_NODE_MAJOR."
  echo ""
  echo "Install and use Node.js $SMARTPERFETTO_NODE_MAJOR, then rerun:"
  echo "  volta setup && volta fetch node@$node_spec"
  echo "  nvm install $node_spec && nvm use $node_spec"
  echo ""
  echo "If a version manager is installed but not initialized, initialize one of these paths first:"
  echo "  export VOLTA_HOME=\"\$HOME/.volta\""
  echo "  export PATH=\"\$VOLTA_HOME/bin:\$PATH\""
  echo "  export NVM_DIR=\"\$HOME/.nvm\""
  echo "  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\""
  echo '  [ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"'
  echo '  [ -s "/usr/local/opt/nvm/nvm.sh" ] && . "/usr/local/opt/nvm/nvm.sh"'
  echo ""
  echo "One-shot workaround:"
  echo "  NVM_DIR=\"\$HOME/.nvm\" ./start.sh"
  echo ""
  echo "The repo includes .nvmrc/.node-version so most shells can auto-select it."
  return 1
}

smartperfetto_file_sha256() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    cksum "$file" | awk '{print $1}'
  fi
}

smartperfetto_source_build_commit() {
  local project_root="$1"
  local commit=""

  if command -v git >/dev/null 2>&1; then
    commit="$(git -C "$project_root" rev-parse --verify HEAD 2>/dev/null || true)"
  fi
  if [ -n "$commit" ]; then
    printf '%s\n' "$commit"
    return 0
  fi
  printf '%s\n' "${SMARTPERFETTO_BUILD_COMMIT:-}"
}

smartperfetto_backend_lock_hash() {
  local project_root="$1"
  smartperfetto_file_sha256 "$project_root/backend/package-lock.json"
}

smartperfetto_backend_marker_value() {
  local marker="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$marker" 2>/dev/null | head -n 1
}

smartperfetto_write_backend_marker() {
  local project_root="$1"
  local marker="$project_root/backend/node_modules/.smartperfetto-node-abi"

  {
    echo "node=$(node -v)"
    echo "modules=$(smartperfetto_node_modules_abi)"
    echo "lock_sha256=$(smartperfetto_backend_lock_hash "$project_root")"
  } > "$marker"
}

smartperfetto_verify_backend_native_modules() {
  local project_root="$1"
  (
    cd "$project_root/backend" || exit 1
    node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();"
    node <<'NODE'
const fs = require('fs');
const path = require('path');

function detectClaudeAgentSdkPackageKey() {
  if (process.platform === 'linux') {
    const report = typeof process.report?.getReport === 'function'
      ? process.report.getReport()
      : undefined;
    const glibc = report?.header?.glibcVersionRuntime;
    return `linux-${process.arch}${glibc ? '' : '-musl'}`;
  }
  return `${process.platform}-${process.arch}`;
}

const sdkMain = require.resolve('@anthropic-ai/claude-agent-sdk');
const nodeModules = path.resolve(path.dirname(sdkMain), '..', '..');
const packageName = `@anthropic-ai/claude-agent-sdk-${detectClaudeAgentSdkPackageKey()}`;
const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
const binaryPath = path.join(nodeModules, ...packageName.split('/'), binaryName);

if (!fs.existsSync(binaryPath)) {
  console.error(`Missing Claude Agent SDK native binary: ${binaryPath}`);
  console.error('Reinstall backend dependencies with optional dependencies enabled: npm ci --include=optional');
  process.exit(1);
}

if (process.platform !== 'win32') {
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    console.error(`Claude Agent SDK native binary is not executable: ${binaryPath}`);
    process.exit(1);
  }
}
NODE
  )
}

smartperfetto_install_backend_deps() {
  local project_root="$1"
  (
    cd "$project_root/backend" || exit 1
    if [ -f package-lock.json ]; then
      npm ci --include=optional
    else
      npm install --include=optional
    fi
  )
  smartperfetto_write_backend_marker "$project_root"
}

smartperfetto_ensure_backend_deps() {
  local project_root="$1"
  local node_modules="$project_root/backend/node_modules"
  local marker="$node_modules/.smartperfetto-node-abi"
  local current_abi
  local current_lock_hash
  local marker_abi
  local marker_lock_hash
  local reason=""

  smartperfetto_ensure_node "$project_root" || return 1

  current_abi="$(smartperfetto_node_modules_abi)"
  current_lock_hash="$(smartperfetto_backend_lock_hash "$project_root")"

  if [ ! -d "$node_modules" ]; then
    reason="backend dependencies not found"
  elif [ ! -f "$marker" ]; then
    reason="backend dependencies were installed before Node ABI tracking was added"
  else
    marker_abi="$(smartperfetto_backend_marker_value "$marker" modules)"
    marker_lock_hash="$(smartperfetto_backend_marker_value "$marker" lock_sha256)"
    if [ "$marker_abi" != "$current_abi" ]; then
      reason="Node ABI changed from ${marker_abi:-unknown} to $current_abi"
    elif [ "$marker_lock_hash" != "$current_lock_hash" ]; then
      reason="backend package-lock.json changed"
    fi
  fi

  if [ -n "$reason" ]; then
    echo "Installing backend dependencies ($reason)..."
    rm -rf "$node_modules"
    smartperfetto_install_backend_deps "$project_root"
  fi

  if ! smartperfetto_verify_backend_native_modules "$project_root" >/dev/null 2>&1; then
    echo "Backend native module check failed; reinstalling dependencies for Node $(node -v)..."
    rm -rf "$node_modules"
    smartperfetto_install_backend_deps "$project_root"
    smartperfetto_verify_backend_native_modules "$project_root"
  fi

  smartperfetto_write_backend_marker "$project_root"
}
