# SmartPerfetto Agent Guide

Project-scoped instructions for AI coding agents working in this repository.
Keep personal preferences, local credentials, and machine-only workflows out of
this file. Put durable repository conventions here so collaborators can clone
the project and get the same agent behavior.

Claude Code reads `CLAUDE.md`. Codex, OpenCode, Windsurf, Cline, and other
agents commonly read `AGENTS.md`. Keep those two root files in sync. Tool
adapter files such as Cursor, Copilot, and Gemini should stay short and point
back to this canonical guide plus the detailed `.claude/rules/` files.

## Response and Product Language

- Reply to maintainers in the language they use in the task.
- Repository documentation may be English or Chinese; follow the existing file.
- SmartPerfetto user-facing AI answers, streamed progress, reports, and Insight
  text default to Simplified Chinese. Respect `SMARTPERFETTO_OUTPUT_LANGUAGE`
  and existing `localize(...)` / prompt-language templates when a task changes
  runtime output.

## Project Snapshot

SmartPerfetto is an AGPL-licensed, AI-assisted Android Perfetto analysis
platform.

```text
Perfetto UI @ :10000
  com.smartperfetto.AIAssistant plugin
        | SSE / HTTP
        v
Express backend @ :3000
  runtime selector -> Claude Agent SDK or OpenAI Agents SDK
  MCP tools / YAML Skills / Markdown Strategies / report generation
        |
        v
trace_processor_shell HTTP RPC pool, ports 9100-9900
```

Core stack:

- Node.js 24 LTS, TypeScript strict mode, Express.
- Forked Perfetto UI submodule under `perfetto/`.
- Committed pre-built UI under `frontend/` for users and Docker images.
- Runtime selector in `backend/src/agentRuntime/`.
- Claude runtime in `backend/src/agentv3/`.
- OpenAI Agents SDK runtime in `backend/src/agentOpenAI/`.
- Assistant/session orchestration in `backend/src/assistant/`.
- YAML Skill engine and assets under `backend/skills/`.
- Markdown scene strategies and prompt templates under `backend/strategies/`.

## Start Commands

Use the same entry points contributors use:

```bash
./start.sh                         # default user/local source path; pre-built frontend
./scripts/start-dev.sh             # Perfetto UI plugin development; requires submodule
./scripts/start-dev.sh --quick     # restart dev services without a full frontend rebuild
./scripts/update-frontend.sh       # refresh committed frontend/ after UI plugin changes
./scripts/restart-backend.sh       # only after .env/dependency changes or stuck watcher
cd backend && npm run build
```

Default assumption: the user is running `./start.sh`, so backend `.ts`, Skill
`.yaml`, and strategy/template `.md` changes normally require only a browser
refresh. Do not tell users to restart the backend unless `.env`, dependencies,
or the watcher state changed.

## Windows EXE Packaging and Release Rules

Windows EXE packaging is a first-class user distribution path for users who do
not want Docker. The release package is produced by
`npm run package:windows-exe` and published by `npm run release:windows-exe`.

Rules for this path:

- The root `package.json` version is the source of truth. Use
  `npm run version:set -- <version>` and commit `package.json`,
  `package-lock.json`, `backend/package.json`, and `backend/package-lock.json`
  before a normal public release.
- Public Windows releases must be built from a clean `main` commit. Do not use
  `--allow-dirty` for public releases; it is only for draft/test uploads where
  uncommitted local changes are intentional.
- The zip asset and top-level directory must be versioned as
  `smartperfetto-v<version>-windows-x64.zip` and
  `smartperfetto-v<version>-windows-x64/`. Do not publish the old unversioned
  `smartperfetto-windows-x64.zip` name.
- A normal release flow is: version commit on `main`, push `main`,
  `npm run package:windows-exe`, then
  `npm run release:windows-exe -- <version> --skip-build --no-draft`.
- `--skip-build` is only valid after a fresh package for the exact version and
  current commit has been generated. The release script verifies the zip
  filename, package manifest, version, commit, dirty state, release target, and
  uploaded asset.
- Windows packages include the committed `frontend/` prebuild, backend runtime
  assets, Windows Node.js runtime, Windows native dependencies, and
  `trace_processor_shell.exe`. Any change to this packaging surface requires
  package verification.
- `dist/windows-exe/` is generated output and must not be committed.

## Source Boundaries

Important paths:

- `backend/src/index.ts`: Express bootstrap and route registration.
- `backend/src/routes/agentRoutes.ts`: primary `POST /api/agent/v1/analyze`
  flow and SSE session endpoints.
- `backend/src/assistant/application/agentAnalyzeSessionService.ts`: session
  creation, reuse, provider pinning, and persistence recovery.
- `backend/src/agentRuntime/runtimeSelection.ts`: runtime selection from active
  Provider Manager profile, persisted snapshot, env override, or default.
- `backend/src/agentv3/claudeRuntime.ts`: Claude Agent SDK orchestrator.
- `backend/src/agentOpenAI/openAiRuntime.ts`: OpenAI Agents SDK orchestrator.
- `backend/src/agentv3/claudeMcpServer.ts` and `mcpToolRegistry.ts`: shared MCP
  tool surface used by both runtime families.
