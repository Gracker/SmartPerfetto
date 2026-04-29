# SmartPerfetto Development Guide

AI-driven Perfetto analysis platform for Android performance data.

## Language

用中英文思考，用中文回答。Insight 内容必须使用中文。

## Compact Instructions

```
Tech: TypeScript strict, follow existing patterns
Dev:  tsx watch (backend) + build.js --watch (frontend) — auto-rebuild on save
Test: cd backend && npm run test:scene-trace-regression  ← MANDATORY after every change
Start (users):      ./start.sh                          ← pre-built frontend, no submodule
Start (UI dev):     ./scripts/start-dev.sh              ← requires perfetto submodule, hot reload
Update prebuilt:    ./scripts/update-frontend.sh        ← run after modifying AI plugin UI
Restart backend:    ./scripts/restart-backend.sh        ← .env/npm changes only
Build backend:      cd backend && npm run build
```

## Post-change Dev Workflow

Backend (`tsx watch`) auto-rebuilds on file save. Frontend hot-reload only works in `start-dev.sh` mode.

**Default assumption**: user runs `./start.sh` (pre-built frontend).

- **Backend `.ts` / `.yaml` / `.md` changes**: restart-backend.sh not needed — tsx watch reloads automatically. Tell user to refresh browser.
- **Frontend plugin changes** (`ai_panel.ts`, `styles.scss` etc.): must be running `./scripts/start-dev.sh` for hot reload. After verifying, run `./scripts/update-frontend.sh` to update `frontend/`.
- **Only use `./scripts/restart-backend.sh`** for: `.env` changes, `npm install`, or tsx watch stuck.
- **Only use `./scripts/start-dev.sh`** for: modifying AI plugin UI (requires submodule).
- **Default assumption**: User only refreshes browser after changes.

## Verification (done-conditions)

Every task must satisfy these before completion:

| Task Type | Done When |
|-----------|-----------|
| Any code change | `cd backend && npm run test:scene-trace-regression` passes (6 canonical traces) |
| Skill YAML change | `npm run validate:skills` passes + regression passes |
| Strategy/template .md change | `npm run validate:strategies` passes + regression passes |
| Build/type error | `npx tsc --noEmit` passes in backend/ |
| Pre-commit | Run `/simplify` on changed code |

## Health Stack

Tools used by `/health` for the code quality dashboard:

- typecheck: `cd backend && npx tsc --noEmit`
- test: `cd backend && npm run test:core`
- lint: _not configured_ (candidates: `biome` or `eslint`)
- deadcode: _not configured_ (candidate: `knip`)
- shell: _not configured_ (candidate: `shellcheck scripts/*.sh` — 6 shell scripts)

`/health` composites these into a 0-10 score and appends a snapshot to `~/.gstack/projects/Gracker-SmartPerfetto/health-history.jsonl` for trend tracking.

## Architecture Overview

```
Frontend (Perfetto UI @ :10000) ◄─SSE/HTTP─► Backend (Express @ :3000)
                │                                     │
                └───────── HTTP RPC (9100-9900) ──────┘
                                  │
                    trace_processor_shell (Shared)
```

**Core Concepts:**
- **Primary Runtime: agentv3** — Claude Agent SDK as orchestrator (20 MCP tools)
- **Deprecated Fallback: agentv2** — activated only by `AI_SERVICE=deepseek`
- Scene Classifier → scene-specific system prompts (12 scenes: scrolling/startup/anr/pipeline/interaction/touch-tracking/teaching/memory/game/overview/scroll-response/general)
- Analysis logic in YAML Skills (`backend/skills/`) — L1→L2→L3→L4 layered results
- SSE for real-time streaming

**Detailed rules by area:** See `.claude/rules/` for backend, frontend, skills, prompts, git, and testing rules.

## Key Rules (NEVER / ALWAYS)

