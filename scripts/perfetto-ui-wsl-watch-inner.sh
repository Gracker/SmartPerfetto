#!/usr/bin/env bash
# wsl 中运行 Perfetto UI dev：需已存在 perfetto 子模块和 ui node_modules
set -e
WSL_PROOT="${1:?}"
LOG_WSL="${2:?}"
cd "$WSL_PROOT/perfetto/ui" || exit 1
exec node build.js --no-depscheck --only-wasm-memory64 --serve --watch >> "$LOG_WSL" 2>&1
