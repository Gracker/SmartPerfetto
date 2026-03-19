# SmartPerfetto Development Guide

AI-driven Perfetto analysis platform for Android performance data.

## Compact Instructions

```
Tech: TypeScript strict, follow existing patterns
Dev:  tsx watch (backend) + build.js --watch (frontend) — auto-rebuild on save
Test: cd backend && npm run test:scene-trace-regression  ← MANDATORY after every change
Start: ./scripts/start-dev.sh (first-time) | ./scripts/restart-backend.sh (.env/npm changes only)
Build: cd backend && npm run build
```

## Post-change Dev Workflow

Both backend (`tsx watch`) and frontend (`build.js --watch`) auto-rebuild on file save. After code changes:
- **All .ts / .yaml changes**: Tell user to refresh the browser. No restart needed.
- **Only use `./scripts/restart-backend.sh`** for: `.env` changes, `npm install`, or tsx watch stuck.
- **Only use `./scripts/start-dev.sh`** for: first-time setup or both services crashed.
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

## Architecture Overview

```
Frontend (Perfetto UI @ :10000) ◄─SSE/HTTP─► Backend (Express @ :3000)
                │                                     │
                └───────── HTTP RPC (9100-9900) ──────┘
                                  │
                    trace_processor_shell (Shared)
```

**Core Concepts:**
- **Primary Runtime: agentv3** — Claude Agent SDK as orchestrator (18 MCP tools)
- **Deprecated Fallback: agentv2** — activated only by `AI_SERVICE=deepseek`
- Scene Classifier → scene-specific system prompts (scrolling/startup/anr/general)
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
- `POST /api/agent/v1/scene-reconstruct` — Scene reconstruction

**Supporting:** `/api/traces/register-rpc`, `/api/skills/*`, `/api/export/*`, `/api/sessions/*`, `/api/agent/v1/logs/*`

## SSE Events (agentv3)

| Event | Description |
|-------|-------------|
| progress | Phase transitions (starting/analyzing/concluding) |
| agent_response | MCP tool results (SQL/Skill) |
| answer_token | Final text streaming |
| thought | Intermediate reasoning |
| analysis_completed | Analysis complete (carries reportUrl) |
| error | Exceptions |

## Session Management

- In-memory `Map<sessionId, AnalysisSession>` with 30-min cleanup
- SDK session ID persisted to `logs/claude_session_map.json` (debounced, 24h TTL)
- Multi-turn: reuse sessionId, agentv3 uses `resume: sdkSessionId` for SDK context recovery
- Concurrency: `activeAnalyses` Set prevents parallel analyze() on same session

## Environment

```bash
# backend/.env
PORT=3000
CLAUDE_MODEL=claude-sonnet-4-6          # Optional, default
# CLAUDE_MAX_TURNS=15                   # Optional
# CLAUDE_ENABLE_SUB_AGENTS=true         # Optional feature flag
# CLAUDE_ENABLE_VERIFICATION=false      # Default: true
# AI_SERVICE=deepseek                   # Legacy agentv2 only
```

## Quick Start

```bash
./scripts/start-dev.sh  # Auto-builds trace_processor_shell
# Backend @ :3000, Frontend @ :10000
```

## Common Issues

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | `./scripts/start-dev.sh` |
| Empty data | Check stepId matches YAML `id:` |
| Port conflict | `pkill -f trace_processor_shell` |
| Debug | Check `backend/logs/sessions/*.jsonl` |

## Code Generation

When fixing L10n or code generation issues, always fix the generator script/template, not the generated output.
