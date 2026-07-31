# SmartPerfetto Agent Guide

Project-scoped entry guide for AI coding agents. Keep this file short: durable
details belong in `.claude/rules/` and product docs, not in root agent adapters.

Claude Code reads `CLAUDE.md`. Codex, OpenCode, Windsurf, Cline, and other
agents commonly read `AGENTS.md`. Keep these two files in sync. Cursor,
Copilot, and Gemini adapters should stay short and point back here plus the
relevant `.claude/rules/` files.

## Basics

- Reply to maintainers in the language they use.
- SmartPerfetto is an AGPL-licensed, AI-assisted Android Perfetto analysis
  platform: pre-built Perfetto UI, Express backend, AI runtimes, YAML Skills,
  Markdown strategies, and a `trace_processor_shell` pool.
- Core stack: Node.js 24 LTS, TypeScript strict mode, Express, forked Perfetto
  UI submodule, committed `frontend/` prebuild for user and Docker paths.
- Default user path is `./start.sh`. Use `./scripts/start-dev.sh` only for
  Perfetto UI plugin development.

## Common Commands

```bash
./start.sh
./scripts/start-dev.sh
./scripts/start-dev.sh --quick
./scripts/update-frontend.sh
./scripts/restart-backend.sh
cd backend && npm run build
```

## Must-Follow Rules

- Preserve unrelated local changes; inspect git status before editing.
- Do not hardcode prompt content in TypeScript. Use `backend/strategies/` and
  `backend/skills/`.
- Do not hardcode MCP tool lists, Skill counts, scene lists, or AI output
  sections in adapter docs or TypeScript. Use the registry/frontmatter files
  and the reference docs as the source of truth.
- Do not manually edit generated files; fix the generator/template and
  regenerate.
- Keep tracked documentation limited to current user, architecture, runtime,
  and maintainer contracts. Do not commit dated plans, review reports,
  research dumps, presentation sources, or agent evidence; fold durable
  conclusions into a core document and use issues, PRs, or git history for
  implementation history.
- Preserve the AI output contract: final conclusions, evidence/claim
  verification, identity resolution, reports, snapshots, CLI output, and
  frontend chat projection are separate surfaces. Keep chat readable without
  deleting report/snapshot provenance.
- `frontend/` is consumed by Docker, `./start.sh`, and portable packages. After
  AI Assistant plugin UI changes, verify in dev mode and run
  `./scripts/update-frontend.sh`.
- Keep Provider Manager/runtime provider pinning semantics intact.
- Do not push a root commit that points at a local-only `perfetto/` submodule
  commit.
- Before committing or pushing changes to Skills, Strategies, portable SQL,
  evidence/identity contracts, trace-processor pins, or the public exporter,
  run `npm run check:perfetto-skills-impact` with the arguments defined in
  `.claude/rules/skills.md` and record `required`, `not_required`, or `deferred` with the required
  reason/handoff and change fingerprint.
- Before feature or bug work, check the affected product surfaces in
  `.claude/rules/product-surface.md`.
- Treat startup/readiness, loopback URLs, portable paths or package layout,
  bundled runtimes/native modules, signing, and notarization changes as
  portable-impacting work; follow the PR and release gates in
  `.claude/rules/testing.md` and `.claude/rules/release.md`.
- For non-trivial feature or bug work, use `gitnexus-impact-analysis` during
  planning and run GitNexus change detection before commit. Follow
  `.claude/rules/git.md` and cross-check graph results against source and tests.
- Before syncing, rebasing, merging, or upgrading official Perfetto code,
  trace processor prebuilts, SQL docs, stdlib indexes, or committed Perfetto UI
  prebuilds, read `.claude/rules/perfetto-sync.md`.
- Before publish, package, tag, npm, Docker, or portable release work, read
  `.claude/rules/release.md` plus `.claude/rules/git.md` and
  `.claude/rules/testing.md`.

## Independent Review Gate

For non-trivial tasks such as multi-file edits, architecture changes, or complex
logic, use Plan -> independent read-only review -> Revise -> Execute.

- If the primary agent is not Codex and a Codex review tool is available, prefer
  Codex read-only review.
- If the primary agent is Codex, do not call Codex to review itself. Prefer a
  read-only reviewer sub-agent/tool.
- In ZCode/OpenCode, invoke the `codex` MCP tool for this gate. It exposes
  `codex` (start a read-only review session; pass a review prompt with
  `sandbox: "read-only"` and `approval-policy: "never"`) and `codex-reply`
  (continue a session by `threadId`). Registered as `mcp.codex` in
  `~/.zcode/v2/config.json`, backed by `codex mcp-server`.
- If no stable reviewer is available, or the reviewer times out twice, use a
  structured self-review plus post-diff review, note the fallback, and rely on
  the relevant verification tier from `.claude/rules/testing.md`.
- Reviewers must not edit files.

## Detailed Rules

Read the relevant detailed rule before touching that area:

- `.claude/rules/backend.md`
- `.claude/rules/frontend.md`
- `.claude/rules/prompts.md`
- `.claude/rules/skills.md`
- `.claude/rules/codebase-aware.md`
- `.claude/rules/product-surface.md`
- `.claude/rules/perfetto-sync.md`
- `.claude/rules/release.md`
- `.claude/rules/testing.md`
- `.claude/rules/git.md`

Run the smallest verification tier that proves the change. Before opening or
landing a PR, run `npm run verify:pr` from the repository root.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **SmartPerfetto** (47377 symbols, 142809 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/SmartPerfetto/context` | Codebase overview, check index freshness |
| `gitnexus://repo/SmartPerfetto/clusters` | All functional areas |
| `gitnexus://repo/SmartPerfetto/processes` | All execution flows |
| `gitnexus://repo/SmartPerfetto/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
