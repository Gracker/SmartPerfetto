# Product Surface Rules

Read this file before feature development, bug fixes, refactors, provider work,
runtime work, CLI work, frontend work, reports, or packaging.

SmartPerfetto is no longer only a local Perfetto UI plugin. Every change should
be checked against the public product surfaces below.

## Supported Entry Points

| Entry point | User command/path | Primary users | Notes |
| --- | --- | --- | --- |
| Web UI from source | `./start.sh` -> `http://localhost:10000` | local users and maintainers | Uses committed `frontend/`; no `perfetto/` build needed for normal use |
| Web UI dev mode | `./scripts/start-dev.sh` | AI Assistant plugin developers | Requires `perfetto/` submodule and rebuilt `frontend/` before shipping |
| Docker | `docker compose -f docker-compose.hub.yml up -d` | users who do not want host Node.js | Cannot read host Claude Code local auth |
| Portable app | GitHub release assets | non-developer Windows/macOS/Linux users | Bundles Node.js 24, native deps, backend, `frontend/`, trace processor |
| npm CLI | `npm install -g @gracker/smartperfetto`; `smp` | automation and terminal users | Requires host Node.js `>=24 <25`, no Web UI |
| CLI trace capture | `smp capture ...` | terminal users collecting traces | Uses Android capture presets/configs, optional post-capture `--analyze`, and local turn artifacts |
| HTTP/SSE API | `/api/agent/v1/*`, `/api/traces/*`, `/api/reports/*` | integrations and frontend | Keep response contracts stable or regenerate frontend types |

## Runtime And Provider Matrix

| Runtime | Provider families | Resume state | Important boundary |
| --- | --- | --- | --- |
| `claude-agent-sdk` | Anthropic direct, Bedrock, Vertex, Claude/Anthropic-compatible gateways, local Claude Code auth for source runs | Claude SDK session id in `SessionStateSnapshot` | Local Claude Code auth is not available in Docker or portable packages unless explicitly configured in that environment |
| `openai-agents-sdk` | OpenAI Responses API, OpenAI-compatible gateways, Ollama/chat-completions endpoints | OpenAI history and last response id in `SessionStateSnapshot` | Requires OpenAI runtime rules; do not validate only Claude env vars |
| `pi-agent-core` | Custom Provider Manager profiles, Pi model JSON, OpenAI-compatible providers where supported by Pi AI | Pi opaque transcript state in `SessionStateSnapshot` | Keep SmartPerfetto MCP tool allowlists, plan evidence logging, and final verifier parity with the Claude target path |
| `opencode` | Custom Provider Manager profiles, OpenCode model JSON, OpenAI-compatible providers | OpenCode session id and isolated project/home/config dirs in `SessionStateSnapshot` | Keep the bridge sandboxed and route all SmartPerfetto tools through the shared MCP registry/plan evidence log |
| `qoder-agent-sdk` | Custom Provider Manager profiles or env, local `qodercli` login, PAT, explicit CLI path | Qoder SDK session id for public runs only | SDK is opt-in; disable built-in tools, project tokens before SSE, and never resume or persist opaque state for private-knowledge runs |

Provider Manager active profiles override `.env` and system fallback. A
session keeps its selected provider/runtime. Resume must not silently switch to
a different provider after the user changes the active profile.

## Bundled And Runtime-Read Content

| Content | Path | Runtime use | Change rule |
| --- | --- | --- | --- |
| Pre-built Perfetto UI | `frontend/` | Docker, `./start.sh`, portable packages | After AI Assistant plugin UI changes, verify dev mode and run `./scripts/update-frontend.sh` |
| Perfetto UI source | `perfetto/` | only UI/plugin development | Push submodule commit to `fork` before pushing root gitlink |
| Skills | `backend/skills/` | MCP `invoke_skill`, CLI `skill`, reports | Validate Skills; do not hardcode Skill logic in TypeScript |
| Strategies/prompts | `backend/strategies/` | system prompts and scene methodology | Do not hardcode prompt content in TypeScript |
| SQL fragments/indexes | `backend/sql/`, generated backend data | schema lookup and Skill execution | Update generators before generated output when applicable |
| Rendering pipeline docs | `docs/rendering_pipelines/` | teaching mode and Skill-linked docs | Treat as runtime-read; update Skill/config references when moving files |
| Trace processor prebuilts | `prebuilts/trace_processor/` and package assets | CLI, Docker, portable, source fallback | Keep pin, SHA256, package copy rules, and docs in sync |

## AI Result Surfaces

AI analysis output is consumed through several surfaces:

| Surface | Typical path | Notes |
| --- | --- | --- |
| Live chat / AI panel | SSE `answer_token`, `conclusion`, `analysis_completed` | Should be readable and avoid raw SQL/audit noise |
| HTML report | `/api/reports/*`, report export | Keeps evidence, claim verification, identities, and appendix detail |
| CLI turn artifacts | `~/.smartperfetto/` session/report files | Used by `smp run`, `smp ask`, `smp capture --analyze`, and `smp report` |
| Analysis-result snapshot | snapshot services and frontend comparison state | Used for multi-result comparison and later review |
| Frontend generated contract | generated DataEnvelope/analysis types | Regenerate when backend contract types change |

Do not collapse these into one behavior. A readability fix for chat should not
remove evidence/provenance from reports, snapshots, or CLI artifacts.

## Feature/Bug Checklist

Before implementing or declaring a fix complete, ask which of these are
affected:

- Web UI, CLI, API, reports, Docker, portable packages, and source scripts.
- CLI trace capture, including capture presets/config output and optional
  post-capture analysis.
- Claude, OpenAI, Pi Agent Core, OpenCode, and Qoder runtimes; Provider Manager, env
  fallback, local Claude auth, and resume/session snapshots.
- Single-trace, raw trace comparison, multi-analysis-result comparison, and
  report export.
- Live chat projection, HTML report, CLI artifacts, claim verification,
  identity resolution, and analysis-result snapshots.
- Runtime-read content: Skills, Strategies, rendering pipeline docs, SQL schema
  indexes, pre-built UI, and trace processor assets.
- Node.js 24 boundary: source/npm require Node `>=24 <25`; portable packages
  bundle Node 24; Docker does not require host Node.
- Generated files and artifacts: frontend types, committed `frontend/`,
  package manifests, and release asset manifests.
- Tests and smoke paths listed in `.claude/rules/testing.md`.

## Comparison Mode Contract

There are two comparison products:

- Raw trace comparison: current trace plus reference trace in one live AI
  session. CLI `smp compare` and the frontend raw-trace compare entry must use
  the same backend comparison identity, evidence pack, session snapshot, and
  report section contract.
- Analysis-result comparison: persisted snapshots across traces, windows, or
  workspace users. This keeps the workspace/RBAC/matrix API and should reuse
  the shared comparison report section where possible.

Do not implement a private CLI-only comparison prompt or appendix that the
frontend cannot share. If comparison quality changes, check both CLI and
frontend outputs.

## Documentation Impact

- User-facing behavior changes need README and `docs/getting-started` updates
  in Chinese and English where both exist.
- Release, packaging, CLI, provider, runtime, or platform changes need updates
  under `docs/reference/` and `.claude/rules/`.
- Architecture-affecting changes need `docs/architecture/overview*.md` and the
  relevant subsystem doc updated.
- If a doc path is runtime-read, update code references before moving or
  deleting it.
