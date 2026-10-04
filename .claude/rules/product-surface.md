# Product Surface Rules

Read this file before feature development, bug fixes, refactors, provider work,
runtime work, CLI work, frontend work, reports, or packaging.

SmartPerfetto is no longer only a local Perfetto UI plugin. Every change should
be checked against the public product surfaces below.

## Supported Entry Points

| Entry point | User command/path | Primary users | Notes |
| --- | --- | --- | --- |
| Web UI from source | `./start.sh` -> `http://127.0.0.1:10000` | local users and maintainers | Uses committed `frontend/`; backend and frontend bind to IPv4 loopback by default; no `perfetto/` build needed for normal use |
| Web UI dev mode | `./scripts/start-dev.sh` | AI Assistant plugin developers | Requires `perfetto/` submodule and rebuilt `frontend/` before shipping |
| Docker | `docker compose -f docker-compose.hub.yml up -d` | users who do not want host Node.js | Cannot read host Claude Code local auth |
| Portable app | GitHub release assets | non-developer Windows/macOS/Linux users | Bundles Node.js 24, native deps, backend, `frontend/`, trace processor |
| npm CLI | `npm install -g @gracker/smartperfetto`; `smp` | automation and terminal users | Requires host Node.js `>=24 <25`, no Web UI |
| CLI trace capture | `smp capture ...` | terminal users collecting traces | Uses Android capture presets/configs, optional post-capture `--analyze`, and local turn artifacts |
| HTTP/SSE API | `/api/workspaces/:workspaceId/{agent,traces,reports,providers,…}/*`; legacy global `/api/agent/v1/*`, `/api/traces/*`, `/api/reports/*`, `/api/v1/providers/*` answer with `Deprecation` + `Sunset` (`legacyAgentApi.ts`) | integrations and frontend | The plugin calls only the workspace routes. Keep response contracts stable or regenerate frontend types |
| Agent external feedback | Analysis message CTA, `/api/workspaces/:workspaceId/agent/:sessionId/external-issue/*` | users reporting analysis, Skill, runtime, docs, or UI gaps | Resolve the persisted source run; pin provider/runtime; validate and deidentify; never submit to GitHub |
| Self-Evolution admin | Settings `Evolution`, `/api/admin/self-evolution/*` | authorized analysts and administrators | Default off; preserve RBAC/scope, immutable run snapshots, persistence fail-closed, gate binding, reconciliation, and revert |
| Critical-path wait chain | AI Assistant `Critical path` drawer on a selected `thread_state` -> `POST /api/workspaces/:workspaceId/critical-path/:traceId/analyze` (legacy `/api/critical-path/*` is 410 under enterprise/OIDC) | Web UI users inspecting one blocked task | Response contract in `backend/src/types/criticalPathContract.ts`, generated into the plugin (`check:types`); trace ownership checked like Agent routes. The optional model summary is AI feature `critical_path_ai_summary`: AI off, a caller without `agent:run`, a non-Claude active runtime, or missing credentials return the deterministic summary with a warning (never 403). It follows the caller's Provider Manager profile, runs the shared isolated one-shot call (`services/oneShotModelCall.ts`), and aborts on client disconnect. The route's result is not persisted to reports, snapshots, or the conversation. The same engine backs the `analyze_wait_chain` MCP tool, whose output does enter the conversation and run evidence |
| Flamegraph | Static `assistant-flamegraph.js` page -> `GET /api/flamegraph/:traceId/availability`, `POST /api/flamegraph/:traceId/analyze` | Web UI users reading CPU call-stack hotspots | Non-workspace route (410 under enterprise/OIDC); validation and trace ownership as the critical-path route, and the page sends no workspace headers. AI feature `flamegraph_ai_summary` degrades like the critical-path summary (same one-shot call, `agent:run`); Chinese output only. Not persisted |

## Runtime And Provider Matrix

| Runtime | Provider families | Native state within a run | Important boundary |
| --- | --- | --- | --- |
| `claude-agent-sdk` | Anthropic direct, Bedrock, Vertex, Claude/Anthropic-compatible gateways | SDK session held in memory for the current run only (every SDK query goes through `claudeSdkQuery`, which forces `persistSession: false`, so no transcript reaches the local Claude session store); the snapshot keeps the provider pin (legacy `sdkSessionId` fields are read to infer the runtime kind, never written) | Requires explicit provider/env credentials; Claude Code login and Base URL alone do not establish SDK readiness |
| `openai-agents-sdk` | OpenAI Responses API, OpenAI-compatible gateways, Ollama/chat-completions endpoints | SDK history held for the current run only; the snapshot keeps the provider pin (legacy `openAI*` fields are read, never written) | Requires OpenAI runtime rules; do not validate only Claude env vars |
| `pi-agent-core` | Custom Provider Manager profiles, Pi model JSON, OpenAI-compatible providers where supported by Pi AI | Pi Agent messages held for the current run only; the snapshot keeps the provider pin (a legacy stored transcript is ignored) | Keep SmartPerfetto MCP tool allowlists, plan evidence logging, and final verifier parity with the Claude target path |
| `opencode` | Custom Provider Manager profiles, OpenCode model JSON, OpenAI-compatible providers | Fresh native session every run inside isolated project/home/config dirs derived from the session id; the snapshot keeps the provider pin (a legacy stored session id or path is ignored) | Keep the bridge sandboxed and route all SmartPerfetto tools through the shared MCP registry/plan evidence log |
| `qoder-agent-sdk` | Custom Provider Manager profiles or env, local `qodercli` login, PAT, explicit CLI path, optional `resolveModel` BYOK | SDK session held for the current run only; the snapshot keeps the provider pin (a legacy stored session id is ignored) | SDK is opt-in; BYOK never replaces Qoder auth or enters subprocess env/plaintext snapshots; disable built-in tools, project tokens before SSE, and never resume or persist opaque state |

