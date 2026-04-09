# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

> AI-powered Android performance analysis built on [Perfetto](https://perfetto.dev/).

Load a Perfetto trace, ask a question in natural language, and get structured, evidence-backed analysis with root cause chains and optimization recommendations.

<!-- TODO: Uncomment after GitHub org is set up
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Build](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions)
-->

> **Project Status: Active Development (Pre-release)**
>
> SmartPerfetto is under active development and used in production for Android performance analysis at scale. The core analysis engine, skill system, and UI integration are stable. APIs may change before the 1.0 release. Contributions and feedback are welcome.

## Features

- **AI Agent Analysis** — Claude Agent SDK orchestrates 20 MCP tools to query trace data, execute skills, and reason about performance issues. Supports [third-party LLMs](#use-with-other-llm-providers) (GLM, DeepSeek, Qwen, Kimi, OpenAI, Gemini, etc.) via API proxy
- **146 Analysis Skills** — YAML-based declarative pipelines (87 atomic + 29 composite + 28 pipeline + 2 deep) with layered results (L1 overview → L4 deep root cause)
- **12 Scene Strategies** — Scene-specific analysis playbooks (scrolling, startup, ANR, interaction, memory, game, and more)
- **21 Jank Root Cause Codes** — Priority-ordered decision tree with dual-signal detection (present_type + present_ts interval)
- **Multi-Architecture** — Standard HWUI, Flutter (TextureView/SurfaceView, Impeller/Skia), Jetpack Compose, WebView
- **Vendor Overrides** — Device-specific analysis for Pixel, Samsung, Xiaomi, OPPO, vivo, Honor, Qualcomm, MediaTek
- **Deep Root Cause Chains** — Blocking chain analysis, binder tracing, causal reasoning with Mermaid diagrams
- **Real-time Streaming** — SSE-based live analysis with phase transitions and intermediate reasoning
- **Perfetto UI Integration** — Custom plugin with timeline navigation, data tables, and chart visualization

## Getting Started

### Option 1: Docker (Recommended for users)

The fastest way to get SmartPerfetto running. No build tools required — just Docker and an API key.

```bash
git clone --recursive https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto

cp backend/.env.example backend/.env
# Edit backend/.env — set ANTHROPIC_API_KEY (or configure a third-party LLM, see below)

docker compose up --build
```

Open **http://localhost:10000**, load a `.pftrace` file, and start analyzing.

### Option 2: Local Setup (Recommended for developers)

Full development environment with hot reload and debugging.

**Prerequisites:**
- Node.js 18+ (`node -v`)
- Python 3 (Perfetto build tools)
- C++ toolchain — macOS: `xcode-select --install` / Linux: `sudo apt install build-essential python3`
- LLM API key — [Anthropic](https://console.anthropic.com/) (recommended), or any [supported LLM provider](#use-with-other-llm-providers)

```bash
git clone --recursive https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto

cp backend/.env.example backend/.env
# Edit backend/.env — set ANTHROPIC_API_KEY (or configure a third-party LLM, see below)

# First-time setup (builds trace_processor_shell, ~3-5 min)
./scripts/start-dev.sh
```

Open **http://localhost:10000**. Both backend and frontend auto-rebuild on file save — just refresh the browser after changes.

### Usage

1. Open http://localhost:10000 in your browser
2. Load a Perfetto trace file (`.pftrace` or `.perfetto-trace`)
3. Open the **AI Assistant** panel
4. Ask a question:
   - "分析滑动卡顿" (Analyze scroll jank)
   - "Why is startup slow?"
   - "CPU 调度有没有问题？" (Any CPU scheduling issues?)
   - "Analyze the ANR in this trace"

### Trace Requirements

SmartPerfetto works best with traces captured on **Android 12+** with these atrace categories:

| Scene | Minimum Categories | Recommended Extra |
|-------|-------------------|-------------------|
| Scrolling | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| Startup | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |

## Use with Other LLM Providers

SmartPerfetto works with **any LLM that supports function calling** — not just Claude. Connect to Chinese LLM providers, OpenAI, Google Gemini, or local models via an API proxy.

### How It Works

The Claude Agent SDK accepts an `ANTHROPIC_BASE_URL` environment variable. Point it at an API proxy that translates Anthropic Messages API format to the provider's OpenAI-compatible API:

```
SmartPerfetto → Claude Agent SDK → ANTHROPIC_BASE_URL → API Proxy → LLM Provider
```

### Setup

1. **Deploy an API proxy** that supports Anthropic-to-OpenAI format translation:
   - [one-api](https://github.com/songquanpeng/one-api) — popular, supports 50+ providers
   - [new-api](https://github.com/Calcium-Ion/new-api) — one-api fork with more features
   - [LiteLLM](https://github.com/BerriAI/litellm) — Python-based, Anthropic format support

2. **Configure the proxy** with your provider's API key and endpoint

3. **Edit `backend/.env`** — uncomment the provider block in `.env.example`:

```bash
# Point at your proxy
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_API_KEY=sk-proxy-xxx

# Set model names (must match what the proxy expects)
CLAUDE_MODEL=glm-4-plus
CLAUDE_LIGHT_MODEL=glm-4-flash
```

### Supported Providers

| Provider | Main Model | Light Model | Proxy Backend URL |
|----------|-----------|-------------|-------------------|
| **GLM (智谱AI)** | `glm-4-plus` | `glm-4-flash` | `https://open.bigmodel.cn/api/paas/v4` |
| **DeepSeek** | `deepseek-chat` | `deepseek-chat` | `https://api.deepseek.com/v1` |
| **Qwen (通义千问)** | `qwen-max` | `qwen-turbo` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| **Kimi (月之暗面)** | `moonshot-v1-128k` | `moonshot-v1-8k` | `https://api.moonshot.cn/v1` |
| **Doubao (豆包)** | `ep-xxx` (endpoint ID) | `ep-xxx` | `https://ark.cn-beijing.volces.com/api/v3` |
| **Minimax** | `abab6.5s-chat` | `abab5.5-chat` | `https://api.minimax.chat/v1` |
| **Baichuan (百川)** | `Baichuan4` | `Baichuan3-Turbo` | `https://api.baichuan-ai.com/v1` |
| **Hunyuan (腾讯混元)** | `hunyuan-pro` | `hunyuan-lite` | `https://api.hunyuan.cloud.tencent.com/v1` |
| **OpenAI** | `gpt-4o` | `gpt-4o-mini` | `https://api.openai.com/v1` |
| **Google Gemini** | `gemini-2.5-pro` | `gemini-2.0-flash` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| **Ollama (local)** | `qwen2.5:72b` | `qwen2.5:7b` | `http://localhost:11434/v1` |

See [`backend/.env.example`](backend/.env.example) for complete configuration examples with console URLs and notes.

### Notes

- **`CLAUDE_LIGHT_MODEL`** is used for auxiliary single-turn calls (query classification, conclusion verification, scene summarization). If your proxy only maps one model, set it to the same value as `CLAUDE_MODEL`.
- **Sub-agents** (`CLAUDE_ENABLE_SUB_AGENTS`) are disabled by default for all users (research preview in the Claude Agent SDK). When enabled, the SDK internally resolves model shorthands like `'sonnet'` → `'claude-sonnet-4-6'` and makes separate API calls — these go through your proxy. Whether it works depends on your proxy's Anthropic format translation fidelity. If you want to try it, set `CLAUDE_ENABLE_SUB_AGENTS=true` and ensure your proxy maps Anthropic model names correctly.
- **Extended thinking** (`CLAUDE_EFFORT`) is a Claude-specific feature. Non-Claude providers will ignore it.
- **Function calling quality** varies by provider. Models with strong function calling (GLM-4, DeepSeek V3, Qwen-Max, GPT-4o) work best with SmartPerfetto's 20-tool MCP server.

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
│  │    ├─ System Prompt Builder (dynamic, scene-specific)     │   │
│  │    ├─ Claude Agent SDK (MCP protocol)                     │   │
│  │    ├─ SSE Bridge (SDK stream → frontend events)           │   │
│  │    └─ Verifier (4-layer) + Reflection Retry               │   │
│  │                                                           │   │
│  │  MCP Server (20 tools: 9 always-on + 11 conditional)      │   │
│  │    execute_sql │ invoke_skill │ detect_architecture       │   │
│  │    lookup_sql_schema │ lookup_knowledge │ submit_plan     │   │
│  │    submit_hypothesis │ fetch_artifact │ ...               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           Skill Engine (146 YAML Skills)                  │   │
│  │   atomic/ (87) │ composite/ (29) │ pipelines/ (28) │ ... │   │
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
| **MCP Server** | 20 tools bridging Claude to trace data (SQL, Skills, schema lookup, knowledge, planning, hypothesis, comparison) |
| **Skill Engine** | Executes YAML-defined analysis pipelines with SQL queries, producing layered results (L1-L4) |
| **Scene Classifier** | Keyword-based routing (<1ms) to scene-specific strategies (scrolling, startup, ANR, ...) |
| **Verifier** | 4-layer quality check (heuristic + plan + hypothesis + LLM) with up to 2 reflection retries |
| **Artifact Store** | Caches skill results as compact references (~3000 tokens saved per skill invocation) |
| **SQL Summarizer** | Compresses SQL results to stats + samples (~85% token savings) |

## Project Structure

```
SmartPerfetto/
├── backend/
│   ├── src/agentv3/        # AI runtime (Claude Agent SDK orchestrator)
│   ├── src/services/       # Core services (trace processor, skill engine)
│   ├── skills/             # 146 YAML analysis skills
│   │   ├── atomic/         #   Single-step detection (87)
│   │   ├── composite/      #   Multi-step analysis (29)
│   │   ├── pipelines/      #   Render pipeline detection (28)
│   │   ├── deep/           #   Deep causal analysis (2)
│   │   ├── modules/        #   Module configs (app/framework/hardware/kernel)
│   │   └── vendors/        #   Vendor overrides (pixel/samsung/xiaomi/...)
│   ├── strategies/         # Scene strategies + prompt templates (.md)
│   └── __tests__/          # Unit tests (1029 tests)
│
├── perfetto/               # Forked Perfetto UI (submodule)
│   └── ui/src/plugins/com.smartperfetto.AIAssistant/
│
└── Skills-Standard/        # Standalone skills (Anthropic SKILL.md format)
    ├── scrolling-analysis/
    └── startup-analysis/
```

## Skills-Standard (Standalone Skills)

The `Skills-Standard/` directory contains analysis skills exported as standalone [Anthropic SKILL.md](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/skills) packages. These work independently with any Claude-powered tool that has SQL access to Perfetto traces — **no SmartPerfetto backend required**.

| Skill | Description |
|-------|-------------|
| **scrolling-analysis** | Jank detection with 21 root cause codes, dual-signal detection, Flutter/Compose/WebView support |
| **startup-analysis** | Launch performance with TTID/TTFD diagnosis, 4-quadrant analysis, blocking chain tracing |

See [Skills-Standard/README.md](Skills-Standard/README.md) for installation and usage.

## Development

### Dev Workflow

After the initial `./scripts/start-dev.sh`, both backend (`tsx watch`) and frontend (`build.js --watch`) auto-rebuild on save:

| Change Type | Action Needed |
|-------------|---------------|
| TypeScript / YAML / Markdown | Refresh browser |
| `.env` or `npm install` | `./scripts/restart-backend.sh` |
| Both services crashed | `./scripts/start-dev.sh` |

### Testing

Every code change must pass the regression suite:

```bash
cd backend

# Mandatory — run after EVERY change
npm run test:scene-trace-regression

# Validate skill YAML contracts
npm run validate:skills

# Validate strategy markdown frontmatter
npm run validate:strategies

# Full test suite (~8 min)
npm test
```

### API Overview

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agent/v1/analyze` | Start analysis |
| GET | `/api/agent/v1/:id/stream` | SSE real-time updates |
| GET | `/api/agent/v1/:id/status` | Get analysis status |
| POST | `/api/agent/v1/resume` | Resume multi-turn analysis |
| POST | `/api/agent/v1/scene-reconstruct` | Scene reconstruction |

See [CLAUDE.md](CLAUDE.md) for the full API reference.

### Debugging

Session logs are stored in `backend/logs/sessions/*.jsonl`:

```bash
# View session logs via API
curl http://localhost:3000/api/agent/v1/logs/{sessionId}
```

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | `./scripts/start-dev.sh` |
| Empty analysis data | Verify trace has FrameTimeline data (Android 12+) |
| Port conflict on 9100-9900 | `pkill -f trace_processor_shell` |

## Documentation

- [Technical Architecture](docs/technical-architecture.md) — System design and extension guide
- [MCP Tools Reference](docs/mcp-tools-reference.md) — 20 MCP tools with parameters and behavior
- [Skill System Guide](docs/skill-system-guide.md) — YAML Skill DSL reference
- [Data Contract](backend/docs/DATA_CONTRACT_DESIGN.md) — DataEnvelope v2.0 specification
- [Rendering Pipelines](docs/rendering_pipelines/) — 23 Android rendering pipeline reference docs

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing requirements, and the PR process.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## License

[AGPL v3](LICENSE) — SmartPerfetto core.

The `perfetto/` submodule is a fork of [Google's Perfetto](https://github.com/google/perfetto), licensed under [Apache 2.0](perfetto/LICENSE).

For commercial licensing options (use without AGPL obligations), please contact the maintainer.
