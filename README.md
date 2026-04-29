# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Gracker/SmartPerfetto)](LICENSE)
[![Backend Regression Gate](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml)
[![Node.js >=18](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](backend/tsconfig.json)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed)](docker-compose.yml)
[![Perfetto UI fork](https://img.shields.io/badge/Perfetto-UI%20fork-4285f4)](https://perfetto.dev/)
[![Sponsor](https://img.shields.io/badge/Sponsor-WeChat%20553000664-f66f6f)](#sponsor)

> AI-powered Android performance analysis built on [Perfetto](https://perfetto.dev/).

SmartPerfetto adds an AI analysis layer on top of Perfetto traces. Load a trace, ask a natural-language question, and get an evidence-backed answer with SQL results, skill outputs, root-cause reasoning, and optimization suggestions.

The project is open source and in active development. The UI, backend runtime, and skill system are usable today, but public APIs and internal contracts may still change.

## Perfetto Resources

| Resource | English | Chinese |
|----------|---------|---------|
| Android Performance Blog | [androidperformance.com/en](https://www.androidperformance.com/en) | [androidperformance.com](https://www.androidperformance.com/) |
| Perfetto official docs | [perfetto.dev/docs](https://perfetto.dev/docs/) | [gugu-perf.github.io/perfetto-docs-zh-cn](https://gugu-perf.github.io/perfetto-docs-zh-cn/) |

## What It Does

- Analyzes Android Perfetto traces for scrolling jank, startup, ANR, interaction latency, memory, game, and rendering-pipeline issues.
- Keeps Perfetto's timeline and SQL power, then adds an AI assistant panel inside the Perfetto UI.
- Uses a TypeScript backend to run agent workflows, query `trace_processor_shell`, invoke YAML analysis skills, and stream results to the browser.
- Supports Anthropic directly and other tool-calling LLMs through an Anthropic-compatible API proxy.
- Ships with 160+ YAML skill/config files and scene strategies for Android performance investigation.

## Tech Stack

| Area | Technology |
|------|------------|
| Frontend | Forked Perfetto UI with the `com.smartperfetto.AIAssistant` plugin |
| Backend | Node.js 18+, TypeScript strict mode, Express |
| Agent runtime | Claude Agent SDK, MCP tools, scene strategies, verifier, SSE streaming |
| Trace engine | Perfetto `trace_processor_shell` over HTTP RPC |
| Analysis logic | YAML skills under `backend/skills/` plus Markdown strategies under `backend/strategies/` |
| Storage | Local uploads, session logs, reports, and runtime learning files |
| Testing | Jest, skill validation, strategy validation, 6-trace scene regression gate |
| Deployment | Docker Compose or local dev scripts |

## Quick Start

Prerequisites: **Node.js 18+**, `curl`, `lsof`, `pkill`, and an LLM API key.

```bash
git clone https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto
cp backend/.env.example backend/.env
# Edit backend/.env — set ANTHROPIC_API_KEY (direct) or
# ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY (API proxy)

./start.sh
```

- Frontend: [http://localhost:10000](http://localhost:10000)
- Backend: [http://localhost:3000](http://localhost:3000)

The repo ships with a pre-built Perfetto UI in `frontend/` — **no submodule init, no C++ toolchain, no 30-minute compile**. Load a `.pftrace` file, open the **AI Assistant** panel, and start analyzing.

### Docker

```bash
cp backend/.env.example backend/.env
docker compose up --build
```

### Two Scripts — Which One to Use?

| Script | Use when |
|--------|----------|
| `./start.sh` | ✅ Default — regular use, backend changes, strategy/skill edits |
| `./scripts/start-dev.sh` | Only when modifying the AI plugin UI (`ai_panel.ts`, `styles.scss` etc.) — requires `perfetto/` submodule |

### Frontend Development (modifying AI plugin code)

When you need to edit the AI Assistant plugin UI:

```bash
# One-time: initialize the perfetto submodule
git submodule update --init --recursive

# Start with hot reload (rebuilds frontend on save)
./scripts/start-dev.sh
```

After verifying your changes in the browser, update the pre-built frontend and commit:

```bash
./scripts/update-frontend.sh
git add frontend/
git commit -m "chore(frontend): update prebuilt"
```

## Configure an LLM

Minimum direct Anthropic setup:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

Third-party providers can be used through an API proxy that accepts Anthropic Messages requests and forwards them to a provider backend:

```bash
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_API_KEY=sk-proxy-xxx
CLAUDE_MODEL=your-main-model
CLAUDE_LIGHT_MODEL=your-light-model
```

Known proxy options include [one-api](https://github.com/songquanpeng/one-api), [new-api](https://github.com/Calcium-Ion/new-api), and [LiteLLM](https://github.com/BerriAI/litellm). The selected model must support streaming and tool/function calling reliably. See [backend/.env.example](backend/.env.example) for provider examples and tuning options.

## Basic Usage

1. Open [http://localhost:10000](http://localhost:10000).
2. Load a Perfetto trace file (`.pftrace` or `.perfetto-trace`).
3. Open the AI Assistant panel.
4. Ask a question, for example:
   - `分析滑动卡顿`
   - `Why is startup slow?`
   - `CPU 调度有没有问题？`
   - `Analyze the ANR in this trace`

SmartPerfetto works best with Android 12+ traces that include FrameTimeline data. Recommended atrace categories:

| Scene | Minimum categories | Useful extras |
|-------|--------------------|---------------|
| Scrolling | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| Startup | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |

## API Integration

The browser UI talks to the backend through REST and SSE. If you want to build your own UI or automation, start with these endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/agent/v1/analyze` | Start an analysis |
| `GET` | `/api/agent/v1/:sessionId/stream` | Subscribe to SSE progress and answer tokens |
| `GET` | `/api/agent/v1/:sessionId/status` | Poll analysis status |
| `POST` | `/api/agent/v1/:sessionId/respond` | Continue a multi-turn session |
| `POST` | `/api/agent/v1/resume` | Resume SDK context for an existing session |
| `POST` | `/api/agent/v1/scene-reconstruct` | Start scene reconstruction |
| `GET` | `/api/agent/v1/:sessionId/report` | Fetch the generated report |

Set `SMARTPERFETTO_API_KEY` in `backend/.env` if you expose the backend beyond your local machine. Protected APIs then require `Authorization: Bearer <token>`.

## Architecture

```text
Frontend (Perfetto UI @ :10000)
  └─ SmartPerfetto AI Assistant plugin
       └─ SSE / HTTP
Backend (Express @ :3000)
  ├─ agentv3 runtime: scene routing, prompts, MCP tools, verifier
  ├─ Skill engine: YAML analysis pipelines
  ├─ Session/report/log services
  └─ trace_processor_shell pool (HTTP RPC, 9100-9900)
```

Repository layout:

```text
SmartPerfetto/
├── backend/
│   ├── src/agentv3/        # Primary AI runtime
│   ├── src/services/       # Trace processor, skills, reports, sessions
│   ├── skills/             # YAML analysis skills and configs
│   ├── strategies/         # Scene strategies and prompt templates
│   └── tests/              # Skill-eval and regression tests
├── docs/                   # Architecture, MCP, skills, rendering references
├── scripts/                # Development and restart scripts
└── perfetto/               # Forked Perfetto UI submodule
```

## Development

Common commands:

```bash
./scripts/start-dev.sh
./scripts/restart-backend.sh

cd backend
npm run build
npm run test:scene-trace-regression
npm run validate:skills
npm run validate:strategies
npm run test:core
```

Required checks:

- Any code change: `cd backend && npm run test:scene-trace-regression`
- Skill YAML change: `npm run validate:skills` plus scene regression
- Strategy/template Markdown change: `npm run validate:strategies` plus scene regression
- Type/build fix: `cd backend && npx tsc --noEmit`

Do not hardcode prompt content in TypeScript. Put scene logic in `backend/strategies/*.strategy.md` or reusable `*.template.md` files.

## Documentation

- [Documentation Center](docs/README.md)
- [Quick Start](docs/getting-started/quick-start.md)
- [Architecture Overview](docs/architecture/overview.md)
- [API Reference](docs/reference/api.md)
- [MCP Tools Reference](docs/reference/mcp-tools.md)
- [Skill System Guide](docs/reference/skill-system.md)
- [Data Contract](backend/docs/DATA_CONTRACT_DESIGN.md)
- [Rendering Pipeline References](docs/rendering_pipelines/)
- [Security Policy](SECURITY.md)

## Contributing

Contributions are welcome. Good first contributions include:

- Reproducing a performance case with a small trace and clear question
- Adding or improving YAML skills
- Improving scene strategies and output templates
- Fixing UI issues in the Perfetto plugin
- Adding regression coverage for known trace scenarios

Before opening a PR:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Fork the repo and create a branch from `main`.
3. Keep changes scoped and include a clear test plan.
4. Run the required checks listed above.
5. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contact

- Bugs and feature requests: [GitHub Issues](https://github.com/Gracker/SmartPerfetto/issues)
- Security reports: [GitHub private advisory](https://github.com/Gracker/SmartPerfetto/security/advisories/new) or `smartperfetto@gracker.dev`
- Collaboration, commercial support, and sponsorship: WeChat `553000664`

## Sponsor

Common sponsorship channels for open-source projects include GitHub Sponsors, OpenCollective, Buy Me a Coffee, Afdian, WeChat/Alipay QR codes, and commercial support or licensing.

SmartPerfetto does not publish a public payment page yet. For sponsorship, donation, enterprise trial, or commercial licensing, contact the maintainer on WeChat: `553000664`.

## License

[AGPL-3.0-or-later](LICENSE) for SmartPerfetto core code.

The `perfetto/` submodule is a fork of [Google Perfetto](https://github.com/google/perfetto) and remains under [Apache-2.0](perfetto/LICENSE).

For commercial licensing without AGPL obligations, contact the maintainer on WeChat: `553000664`.