1. **NEVER hardcode prompt content in TypeScript** — use `*.strategy.md` / `*.template.md` (see `rules/prompts.md`)
2. **ALWAYS push perfetto submodule to `fork` remote**, never `origin` (see `rules/git.md`)
3. **ALWAYS run trace regression** after code changes (see `rules/testing.md`)
4. **ALWAYS check if file is auto-generated** before fixing build errors (see `rules/backend.md`)

## API Endpoints

**Agent (primary path):**
- `POST /api/agent/v1/analyze` — Start analysis
- `GET /api/agent/v1/:sessionId/stream` — SSE real-time stream
- `GET /api/agent/v1/:sessionId/status` — Poll status
- `POST /api/agent/v1/resume` — Resume analysis (multi-turn SDK context recovery)

**Multi-turn & interaction:**
- `GET /api/agent/v1/:sessionId/turns` — Get analysis turns
- `POST /api/agent/v1/:sessionId/respond` — Multi-turn response
- `POST /api/agent/v1/:sessionId/intervene` — User intervention
- `POST /api/agent/v1/:sessionId/cancel` — Cancel analysis
- `POST /api/agent/v1/:sessionId/interaction` — Handle interaction
- `GET /api/agent/v1/:sessionId/focus` — Get focus app
- `GET /api/agent/v1/:sessionId/report` — Get analysis report

**Scene reconstruction:**
- `POST /api/agent/v1/scene-reconstruct` — Start reconstruction
- `GET /api/agent/v1/scene-reconstruct/:analysisId/stream` — SSE stream
- `GET /api/agent/v1/scene-reconstruct/:analysisId/status` — Get status
- `POST /api/agent/v1/scene-reconstruct/:analysisId/deep-dive` — Deep dive
- `DELETE /api/agent/v1/scene-reconstruct/:analysisId` — Delete

**Supporting:** `/api/agent/v1/scene-detect-quick`, `/api/agent/v1/teaching/pipeline`, `/api/agent/v1/logs/*`, `/api/agent/v1/sessions`, `/api/traces/*`, `/api/skills/*`, `/api/export/*`, `/api/sessions/*`

## SSE Events (agentv3)

| Event | Description |
|-------|-------------|
| progress | Phase transitions (starting/analyzing/concluding) |
| agent_response | MCP tool results (SQL/Skill) |
| answer_token | Final text streaming |
| thought | Intermediate reasoning |
| conclusion | Near-terminal — SDK result arrives, conclusion text ready |
| analysis_completed | Terminal — HTML report generated (carries reportUrl) |
| error | Exceptions |

Note: agentv3 sends `conclusion` first (user sees result immediately), then `analysis_completed` follows after report generation.

## Analysis Mode (fast / full / auto)

`POST /api/agent/v1/analyze` accepts `options.analysisMode`:

| Mode | Turns | MCP tools | Verifier / sub-agents | Typical cost |
|------|:-----:|:---------:|:---:|---:|
| `fast` | 5 | 3 lightweight (`execute_sql`, `invoke_skill`, `lookup_sql_schema`) | skipped | $0.05–0.25 |
| `full` | 30 | 20 (full toolkit) | enabled | $0.3–1.0 |
| `auto` (default) | routed | per chosen path | per chosen path | varies |

`auto` routing order: `applyKeywordRules` (drill-down keyword → full / short confirm keyword → quick) → `applyHardRules` (selection / comparison / findings / prior-full / 7 deterministic scenes) → Haiku fallback.

**Frontend** (`ai_panel.ts`): chip selector persisted in `localStorage['ai-analysis-mode']`. Switching mode mid-session clears `agentSessionId` so the backend opens a fresh SDK session (avoids 5-turn quick / 30-turn full context mix).

**Known limitation**: fast mode + heavy query (e.g. `分析启动性能`) can exhaust the 5-turn budget when Claude calls `invoke_skill` and spends turns parsing large (~200 KB) skill JSON. Prefer `execute_sql` for simple factual queries in fast mode, or steer heavy queries to full mode.

