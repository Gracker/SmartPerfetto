# SmartPerfetto

AI-driven Android performance analysis platform built on [Perfetto](https://perfetto.dev/).

SmartPerfetto combines Perfetto's trace visualization with an intelligent agent system powered by Claude Agent SDK. It automatically analyzes performance traces, identifies root causes of jank/ANR/startup issues, and provides actionable optimization suggestions with evidence-backed reasoning.

## Features

- **Intelligent Analysis** — Ask questions in natural language ("分析滑动卡顿", "why is startup slow?") and get structured, evidence-backed answers
- **Claude Agent SDK (agentv3)** — Claude as orchestrator with 18 MCP tools for trace data access, planning, hypothesis testing, and verification
- **140 YAML Skills** — Reusable analysis pipelines (80 atomic + 28 composite + 30 pipeline + 2 deep) with layered results (L1 overview → L4 deep root cause)
- **Scene-Aware Strategies** — 12 scene-specific analysis strategies (scrolling, startup, ANR, memory, game, ...) injected into system prompts
- **4-Layer Verification** — Heuristic + plan adherence + hypothesis resolution + LLM verification, with reflection-driven retry
- **Real-time Streaming** — SSE-based progress updates as analysis progresses through stages
- **Perfetto Integration** — Shared `trace_processor_shell` via HTTP RPC; click-to-navigate from analysis results to timeline

## Quick Start

```bash
# Configure AI backend
cp backend/.env.example backend/.env
# Edit backend/.env with your Anthropic API key

# One command to start everything (builds trace_processor_shell automatically)
./scripts/start-dev.sh
```

Access:
- **Perfetto UI**: http://localhost:10000
- **Backend API**: http://localhost:3000

### Usage

1. Open http://localhost:10000 in your browser
2. Load a Perfetto trace file
3. Open the AI Assistant panel
4. Ask a question, e.g.:
   - "分析滑动卡顿" (Analyze scroll jank)
   - "启动为什么慢？" (Why is startup slow?)
   - "CPU 调度有没有问题？" (Any CPU scheduling issues?)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (Perfetto UI @ :10000)               │
│         Plugin: com.smartperfetto.AIAssistant                    │
│         - AI Panel (ask questions, view results)                 │
│         - Timeline integration (click-to-navigate)              │
└───────────────────────────┬─────────────────────────────────────┘
                            │ SSE / HTTP
┌───────────────────────────▼─────────────────────────────────────┐
│                    Backend (Express @ :3000)                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                 agentv3 Runtime                            │   │
│  │                                                           │   │
│  │  ClaudeRuntime (orchestrator)                             │   │
│  │    ├─ Scene Classifier (keyword-based, <1ms)              │   │
│  │    ├─ System Prompt Builder (dynamic, 4500 token budget)  │   │
│  │    ├─ Claude Agent SDK (MCP protocol)                     │   │
│  │    ├─ SSE Bridge (SDK stream → frontend events)           │   │
│  │    └─ Verifier (4-layer) + Reflection Retry               │   │
│  │                                                           │   │
│  │  MCP Server (18 tools)                                    │   │
│  │    execute_sql │ invoke_skill │ detect_architecture       │   │
│  │    lookup_sql_schema │ lookup_knowledge │ submit_plan     │   │
│  │    submit_hypothesis │ fetch_artifact │ ...               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           Skill Engine (140 YAML Skills)                  │   │
│  │   atomic/ (80) │ composite/ (28) │ pipelines/ (30) │ ... │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │     trace_processor_shell (HTTP RPC, port pool 9100-9900) │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Purpose |
|-----------|---------|
| **ClaudeRuntime** | Main orchestrator: scene classification → dynamic system prompt → Claude Agent SDK → verification loop |
| **MCP Server** | 18 tools bridging Claude to trace data (SQL, Skills, schema lookup, knowledge, planning, hypothesis) |
| **Skill Engine** | Executes YAML-defined analysis pipelines with SQL queries, producing layered results (L1-L4) |
| **Scene Classifier** | Keyword-based routing (<1ms) to scene-specific strategies (scrolling, startup, ANR, ...) |
| **Verifier** | 4-layer quality check (heuristic + plan + hypothesis + LLM) with up to 2 reflection retries |
| **Artifact Store** | Caches skill results as compact references (~3000 tokens saved per skill invocation) |
| **SQL Summarizer** | Compresses SQL results to stats + samples (~85% token savings) |

## Directory Structure

```
SmartPerfetto/
├── backend/
│   ├── src/
│   │   ├── agentv3/           # Primary AI runtime (Claude Agent SDK)
│   │   │   ├── claudeRuntime.ts        # Main orchestrator
│   │   │   ├── claudeMcpServer.ts      # 18 MCP tools
│   │   │   ├── claudeSystemPrompt.ts   # Dynamic system prompt builder
│   │   │   ├── claudeSseBridge.ts      # SDK → SSE streaming bridge
│   │   │   ├── claudeVerifier.ts       # 4-layer verification
│   │   │   ├── sceneClassifier.ts      # Keyword scene classification
│   │   │   ├── strategyLoader.ts       # Strategy/template loader
│   │   │   ├── artifactStore.ts        # Skill result caching
│   │   │   └── sqlSummarizer.ts        # SQL result compression
│   │   ├── agent/              # Shared components
│   │   │   ├── detectors/      # Architecture detection (Flutter/Compose/WebView)
│   │   │   ├── context/        # Multi-turn context, entity tracking
│   │   │   └── core/           # IOrchestrator interface, conclusion generation
│   │   ├── services/           # Core services
│   │   │   └── skillEngine/    # YAML skill executor & loader
│   │   └── routes/             # API endpoints
│   ├── skills/                 # Analysis skills (YAML)
│   │   ├── atomic/             # Single-step detection (80 skills)
│   │   ├── composite/          # Multi-step analysis (28 skills)
│   │   ├── pipelines/          # Rendering pipeline detection (30 skills)
│   │   ├── deep/               # Deep analysis (2 skills)
│   │   ├── fragments/          # Reusable SQL fragments (CTEs)
│   │   ├── modules/            # Module expert configs
│   │   └── vendors/            # Vendor-specific overrides
│   ├── strategies/             # Scene strategies + prompt templates
│   │   ├── *.strategy.md       # 12 scene-specific strategies
│   │   └── *.template.md       # 15 reusable prompt templates
│   └── logs/sessions/          # Session logs (JSONL)
├── perfetto/                   # Perfetto UI (forked submodule)
│   └── ui/src/plugins/com.smartperfetto.AIAssistant/
├── rendering_pipelines/        # 30 rendering pipeline reference docs
└── scripts/                    # Dev scripts
```

## API Endpoints

### Analysis

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agent/v1/analyze` | Start analysis |
| GET | `/api/agent/v1/:id/stream` | SSE real-time updates |
| GET | `/api/agent/v1/:id/status` | Get analysis status |
| POST | `/api/agent/v1/scene-reconstruct` | Scene reconstruction |

### SSE Events

| Event | Description |
|-------|-------------|
| `progress` | Phase transitions (starting/analyzing/concluding) |
| `agent_response` | MCP tool results (SQL/Skill data) |
| `thought` | Intermediate reasoning |
| `answer_token` | Final text streaming |
| `analysis_completed` | Analysis complete (carries reportUrl) |
| `error` | Exceptions |

### Supporting

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/traces/register-rpc` | Register trace_processor RPC port |
| GET | `/api/skills/*` | Skill listing and metadata |
| GET | `/api/export/*` | Report export |
| GET | `/api/sessions/*` | Session management |
| GET | `/api/agent/v1/logs/:sessionId` | Session logs |

## Environment

```bash
# backend/.env
PORT=3000
CLAUDE_MODEL=claude-sonnet-4-6          # Optional, default
# CLAUDE_MAX_TURNS=15                   # Optional
# CLAUDE_ENABLE_SUB_AGENTS=true         # Optional feature flag
# CLAUDE_ENABLE_VERIFICATION=false      # Default: true
```

## Debugging

```bash
# View session logs
curl http://localhost:3000/api/agent/v1/logs/{sessionId}
```

Logs are stored in `backend/logs/sessions/*.jsonl`.

### Common Issues

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | Run `./scripts/start-dev.sh` |
| Empty analysis data | Verify trace has FrameTimeline data (Android 12+) |
| Port conflict on 9100-9900 | `pkill -f trace_processor_shell` |
| Debug agent behavior | Check `backend/logs/sessions/*.jsonl` |

## Perfetto Submodule

```bash
# First clone
git submodule update --init --recursive

# Push both repos (perfetto → fork remote, main → origin)
./scripts/push-all.sh

# Sync upstream Perfetto changes
./scripts/sync-perfetto-upstream.sh
```

> **Important**: Always push perfetto to `fork` remote, never to `origin` (Google upstream).

## Documentation

- [Technical Architecture](docs/technical-architecture.md) — Why SmartPerfetto exists, how each layer works, developer extension guide
- [MCP Tools Reference](docs/mcp-tools-reference.md) — 18 MCP tools: parameters, return values, behavior details
- [Skill System Guide](docs/skill-system-guide.md) — YAML Skill DSL: format, step types, fragments, display config
- [Project Description](docs/PROJECT_DESCRIPTION.md) — High-level project overview for external audiences
- [Rendering Pipelines](rendering_pipelines/) — 30 Android rendering pipeline reference docs
- [Data Contract](backend/docs/DATA_CONTRACT_DESIGN.md) — DataEnvelope v2.0 specification
