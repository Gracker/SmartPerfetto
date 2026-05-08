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
- Do not manually edit generated files; fix the generator/template and
  regenerate.
- `frontend/` is consumed by Docker, `./start.sh`, and Windows packages. After
  AI Assistant plugin UI changes, verify in dev mode and run
  `./scripts/update-frontend.sh`.
- Keep Provider Manager/runtime provider pinning semantics intact.
- Do not push a root commit that points at a local-only `perfetto/` submodule
  commit.
- For Windows EXE packaging/release work, keep public releases clean and
  versioned; follow `.claude/rules/git.md`, `.claude/rules/testing.md`, and
  `docs/reference/windows-exe.md`.

## Detailed Rules

Read the relevant detailed rule before touching that area:

- `.claude/rules/backend.md`
- `.claude/rules/frontend.md`
- `.claude/rules/prompts.md`
- `.claude/rules/skills.md`
- `.claude/rules/testing.md`
- `.claude/rules/git.md`

Run the smallest verification tier that proves the change. Before opening or
landing a PR, run `npm run verify:pr` from the repository root.
