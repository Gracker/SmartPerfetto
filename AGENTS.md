# SmartPerfetto Agent Guide

This is the canonical project guide. `CLAUDE.md` and `GEMINI.md` import it;
keep adapter files minimal and maintain area contracts in `.claude/rules/`.

## Working Approach

- Communicate in Simplified Chinese unless requested otherwise. Lead with the
  outcome, then the evidence and material gaps; keep identifiers in English.
- Inspect the live worktree, relevant source, tests and scoped rules before
  editing. Current code and runtime evidence take precedence over history.
  Search memory only when prior decisions matter to the task.
- Complete authorized implementation, verification and necessary repairs.
  Decide routine reversible details yourself; ask only about an unresolved
  choice that materially changes scope, acceptance or an irreversible action.
- Preserve unrelated edits and user data. Do not format, revert, stage or clean
  other work. Remove only this task's disposable artifacts.
- For non-trivial work, state the files, order, dependencies and risks, then
  Execute -> Verify -> Revise. Review architecture boundaries and simplify the
  task-owned diff without changing its behavior or contracts.
- Use independent read-only review for material architecture, security,
  release, shared-state or public-contract risk. Other work needs a concise
  plan and diff review. Follow [agent-orchestration](.claude/rules/agent-orchestration.md)
  when delegating; if no stable reviewer is available, record self-review as
  the fallback. Do not call Codex to review itself.
- Use repository-defined, executable checks at the smallest applicable tier in
  [testing](.claude/rules/testing.md). Broaden or repeat only for changed
  evidence, failures, unresolved risk or a required PR/release gate. Missing
  commands are `NOT CONFIGURED`; missing prerequisites are `NOT AVAILABLE`.
  Distinguish local edits, tests, commits, pushes and releases.
- Read relevant Skills when they help; do not use the `brainstorming` Skill.
  A full `grilling` interview requires an explicit user request.
- Prefer `rg` for exact text, batch independent reads, and keep shared mutations
  serial. Use dependency tools according to [git](.claude/rules/git.md), with
  direct-source fallback when their coverage is unavailable or unreliable.

## Project and Commands

SmartPerfetto is an AGPL-licensed Android Perfetto analysis platform: forked
Perfetto UI, Express backend, TypeScript strict mode, Node.js 24 LTS, native AI
runtimes, YAML Skills, Markdown strategies and a `trace_processor_shell` pool.
The Web UI, standalone CLI and API share analysis and finalization contracts.
`frontend/` is the committed prebuild used by source, Docker and portable paths.

```bash
./start.sh                          # Default user/source entry
./scripts/start-dev.sh              # Perfetto UI plugin development
./scripts/start-dev.sh --quick
./scripts/update-frontend.sh
./scripts/restart-backend.sh
cd backend && npm run build
```

Use [architecture overview](docs/architecture/overview.md) and
[agent runtime](docs/architecture/agent-runtime.md) for current module ownership.
Before feature/bug work, identify affected product surfaces using
[product-surface](.claude/rules/product-surface.md).

## Product Contracts

- Keep prompts in `backend/strategies/` and Skills in `backend/skills/`.
  Discover tools, scenes and output contracts from their registries/frontmatter;
  do not duplicate them or their counts in TypeScript or adapters.
- Fix generators/templates and regenerate their outputs; do not hand-edit
  generated files. After AI Assistant UI changes, verify in dev mode and run
  `./scripts/update-frontend.sh`.
- Keep final conclusions, evidence/claim verification, identity resolution,
  reports, snapshots, CLI artifacts and chat projection as separate surfaces.
  Readability changes must preserve provenance. Model declarations are input
  to verification, never evidence or authorization.
- Use actual dispatch, collection and streaming state to determine authorship
  and completion. Check real input and context before changing detectors.
  Preserve structured attribution/success facts before transport truncation.
  Shared tool narration should describe an honest finding, not raw payloads.
- Preserve provider pinning, current-run ownership, authorization and privacy
  projection. Budget, scope, evidence access, deliverable and source need are
  independent; model autonomy does not widen access or waive verification.
- Before committing/pushing Skills, Strategies, portable SQL, evidence/identity
  contracts, processor pins or exporter changes, run
  `npm run check:perfetto-skills-impact` per [skills](.claude/rules/skills.md).
  Record `required`, `not_required` or `deferred`, the reason/handoff and change
  fingerprint.
- Treat startup/readiness, loopback URLs, portable paths/layout, bundled
  runtimes/native modules, signing and notarization as portable-impacting work;
  follow the matching [testing](.claude/rules/testing.md) and
  [release](.claude/rules/release.md) gates.
- Do not publish a root gitlink pointing at a local-only Perfetto commit.
  Follow [git](.claude/rules/git.md) for submodule landing/anchoring and
  [perfetto-sync](.claude/rules/perfetto-sync.md) before upstream/prebuilt sync.
- Keep tracked docs focused on current user, architecture, runtime and
  maintainer contracts. Use issues, PRs and Git history for dated plans/reports.

## Area Rules

Read only the rules relevant to the touched area:

| Area | Rule |
| --- | --- |
| Backend, runtime, provider, evidence, sessions | [backend](.claude/rules/backend.md) |
| Perfetto UI plugin and committed prebuild | [frontend](.claude/rules/frontend.md) |
| Prompt/strategy assets | [prompts](.claude/rules/prompts.md) |
| Skill/SQL contracts and public pairing | [skills](.claude/rules/skills.md) |
| Source, knowledge, CodeRefs and privacy | [codebase-aware](.claude/rules/codebase-aware.md) |
| Test ownership and verification tiers | [testing](.claude/rules/testing.md) |
| Dependencies, GitNexus, Git and submodules | [git](.claude/rules/git.md) |
| Perfetto upstream, processor and UI assets | [perfetto-sync](.claude/rules/perfetto-sync.md) |
| Packaging and public release | [release](.claude/rules/release.md) |

Before opening or landing a PR, run `npm run verify:pr` from the repository root.