- `backend/src/services/skillEngine/`: YAML Skill execution.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`: SmartPerfetto UI
  plugin source.
- `frontend/`: committed pre-built UI bundle consumed by `./start.sh`, Docker
  Hub images, and source Docker builds.
- `.claude/rules/`: detailed project rules by area; read the relevant file
  before editing that area.

## Non-Negotiable Rules

- Do not hardcode prompt content in TypeScript. Put scene strategy text in
  `backend/strategies/*.strategy.md`, reusable prompt text in
  `backend/strategies/*.template.md`, and deterministic trace analysis in
  `backend/skills/**/*.skill.yaml`.
- Do not manually edit generated files. Fix the generator/template instead.
  Examples include `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/*.ts`,
  `dist/`, checked-in generated bundles, and files marked `Generated` or
  `Auto-generated`.
- Any AI Assistant plugin UI change under `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`
  must be verified in dev mode and followed by `./scripts/update-frontend.sh`
  before committing, so `frontend/index.html` and the active `frontend/v*`
  bundle remain in sync.
- Docker users and `./start.sh` users consume `frontend/`; they do not build the
  Perfetto submodule.
- When changing `AnalysisOptions`, also update the explicit whitelist in
  `backend/src/routes/agentRoutes.ts` before calling `orchestrator.analyze(...)`.
  New fields do not propagate automatically.
- For Provider Manager / runtime work, preserve provider pinning semantics:
  active provider wins for new sessions, explicit `providerId` wins for that
  request, persisted sessions restore their saved runtime/provider snapshot, and
  `providerId: null` means env/default fallback.
- Never push a root commit that points at a local-only `perfetto/` submodule
  commit.

## Verification Matrix

Run the smallest command that proves the change, and run the full PR gate before
opening or landing a PR.

| Change type | Required verification |
| --- | --- |
| Docs-only, no runtime-read files | `git diff --check` |
| Build/type fix | `cd backend && npm run typecheck` plus the affected test tier |
| Contract/type-only change | `cd backend && npx tsc --noEmit` plus the relevant contract tests |
| CRUD-only service, no agent/runtime path | That service's `__tests__/<name>.test.ts` |
| MCP, memory, report, provider, session, or agent runtime | `cd backend && npm run test:scene-trace-regression` |
| Skill YAML | `cd backend && npm run validate:skills` plus scene trace regression |
| Strategy/template Markdown | `cd backend && npm run validate:strategies` plus scene trace regression |
| Frontend generated types | `cd backend && npm run generate:frontend-types` plus relevant frontend/backend tests |
| AI plugin UI | dev-server browser verification, relevant `perfetto/ui` tests/typecheck, then `./scripts/update-frontend.sh` |
| Windows EXE packaging/release | `bash -n scripts/package-windows-exe.sh scripts/release-windows-exe.sh`, `shellcheck -x scripts/package-windows-exe.sh scripts/release-windows-exe.sh`, `node --check scripts/sync-version.cjs scripts/verify-windows-package.cjs`, `npm run package:windows-exe`, and `node scripts/verify-windows-package.cjs --zip dist/windows-exe/smartperfetto-v<version>-windows-x64.zip --version <version> --commit "$(git rev-parse HEAD)"` |
| Before PR | `npm run verify:pr` from the repository root |

`npm run verify:pr` runs root quality checks, Rust checks, backend Skill and
Strategy validation, typecheck, build, CLI package checks, core tests,
trace-processor availability, and the 6-trace scene regression gate.

## Git and Submodule Rules

- Root remote is `origin` (`Gracker/SmartPerfetto`).
- `perfetto/` is a submodule fork of Google Perfetto.
- Inside `perfetto/`, push SmartPerfetto changes to the `fork` remote, never to
  upstream `origin`.
- Submodule landing order: commit in `perfetto/`, push to `fork`, return to root,
  update `frontend/` if UI output changed, stage the gitlink and root artifacts,
  then commit and push root.
- Worktrees may contain user changes. Do not revert unrelated local edits.

## API Surface

Primary agent endpoints are under `/api/agent/v1`:

- `POST /api/agent/v1/analyze`
- `GET /api/agent/v1/:sessionId/stream`
- `GET /api/agent/v1/:sessionId/status`
- `GET /api/agent/v1/:sessionId/turns`
- `POST /api/agent/v1/:sessionId/respond`
- `POST /api/agent/v1/:sessionId/intervene`
- `POST /api/agent/v1/:sessionId/cancel`
- `GET /api/agent/v1/:sessionId/report`
- `POST /api/agent/v1/resume`
- `POST /api/agent/v1/scene-reconstruct`

Supporting APIs include `/api/traces`, `/api/skills`, `/api/reports`,
`/api/export`, `/api/v1/providers`, `/api/memory`, `/api/cases`, `/api/rag`,
`/api/baselines`, `/api/ci`, `/api/flamegraph`, and `/api/critical-path`.

Main SSE events: `progress`, `agent_response`, `thought`, `answer_token`,
`conclusion`, `analysis_completed`, and `error`. The `conclusion` event is near
terminal and may arrive before report generation completes; `analysis_completed`
is terminal and carries report metadata.

## Detailed Rule Files

Read these when touching the corresponding area:

- `.claude/rules/backend.md`
- `.claude/rules/frontend.md`
- `.claude/rules/prompts.md`
- `.claude/rules/skills.md`
- `.claude/rules/testing.md`
- `.claude/rules/git.md`

If these files drift from code, update the rules in the same change that changes
the architecture or workflow.
