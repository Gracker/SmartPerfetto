# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Gracker/SmartPerfetto)](LICENSE)
[![Backend Regression Gate](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml)
[![Node.js 24 LTS](https://img.shields.io/badge/Node.js-24%20LTS-brightgreen)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](backend/tsconfig.json)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed)](docker-compose.yml)
[![Perfetto UI fork](https://img.shields.io/badge/Perfetto-UI%20fork-4285f4)](https://perfetto.dev/)
[![Sponsor](https://img.shields.io/badge/Sponsor-WeChat%20553000664-f66f6f)](docs/sponsor.en.md)

> AI-powered Android performance analysis built on [Perfetto](https://perfetto.dev/).

SmartPerfetto adds an AI analysis layer on top of Perfetto traces. Load a trace, ask a natural-language question, and get an evidence-backed answer with SQL results, skill outputs, root-cause reasoning, and optimization suggestions.

Configure a provider before running AI analysis. This README keeps the startup flow and one provider configuration example only; the complete provider/model list lives in [docs/getting-started/configuration.en.md](docs/getting-started/configuration.en.md), [backend/.env.example](backend/.env.example), and the root [.env.example](.env.example).

Provider Base URL notice: the prefilled Claude/Anthropic-compatible and OpenAI-compatible Base URLs are based on public provider information. They are not guaranteed to be correct for every account, region, plan, or future provider change. If a preset fails, verify the Base URL, model ID, and protocol in your provider console first; then open an issue or PR if the public preset should be updated.

The project is open source and in active development. The UI, backend runtime, and skill system are usable today, but public APIs and internal contracts may still change.

<!-- android-performance-ecosystem:start -->
## Android performance ecosystem

The [Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) brings its navigation Hub and seven core projects into an optional path from instrumentation and capture to analysis, system knowledge, and reproducible cases.

| Stage | Project | Purpose | Address |
| --- | --- | --- | --- |
| Navigate | [Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) | Maintain the shared project map, handoff metadata, generated README navigation, and drift checks. | [GitHub](https://github.com/Gracker/android-performance-ecosystem) |
| Instrument | [TraceFix](https://github.com/Gracker/TraceFix) | Inject app-side android.os.Trace sections at build time so method work is visible at runtime. | [GitHub](https://github.com/Gracker/TraceFix) |
| Capture and measure | [Perfetto Tools](https://github.com/Gracker/perfetto-tools) | Capture repeatable Perfetto traces and collect FPS or Simpleperf measurements. | [GitHub](https://github.com/Gracker/perfetto-tools) |
| Analyze | [SmartPerfetto](https://github.com/Gracker/SmartPerfetto) | Investigate traces with an AI-assisted Web UI, CLI, reports, sessions, comparisons, and evidence workflow. | [GitHub](https://github.com/Gracker/SmartPerfetto) |
| Agent analysis | [Perfetto Skills](https://github.com/Gracker/Perfetto-Skills) | Give agents a portable Perfetto analysis Skill for Android, Linux, and Chromium, with selected assets synchronized through pinned workflows. | [GitHub](https://github.com/Gracker/Perfetto-Skills) |
| Learn | [Android Performance Blog](https://github.com/Gracker/Gracker.github.io) | Teach Perfetto and Systrace analysis through articles, system explanations, and case studies. | [AndroidPerformance.com](https://www.androidperformance.com/) · [GitHub](https://github.com/Gracker/Gracker.github.io) |
| System knowledge | Android Internal Wiki | An alpha knowledge base for Android mechanisms from App to Framework, Native, and Kernel. | **Coming soon** |
| Reproduce | [Trace for Blog (SystraceForBlog)](https://github.com/Gracker/SystraceForBlog) | Provide the Perfetto, Systrace, and related case files used by articles for hands-on reproduction. | [GitHub](https://github.com/Gracker/SystraceForBlog) |
<!-- android-performance-ecosystem:end -->

## Choose the right Perfetto project

These projects are complementary. Pick the smallest surface that matches how
you want to work; none is a prerequisite for another.

| Project | Form | Best for | Main boundary | Choose it when |
|---|---|---|---|---|
| [SmartPerfetto](https://github.com/Gracker/SmartPerfetto) | Full Web UI, CLI, and backend | End-to-end interactive Android investigations | Managed Skill runtime, reports, sessions, comparisons, and provider integration | You want a complete analysis product |
| [Perfetto Skills](https://github.com/Gracker/Perfetto-Skills) | Portable standard Agent Skill | Local agents with filesystem and terminal access | Deterministic local runner, evidence contracts, and broad analysis workflows | You want trace analysis inside Codex, Claude Code, or OpenCode |
| [Google official Perfetto Skill](https://github.com/google/perfetto/tree/main/ai/skills/perfetto) | Official upstream Agent Skill bundle | Upstream-first trace recording and analysis | Official recording, memory, GPU, and ad-hoc PerfettoSQL guidance | You want the smallest upstream-maintained starting point |

See Google's [official Perfetto AI usage guide](https://perfetto.dev/docs/getting-started/using-ai)
for the upstream Skill installation and release model.

## Configure Your AI Provider First

SmartPerfetto uses exactly one active model-provider source at runtime. Pick one path and avoid mixing them during first setup:

- You do not need to configure Claude Code, OpenAI Agents SDK, Pi Agent Core, and OpenCode all at once. Claude Code is the local-auth / Claude-compatible runtime path; OpenAI Agents SDK is the OpenAI / OpenAI-compatible runtime path; Pi Agent Core and OpenCode are custom-provider runtime paths. Pick one for first setup.
- UI Provider Manager: easiest for portable packages, Docker, and new users. Start SmartPerfetto, open **AI Assistant Settings → Providers**, add a provider, paste the **Provider API Key**, verify the Base URL/runtime, save it, test it, then activate it. Saving a provider is not enough; the active provider is what takes effect.
- Env file: best for scripted or server deployments. Local source runs read `backend/.env`; Docker reads the repository-root `.env`.
- Local Claude Code config: best for source runs when `claude` already works in the same terminal. No SmartPerfetto `.env` is required.

The `Connection` tab normally only needs the backend URL. Its advanced backend auth token is optional and is only used when the backend was started with `SMARTPERFETTO_API_KEY`; it is not a model-provider key field. An active Provider Manager profile overrides `.env`; choose `System Default` in the provider switcher or deactivate providers to return to `.env` / local Claude Code config. See [docs/getting-started/configuration.en.md](docs/getting-started/configuration.en.md) for the full provider guide.

Step 1: Choose your run mode and credential file.

| Run mode | Credential file | Notes |
|----------|-----------------|-------|
| Local source checkout where Claude Code already works in the same terminal | No `.env` required | Verify with `claude`; then run `./start.sh`, which starts both backend and the pre-built frontend |
| Local source checkout with explicit API key or compatible proxy | `backend/.env` | Create it with `cp backend/.env.example backend/.env` |
| Docker Hub image | Provider Manager UI or repository-root `.env` | Docker cannot see the host Claude Code login; use `.env` only for scripted setup |
| Source Docker build | Provider Manager UI or repository-root `.env` | `docker-compose.yml` reads root `.env`; same credential file as the Docker Hub path |
| Portable package | Provider Manager UI first | Use the package UI at `http://localhost:10000`; only use the package env file if you need scripted setup |

Step 2: Choose the runtime and provider settings. Claude Agent SDK is for Claude Code / Anthropic-compatible providers; OpenAI Agents SDK is for OpenAI / OpenAI-compatible providers. Pi Agent Core and OpenCode are optional custom-provider runtimes that reuse the same SmartPerfetto analysis contract. For first setup, keep only one credential family enabled. In advanced deployments where multiple credential families are present, `SMARTPERFETTO_AGENT_RUNTIME` or the active UI provider decides; otherwise the default is Claude Agent SDK.

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

OpenAI / OpenAI-compatible providers use the OpenAI Agents SDK runtime; Ollama and other OpenAI-compatible endpoints use `OPENAI_AGENTS_PROTOCOL=chat_completions`. In Provider Manager, dual-surface providers such as DeepSeek, Qwen, Kimi, MiMo, and TokenHub show both Claude-compatible and OpenAI-compatible Base URLs. The selected SDK runtime decides which side is used. Pi Agent Core and OpenCode are exposed only through custom providers or explicit env configuration; neither path reads local `.pi` / OpenCode project config or CLI login state. Full provider-specific fields, known regional URL variants, model IDs, and troubleshooting notes are in [docs/getting-started/configuration.en.md](docs/getting-started/configuration.en.md) and the env templates.

Step 3 (optional): Set the output language. SmartPerfetto defaults to Simplified Chinese for AI answers, streamed progress, and generated reports. Set this if the primary users prefer English:

```env
SMARTPERFETTO_OUTPUT_LANGUAGE=en
```

Step 4: Start or restart services. For Docker, run `docker compose -f docker-compose.hub.yml up -d` or `docker compose -f docker-compose.hub.yml restart`. For local source runs, use `./start.sh`; if you only changed `.env` while the backend is already running, use `./scripts/restart-backend.sh`. Use authenticated `GET /api/runtime-health` (or the Provider settings status) to verify the active source: `aiEngine.credentialSource=provider-manager` means the UI provider overrides env, while `env-or-default` means SmartPerfetto is using `.env` or local Claude Code fallback. Public `GET /health` is liveness-only. For the local Claude Code path, also verify by running a normal `claude` request in the same terminal.

## Perfetto Resources

| Resource | English | Chinese |
|----------|---------|---------|
| Android Performance Blog | [androidperformance.com/en](https://www.androidperformance.com/en) | [androidperformance.com](https://www.androidperformance.com/) |
| Perfetto official docs | [perfetto.dev/docs](https://perfetto.dev/docs/) | [gugu-perf.github.io/perfetto-docs-zh-cn](https://gugu-perf.github.io/perfetto-docs-zh-cn/) |

## What It Does

- Analyzes Android Perfetto traces for scrolling jank, startup, ANR, interaction latency, memory, game, and rendering-pipeline issues.
- Keeps Perfetto's timeline and SQL power, then adds an AI assistant panel inside the Perfetto UI.
- Reconstructs mixed-action traces in Smart mode before deep analysis, so users can inspect the scene timeline and choose all scenes or only startup, scrolling, click, navigation, device-state, or ANR ranges.
- Compares completed analysis results across multiple traces, windows, or workspace users without requiring both Perfetto UI windows to stay open.
- Ships a signed Android Internals Knowledge Pack for bounded background retrieval, while keeping private source/knowledge access explicitly authorized and separate from trace evidence.
- Supports deterministic multi-trace Skill batches and side-effect-free Android capture proposals before explicit device recording.
- Uses a TypeScript backend to run agent workflows, query `trace_processor_shell`, invoke YAML analysis skills, and stream results to the browser.
- Supports Anthropic directly, Claude/Anthropic-compatible providers, OpenAI/OpenAI-compatible providers, Pi Agent Core custom models, and OpenCode custom models through the matching backend runtime.
- Ships with registry-discovered YAML skill/config files and scene strategies for Android performance investigation.

## Feature Overview

- [Feature Overview](docs/getting-started/features.en.md): AI Assistant workflows, Smart scene inventory and selected deep dives, performance scenarios, selection-aware analysis, reports, raw/result comparison, Android Internals knowledge, code-aware local-source analysis, provider management, batch/capture automation, and runtime options.

## Tech Stack

| Area | Technology |
|------|------------|
| Frontend | Forked Perfetto UI with the `com.smartperfetto.AIAssistant` plugin |
| Backend | Node.js 24 LTS, TypeScript strict mode, Express |
| Agent runtime | Runtime selector, Claude Agent SDK, OpenAI Agents SDK, Pi Agent Core, OpenCode, MCP tools, scene strategies, verifier, SSE streaming |
| Trace engine | Perfetto `trace_processor_shell` over HTTP RPC |
| Analysis logic | YAML skills under `backend/skills/` plus Markdown strategies under `backend/strategies/` |
| Storage | Local uploads, session logs, reports, and runtime learning files |
| Testing | Jest, skill validation, strategy validation, 6-trace scene regression gate |
| Deployment | Docker Compose, GitHub portable packages, npm CLI package, or local scripts |

## Public Release Channels

| Channel | Install / run | Node requirement | Includes |
|---------|---------------|------------------|----------|
| Docker Hub | `docker compose -f docker-compose.hub.yml up -d` | No host Node.js required | Backend, committed pre-built UI, pinned `trace_processor_shell`, signed Knowledge Pack |
| GitHub portable | Download `smartperfetto-v<version>-*.zip` / `.tar.gz` | Bundled Node.js 24 | Launcher, backend, pre-built UI, native dependencies, pinned `trace_processor_shell`, signed Knowledge Pack |
| npm CLI | `npm install -g @gracker/smartperfetto` | Host Node.js `>=24 <25` | `smp` / `smartperfetto` CLI, Skills, Strategies, SQL, trace-processor prebuilts, signed Knowledge Pack |
| Source checkout | `./start.sh` | Host Node.js 24 LTS | Backend source, committed pre-built UI, signed Knowledge Pack, optional `perfetto/` submodule for UI work |

Maintainer release rules are in [Release Runbook](docs/reference/release.en.md)
and [`.claude/rules/release.md`](.claude/rules/release.md). Feature and bug
work should also check [`.claude/rules/product-surface.md`](.claude/rules/product-surface.md)
so Web UI, CLI, API, reports, Docker, portable packages, runtime/provider,
pre-built content, and Node boundaries stay aligned.

## For Users

### Docker (Recommended)

Use this path if you only want to run SmartPerfetto. You need Docker Desktop/Engine; configure the AI provider in the UI Provider Manager after startup, or use the repository-root `.env` when you need scripted deployment. You do not need Node.js, a C++ toolchain, or the `perfetto/` submodule. The Docker Hub image is published nightly from `main` and includes the backend, the pre-built Perfetto UI, and the pinned `trace_processor_shell`, so it also avoids first-run access to Google's artifact bucket on the host.

Both the Docker Hub image and source Docker builds serve the committed pre-built UI from `frontend/`; Docker users never build the Perfetto submodule frontend locally.

The container starts without a local `.env` file for health/UI smoke checks. Real AI analysis needs one explicit provider source: either a UI Provider Manager profile, or one env provider block such as `ANTHROPIC_API_KEY` for Anthropic direct, `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` for a Claude-compatible provider, `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk` plus `OPENAI_*` fields for an OpenAI-compatible provider, or a custom Pi Agent Core / OpenCode block.

Provider profiles created in the UI are stored in the `provider-data` Docker volume. They survive container restarts and normal `docker compose down`; they are removed by `docker compose down -v`.

An active Provider Manager profile has priority over Docker `.env` credentials. The container startup log and authenticated `GET /api/runtime-health` show whether the current credential source is `provider-manager` or `env-or-default`. To force Docker `.env` fallback, deactivate the active provider in AI Assistant settings.

Windows users should use Docker Desktop with the WSL2 backend. The published image is a Linux container image and runs through Docker Desktop; no separate Windows build is required.

Step 1: Download the source. Run `git clone https://github.com/Gracker/SmartPerfetto.git`, then run `cd SmartPerfetto`.

Step 2 (optional): Create the Docker env file. Run `cp .env.example .env`, edit `.env`, uncomment one provider block, and start by replacing the API key/token. If your provider console shows a different Base URL or model ID, use the console value. Skip this step if you will configure the provider in the UI; real AI analysis requires one provider source.

Step 3: Pull the Docker Hub image. Run `docker compose -f docker-compose.hub.yml pull`.

Step 4: Start the container. Run `docker compose -f docker-compose.hub.yml up -d`.

Step 5: Open the service URLs.

- Frontend: [http://localhost:10000](http://localhost:10000)
- Backend health: [http://localhost:3000/health](http://localhost:3000/health)

To use non-default service ports, set `SMARTPERFETTO_BACKEND_PORT` and
`SMARTPERFETTO_FRONTEND_PORT` before running Compose. If the browser-visible
backend address differs from the container listen port, set
`SMARTPERFETTO_BACKEND_PUBLIC_URL`.

Stop the container with `docker compose -f docker-compose.hub.yml down`.

Uploads, logs, and Provider Manager profiles are stored in Docker volumes, so they survive container restarts.

If analysis fails with `Claude Code native binary not found at .../claude-agent-sdk-linux-x64-musl/claude` (or the glibc variant), this is the SDK's per-platform native binary auto-selection misfiring inside the container — it is unrelated to your AI provider configuration. The backend will normally auto-fall-back to an installed sibling variant; if it still mispicks, set `CLAUDE_BINARY_PATH` in `.env` to the actual installed binary. See `.env.example` for details.

### Portable Packages

Users who do not want Docker can use maintainer-built portable packages for Windows, macOS, and Linux. Each package includes the Node.js 24 runtime, target-native `node_modules`, the pre-built Perfetto UI, backend runtime files, the pinned `trace_processor_shell`, and the signed Android Internals Knowledge Pack.

Assets:

- `smartperfetto-v<version>-windows-x64.zip`: extract and double-click `SmartPerfetto.exe`.
- `smartperfetto-v<version>-macos-arm64.zip`: extract and double-click `SmartPerfetto.app`.
- `smartperfetto-v<version>-linux-x64.tar.gz`: extract and run `./SmartPerfetto`.

All launchers start the backend and pre-built Perfetto UI, then open [http://localhost:10000](http://localhost:10000). Override ports with `SMARTPERFETTO_BACKEND_PORT` and `SMARTPERFETTO_FRONTEND_PORT`. AI analysis needs a Provider profile configured in the UI, or env credentials in the package's user data env file.

Maintainer build command:

```bash
npm run package:portable
```

The root `package.json` is the project version source and is synchronized to `backend/package.json` and lockfiles. A normal public release publishes npm first, then GitHub portable assets:

```bash
npm run version:set -- <version>
npm run version:sync -- --check
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v<version>"
git push origin main
npm --prefix backend run cli:pack-check
cd backend
npm publish --access public
cd ..
npm run package:portable
npm run release:portable -- <version> --skip-build --no-draft
```

Cross-platform assets are written to `dist/portable/`; the Windows-compatible command still writes to `dist/windows-exe/`. See [Release Runbook](docs/reference/release.en.md) and [Portable Packaging](docs/reference/portable-packaging.en.md) for npm smoke tests, GitHub release verification, and signing notes.

### Local Script

Use this path if you prefer running from a source checkout on macOS or Linux. Prerequisites: **Node.js 24 LTS**, `curl`, `lsof`, `pkill`, and either Claude Code login or LLM provider credentials. For Windows source development, use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install), not native Windows shell.

The repository includes `.nvmrc`, `.node-version`, and Volta pins in `package.json` plus `backend/package.json`; npm is configured with `engine-strict=true`. `./start.sh`, `./scripts/start-dev.sh`, and `./scripts/restart-backend.sh` will try to activate Node 24 through Volta, nvm, or fnm. If backend dependencies were installed under another Node ABI, the scripts reinstall `backend/node_modules` automatically before starting the server. This prevents native modules such as `better-sqlite3` from being reused across Node 20/24/25.

On macOS, if `trace_processor_shell` fails the `--version` smoke test, macOS says the developer cannot be verified, or the terminal only prints `killed`, Gatekeeper may have blocked the downloaded binary. Open **System Settings → Privacy & Security → Security**, click **Allow Anyway** for `trace_processor_shell`, then re-run `./start.sh` and choose **Open** if macOS asks again. For a binary you trust, you can also run `xattr -dr com.apple.quarantine /absolute/path/to/trace_processor_shell` and then `chmod +x /absolute/path/to/trace_processor_shell`.

Step 1: Download the source. Run `git clone https://github.com/Gracker/SmartPerfetto.git`, then run `cd SmartPerfetto`.

Step 2: Choose the model credential source. If Claude Code already works in the same terminal, run `claude` to verify it and do not create `.env`. If you want an explicit API key or compatible proxy, run `cp backend/.env.example backend/.env`, then edit `backend/.env`: uncomment `ANTHROPIC_API_KEY` for direct Anthropic, uncomment one Claude Code / Anthropic-compatible provider block for compatible providers, use the OpenAI Agents SDK fields for OpenAI / OpenAI-compatible providers, or use the custom Pi Agent Core / OpenCode sections.

Step 3: Start services. Run `./start.sh`. This script starts both the backend at `http://localhost:3000` and the repository's pre-built Perfetto UI at `http://localhost:10000`; regular use does not require initializing the `perfetto/` submodule or compiling Perfetto UI from source. Use `SMARTPERFETTO_BACKEND_PORT` and `SMARTPERFETTO_FRONTEND_PORT` when those defaults conflict with other local services.

## For Developers

### Runtime Scripts

For regular use, backend changes, strategy changes, and skill changes, prefer `./start.sh`. It starts the backend and serves the repository's pre-built Perfetto UI as the frontend. Use `./scripts/start-dev.sh` only when editing the AI Assistant plugin UI, debugging Perfetto UI source, or explicitly needing the `perfetto/` submodule watch build. Do not only run `cd backend && npm run dev`: that starts Express, but it does not bring up the frontend or validate the trace-processor path.

On Linux, if analysis fails with `Claude Code native binary not found at .../node_modules/@anthropic-ai/claude-agent-sdk-.../claude`, the backend dependencies were installed without the Claude Agent SDK optional native package for this platform. Fix it in three steps: Step 1, run `rm -rf backend/node_modules`; Step 2, run `cd backend && npm ci --include=optional`; Step 3, run `cd .. && ./scripts/start-dev.sh`.

| Script | Use when |
|--------|----------|
| `./start.sh` | ✅ Default — regular use, backend changes, strategy/skill edits; starts both backend and pre-built frontend |
| `./scripts/start-dev.sh` | AI plugin UI edits (`ai_panel.ts`, `styles.scss` etc.) or Perfetto UI source debugging — requires `perfetto/` submodule |

### Source Docker Build

Use this only when testing Docker changes or building an unreleased local checkout. Step 1: run `cp .env.example .env` and edit the provider if needed. Step 2: run `docker compose up --build`.

The source build uses the committed `frontend/` bundle and does not rebuild the `perfetto/` submodule.

### Frontend Development (modifying AI plugin code)

When you need to edit the AI Assistant plugin UI, Step 1 (first time): run `git submodule update --init --recursive` to initialize the `perfetto/` submodule. Step 2: run `./scripts/start-dev.sh`; it rebuilds on save.

After verifying your changes in the browser, Step 1: run `./scripts/update-frontend.sh` to update the pre-built frontend. Step 2: run `git add frontend/`. Step 3: run `git commit -m "chore(frontend): update prebuilt"`.

## Runtime Settings

The quick setup above covers where credentials live. Detailed provider setup, model IDs, regional Base URL variants, OpenAI-compatible runtime fields, Anthropic-compatible presets, Pi Agent Core/OpenCode custom runtime fields, proxy guidance, and troubleshooting live in [docs/getting-started/configuration.en.md](docs/getting-started/configuration.en.md). Use authenticated `GET /api/runtime-health` to confirm `aiEngine.runtime`, `aiEngine.credentialSource`, `aiEngine.providerMode`, and `aiEngine.diagnostics` after changing provider settings.

Claude Code local auth/config is only available to local source runs, not Docker. Separate tools such as Codex CLI, Gemini CLI, and OpenCode manage their own configuration files and login state; SmartPerfetto does not automatically read those credentials. Even the `opencode` runtime uses explicit Provider Manager/env model configuration and an isolated server/project boundary. The frontend settings dialog's `Connection` tab stores the backend URL and an optional advanced `SMARTPERFETTO_API_KEY` access token only when the backend is protected; the `Providers` tab can write model-provider profiles to the backend Provider Manager.

### Output Language

User-facing output defaults to Simplified Chinese. To make AI answers, streamed progress text, and generated Agent-Driven reports English, set:

```bash
SMARTPERFETTO_OUTPUT_LANGUAGE=en
```

Accepted values include `zh-CN` and `en`. Restart the backend after changing `.env`.

### Turn Budgets

SmartPerfetto has separate turn budgets for fast and full analysis. Claude runtime uses `CLAUDE_*`; OpenAI runtime uses `OPENAI_*` with the same meanings:

```bash
CLAUDE_QUICK_MAX_TURNS=50  # fast mode default
CLAUDE_MAX_TURNS=100       # full mode default
OPENAI_QUICK_MAX_TURNS=50  # optional OpenAI runtime override
OPENAI_MAX_TURNS=100       # optional OpenAI runtime override
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
smp doctor
smp run trace.pftrace "Analyze scrolling jank"
smp ask <sessionId> "Why is RenderThread slow?"
smp list
smp report <sessionId> --open

# Record an Android trace from a connected device, then analyze it.
smp capture presets
smp capture suggest "Analyze Camera open-to-first-preview latency" --app com.example.camera
smp capture config --preset camera --app com.example.camera --duration 20
smp capture android --preset startup --app com.example.app --duration 10 --out launch.perfetto-trace
smp capture android --preset cpu --app '*' --duration 30 --categories dalvikviktime my_custom_tag --out cpu-custom.perfetto-trace
smp capture android --preset power --app com.example.app --duration 60 --out power.perfetto-trace
smp capture android --config ~/tools/perfetto_shell/perfetto.config --out ~/tools/perfetto_shell/trace/dut-game-launch.ptrace --analyze --query "Analyze app launch"

# Or run the interactive SmartPerfetto REPL.
smp repl
```

The `camera` preset collects Camera/HAL/vendor atrace candidates, Binder and
scheduler context, FrameTimeline, and DMA-BUF or legacy ION ftrace events. The
atrace candidates and memory ftrace events are optional; availability depends
on the Android release, device/vendor implementation, and kernel support. A
trace may still lack portable Camera open, request/result, buffer, or preview
presentation anchors; SmartPerfetto reports that evidence gap instead of
fabricating an open-to-first-frame number.

The npm CLI package is the supported standalone terminal product. It does not start or bundle the Web UI launcher; use Docker or a GitHub portable package when you need the browser experience. The first analysis uses the bundled pinned `trace_processor_shell` binary when available, and can download the pinned binary automatically on unsupported targets. Android capture itself never downloads tools at runtime: `adb` is resolved from `ADB_PATH`, an approved bundled slot, then `PATH`; pre-Android Q or `--sideload` tracebox capture requires an approved bundled `tracebox` or `--tracebox /path/to/tracebox`. If your network cannot reach Google's artifact bucket, set `TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell` to use a local binary, or set `TRACE_PROCESSOR_DOWNLOAD_BASE` / `TRACE_PROCESSOR_DOWNLOAD_URL` to a trusted mirror; downloaded binaries are still checked against the pinned SHA256. `smartperfetto` remains available as the long command name; source checkout scripts are only for maintainers debugging the CLI. See [CLI Reference](docs/reference/cli.en.md) for all commands, capture presets, REPL slash commands, storage layout, and resume behavior.

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

Leave `SMARTPERFETTO_API_KEY` unset for local single-user runs. Set it in `backend/.env` only if you expose the backend beyond your local machine. Protected APIs then require `Authorization: Bearer <token>`. This static key is the deployment-operator credential with local administration authority; do not distribute it to ordinary users.

For enterprise or shared deployments, also set a dedicated 32-byte-or-longer `SMARTPERFETTO_TP_PROXY_CAPABILITY_SECRET`. It signs only the short-lived browser WebSocket capability used by the trace-processor proxy, so the long-lived backend API key is never placed in a URL. Rotating this secret invalidates outstanding capabilities. Docker Compose passes it through the project `.env` file.

## Architecture

```text
Frontend (Perfetto UI @ :10000)
  └─ SmartPerfetto AI Assistant plugin
       └─ SSE / HTTP
Backend (Express @ :3000)
  ├─ Runtime selector: Claude Agent SDK, OpenAI Agents SDK, Pi Agent Core, or OpenCode
  ├─ Agent orchestration: scene routing, prompts, MCP tools, verifier
  ├─ Shared comparison evidence/report contracts for Web UI and CLI
  ├─ Skill engine: YAML analysis pipelines
  ├─ Session/report/log services
  └─ trace_processor_shell pool (HTTP RPC, 9100-9900)
```

Repository layout:

```text
SmartPerfetto/
├── backend/
│   ├── src/agentRuntime/   # SDK/server runtime selection, registry, Pi/OpenCode adapters
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
  - Skill YAML change: `cd backend && npm run validate:skills` plus scene regression
  - Strategy/template Markdown change: `cd backend && npm run validate:strategies` plus scene regression
- Type/build fix: `cd backend && npm run typecheck`

Do not hardcode prompt content in TypeScript. Put scene logic in `backend/strategies/*.strategy.md` or reusable `*.template.md` files.

## Documentation

- [Documentation Center](docs/README.en.md)
- [Quick Start](docs/getting-started/quick-start.en.md)
- [Code-Aware Analysis](docs/getting-started/code-aware-analysis.en.md)
- [Architecture Overview](docs/architecture/overview.en.md)
- [API Reference](docs/reference/api.en.md)
- [CLI Reference](docs/reference/cli.en.md)
- [MCP Tools Reference](docs/reference/mcp-tools.en.md)
- [Skill System Guide](docs/reference/skill-system.en.md)
- [Data Contract](backend/docs/DATA_CONTRACT_DESIGN.en.md)
- [Android 17 Rendering Type References](docs/rendering_pipelines/S01_rendering_types_overview.md)
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

SmartPerfetto accepts personal donations, AI credits / token sponsorship, commercial support, and commercial licensing inquiries.

- Sponsor page: [docs/sponsor.en.md](docs/sponsor.en.md)
- WeChat / Alipay QR codes: [docs/sponsor.en.md#personal-donations](docs/sponsor.en.md#personal-donations)
- AI credits / token sponsorship: [docs/sponsor.en.md#ai-credits-token-sponsorship](docs/sponsor.en.md#ai-credits-token-sponsorship)
- Commercial support and licensing: WeChat `553000664`

## License

[AGPL-3.0-or-later](LICENSE) for SmartPerfetto core code.

The `perfetto/` submodule is a fork of [Google Perfetto](https://github.com/google/perfetto) and remains under [Apache-2.0](https://github.com/google/perfetto/blob/main/LICENSE).

For commercial licensing without AGPL obligations, contact the maintainer on WeChat: `553000664`.
