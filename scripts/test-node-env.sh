#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_HOME="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

mkdir -p "$TMP_HOME/.nvm"
cat > "$TMP_HOME/.nvm/nvm.sh" <<'NVM'
[ -z "$NVM_DIR" ] && export NVM_DIR="$HOME/.nvm"
nvm() {
  return 0
}
NVM

# shellcheck disable=SC2016
HOME="$TMP_HOME" env -u NVM_DIR bash -u -c '
  . "$1/scripts/node-env.sh"
  smartperfetto_load_nvm
  test "${NVM_DIR:-}" = "$HOME/.nvm"
' bash "$PROJECT_ROOT"

mkdir -p "$TMP_HOME/tools" "$TMP_HOME/.volta/bin"
cat > "$TMP_HOME/tools/volta" <<'VOLTA'
#!/bin/sh
if [ "$1" = "fetch" ]; then
  exit 0
fi
exit 1
VOLTA
chmod +x "$TMP_HOME/tools/volta"

cat > "$TMP_HOME/.volta/bin/node" <<'NODE'
#!/bin/sh
if [ "$1" = "-e" ]; then
  printf 24
else
  echo v24.15.0
fi
NODE
chmod +x "$TMP_HOME/.volta/bin/node"

# shellcheck disable=SC2016
HOME="$TMP_HOME" PATH="$TMP_HOME/tools:/usr/bin:/bin" env -u VOLTA_HOME -u NVM_DIR -u npm_config_prefix bash -u -c '
  . "$1/scripts/node-env.sh"
  smartperfetto_try_switch_node "$1" "24"
  test "$(command -v node)" = "$HOME/.volta/bin/node"
  test "$(smartperfetto_node_major)" = "24"
' bash "$PROJECT_ROOT"

# A colored terminal (FORCE_COLOR) must not decorate the version the scripts compare.
# shellcheck disable=SC2016
FORCE_COLOR=1 bash -u -c '
  . "$1/scripts/node-env.sh"
  major="$(smartperfetto_node_major)"
  abi="$(smartperfetto_node_modules_abi)"
  case "$major$abi" in *[!0-9]*|"") echo "uncolored version expected, got: $major / $abi" >&2; exit 1 ;; esac
' bash "$PROJECT_ROOT"

echo "node-env tests passed"
