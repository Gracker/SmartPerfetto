#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_ROOT="${SMARTPERFETTO_PORTABLE_OUT_DIR:-$PROJECT_ROOT/dist/portable}"
VERSION=""
DRAFT=true
PRERELEASE=false
SKIP_BUILD=false
ALLOW_DIRTY=false
GH_REPO=""
TARGETS=()
DEFAULT_TARGETS=("windows-x64" "macos-arm64" "linux-x64")

usage() {
  cat <<'USAGE'
Usage:
  npm run release:portable -- <version> [options]

Options:
  --targets LIST       Comma-separated targets. Default: windows-x64,macos-arm64,linux-x64.
  --target TARGET      Add one target. May be repeated.
  --no-draft           Publish immediately instead of creating a draft release.
  --prerelease         Mark the release as a prerelease.
  --skip-build         Reuse existing dist/portable assets for the version.
  --allow-dirty        Allow uploading a draft/test package built from uncommitted changes.
  -R, --repo REPO      Pass a GitHub repo override to gh, for example Gracker/SmartPerfetto.

Examples:
  npm run release:portable -- 1.0.3
  npm run release:portable -- 1.0.3 --no-draft
  npm run release:portable -- 1.0.3 --targets windows-x64
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

target_os() {
  case "$1" in
    windows-x64) echo "windows" ;;
    macos-arm64) echo "macos" ;;
    linux-x64) echo "linux" ;;
    *) echo "ERROR: unsupported target: $1" >&2; exit 2 ;;
  esac
}

target_arch() {
  case "$1" in
    windows-x64|linux-x64) echo "x64" ;;
    macos-arm64) echo "arm64" ;;
    *) echo "ERROR: unsupported target: $1" >&2; exit 2 ;;
  esac
}

target_ext() {
  case "$1" in
    windows-x64|macos-arm64) echo "zip" ;;
    linux-x64) echo "tar.gz" ;;
    *) echo "ERROR: unsupported target: $1" >&2; exit 2 ;;
  esac
}

target_usage() {
  case "$1" in
    windows-x64) echo "Extract the zip and double-click SmartPerfetto.exe." ;;
    macos-arm64) echo "Extract the zip and double-click SmartPerfetto.app." ;;
    linux-x64) echo "Extract the tar.gz and run ./SmartPerfetto." ;;
    *) echo "" ;;
  esac
}

asset_name_for_target() {
  local target="$1"
  echo "smartperfetto-v${VERSION}-$(target_os "$target")-$(target_arch "$target").$(target_ext "$target")"
}

asset_path_for_target() {
  echo "$OUT_ROOT/$(asset_name_for_target "$1")"
}

assert_clean_worktree() {
  if [ "$ALLOW_DIRTY" = true ]; then
    return
  fi
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo "ERROR: refusing to upload release packages from a dirty worktree." >&2
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

  local target asset_name remote_asset
  for target in "${TARGETS[@]}"; do
    asset_name="$(asset_name_for_target "$target")"
    remote_asset="$(gh_release view "$TAG" --json assets --jq ".assets[] | select(.name == \"$asset_name\") | .name")"
    if [ "$remote_asset" != "$asset_name" ]; then
      echo "ERROR: release $TAG does not contain expected asset $asset_name after upload." >&2
      exit 1
    fi
  done
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
if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

require_command gh
require_command git
require_command node
require_command tar
require_command unzip

cd "$PROJECT_ROOT"

node scripts/sync-version.cjs --check "$VERSION"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
TARGET_SHA="$(git rev-parse HEAD)"

assert_clean_worktree

if [ "$SKIP_BUILD" = false ]; then
  target_csv="$(IFS=,; echo "${TARGETS[*]}")"
  npm run package:portable -- --targets "$target_csv"
  assert_clean_worktree
fi

verify_args_common=(--version "$VERSION" --commit "$TARGET_SHA")
if [ "$ALLOW_DIRTY" = false ]; then
  verify_args_common+=(--require-clean)
fi

assets=()
asset_lines=()
for target in "${TARGETS[@]}"; do
  asset_path=""
  asset_name=""
  asset_sha=""
  asset_size=""
  asset_path="$(asset_path_for_target "$target")"
  asset_name="$(asset_name_for_target "$target")"
  if [ ! -f "$asset_path" ]; then
    echo "ERROR: release asset not found: $asset_path" >&2
    echo "Run npm run package:portable, or remove --skip-build." >&2
    exit 1
  fi
  node scripts/verify-portable-package.cjs \
    --asset "$asset_path" \
    --target "$target" \
    "${verify_args_common[@]}"
  asset_sha="$(sha256_file "$asset_path")"
  asset_size="$(file_size_bytes "$asset_path")"
  assets+=("$asset_path#$asset_name")
  asset_lines+=("- ${asset_name} — SHA256: \`${asset_sha}\`, Size: ${asset_size} bytes, Usage: $(target_usage "$target")")
done

gh auth status >/dev/null

NOTES_FILE="$(mktemp -t smartperfetto-portable-release.XXXXXX.md)"
trap 'rm -f "$NOTES_FILE"' EXIT

{
  echo "SmartPerfetto portable release."
  echo ""
  echo "Assets:"
  printf '%s\n' "${asset_lines[@]}"
  echo ""
  echo "Target commit: \`$TARGET_SHA\`"
} > "$NOTES_FILE"

create_args=(create "$TAG" "${assets[@]}" --title "SmartPerfetto $TAG" --notes-file "$NOTES_FILE" --target "$TARGET_SHA")
edit_args=(edit "$TAG" --title "SmartPerfetto $TAG" --notes-file "$NOTES_FILE" --target "$TARGET_SHA")
if [ "$DRAFT" = true ]; then
  create_args+=(--draft)
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
  for asset in "${assets[@]}"; do
    gh_release upload "$TAG" "$asset" --clobber
  done
  gh_release "${edit_args[@]}"
else
  gh_release "${create_args[@]}"
fi

verify_remote_release

echo "Portable release assets uploaded:"
echo "  tag: $TAG"
for target in "${TARGETS[@]}"; do
  echo "  - $(asset_name_for_target "$target")"
done
