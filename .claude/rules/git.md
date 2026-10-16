# Git and Submodule Rules

## Root Workflow

Inspect live status, preserve unrelated work, validate the affected tier, and
stage only task-owned files. Commit/push when authorized. Generated logs,
`dist/portable`, `dist/windows-exe`, build caches and local agent settings stay
untracked. Public release sequence belongs to [release](release.md), not a
second Git checklist.

## Dependency Impact

Use GitNexus for shared behavior/module/schema/public-contract changes or uncertain
nontrivial impact; docs and behavior-preserving local edits need no graph refresh.
The graph is a radar, not authority: cross-check direct references, source,
tests and [product surfaces](product-surface.md). If needed, inspect status and
refresh with `gitnexus analyze --index-only --default-branch main`; do not run
setup or let indexing rewrite guides/install Skills. `.gitnexusignore` owns
coverage and `.gitnexus/` remains untracked.

Prefer MCP impact/change detection or their CLI equivalents. Analyze upstream
impact (depth 3, tests, confidence >=0.8), then staged changes before committing;
use all-worktree scope only when all edits are authorized. HIGH/CRITICAL results
need behavior investigation, not automatic caller rewrites. If unavailable or
outside reliable coverage, inspect source/direct references/tests and report the
material gap; do not turn implementation into graph repair.

## Perfetto Landing and Anchoring

Root `origin` is SmartPerfetto. Inside `perfetto/`, `origin` is Google upstream
and `fork` is Gracker's fork. Never push product changes to upstream `origin`.

1. Commit submodule changes and push to `fork`.
2. Anchor the commit on `fork/main`, not merely a feature branch.
3. Refresh required committed frontend output following [frontend](frontend.md).
4. Commit/push root gitlink and task-owned generated artifacts only after anchoring.

Before root gitlink publication and before deleting any submodule branch:

```bash
git -C perfetto fetch --prune fork
GITLINK=$(git ls-tree HEAD perfetto | awk '{print $3}')
git -C perfetto merge-base --is-ancestor "$GITLINK" fork/main
```

A failed check requires resolving/landing the submodule first; never force-push
`fork/main` to manufacture reachability. Remote HEAD or branch containment is
insufficient. Before branch deletion also check every release tag's gitlink:

```bash
for t in $(git tag); do
  gl=$(git ls-tree "$t" perfetto 2>/dev/null | awk '{print $3}')
  [ -n "$gl" ] || continue
  git -C perfetto merge-base --is-ancestor "$gl" fork/main 2>/dev/null \
    || echo "ORPHAN: $t -> $gl"
done
```

Anchor every reported orphan before deleting its only reachable branch. Public
recursive clones and historical release tags must remain usable. Read
[perfetto-sync](perfetto-sync.md) for upstream/processor/prebuilt upgrades.
