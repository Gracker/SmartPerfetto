#!/usr/bin/env bash
# Run from WSL. Arg $1: SmartPerfetto repo root in Unix form (e.g. /mnt/d/SmartPerfetto)
set -e
ROOT="${1:?usage: perfetto-ui-wsl-build-inner.sh /mnt/.../SmartPerfetto}"
cd "$ROOT/perfetto"
# 首次需 Linux emsdk（仅 mac 以外走 linux64/emsdk，含 WSL）
if [ ! -d "buildtools/linux64/emsdk" ]; then
  echo "First WSL run: install-build-deps --ui (several minutes, needs python3)..." >&2
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found in WSL" >&2
    exit 1
  fi
  python3 tools/install-build-deps --ui
fi
if [ ! -d "ui/node_modules" ] && [ ! -f "ui/node_modules/.last_install" ]; then
  echo "ui/node_modules missing; run pnpm in perfetto/ui from Windows (npm run dev:win) first" >&2
  exit 1
fi
exec node ui/build.js --no-depscheck
