# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Gracker/SmartPerfetto)](LICENSE)
[![Backend Regression Gate](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml)
[![Node.js 24 LTS](https://img.shields.io/badge/Node.js-24%20LTS-brightgreen)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](backend/tsconfig.json)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed)](docker-compose.yml)
[![Perfetto UI fork](https://img.shields.io/badge/Perfetto-UI%20fork-4285f4)](https://perfetto.dev/)
[![Sponsor](https://img.shields.io/badge/Sponsor-WeChat%20553000664-f66f6f)](#sponsor)

> AI-powered Android performance analysis built on [Perfetto](https://perfetto.dev/).

SmartPerfetto adds an AI analysis layer on top of Perfetto traces. Load a trace, ask a natural-language question, and get an evidence-backed answer with SQL results, skill outputs, root-cause reasoning, and optimization suggestions.

Configure a provider before running AI analysis. This README keeps the startup flow and one provider configuration example only; the complete provider/model list lives in [docs/getting-started/configuration.md](docs/getting-started/configuration.md), [backend/.env.example](backend/.env.example), and the root [.env.example](.env.example).

Provider Base URL notice: the prefilled Claude/Anthropic-compatible and OpenAI-compatible Base URLs are based on public provider information. They are not guaranteed to be correct for every account, region, plan, or future provider change. If a preset fails, verify the Base URL, model ID, and protocol in your provider console first; then open an issue or PR if the public preset should be updated.

The project is open source and in active development. The UI, backend runtime, and skill system are usable today, but public APIs and internal contracts may still change.

## Configure Your AI Provider First

LLM credentials only take effect on the backend side. The Perfetto UI's AI Assistant settings panel has a `Backend API Key` field, but that field is only for `SMARTPERFETTO_API_KEY`, which protects the SmartPerfetto backend. It is not a place to enter model-provider keys. See [docs/getting-started/configuration.md](docs/getting-started/configuration.md) for the full provider guide.

Step 1: Choose your run mode and credential file.

| Run mode | Credential file | Notes |
|----------|-----------------|-------|
| Local source checkout where Claude Code already works in the same terminal | No `.env` required | Verify with `claude`; then run `./start.sh`, which starts both backend and the pre-built frontend |
| Local source checkout with explicit API key or compatible proxy | `backend/.env` | Create it with `cp backend/.env.example backend/.env` |
| Docker Hub image | `.env` in the repository root | Create it with `cp backend/.env.example .env`; Docker cannot see the host Claude Code login |
| Source Docker build | `backend/.env` | Read by `docker-compose.yml` |

Step 2: Choose the runtime and provider settings. Claude Agent SDK is for Claude Code / Anthropic-compatible providers; OpenAI Agents SDK is for OpenAI / OpenAI-compatible providers. If both credential families are present, `SMARTPERFETTO_AGENT_RUNTIME` or the active UI provider decides; otherwise the default is Claude Agent SDK.

For direct Anthropic API access, set:

```env
ANTHROPIC_API_KEY=sk-ant-your-key
```

For providers that expose Claude Code / Anthropic-compatible endpoints, uncomment the provider block in [backend/.env.example](backend/.env.example), replace the API key/token, and keep `CLAUDE_MODEL` / `CLAUDE_LIGHT_MODEL` as the SmartPerfetto model fields. Example for DeepSeek:

```env
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-your-deepseek-key
CLAUDE_MODEL=deepseek-v4-pro
CLAUDE_LIGHT_MODEL=deepseek-v4-flash
```

OpenAI / OpenAI-compatible providers use the OpenAI Agents SDK runtime; Ollama and other OpenAI-compatible endpoints use `OPENAI_AGENTS_PROTOCOL=chat_completions`. The UI Provider Management flow can store both Claude-compatible and OpenAI-compatible Base URLs for dual-surface providers, then switch the active SDK runtime from the AI input provider switcher. Full provider-specific fields, known regional URL variants, model IDs, and troubleshooting notes are in [docs/getting-started/configuration.md](docs/getting-started/configuration.md) and the env templates.

Step 3 (optional): Set the output language. SmartPerfetto defaults to Simplified Chinese for AI answers, streamed progress, and generated reports. Set this if the primary users prefer English:

```env
SMARTPERFETTO_OUTPUT_LANGUAGE=en
```

Step 4: Start or restart services. For Docker, run `docker compose -f docker-compose.hub.yml up -d` or `docker compose -f docker-compose.hub.yml restart`. For local source runs, use `./start.sh`; if you only changed `.env` while the backend is already running, use `./scripts/restart-backend.sh`. For explicit SmartPerfetto env/proxy credentials, verify the active provider with [http://localhost:3000/health](http://localhost:3000/health). For the local Claude Code path, verify by running a normal `claude` request in the same terminal; the first AI analysis call will use the SDK's Claude Code auth/config path.

## Perfetto Resources

| Resource | English | Chinese |
|----------|---------|---------|
| Android Performance Blog | [androidperformance.com/en](https://www.androidperformance.com/en) | [androidperformance.com](https://www.androidperformance.com/) |
| Perfetto official docs | [perfetto.dev/docs](https://perfetto.dev/docs/) | [gugu-perf.github.io/perfetto-docs-zh-cn](https://gugu-perf.github.io/perfetto-docs-zh-cn/) |

## What It Does

- Analyzes Android Perfetto traces for scrolling jank, startup, ANR, interaction latency, memory, game, and rendering-pipeline issues.
- Keeps Perfetto's timeline and SQL power, then adds an AI assistant panel inside the Perfetto UI.
- Uses a TypeScript backend to run agent workflows, query `trace_processor_shell`, invoke YAML analysis skills, and stream results to the browser.
- Supports Anthropic directly, Claude/Anthropic-compatible providers, and OpenAI/OpenAI-compatible providers through the matching backend SDK runtime.
- Ships with 160+ YAML skill/config files and scene strategies for Android performance investigation.

## Tech Stack

| Area | Technology |
|------|------------|
| Frontend | Forked Perfetto UI with the `com.smartperfetto.AIAssistant` plugin |
| Backend | Node.js 24 LTS, TypeScript strict mode, Express |
| Agent runtime | Runtime selector, Claude Agent SDK, OpenAI Agents SDK, MCP tools, scene strategies, verifier, SSE streaming |
| Trace engine | Perfetto `trace_processor_shell` over HTTP RPC |
| Analysis logic | YAML skills under `backend/skills/` plus Markdown strategies under `backend/strategies/` |
| Storage | Local uploads, session logs, reports, and runtime learning files |
| Testing | Jest, skill validation, strategy validation, 6-trace scene regression gate |
| Deployment | Docker Compose or local dev scripts |

## For Users

### Docker (Recommended)

Use this path if you only want to run SmartPerfetto. You need Docker Desktop/Engine and LLM provider credentials in `.env`; you do not need Node.js, a C++ toolchain, or the `perfetto/` submodule. The Docker Hub image is published nightly from `main` and includes the backend, the pre-built Perfetto UI, and the pinned `trace_processor_shell`, so it also avoids first-run access to Google's artifact bucket on the host.

Both the Docker Hub image and source Docker builds serve the committed pre-built UI from `frontend/`; Docker users never build the Perfetto submodule frontend locally.

The container starts without a local `.env` file for health/UI smoke checks, but AI analysis needs one explicit provider block, for example `ANTHROPIC_API_KEY` for Anthropic direct, `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` for a Claude-compatible provider, or `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk` plus `OPENAI_*` fields for an OpenAI-compatible provider.

Provider profiles created in the UI are stored in the `provider-data` Docker volume. They survive container restarts and normal `docker compose down`; they are removed by `docker compose down -v`.

Windows users should use Docker Desktop with the WSL2 backend. The published image is a Linux container image and runs through Docker Desktop; no separate Windows build is required.

Step 1: Download the source. Run `git clone https://github.com/Gracker/SmartPerfetto.git`, then run `cd SmartPerfetto`.

Step 2 (optional): Create the Docker env file. Run `cp backend/.env.example .env`, edit `.env`, uncomment one provider block, and start by replacing the API key/token. If your provider console shows a different Base URL or model ID, use the console value. You can skip this for health/UI smoke checks; real AI analysis requires a provider.

Step 3: Pull the Docker Hub image. Run `docker compose -f docker-compose.hub.yml pull`.

Step 4: Start the container. Run `docker compose -f docker-compose.hub.yml up -d`.

Step 5: Open the service URLs.

- Frontend: [http://localhost:10000](http://localhost:10000)
- Backend health: [http://localhost:3000/health](http://localhost:3000/health)

Stop the container with `docker compose -f docker-compose.hub.yml down`.

Uploads, logs, and Provider Manager profiles are stored in Docker volumes, so they survive container restarts.

### Local Script

Use this path if you prefer running from a source checkout on macOS or Linux. Prerequisites: **Node.js 24 LTS**, `curl`, `lsof`, `pkill`, and either Claude Code login or LLM provider credentials. For Windows source development, use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install), not native Windows shell.

The repository includes `.nvmrc` and `.node-version`, and npm is configured with `engine-strict=true`. `./start.sh`, `./scripts/start-dev.sh`, and `./scripts/restart-backend.sh` will try to activate Node 24 through nvm or fnm. If backend dependencies were installed under another Node ABI, the scripts reinstall `backend/node_modules` automatically before starting the server. This prevents native modules such as `better-sqlite3` from being reused across Node 20/24/25.

On macOS, if `trace_processor_shell` fails the `--version` smoke test, macOS says the developer cannot be verified, or the terminal only prints `killed`, Gatekeeper may have blocked the downloaded binary. Open **System Settings → Privacy & Security → Security**, click **Allow Anyway** for `trace_processor_shell`, then re-run `./start.sh` and choose **Open** if macOS asks again. For a binary you trust, you can also run `xattr -dr com.apple.quarantine /absolute/path/to/trace_processor_shell` and then `chmod +x /absolute/path/to/trace_processor_shell`.

Step 1: Download the source. Run `git clone https://github.com/Gracker/SmartPerfetto.git`, then run `cd SmartPerfetto`.

Step 2: Choose the model credential source. If Claude Code already works in the same terminal, run `claude` to verify it and do not create `.env`. If you want an explicit API key or compatible proxy, run `cp backend/.env.example backend/.env`, then edit `backend/.env`: uncomment `ANTHROPIC_API_KEY` for direct Anthropic, uncomment one Claude Code / Anthropic-compatible provider block for compatible providers, or use the OpenAI Agents SDK fields for OpenAI / OpenAI-compatible providers.

Step 3: Start services. Run `./start.sh`. This script starts both the backend at `http://localhost:3000` and the repository's pre-built Perfetto UI at `http://localhost:10000`; regular use does not require initializing the `perfetto/` submodule or compiling Perfetto UI from source.

## For Developers

### Runtime Scripts

For regular use, backend changes, strategy changes, and skill changes, prefer `./start.sh`. It starts the backend and serves the repository's pre-built Perfetto UI as the frontend. Use `./scripts/start-dev.sh` only when editing the AI Assistant plugin UI, debugging Perfetto UI source, or explicitly needing the `perfetto/` submodule watch build. Do not only run `cd backend && npm run dev`: that starts Express, but it does not bring up the frontend or validate the trace-processor path.

On Linux, if analysis fails with `Claude Code native binary not found at .../node_modules/@anthropic-ai/claude-agent-sdk-.../claude`, the backend dependencies were installed without the Claude Agent SDK optional native package for this platform. Fix it in three steps: Step 1, run `rm -rf backend/node_modules`; Step 2, run `cd backend && npm ci --include=optional`; Step 3, run `cd .. && ./scripts/start-dev.sh`.

| Script | Use when |
|--------|----------|
| `./start.sh` | ✅ Default — regular use, backend changes, strategy/skill edits; starts both backend and pre-built frontend |
| `./scripts/start-dev.sh` | AI plugin UI edits (`ai_panel.ts`, `styles.scss` etc.) or Perfetto UI source debugging — requires `perfetto/` submodule |

### Source Docker Build

Use this only when testing Docker changes or building an unreleased local checkout. Step 1: run `cp backend/.env.example backend/.env` and edit the provider if needed. Step 2: run `docker compose up --build`.

The source build uses the committed `frontend/` bundle and does not rebuild the `perfetto/` submodule.

### Frontend Development (modifying AI plugin code)

When you need to edit the AI Assistant plugin UI, Step 1 (first time): run `git submodule update --init --recursive` to initialize the `perfetto/` submodule. Step 2: run `./scripts/start-dev.sh`; it rebuilds on save.

After verifying your changes in the browser, Step 1: run `./scripts/update-frontend.sh` to update the pre-built frontend. Step 2: run `git add frontend/`. Step 3: run `git commit -m "chore(frontend): update prebuilt"`.

## Runtime Settings

The quick setup above covers where credentials live. Detailed provider setup, model IDs, regional Base URL variants, OpenAI-compatible runtime fields, Anthropic-compatible presets, proxy guidance, and troubleshooting live in [docs/getting-started/configuration.md](docs/getting-started/configuration.md). Use `GET /health` to confirm `aiEngine.runtime`, `aiEngine.providerMode`, and `aiEngine.diagnostics` after changing provider settings.

Claude Code local auth/config is only available to local source runs, not Docker. Separate tools such as Codex CLI, Gemini CLI, and OpenCode manage their own configuration files and login state; SmartPerfetto does not automatically read those credentials. The frontend settings dialog only stores the backend URL and optional `SMARTPERFETTO_API_KEY` for SmartPerfetto backend auth.

### Output Language

User-facing output defaults to Simplified Chinese. To make AI answers, streamed progress text, and generated Agent-Driven reports English, set:

```bash
SMARTPERFETTO_OUTPUT_LANGUAGE=en
```

Accepted values include `zh-CN` and `en`. Restart the backend after changing `.env`.

### Turn Budgets

SmartPerfetto has separate turn budgets for fast and full analysis. Claude runtime uses `CLAUDE_*`; OpenAI runtime uses `OPENAI_*` with the same meanings:

```bash
CLAUDE_QUICK_MAX_TURNS=10  # fast mode default
CLAUDE_MAX_TURNS=60        # full mode default
OPENAI_QUICK_MAX_TURNS=10  # optional OpenAI runtime override
OPENAI_MAX_TURNS=60        # optional OpenAI runtime override
```

Raise these values for slower models or traces that need more tool iterations. The total safety timeout scales with the turn budget: full mode uses `CLAUDE_FULL_PER_TURN_MS` / `OPENAI_FULL_PER_TURN_MS` per turn, and fast mode uses `CLAUDE_QUICK_PER_TURN_MS` / `OPENAI_QUICK_PER_TURN_MS` per turn. Restart the backend after changing `.env`.

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

## CLI Usage

SmartPerfetto also ships a terminal CLI for trace analysis without opening the browser UI. It uses the same runtime selection, tools, skills, and report pipeline as the web experience and writes local sessions, transcripts, and reports under `~/.smartperfetto/`.

```bash
# Requires Node.js 24 LTS
npm install -g @gracker/smartperfetto

# Analyze a trace, then continue the conversation or open the report.
smp -f trace.pftrace -p "Analyze scrolling jank"
smp resume <sessionId> --query "Why is RenderThread slow?"
smp list
smp report <sessionId> --open

# Or run an interactive Claude-Code-style REPL.
smp
```

The first analysis downloads the pinned `trace_processor_shell` binary automatically if it is not already available. If your network cannot reach Google's artifact bucket, set `TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell` to use a local binary, or set `TRACE_PROCESSOR_DOWNLOAD_BASE` / `TRACE_PROCESSOR_DOWNLOAD_URL` to a trusted mirror; downloaded binaries are still checked against the pinned SHA256. `smartperfetto` remains available as the long command name; source checkout scripts are only for maintainers debugging the CLI. See [CLI Reference](docs/reference/cli.md) for all commands, REPL slash commands, storage layout, and resume behavior.

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
  ├─ Runtime selector: Claude Agent SDK or OpenAI Agents SDK
  ├─ Agent orchestration: scene routing, prompts, MCP tools, verifier
  ├─ Skill engine: YAML analysis pipelines
  ├─ Session/report/log services
  └─ trace_processor_shell pool (HTTP RPC, 9100-9900)
```

Repository layout:

```text
SmartPerfetto/
├── backend/
│   ├── src/agentRuntime/   # SDK runtime selection
│   ├── src/agentv3/        # Claude Agent SDK orchestration
│   ├── src/agentOpenAI/    # OpenAI Agents SDK orchestration
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

# Before opening a PR: runs quality, build/type checks, skill/strategy
# validation, core tests, and the 6 canonical trace regression.
npm run verify:pr

cd backend
npm run build
npm run cli:build-run -- --help
npm run test:scene-trace-regression
npm run validate:skills
npm run validate:strategies
npm run test:core
```

Required checks:

- Before opening a PR: `npm run verify:pr` from the repository root
- Code change by category:
  - Contract / type-only (`backend/src/types/sparkContracts.ts` etc.): `cd backend && npx tsc --noEmit` + relevant `__tests__/sparkContracts.test.ts`
  - CRUD-only service (file IO, no agent path touched): that service's unit tests
  - Touches mcp / memory / report / agent runtime: `cd backend && npm run test:scene-trace-regression`
- Skill YAML change: `npm run validate:skills` plus scene regression
- Strategy/template Markdown change: `npm run validate:strategies` plus scene regression
- Type/build fix: `cd backend && npm run typecheck`

Do not hardcode prompt content in TypeScript. Put scene logic in `backend/strategies/*.strategy.md` or reusable `*.template.md` files.

## Documentation

- [Documentation Center](docs/README.md)
- [Quick Start](docs/getting-started/quick-start.md)
- [Architecture Overview](docs/architecture/overview.md)
- [API Reference](docs/reference/api.md)
- [CLI Reference](docs/reference/cli.md)
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
