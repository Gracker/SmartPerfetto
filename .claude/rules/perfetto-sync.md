# Perfetto Upstream Sync Rules

Read this file before syncing, rebasing, merging, or upgrading the official
Perfetto fork/submodule, trace processor prebuilts, Perfetto SQL docs, stdlib
indexes, or committed Perfetto UI prebuild.

Perfetto sync is a product upgrade, not a vendor drop. SmartPerfetto carries a
forked Perfetto UI, an AI Assistant plugin, committed frontend bundles, backend
SQL/stdlib knowledge, trace processor prebuilts, Skills, Strategies, and release
assets that must stay consistent.

## Required Context

Before editing:

1. Inspect root and submodule status:
   ```bash
   git status --short --branch
   git -C perfetto status --short --branch
   ```
2. Read the related rules:
   - `.claude/rules/frontend.md`
   - `.claude/rules/git.md`
   - `.claude/rules/testing.md`
   - `.claude/rules/prompts.md` when Skills or Strategies will change
   - `.claude/rules/release.md` when the work will be published or packaged
3. Confirm the upstream Perfetto tag or commit being synced. Do not upgrade
   unrelated pinned tools just because Perfetto changed.

## Sync Sequence

Use this order unless the task has a narrower explicit scope:

1. Fetch official Perfetto in `perfetto/` and choose the upstream tag or commit.
2. Merge or rebase onto the SmartPerfetto fork branch.
3. Resolve conflicts by preserving both upstream behavior and SmartPerfetto
   custom behavior. Do not drop `com.smartperfetto.AIAssistant` plugin entry
   points, toolbar entry points, generated API contracts, or provider UI state.
4. Regenerate dependency lockfiles with the Perfetto-supported package manager
   version for that tree. Do not rewrite lockfiles with an arbitrary local tool
   version.
5. Stop stale Perfetto UI watch/dev processes before rebuilding. Clear stale
   `perfetto/out/ui/watch.lock` only after confirming the owning process is gone.
6. Rebuild or regenerate the affected Perfetto UI outputs. After browser
   verification, stop the HMR dev server and run
   `(cd perfetto && tools/node ui/build.mjs)` so the production bundle and CSS
   exist before refreshing the committed prebuild.
7. Refresh the committed `frontend/` prebuild with `./scripts/update-frontend.sh`
   when the plugin UI, Perfetto UI bundle, or generated UI assets changed.
8. Update trace processor prebuilts and pin files only when that runtime is part
   of the sync. Keep independent recording-tool pins separate unless the task
   explicitly updates them too.
9. Regenerate Perfetto SQL docs, SQL indexes, stdlib symbols, and light indexes
   from the exact trace-processor runtime revision with
   `cd backend && npm run stdlib:generate-runtime-assets`; this creates one
   temporary revision worktree for all outputs. Do not generate runtime
   knowledge from the UI fork HEAD or hand-edit generated data.
10. Feed new Perfetto SQL, stdlib, metric, or trace semantics into
    `backend/skills/` and `backend/strategies/` where they improve actual
    analysis quality. Do not stop at updating raw index files.
11. Run independent review or structured self-review focused on release risk,
    generated assets, trace processor pins, submodule reachability, and
    SmartPerfetto AI Assistant preservation.

## Conflict Policy

- Treat UI conflicts as dual-intent merges. Preserve upstream UI changes and
  SmartPerfetto AI entry points unless there is a reviewed reason to remove one.
- Do not hardcode prompt or analysis behavior in TypeScript while adapting to
  new Perfetto knowledge. Put analysis guidance in Skills, Strategies, or shared
  strategy templates.
- Generated files must be regenerated from their source. If a generated file is
  wrong, fix the generator, source input, or template.
- Keep user, Docker, portable, and source-checkout surfaces aligned. A local
  `start-dev.sh` success does not prove the committed `frontend/` path works.

## Verification

Run the smallest tier that proves the sync, but a broad Perfetto upstream sync
usually needs all of these:

```bash
git diff --check
npm run check:frontend-prebuild
npm --prefix backend run cli:e2e
cd backend && npm run test:scene-trace-regression
```

Also verify the submodule commit is reachable from the fork remote before
landing the root gitlink:

```bash
git -C perfetto branch --contains HEAD
git -C perfetto ls-remote fork HEAD
```

When the sync changes Skills or Strategies, also run:

```bash
cd backend && npm run validate:skills
cd backend && npm run validate:strategies
```

When the sync changes AI Assistant plugin UI, verify the UI in dev mode at
`http://localhost:10000`, run relevant Perfetto UI tests or typecheck for the
touched files, then refresh and check the committed prebuild.

When the sync changes public release assets, npm CLI packaging, Docker
consumption, or portable packaging, follow `.claude/rules/release.md` and the
packaging verification tier in `.claude/rules/testing.md`.

## Landing Order

If `perfetto/` changed:

1. Commit inside `perfetto/`.
2. Push the submodule commit to the `fork` remote, never upstream `origin`.
3. Confirm the pushed commit is reachable from `fork`.
4. Return to the root repository.
5. Stage the root gitlink, refreshed `frontend/`, updated pins, regenerated
   SQL/stdlib data, and Skill/Strategy changes that belong to the sync.
6. Commit and push the root repository only after the submodule commit is
   reachable.

Do not push a root commit that points at a local-only Perfetto submodule commit.

## Review Checklist

Before calling the sync done, explicitly check:

- SmartPerfetto AI Assistant plugin still registers and appears in the UI.
- Provider Manager/runtime provider pinning semantics are unchanged.
- `frontend/index.html` points at the active committed `frontend/v*` bundle.
- Required wasm/js assets, manifest files, and static assistant assets exist in
  the committed frontend bundle.
- Trace processor version and packaged prebuilts match the intended runtime pin.
- SQL docs, stdlib symbols, Skills, and Strategies agree on the new Perfetto
  schema/stdlib capabilities.
- Scene trace regression still passes on the canonical traces.
- The root repository and `perfetto/` submodule have no unrelated staged files.
