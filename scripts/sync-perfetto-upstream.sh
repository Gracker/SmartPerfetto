#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Merge latest changes from google/perfetto upstream into the fork.
#
# Remotes in perfetto/:
#   origin = https://github.com/google/perfetto.git  (upstream, read-only)
#   fork   = git@github.com:Gracker/perfetto.git     (our fork, push here)
#
# Flow: fetch origin/main → merge into current branch → push to fork

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -d "perfetto/.git" ]; then
  echo "ERROR: perfetto submodule not initialized."
  echo "Run: git submodule update --init --recursive"
  exit 1
fi

# Check clean working trees
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Main project has uncommitted changes. Commit or stash first."
  exit 1
fi

cd perfetto

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Perfetto submodule has uncommitted changes. Commit or stash first."
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)
echo "Perfetto branch: $CURRENT_BRANCH"

# Ensure fork remote exists
if ! git remote | grep -q "^fork$"; then
  echo "Adding fork remote..."
  git remote add fork git@github.com:Gracker/perfetto.git
fi

# Fetch upstream
echo "Fetching upstream (google/perfetto)..."
git fetch origin main

# Check if there are new commits
COMMIT_COUNT=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")

if [ "$COMMIT_COUNT" -eq 0 ]; then
  echo "Already up to date with upstream."
  exit 0
fi

echo "$COMMIT_COUNT new upstream commits."
echo ""
echo "Latest upstream commits:"
git log --oneline origin/main -5
echo ""

read -r -p "Merge $COMMIT_COUNT commits? (Y/n) " -n 1
echo
if [[ "$REPLY" =~ ^[Nn]$ ]]; then
  echo "Cancelled."
  exit 0
fi

# Merge
echo "Merging origin/main..."
if git merge origin/main --no-edit; then
  echo "Merge successful (no conflicts)."
else
  echo ""
  echo "CONFLICT! Resolve manually:"
  echo "  cd perfetto"
  echo "  git status          # see conflicted files"
  echo "  # ... fix conflicts ..."
  echo "  git add <files>"
  echo "  git commit"
  echo "  git push fork $CURRENT_BRANCH"
  echo "  cd .."
  echo "  git add perfetto && git commit"
  exit 1
fi

# Push to fork
echo "Pushing to fork/$CURRENT_BRANCH..."
git push fork "$CURRENT_BRANCH"

# Update main project submodule pointer
cd "$PROJECT_ROOT"
git add perfetto

if ! git diff --cached --quiet; then
  PERFETTO_SHORT=$(cd perfetto && git rev-parse --short HEAD)
  git commit -m "chore: sync perfetto upstream (now at $PERFETTO_SHORT)"
  echo ""
  echo "Done. Main project updated. Run 'git push origin main' or './scripts/push-all.sh'."
else
  echo "Submodule pointer unchanged."
fi
