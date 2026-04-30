#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

# Push both repos: perfetto submodule (fork) first, then main project (origin).
# Always push submodule before main to avoid broken submodule references.

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -f ".gitmodules" ]; then
  echo "ERROR: Not in project root (no .gitmodules found)"
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)

# --- Step 1: Push perfetto submodule to fork ---
echo "=== Pushing perfetto submodule ==="
cd perfetto

PERFETTO_BRANCH=$(git branch --show-current)

if ! git remote | grep -q "^fork$"; then
  echo "ERROR: No 'fork' remote in perfetto submodule."
  echo "Run: cd perfetto && git remote add fork git@github.com:Gracker/perfetto.git"
  exit 1
fi

# Check if there are commits to push
if [ -n "$(git log "fork/${PERFETTO_BRANCH}..HEAD" --oneline 2>/dev/null)" ]; then
  echo "Pushing perfetto ($PERFETTO_BRANCH) to fork..."
  git push fork "$PERFETTO_BRANCH"
  echo "Perfetto submodule pushed."
else
  echo "Perfetto submodule is up to date."
fi

cd "$PROJECT_ROOT"

# --- Step 2: Push main project to origin ---
echo ""
echo "=== Pushing main project ==="

if [ -n "$(git log "origin/${CURRENT_BRANCH}..HEAD" --oneline 2>/dev/null)" ]; then
  echo "Pushing main project ($CURRENT_BRANCH) to origin..."
  git push origin "$CURRENT_BRANCH"
  echo "Main project pushed."
else
  echo "Main project is up to date."
fi

echo ""
echo "Done. Both repos pushed."
