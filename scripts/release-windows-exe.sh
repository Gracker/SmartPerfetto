#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=""
DRAFT=true
PRERELEASE=false
SKIP_BUILD=false
ALLOW_DIRTY=false
GH_REPO=""

usage() {
  cat <<'USAGE'
Usage:
  npm run release:windows-exe -- <version> [options]

Options:
  --no-draft       Publish immediately instead of creating a draft release.
  --prerelease     Mark the release as a prerelease.
  --skip-build     Reuse dist/windows-exe/smartperfetto-v<version>-windows-x64.zip.
  --allow-dirty    Allow uploading a draft/test package built from uncommitted changes.
  -R, --repo REPO  Pass a GitHub repo override to gh, for example Gracker/SmartPerfetto.

Examples:
  npm run release:windows-exe -- 1.0.1
  npm run release:windows-exe -- 1.0.1 --no-draft
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

file_size_bytes() {
  local file="$1"
  if stat -f%z "$file" >/dev/null 2>&1; then
    stat -f%z "$file"
  else
    stat -c%s "$file"
  fi
}

gh_release() {
  if [ -n "$GH_REPO" ]; then
    gh release "$@" -R "$GH_REPO"
  else
    gh release "$@"
  fi
}

assert_clean_worktree() {
  if [ "$ALLOW_DIRTY" = true ]; then
    return
  fi
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo "ERROR: refusing to upload a release package from a dirty worktree." >&2
    echo "Commit the version/source changes first, or rerun with --allow-dirty for a draft/test upload." >&2
    exit 1
  fi
}

verify_remote_release() {
  local remote_target
  remote_target="$(gh_release view "$TAG" --json targetCommitish --jq '.targetCommitish')"
  if [ "$remote_target" != "$TARGET_SHA" ]; then
    echo "ERROR: release $TAG target mismatch after upload." >&2
    echo "  expected: $TARGET_SHA" >&2
    echo "  actual:   ${remote_target:-<empty>}" >&2
    exit 1
  fi

  local remote_asset
  remote_asset="$(gh_release view "$TAG" --json assets --jq ".assets[] | select(.name == \"$ASSET_NAME\") | .name")"
  if [ "$remote_asset" != "$ASSET_NAME" ]; then
    echo "ERROR: release $TAG does not contain expected asset $ASSET_NAME after upload." >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-draft)
      DRAFT=false
      shift
      ;;
    --prerelease)
      PRERELEASE=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      shift
      ;;
    -R|--repo)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: $1 requires a repository argument." >&2
        exit 2
      fi
      GH_REPO="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "ERROR: version provided more than once." >&2
        usage
        exit 2
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "ERROR: release version is required." >&2
  usage
  exit 2
fi

require_command gh
require_command git
require_command node
require_command unzip

cd "$PROJECT_ROOT"

node scripts/sync-version.cjs --check "$VERSION"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
ASSET_NAME="smartperfetto-v${VERSION}-windows-x64.zip"
ASSET_PATH="$PROJECT_ROOT/dist/windows-exe/$ASSET_NAME"
TARGET_SHA="$(git rev-parse HEAD)"

assert_clean_worktree

if [ "$SKIP_BUILD" = false ]; then
  npm run package:windows-exe
  assert_clean_worktree
fi

if [ ! -f "$ASSET_PATH" ]; then
  echo "ERROR: release asset not found: $ASSET_PATH" >&2
  echo "Run npm run package:windows-exe, or remove --skip-build." >&2
  exit 1
fi

verify_args=(--zip "$ASSET_PATH" --version "$VERSION" --commit "$TARGET_SHA")
if [ "$ALLOW_DIRTY" = false ]; then
  verify_args+=(--require-clean)
fi
node scripts/verify-windows-package.cjs "${verify_args[@]}"

gh auth status >/dev/null

ASSET_SHA="$(sha256_file "$ASSET_PATH")"
ASSET_SIZE="$(file_size_bytes "$ASSET_PATH")"
NOTES_FILE="$(mktemp -t smartperfetto-windows-release.XXXXXX.md)"
trap 'rm -f "$NOTES_FILE"' EXIT

cat > "$NOTES_FILE" <<NOTES
SmartPerfetto Windows x64 release.

Download:

- ${ASSET_NAME}

Usage:

1. Extract the zip to a normal local directory.
2. Double-click SmartPerfetto.exe.
3. Open http://localhost:10000 if the browser does not open automatically.

Asset verification:

- SHA256: \`${ASSET_SHA}\`
- Size: ${ASSET_SIZE} bytes
- Target commit: \`${TARGET_SHA}\`
NOTES

create_args=(create "$TAG" "$ASSET_PATH#$ASSET_NAME" --title "SmartPerfetto $TAG" --notes-file "$NOTES_FILE" --target "$TARGET_SHA")
edit_args=(edit "$TAG" --title "SmartPerfetto $TAG" --notes-file "$NOTES_FILE" --target "$TARGET_SHA")
if [ "$DRAFT" = true ]; then
  create_args+=(--draft)
  edit_args+=(--draft)
else
  edit_args+=(--draft=false)
fi
if [ "$PRERELEASE" = true ]; then
  create_args+=(--prerelease)
  edit_args+=(--prerelease)
else
  edit_args+=(--prerelease=false)
fi

if gh_release view "$TAG" >/dev/null 2>&1; then
  gh_release upload "$TAG" "$ASSET_PATH#$ASSET_NAME" --clobber
  gh_release "${edit_args[@]}"
else
  gh_release "${create_args[@]}"
fi

verify_remote_release

echo "Windows release asset uploaded:"
echo "  tag:   $TAG"
echo "  asset: $ASSET_NAME"
echo "  sha:   $ASSET_SHA"