Follow-up questions start a fresh native context in every runtime. Only the
shared authorized typed history crosses user turns: a bounded recent preview
plus `read_session_history` for older records. Native state in the table is
run-local implementation state, not permission to replay an earlier transcript.
Source-derived history requires the original exact analysis-context fingerprint.

Provider Manager active profiles override `.env` and system fallback. A
session keeps its selected provider/runtime. Resume must not silently switch to
a different provider after the user changes the active profile.

## Bundled And Runtime-Read Content

| Content | Path | Runtime use | Change rule |
| --- | --- | --- | --- |
| Pre-built Perfetto UI | `frontend/` | Docker, `./start.sh`, portable packages | After AI Assistant plugin UI changes, verify dev mode and run `./scripts/update-frontend.sh` |
| Perfetto UI source | `perfetto/` | only UI/plugin development | Push the submodule commit to `fork` and anchor it to `fork/main` before pushing the root gitlink (`git.md`) |
| Skills | `backend/skills/` | MCP `invoke_skill`, CLI `skill`, reports | Validate Skills; do not hardcode Skill logic in TypeScript |
| Strategies/prompts | `backend/strategies/` | system prompts and scene methodology | Do not hardcode prompt content in TypeScript |
| SQL fragments/indexes | `backend/sql/`, generated backend data | schema lookup and Skill execution | Update generators before generated output when applicable |
| Rendering pipeline docs | `docs/rendering_pipelines/` | teaching mode and Skill-linked docs | Treat as runtime-read; update Skill/config references when moving files |
| Trace processor prebuilts | `backend/prebuilts/trace_processor/` and package assets | CLI, Docker, portable, source fallback | Keep pin, SHA256, package copy rules, and docs in sync |

## AI Result Surfaces

AI analysis output is consumed through several surfaces:

| Surface | Typical path | Notes |
| --- | --- | --- |
| Live chat / AI panel | SSE `answer_token` / `answer_segment_reset` drafts (draft-capable runtimes only), then provisional or final `conclusion` / conversation `provisional_answer`, then `analysis_completed` / `run_completed` | Should be readable and avoid raw SQL/audit noise; a live-only, revocable draft shows while the model writes (never stored or replayed), the finished body replaces it — marked pending while the review runs — and only the terminal event carries the verdict |
| HTML report | `/api/workspaces/:workspaceId/reports/*`, report export | Keeps evidence, claim verification, identities, and appendix detail |
| CLI turn artifacts | `~/.smartperfetto/` session/report files | Used by `smp run`, `smp ask`, `smp capture --analyze`, and `smp report` |
| Analysis-result snapshot | snapshot services and frontend comparison state | Used for multi-result comparison and later review |
| Agent-assisted issue draft | `/api/workspaces/:workspaceId/agent/:sessionId/external-issue/*`, per-message UI state | Uses persisted run evidence and user confirmation; a durable public thumbs-down may add only an explicit triage signal, while Agent invocation, drafting, Self-Evolution actions, and GitHub submission remain separate |
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
  fallback, explicit Claude credentials, and resume/session snapshots.
- Single-trace, raw trace comparison, multi-analysis-result comparison, and
  report export.
- Live chat projection, HTML report, CLI artifacts, claim verification,
  identity resolution, and analysis-result snapshots.
- Runtime-read content: Skills, Strategies, rendering pipeline docs, SQL schema
  indexes, pre-built UI, and trace processor assets.
- Self-Evolution: feedback visibility, RunManifest attribution, fixed
  validation/holdout replay, admin RBAC/SSE, overlay generation, external user
  data, restart/upgrade reconciliation, and explicit revert.
- Agent external feedback: current/historical completed runs, exact provider
  snapshot pin, unsupported-runtime fallback, strict source refs, public
  sanitization, private/security fail-closed behavior, user confirmation, and
  no GitHub write.
- Node.js 24 boundary: source/npm require Node `>=24 <25`; portable packages
  bundle Node 24; Docker does not require host Node.
- Generated files and artifacts: frontend types, committed `frontend/`,
  package manifests, and release asset manifests.
- Tests and smoke paths listed in `.claude/rules/testing.md`.

## Portable Impact Triggers

A code change is portable-impacting when it changes any of these contracts,
even if the original report reproduces on only one operating system:

- launcher process lifecycle, startup/readiness polling, loopback URLs, health
  endpoints, browser-open URLs, shutdown, or port release;
- package-relative paths, user data/log directories, archive layout, package
  manifest fields, or update/migration behavior;
- bundled Node.js, Claude, OpenCode, `trace_processor_shell`, native
  dependencies/modules, or their executable/signature metadata;
- macOS Mach-O discovery, code signing, Hardened Runtime entitlements,
  notarization, stapling, or Gatekeeper behavior.

During code/PR work, record the portable impact, update the shared contracts
and focused tests, and run the portable verification tier in
`.claude/rules/testing.md`. Building and runtime-smoking all final release
archives is a public release gate, not a requirement for every intermediate
code edit.

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
- Self-Evolution behavior changes also need the bilingual user acceptance guide,
  configuration/API references, and `self-improving-design.md` kept consistent.
- Agent external-feedback changes also need the bilingual
  `agent-assisted-feedback` guide, API/configuration/troubleshooting references,
  Issue Forms, security policy, and data/runtime architecture docs kept
  consistent.
- If a doc path is runtime-read, update code references before moving or
  deleting it.