## Session Management

- In-memory `Map<sessionId, AnalysisSession>` with 30-min cleanup
- SDK session ID persisted to `logs/claude_session_map.json` (debounced, 24h TTL)
- Multi-turn: reuse sessionId, agentv3 uses `resume: sdkSessionId` for SDK context recovery
- Concurrency: `activeAnalyses` Set prevents parallel analyze() on same session

## Environment

```bash
# backend/.env — see .env.example for full provider list (GLM/DeepSeek/Qwen/Kimi/Doubao/OpenAI/Gemini/Ollama...)
PORT=3000
ANTHROPIC_API_KEY=sk-ant-xxx              # Anthropic direct, or proxy auth token
# ANTHROPIC_BASE_URL=http://localhost:3000 # Third-party LLM via API proxy (one-api/new-api/LiteLLM)
CLAUDE_MODEL=claude-sonnet-4-6            # Optional, default (or provider model name via proxy)
# CLAUDE_LIGHT_MODEL=claude-haiku-4-5     # Optional, for verifier/classifier/summarizer
# CLAUDE_MAX_TURNS=15                     # Optional
# CLAUDE_MAX_BUDGET_USD=5                 # Optional, per-analysis budget cap (Anthropic only)
# CLAUDE_EFFORT=high                      # Optional, SDK effort level (Anthropic only)
# CLAUDE_SUB_AGENT_MODEL=sonnet           # Optional, sub-agent model (haiku/sonnet/opus/inherit)
# Per-turn timeouts — raise for slower LLMs (DeepSeek / Ollama / GLM / Qwen)
# CLAUDE_FULL_PER_TURN_MS=60000           # Optional, full-path per-turn budget (default 60s)
# CLAUDE_QUICK_PER_TURN_MS=40000          # Optional, quick-path per-turn budget (default 40s)
# CLAUDE_VERIFIER_TIMEOUT_MS=60000        # Optional, verifier LLM single-turn timeout (default 60s)
# CLAUDE_CLASSIFIER_TIMEOUT_MS=30000      # Optional, query complexity classifier timeout (default 30s)
# SMARTPERFETTO_API_KEY=xxx               # Optional, bearer token auth
# AI_SERVICE=deepseek                     # Legacy agentv2 only

# Agent safety limits (optional)
# AGENT_SQL_MAX_ROWS=1000
# AGENT_SQL_TABLE_CACHE_TTL_MS=300000
# AGENT_TASK_TIMEOUT_MS=180000

# Usage throttling (optional)
# SMARTPERFETTO_USAGE_MAX_REQUESTS=200
# SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS=100
# SMARTPERFETTO_USAGE_WINDOW_MS=86400000
```

## Quick Start

```bash
./scripts/start-dev.sh                       # Default: download prebuilt trace_processor_shell (~5s)
./scripts/start-dev.sh --build-from-source   # Force source build (use after modifying perfetto C++)
# Backend @ :3000, Frontend @ :10000
```

`trace_processor_shell` is acquired by `scripts/start-dev.sh` in this order: cached binary at
`perfetto/out/ui/trace_processor_shell` → version-pinned LUCI prebuilt (SHA256-verified) → source
build fallback. Pin source of truth: `scripts/trace-processor-pin.env` (shared with `Dockerfile`
and the CI workflow). When upgrading the perfetto submodule (e.g. v54 → v55), update
`PERFETTO_VERSION` and recompute the 4 per-platform SHA256s in that file (instructions inline).

## Common Issues

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | `./scripts/start-dev.sh` |
| Empty data | Check stepId matches YAML `id:` |
| Port conflict | `pkill -f trace_processor_shell` |
| Debug | Check `backend/logs/sessions/*.jsonl` |

## Code Generation

When fixing L10n or code generation issues, always fix the generator script/template, not the generated output.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
