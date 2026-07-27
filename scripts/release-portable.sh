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
SMOKE_EVIDENCE_DIR=""
SMOKE_ATTESTATION_FILE=""
SMOKE_RUN_ID=""
RELEASE_COMMIT=""
TARGETS=()
DEFAULT_TARGETS=("windows-x64" "macos-arm64" "linux-x64")

usage() {
  cat <<'USAGE'
Usage:
  npm run release:portable -- <version> [options]

Options:
  --targets LIST       Comma-separated targets. Default: windows-x64,macos-arm64,linux-x64.
  --target TARGET      Add one target. May be repeated.
  --no-draft           Promote an existing exact three-asset draft without uploading or replacing assets.
  --prerelease         Mark the release as a prerelease.
  --skip-build         Reuse existing dist/portable assets for the version.
  --smoke-evidence-dir DIR
                       Directory containing <target>/smoke-summary.json evidence
                       and optional hosted workflow-context.json files.
  --smoke-attestation FILE
                       Combined all-target hosted workflow attestation.
  --smoke-run-id ID    Successful hosted workflow run that produced the
                       digest-verified combined evidence artifact.
  --release-commit SHA Exact existing draft target commit. Promotion-only; use
                       when the fixed gate code is newer than the release bytes.
  --allow-dirty        Allow uploading a draft/test package built from uncommitted changes.
  -R, --repo REPO      Pass a GitHub repo override to gh, for example Gracker/SmartPerfetto.

Examples:
  npm run release:portable -- 1.0.3
  npm run release:portable -- 1.0.3 --skip-build --no-draft --smoke-evidence-dir <dir>
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

run_portable_build() {
  local target_csv="$1"
  local name
  local build_env=("PATH=$PATH")
  for name in \
    HOME TMPDIR TMP TEMP LANG LANGUAGE LC_ALL TERM SHELL USER LOGNAME \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy \
    SSL_CERT_DIR SSL_CERT_FILE NODE_EXTRA_CA_CERTS \
    NVM_DIR VOLTA_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME \
    DEVELOPER_DIR \
    SMARTPERFETTO_NODE_MAJOR \
    SMARTPERFETTO_PORTABLE_OUT_DIR SMARTPERFETTO_PORTABLE_CACHE_DIR \
    SMARTPERFETTO_MACOS_SIGN_IDENTITY SMARTPERFETTO_MACOS_NOTARY_PROFILE
  do
    if [ -n "${!name:-}" ]; then
      build_env+=("$name=${!name}")
    fi
  done
  env -i "${build_env[@]}" npm run package:portable -- --targets "$target_csv"
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

release_id_for_tag() {
  local release_id
  release_id="$(gh_release view "$TAG" --json databaseId --jq '.databaseId')"
  if [[ ! "$release_id" =~ ^[0-9]+$ ]]; then
    echo "ERROR: GitHub returned an invalid release id for $TAG: ${release_id:-<empty>}" >&2
    exit 1
  fi
  echo "$release_id"
}

verify_remote_release() {
  local release_id="$1"
  local require_complete="$2"
  local expected_draft="$3"
  local remote_json="$4"
  local baseline_json="${5:-}"
  gh api "repos/$REPO_SLUG/releases/$release_id" > "$remote_json"
  node - "$remote_json" "$EXPECTED_ASSETS_FILE" "$TARGET_SHA" "SmartPerfetto $TAG" "$TAG" "$PRERELEASE" "$require_complete" "$expected_draft" "$release_id" "$baseline_json" <<'NODE'
const fs = require('fs');
const [
  remoteFile,
  expectedFile,
  targetSha,
  expectedName,
  expectedTag,
  prerelease,
  requireComplete,
  expectedDraft,
  expectedReleaseId,
  baselineFile,
] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
const expected = fs.readFileSync(expectedFile, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const [name, size, digest] = line.split('\t');
    return {name, size: Number(size), digest};
  });
function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
if (release.id !== Number(expectedReleaseId)) {
  fail(`release id mismatch: expected ${expectedReleaseId}, got ${release.id || '<empty>'}`);
}
if (release.tag_name !== expectedTag) {
  fail(`release tag mismatch: expected ${expectedTag}, got ${release.tag_name || '<empty>'}`);
}
if (release.target_commitish !== targetSha) {
  fail(`release target mismatch: expected ${targetSha}, got ${release.target_commitish || '<empty>'}`);
}
if (release.name !== expectedName) {
  fail(`release name mismatch: expected ${expectedName}, got ${release.name || '<empty>'}`);
}
if (Boolean(release.prerelease) !== (prerelease === 'true')) {
  fail(`release prerelease flag mismatch`);
}
if (Boolean(release.draft) !== (expectedDraft === 'true')) {
  fail(`release draft flag mismatch: expected ${expectedDraft}, got ${Boolean(release.draft)}`);
}
const remoteAssets = Array.isArray(release.assets) ? release.assets : [];
for (const asset of expected) {
  const remote = remoteAssets.find(item => item.name === asset.name);
  if (!remote) fail(`release is missing ${asset.name}`);
  if (!Number.isInteger(remote.id) || remote.id <= 0) {
    fail(`${asset.name} has an invalid asset id`);
  }
  if (remote.state !== 'uploaded') {
    fail(`${asset.name} is not in the uploaded state`);
  }
  if (remote.size !== asset.size) {
    fail(`${asset.name} size mismatch: expected ${asset.size}, got ${remote.size}`);
  }
  if (remote.digest !== asset.digest) {
    fail(`${asset.name} digest mismatch: expected ${asset.digest}, got ${remote.digest || '<empty>'}`);
  }
}
if (requireComplete === 'true') {
  if (expected.length !== 3) fail('publishing requires all three default platform assets');
  const expectedNames = new Set(expected.map(asset => asset.name));
  const unexpected = remoteAssets.filter(asset => !expectedNames.has(asset.name));
  if (remoteAssets.length !== expected.length || unexpected.length > 0) {
    fail(`published release asset set is not exact: ${remoteAssets.map(asset => asset.name).join(', ')}`);
  }
}
if (baselineFile) {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const releaseIdentity = value => ({
    id: value.id,
    tag_name: value.tag_name,
    target_commitish: value.target_commitish,
    name: value.name,
    prerelease: Boolean(value.prerelease),
    assets: (Array.isArray(value.assets) ? value.assets : [])
      .map(asset => ({
        id: asset.id,
        name: asset.name,
        state: asset.state,
        size: asset.size,
        digest: asset.digest,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
  if (JSON.stringify(releaseIdentity(release)) !== JSON.stringify(releaseIdentity(baseline))) {
    fail('release or asset identity changed while publishing the verified draft');
  }
}
NODE
}

asset_id_from_release_json() {
  local remote_json="$1"
  local asset_name="$2"
  node - "$remote_json" "$asset_name" <<'NODE'
const fs = require('fs');
const [remoteFile, assetName] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
const matches = (Array.isArray(release.assets) ? release.assets : [])
  .filter(asset => asset.name === assetName);
if (matches.length !== 1 || !Number.isInteger(matches[0].id) || matches[0].id <= 0) {
  console.error(`ERROR: could not resolve one immutable asset id for ${assetName}`);
  process.exit(1);
}
process.stdout.write(String(matches[0].id));
NODE
}

targets_are_complete() {
  if [ "${#TARGETS[@]}" -ne "${#DEFAULT_TARGETS[@]}" ]; then
    return 1
  fi
  local expected found target candidate
  for expected in "${DEFAULT_TARGETS[@]}"; do
    found=false
    for target in "${TARGETS[@]}"; do
      if [ "$target" = "$expected" ]; then
        found=true
        break
      fi
    done
    if [ "$found" != true ]; then
      return 1
    fi
  done
  for target in "${TARGETS[@]}"; do
    candidate=false
    for expected in "${DEFAULT_TARGETS[@]}"; do
      if [ "$target" = "$expected" ]; then
        candidate=true
      fi
    done
    if [ "$candidate" != true ]; then
      return 1
    fi
  done
  return 0
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
    --smoke-evidence-dir)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --smoke-evidence-dir requires a directory." >&2
        exit 2
      fi
      SMOKE_EVIDENCE_DIR="$2"
      shift 2
      ;;
    --release-commit)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --release-commit requires a full commit SHA." >&2
        exit 2
      fi
      RELEASE_COMMIT="$2"
      shift 2
      ;;
    --smoke-attestation)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --smoke-attestation requires a file." >&2
        exit 2
      fi
      SMOKE_ATTESTATION_FILE="$2"
      shift 2
      ;;
    --smoke-run-id)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --smoke-run-id requires a numeric Actions run id." >&2
        exit 2
      fi
      SMOKE_RUN_ID="$2"
      shift 2
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
if [ "$DRAFT" = false ] && ! targets_are_complete; then
  echo "ERROR: --no-draft requires exactly windows-x64,macos-arm64,linux-x64." >&2
  exit 2
fi
if [ "$DRAFT" = false ] && [ "$ALLOW_DIRTY" = true ]; then
  echo "ERROR: --allow-dirty is limited to draft verification and cannot be combined with --no-draft." >&2
  exit 2
fi
if [ "$DRAFT" = false ] && [ "$SKIP_BUILD" != true ]; then
  echo "ERROR: --no-draft requires --skip-build so the published bytes exactly match target-native smoke evidence." >&2
  exit 2
fi
if [ "$DRAFT" = false ] && [ -z "$SMOKE_EVIDENCE_DIR" ]; then
  echo "ERROR: --no-draft requires --smoke-evidence-dir with all three target-native summaries." >&2
  exit 2
fi
if [ -n "$RELEASE_COMMIT" ] && [ "$DRAFT" != false ]; then
  echo "ERROR: --release-commit is limited to --no-draft promotion." >&2
  exit 2
fi
if { [ -n "$SMOKE_RUN_ID" ] || [ -n "$SMOKE_ATTESTATION_FILE" ]; } && [ "$DRAFT" != false ]; then
  echo "ERROR: hosted smoke provenance options are limited to --no-draft promotion." >&2
  exit 2
fi
if [ -n "$SMOKE_RUN_ID" ] && [[ ! "$SMOKE_RUN_ID" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --smoke-run-id must be a positive integer." >&2
  exit 2
fi
if { [ -n "$SMOKE_RUN_ID" ] && [ -z "$SMOKE_ATTESTATION_FILE" ]; } ||
   { [ -z "$SMOKE_RUN_ID" ] && [ -n "$SMOKE_ATTESTATION_FILE" ]; }; then
  echo "ERROR: --smoke-run-id and --smoke-attestation must be provided together." >&2
  exit 2
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
GATE_SHA="$(git rev-parse HEAD)"
TARGET_SHA="$GATE_SHA"
if [ -n "$RELEASE_COMMIT" ]; then
  if [[ ! "$RELEASE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: --release-commit must be a full 40-character commit SHA." >&2
    exit 2
  fi
  TARGET_SHA="$(printf '%s' "$RELEASE_COMMIT" | tr '[:upper:]' '[:lower:]')"
  if ! git cat-file -e "$TARGET_SHA^{commit}" 2>/dev/null; then
    echo "ERROR: release commit is not available locally: $TARGET_SHA" >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$TARGET_SHA" "$GATE_SHA"; then
    echo "ERROR: release commit $TARGET_SHA is not an ancestor of gate commit $GATE_SHA." >&2
    exit 1
  fi
fi

assert_clean_worktree

if [ "$SKIP_BUILD" = false ]; then
  target_csv="$(IFS=,; echo "${TARGETS[*]}")"
  run_portable_build "$target_csv"
  assert_clean_worktree
fi

verify_args_common=(--version "$VERSION" --commit "$TARGET_SHA")
if [ "$ALLOW_DIRTY" = false ]; then
  verify_args_common+=(--require-clean)
fi
if [ "$DRAFT" = false ]; then
  verify_args_common+=(--public-release)
fi

assets=()
asset_lines=()
EXPECTED_ASSETS_FILE="$(mktemp -t smartperfetto-portable-assets.XXXXXX.tsv)"
trap 'rm -f "$EXPECTED_ASSETS_FILE"' EXIT
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
  if [ "$DRAFT" = false ]; then
    smoke_summary="$SMOKE_EVIDENCE_DIR/$target/smoke-summary.json"
    if [ ! -f "$smoke_summary" ] || [ -L "$smoke_summary" ]; then
      echo "ERROR: target-native smoke evidence not found: $smoke_summary" >&2
      exit 1
    fi
    node scripts/verify-portable-smoke-evidence.cjs \
      --summary "$smoke_summary" \
      --asset "$asset_path" \
      --target "$target" \
      --version "$VERSION" \
      --commit "$TARGET_SHA" \
      --require-public-release
  fi
  asset_sha="$(sha256_file "$asset_path")"
  asset_size="$(file_size_bytes "$asset_path")"
  assets+=("$asset_path#$asset_name")
  asset_lines+=("- ${asset_name} — SHA256: \`${asset_sha}\`, Size: ${asset_size} bytes, Usage: $(target_usage "$target")")
  printf '%s\t%s\tsha256:%s\n' "$asset_name" "$asset_size" "$asset_sha" >> "$EXPECTED_ASSETS_FILE"
done

gh auth status >/dev/null
if [ -n "$GH_REPO" ]; then
  REPO_SLUG="$GH_REPO"
else
  REPO_SLUG="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

NOTES_FILE="$(mktemp -t smartperfetto-portable-release.XXXXXX.md)"
REMOTE_RELEASE_FILE="$(mktemp -t smartperfetto-portable-remote.XXXXXX.json)"
PREPUBLISH_RELEASE_FILE="$(mktemp -t smartperfetto-portable-prepublish.XXXXXX.json)"
FINAL_PREPUBLISH_RELEASE_FILE="$(mktemp -t smartperfetto-portable-final-prepublish.XXXXXX.json)"
trap 'rm -f "$NOTES_FILE" "$EXPECTED_ASSETS_FILE" "$REMOTE_RELEASE_FILE" "$PREPUBLISH_RELEASE_FILE" "$FINAL_PREPUBLISH_RELEASE_FILE"' EXIT

{
  echo "SmartPerfetto portable release."
  echo ""
  echo "Assets:"
  printf '%s\n' "${asset_lines[@]}"
  echo ""
  echo "Target commit: \`$TARGET_SHA\`"
} > "$NOTES_FILE"

create_args=(create "$TAG" --draft --title "SmartPerfetto $TAG" --notes-file "$NOTES_FILE" --target "$TARGET_SHA")
edit_args=(edit "$TAG" --draft=true --title "SmartPerfetto $TAG" --notes-file "$NOTES_FILE" --target "$TARGET_SHA")
if [ "$PRERELEASE" = true ]; then
  create_args+=(--prerelease)
  edit_args+=(--prerelease)
else
  edit_args+=(--prerelease=false)
fi

release_exists=false
if gh_release view "$TAG" --json isDraft --jq '.isDraft' >/dev/null 2>&1; then
  release_exists=true
fi

if [ "$DRAFT" = false ]; then
  if [ "$release_exists" != true ]; then
    echo "ERROR: --no-draft only promotes an existing verified draft; it never creates or uploads release assets." >&2
    exit 1
  fi
  release_id="$(release_id_for_tag)"
  existing_draft="$(gh_release view "$TAG" --json isDraft --jq '.isDraft')"
  if [ "$existing_draft" != "true" ]; then
    verify_remote_release "$release_id" true false "$REMOTE_RELEASE_FILE"
    echo "Published release already matches the local assets exactly; no changes made: $TAG"
    exit 0
  fi
  verify_remote_release "$release_id" true true "$PREPUBLISH_RELEASE_FILE"
  hosted_context_count=0
  for target in "${TARGETS[@]}"; do
    workflow_context="$SMOKE_EVIDENCE_DIR/$target/workflow-context.json"
    if [ -e "$workflow_context" ]; then
      hosted_context_count=$((hosted_context_count + 1))
      if [ ! -f "$workflow_context" ] || [ -L "$workflow_context" ]; then
        echo "ERROR: hosted workflow context must be a regular file: $workflow_context" >&2
        exit 1
      fi
      asset_path="$(asset_path_for_target "$target")"
      asset_name="$(asset_name_for_target "$target")"
      asset_id="$(asset_id_from_release_json "$PREPUBLISH_RELEASE_FILE" "$asset_name")"
      node scripts/verify-portable-smoke-evidence.cjs \
        --summary "$SMOKE_EVIDENCE_DIR/$target/smoke-summary.json" \
        --asset "$asset_path" \
        --target "$target" \
        --version "$VERSION" \
        --commit "$TARGET_SHA" \
        --require-public-release \
        --release-json "$PREPUBLISH_RELEASE_FILE" \
        --release-id "$release_id" \
        --asset-id "$asset_id" \
        --workflow-context "$workflow_context"
    fi
  done
  if [ "$hosted_context_count" -gt 0 ]; then
    if [ "$hosted_context_count" -ne "${#DEFAULT_TARGETS[@]}" ]; then
      echo "ERROR: hosted promotion evidence requires workflow context for all three targets." >&2
      exit 1
    fi
    if [ -z "$SMOKE_RUN_ID" ] || [ -z "$SMOKE_ATTESTATION_FILE" ]; then
      echo "ERROR: hosted workflow evidence requires --smoke-run-id and --smoke-attestation." >&2
      exit 1
    fi
    if [ ! -f "$SMOKE_ATTESTATION_FILE" ] || [ -L "$SMOKE_ATTESTATION_FILE" ]; then
      echo "ERROR: hosted smoke attestation must be a regular file: $SMOKE_ATTESTATION_FILE" >&2
      exit 1
    fi
    node scripts/verify-portable-smoke-attestation.cjs \
      --attestation "$SMOKE_ATTESTATION_FILE" \
      --evidence-dir "$SMOKE_EVIDENCE_DIR" \
      --release-json "$PREPUBLISH_RELEASE_FILE" \
      --repository "$REPO_SLUG" \
      --release-id "$release_id" \
      --version "$VERSION" \
      --commit "$TARGET_SHA" \
      --run-id "$SMOKE_RUN_ID" \
      --gate-sha "$GATE_SHA"
  elif [ -n "$SMOKE_RUN_ID" ] || [ -n "$SMOKE_ATTESTATION_FILE" ]; then
    echo "ERROR: hosted smoke provenance was provided without hosted workflow contexts." >&2
    exit 1
  fi
  verify_remote_release \
    "$release_id" \
    true \
    true \
    "$FINAL_PREPUBLISH_RELEASE_FILE" \
    "$PREPUBLISH_RELEASE_FILE"
  gh api \
    --method PATCH \
    "repos/$REPO_SLUG/releases/$release_id" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -F draft=false \
    > "$REMOTE_RELEASE_FILE"
  published="$(gh_release view "$TAG" --json isDraft --jq '.isDraft')"
  if [ "$published" != "false" ]; then
    echo "ERROR: release $TAG was not published after verification." >&2
    exit 1
  fi
  verify_remote_release \
    "$release_id" \
    true \
    false \
    "$REMOTE_RELEASE_FILE" \
    "$FINAL_PREPUBLISH_RELEASE_FILE"
else
  if [ "$release_exists" = true ]; then
    release_id="$(release_id_for_tag)"
    existing_draft="$(gh_release view "$TAG" --json isDraft --jq '.isDraft')"
    if [ "$existing_draft" != "true" ]; then
      verify_remote_release "$release_id" true false "$REMOTE_RELEASE_FILE"
      echo "Published release already matches the local assets exactly; no changes made: $TAG"
      exit 0
    fi
    remote_target="$(gh_release view "$TAG" --json targetCommitish --jq '.targetCommitish')"
    if [ "$remote_target" != "$TARGET_SHA" ]; then
      echo "ERROR: refusing to modify draft $TAG for a different target commit." >&2
      echo "  expected: $TARGET_SHA" >&2
      echo "  actual:   ${remote_target:-<empty>}" >&2
      exit 1
    fi
    gh_release "${edit_args[@]}"
    for asset in "${assets[@]}"; do
      gh_release upload "$TAG" "$asset" --clobber
    done
  else
    gh_release "${create_args[@]}"
    for asset in "${assets[@]}"; do
      gh_release upload "$TAG" "$asset"
    done
    release_id="$(release_id_for_tag)"
  fi
  verify_remote_release "$release_id" false true "$REMOTE_RELEASE_FILE"
fi

echo "Portable release assets uploaded:"
echo "  tag: $TAG"
for target in "${TARGETS[@]}"; do
  echo "  - $(asset_name_for_target "$target")"
done
