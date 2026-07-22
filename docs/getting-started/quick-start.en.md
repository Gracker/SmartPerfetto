# Quick Start

[English](quick-start.en.md) | [中文](quick-start.md)

This page gets SmartPerfetto running. For complete model and proxy configuration, see the [Configuration Guide](configuration.en.md).

## 1. Clone the Repository

Regular users do not need to initialize the `perfetto/` submodule. The repository already includes a pre-built Perfetto UI bundle.

Step 1: run `git clone https://github.com/Gracker/SmartPerfetto.git`.

Step 2: run `cd SmartPerfetto`.

Initialize the submodule only when you need to modify the AI Assistant frontend plugin.

## 2. Prepare Model Configuration

You do not need to configure every runtime. For first setup, pick one entry point: local `claude`, UI Provider Manager, one Claude-compatible env block, one OpenAI-compatible env block, a custom Pi Agent Core / OpenCode block, or an explicitly installed Qoder SDK with local CLI auth/PAT.

For local source runs, if Claude Code already works in the same terminal, you can skip API key configuration. Run `claude` first to verify that path.

Create an env file only when you need an explicit API key, a compatible proxy, or Docker runtime credentials:

Step 1: run `cp backend/.env.example backend/.env`.

Step 2: edit `backend/.env`. Uncomment `ANTHROPIC_API_KEY` for direct Anthropic access, uncomment one Claude Code / Anthropic-compatible provider block for compatible providers, use the OpenAI Agents SDK fields for OpenAI / OpenAI-compatible providers, or use the Pi Agent Core / OpenCode custom sections. Qoder is opt-in: review its terms, install `@qoder-ai/qoder-agent-sdk`, then use the Qoder section.

`backend/.env.example` includes presets for common Claude-compatible and OpenAI-compatible providers such as DeepSeek, GLM, Qwen, Kimi, Doubao, MiniMax, MiMo, and TokenHub. Docker reads the repository-root `.env` file, including both Docker Hub images and local source Docker builds:

Step 1: run `cp .env.example .env`.

Step 2: edit `.env` and uncomment one provider block. Skip this if you will configure the provider in UI Provider Manager, or if you only need a health/UI smoke check; real AI analysis requires one provider source.

If a Provider Manager profile is active in the UI, it overrides `.env` fallback. Confirm the active source in the container startup log, Provider settings, or authenticated `/api/runtime-health`; public `/health` is liveness-only.

## 3. Run with Docker

Use this path when you only want to try SmartPerfetto and do not want to configure a local development toolchain.

Step 1: run `docker compose -f docker-compose.hub.yml pull`.

Step 2: run `docker compose -f docker-compose.hub.yml up -d`.

Open [http://localhost:10000](http://localhost:10000), load a `.pftrace` or `.perfetto-trace` file, then open the AI Assistant panel.

The image already contains the pinned trace processor, committed UI, and signed
Android Internals Knowledge Pack; the host does not download those runtime
assets.

## 4. Run Locally

Use this path for local use, backend debugging, strategy/Skill edits, or pull requests.

Step 1: run `./start.sh`.

`./start.sh` starts the backend and the repository's pre-built Perfetto UI and
reports success only after both HTTP readiness checks pass. On first run it
installs dependencies and downloads the pinned `trace_processor_shell`
prebuilt binary. If your network cannot access Google's artifact bucket,
prefer Docker, or set `TRACE_PROCESSOR_PATH`,
`TRACE_PROCESSOR_DOWNLOAD_BASE`, or `TRACE_PROCESSOR_DOWNLOAD_URL` before
running the script. If a process outside the current checkout owns a configured
port, startup reports its owner and exits instead of killing it.

| Service | Address |
|---|---|
| Perfetto UI | `http://localhost:10000` |
| Backend API | `http://localhost:3000` |
| Backend health | `http://localhost:3000/health` |

The backend starts automatically and the frontend uses the checked-in pre-built UI. Only AI Assistant frontend plugin work requires `git submodule update --init --recursive` followed by `./scripts/start-dev.sh`.
The repository also contains an offline Knowledge Pack snapshot. The background
worker only checks signed updates according to configuration and never silently
switches an active session's knowledge version.

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

Pick the smallest validation layer that proves your change. Maintainers and
LLM/agents should first read [Product Surface Rules](../../.claude/rules/product-surface.md)
and [Testing Rules](../../.claude/rules/testing.md):

- Contract / type-only: `cd backend && npx tsc --noEmit` plus the relevant `sparkContracts` tests.
- CRUD-only service: the service's unit test.
- MCP / memory / report / agent runtime: `cd backend && npm run test:scene-trace-regression`.
- Documentation entry, command, or link: `npm run verify:docs`.
- PR landing: `npm run verify:pr`.

Release, npm, Docker, or portable-package changes also need the
[Release Runbook](../reference/release.en.md) and
[Release Rules](../../.claude/rules/release.md).

## 7. Trace Corpus

The repository's [Trace corpus](../../Trace/README.md) separates real cases from reproducible constructed cases. Each real case keeps its trace, analysis results, logs, provenance, and Android/API metadata in one directory. Constructed cases store deterministic overlays on real base traces and cover the current Skill and Strategy inventory.

- Check indexes, hashes, publication approvals, and exact coverage: `npm run trace:validate`
- Build every combined trace: `npm run trace:build`
- Run the full release regression: `npm run trace:regression`

New captures must enter the ignored `.private/` staging area through `import-real`. Run `promote-real` only after recording license, consent, privacy review, and sanitization review. See [Trace/README.md](../../Trace/README.md) for complete commands, the constructed-scenario template, coverage quality levels, and Android-version conventions.
