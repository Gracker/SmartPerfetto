# Quick Start

[English](quick-start.en.md) | [中文](quick-start.md)

This page gets SmartPerfetto running. For complete model and proxy configuration, see the [Configuration Guide](configuration.en.md).

## 1. Clone the Repository

Regular users do not need to initialize the `perfetto/` submodule. The repository already includes a pre-built Perfetto UI bundle.

Step 1: run `git clone https://github.com/Gracker/SmartPerfetto.git`.

Step 2: run `cd SmartPerfetto`.

Initialize the submodule only when you need to modify the AI Assistant frontend plugin.

## 2. Prepare Model Configuration

For local source runs, if Claude Code already works in the same terminal, you can skip API key configuration. Run `claude` first to verify that path.

Create an env file only when you need an explicit API key, a compatible proxy, or Docker runtime credentials:

Step 1: run `cp backend/.env.example backend/.env`.

Step 2: edit `backend/.env`. Uncomment `ANTHROPIC_API_KEY` for direct Anthropic access, uncomment one Claude Code / Anthropic-compatible provider block for compatible providers, or use the OpenAI Agents SDK fields for OpenAI / OpenAI-compatible providers.

`backend/.env.example` includes presets for common Claude-compatible and OpenAI-compatible providers such as DeepSeek, GLM, Qwen, Kimi, Doubao, MiniMax, MiMo, and TokenHub. Docker Hub images read the root `.env` file instead:

Step 1: run `cp backend/.env.example .env`.

Step 2: edit `.env` and uncomment one provider block. You can skip this for a health/UI smoke check; real AI analysis requires a provider.

## 3. Run with Docker

Use this path when you only want to try SmartPerfetto and do not want to configure a local development toolchain.

Step 1: run `docker compose -f docker-compose.hub.yml pull`.

Step 2: run `docker compose -f docker-compose.hub.yml up -d`.

Open [http://localhost:10000](http://localhost:10000), load a `.pftrace` or `.perfetto-trace` file, then open the AI Assistant panel.

## 4. Run Locally

Use this path for local use, backend debugging, strategy/Skill edits, or pull requests.

Step 1: run `./start.sh`.

`./start.sh` starts the backend and the repository's pre-built Perfetto UI. On first run it installs dependencies and downloads the pinned `trace_processor_shell` prebuilt binary. If your network cannot access Google's artifact bucket, prefer Docker, or set `TRACE_PROCESSOR_PATH`, `TRACE_PROCESSOR_DOWNLOAD_BASE`, or `TRACE_PROCESSOR_DOWNLOAD_URL` before running the script.

| Service | Address |
|---|---|
| Perfetto UI | `http://localhost:10000` |
| Backend API | `http://localhost:3000` |
| Backend health | `http://localhost:3000/health` |

The backend starts automatically and the frontend uses the checked-in pre-built UI. Only AI Assistant frontend plugin work requires `git submodule update --init --recursive` followed by `./scripts/start-dev.sh`.

## 5. First Analysis

1. Open `http://localhost:10000`.
2. Load a Perfetto trace.
3. Open AI Assistant.
4. Ask a question, for example `Analyze scrolling jank`.

Common prompts:

- `Analyze startup performance`
- `Is there a CPU scheduling problem?`
- `Analyze this ANR`
- `What is the app package name and main process in this trace?`

## 6. Required Checks

Pick the smallest validation layer that proves your change. See [Testing and Verification](../development/testing.en.md) for details:

- Contract / type-only: `cd backend && npx tsc --noEmit` plus the relevant `sparkContracts` tests.
- CRUD-only service: the service's unit test.
- MCP / memory / report / agent runtime: `cd backend && npm run test:scene-trace-regression`.
- PR landing: `npm run verify:pr`.
