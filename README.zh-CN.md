# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Gracker/SmartPerfetto)](LICENSE)
[![Backend Regression Gate](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml)
[![Node.js 24 LTS](https://img.shields.io/badge/Node.js-24%20LTS-brightgreen)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](backend/tsconfig.json)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed)](docker-compose.yml)
[![Perfetto UI fork](https://img.shields.io/badge/Perfetto-UI%20fork-4285f4)](https://perfetto.dev/)
[![Sponsor](https://img.shields.io/badge/Sponsor-WeChat%20553000664-f66f6f)](docs/sponsor.md)

> 基于 [Perfetto](https://perfetto.dev/) 的 AI 驱动 Android 性能分析平台。

SmartPerfetto 在 Perfetto trace 之上增加了一层 AI 分析能力。你可以加载 trace，用自然语言提问，然后得到带 SQL 证据、Skill 结果、根因推理和优化建议的分析结论。

运行 AI 分析前先配置 provider。README 只保留启动流程和一个 provider 配置示例；完整 provider / model 接入清单以 [docs/getting-started/configuration.md](docs/getting-started/configuration.md)、[backend/.env.example](backend/.env.example) 和根目录 [.env.example](.env.example) 为准。

Provider Base URL 注意事项：预置的 Claude/Anthropic-compatible 和 OpenAI-compatible Base URL 来自 provider 公开信息，不保证对所有账号、地区、套餐或后续 provider 变更都正确。如果某个 preset 无法连接或 tool call 异常，先到 provider 控制台核对 Base URL、模型 ID 和协议类型；确认公开 preset 有误后，建议提交 issue 或 PR 修正。

项目已经开源，当前处于活跃开发阶段。UI、后端运行时和 Skill 系统已经可用，但公开 API 和内部合约仍可能继续调整。

<!-- android-performance-ecosystem:start -->
## Android 性能分析生态

[Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) 通过导航 Hub 与七个核心项目，把可选插桩、采集、分析、系统知识与可复现案例连接成一套完整路径。

| 阶段 | 项目 | 作用 | 地址 |
| --- | --- | --- | --- |
| 导航 | [Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) | 维护统一项目地图、交接元数据、README 导航区块与漂移检查。 | [GitHub](https://github.com/Gracker/android-performance-ecosystem) |
| 插桩 | [TraceFix](https://github.com/Gracker/TraceFix) | 在编译期注入 App 侧 android.os.Trace section，让方法执行在运行时 Trace 中可见。 | [GitHub](https://github.com/Gracker/TraceFix) |
| 采集与测量 | [Perfetto Tools](https://github.com/Gracker/perfetto-tools) | 抓取可复现的 Perfetto Trace，并采集 FPS 或 Simpleperf 测量结果。 | [GitHub](https://github.com/Gracker/perfetto-tools) |
| 分析 | [SmartPerfetto](https://github.com/Gracker/SmartPerfetto) | 通过 AI 辅助 Web UI、CLI、报告、会话、对比和证据工作流分析 Trace。 | [GitHub](https://github.com/Gracker/SmartPerfetto) |
| Agent 分析 | [Perfetto Skills](https://github.com/Gracker/Perfetto-Skills) | 为 Agent 提供可移植的 Android、Linux、Chromium Perfetto 分析 Skill，并通过固定版本流程同步选定资产。 | [GitHub](https://github.com/Gracker/Perfetto-Skills) |
| 学习 | [Android Performance Blog](https://github.com/Gracker/Gracker.github.io) | 通过文章、系统原理和案例复盘讲解 Perfetto 与 Systrace 分析。 | [AndroidPerformance.com](https://www.androidperformance.com/) · [GitHub](https://github.com/Gracker/Gracker.github.io) |
| 系统知识 | Android Internal Wiki | 处于 alpha 阶段的 Android 系统知识库，覆盖 App、Framework、Native 与 Kernel 机制。 | **Coming soon** |
| 复现 | [Trace for Blog (SystraceForBlog)](https://github.com/Gracker/SystraceForBlog) | 提供文章使用的 Perfetto、Systrace 及相关案例文件，支持动手复现。 | [GitHub](https://github.com/Gracker/SystraceForBlog) |
<!-- android-performance-ecosystem:end -->

## 如何选择 Perfetto 项目

这三个项目互为补充。按自己的使用方式选择最小合适入口；它们彼此都不是安装或
运行前置依赖。

| 项目 | 形态 | 最适合 | 主要边界 | 适合选择它的情况 |
|---|---|---|---|---|
| [SmartPerfetto](https://github.com/Gracker/SmartPerfetto) | 完整 Web UI、CLI 和后端 | 端到端、交互式 Android 性能排查 | 托管 Skill 运行时、报告、会话、对比和 Provider 集成 | 希望直接使用完整分析产品 |
| [Perfetto Skills](https://github.com/Gracker/Perfetto-Skills) | 可移植的标准 Agent Skill | 具备本地文件和终端能力的 Agent | 确定性本地 runner、证据契约和广泛分析工作流 | 希望在 Codex、Claude Code 或 OpenCode 中直接分析 Trace |
| [Google 官方 Perfetto Skill](https://github.com/google/perfetto/tree/main/ai/skills/perfetto) | 官方上游 Agent Skill bundle | 上游优先的 Trace 录制与分析 | 官方录制、内存、GPU 和通用 PerfettoSQL 指引 | 希望使用最轻量、由上游直接维护的入口 |

官方 Skill 的安装和发布方式见 Google 的
[Perfetto AI 使用文档](https://perfetto.dev/docs/getting-started/using-ai)。

## 先配置 AI Provider

SmartPerfetto 运行时只会使用一个 active 的模型 provider 来源。第一次配置时先选一种路径，不要混着配：

- Claude Code、OpenAI Agents SDK、Pi Agent Core、OpenCode 和 Qoder Agent SDK 不需要都配置。Claude Code 是本机认证 / Claude-compatible runtime 路径；OpenAI Agents SDK 是 OpenAI / OpenAI-compatible runtime 路径；Pi Agent Core、OpenCode 和 Qoder 是 custom-provider runtime 路径。初次使用只选其中一个。
- UI Provider Manager：最适合免安装包、Docker 和新用户。启动 SmartPerfetto 后打开 **AI Assistant Settings → Providers**，新增 provider，填写 **Provider API Key**，核对 Base URL/runtime，保存、测试，再激活。只保存 provider 不会让它生效，active provider 才会参与分析。
- env 文件：适合脚本化或服务器部署。本地源码运行读 `backend/.env`；Docker 统一读仓库根目录 `.env`。
- 本机 Claude Code 配置：适合同一终端里 `claude` 已经可用的源码运行场景，不需要 SmartPerfetto `.env`。

`Connection` 页通常只需要后端地址。里面的高级 backend auth token 是可选项，只在后端启动时设置了 `SMARTPERFETTO_API_KEY` 才需要填写；它不是模型厂商 key。active Provider Manager profile 会覆盖 `.env`；如果要回到 `.env` / 本机 Claude Code 配置，在 provider switcher 里选择 `System Default`，或在设置里停用 active provider。完整 provider 配置见 [docs/getting-started/configuration.md](docs/getting-started/configuration.md)。

步骤 1：选择运行方式和凭证位置。

| 运行方式 | 凭证位置 | 说明 |
|----------|----------|------|
| 本地源码运行，且同一终端里的 Claude Code 已经能正常请求 | 不需要 `.env` | 先运行 `claude` 验证；启动时运行 `./start.sh`，它会同时启动后端和预构建前端 |
| 本地源码运行，使用显式 API key 或兼容代理 | `backend/.env` | 运行 `cp backend/.env.example backend/.env` 创建 |
| Docker Hub 镜像 | Provider Manager UI 或仓库根目录 `.env` | Docker 容器看不到宿主机的 Claude Code 登录态；只有脚本化部署才需要 `.env` |
| 从源码构建 Docker 镜像 | Provider Manager UI 或仓库根目录 `.env` | `docker-compose.yml` 会读取根目录 `.env`；和 Docker Hub 路径保持一致 |
| 免安装包 | 优先用 Provider Manager UI | 打开包启动后的 `http://localhost:10000` 配置；只有需要脚本化部署时才改包的 env 文件 |

步骤 2：选择 runtime 并填写 provider。Claude Agent SDK 用于 Claude Code / Anthropic-compatible provider，OpenAI Agents SDK 用于 OpenAI / OpenAI-compatible provider。Pi Agent Core、OpenCode 和 Qoder Agent SDK 是可选 custom-provider runtime，复用同一套 SmartPerfetto 分析契约。Qoder SDK/CLI 有独立条款，因此源码/npm 安装下也必须显式选择安装，默认不会带入。首次配置只保留一类凭证；如果后续高级部署里多类凭证同时存在，由 `SMARTPERFETTO_AGENT_RUNTIME` 或前端 active provider 决定；都没有显式选择时默认走 Claude Agent SDK。

直连 Anthropic API 的最小配置是：

```env
ANTHROPIC_API_KEY=sk-ant-your-key
```

如果接入已经提供 Claude Code / Anthropic 兼容端点的第三方模型，直接在 [backend/.env.example](backend/.env.example) 里解注释对应 provider block，替换 API key/token，并保留 SmartPerfetto 使用的 `CLAUDE_MODEL` / `CLAUDE_LIGHT_MODEL`。以 DeepSeek 为例：

```env
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-your-deepseek-key
CLAUDE_MODEL=deepseek-v4-pro
CLAUDE_LIGHT_MODEL=deepseek-v4-flash
```

OpenAI / OpenAI-compatible provider 使用 OpenAI Agents SDK runtime；Ollama 或其他 OpenAI-compatible endpoint 使用 `OPENAI_AGENTS_PROTOCOL=chat_completions`。前端 Provider Manager 对 DeepSeek、Qwen、Kimi、MiMo、TokenHub 这类双端点 provider 会同时展示 Claude-compatible 和 OpenAI-compatible Base URL，当前 SDK runtime 决定实际使用哪一侧。Pi Agent Core、OpenCode 和 Qoder 只通过 custom provider 或显式 env 配置暴露。Pi/OpenCode 不读取个人 project/CLI state；Qoder 只有在显式安装可选 SDK 后才会使用本机 `qodercli` 登录态。完整 provider 字段、已知地区 URL 变体、模型 ID 和排障说明见 [docs/getting-started/configuration.md](docs/getting-started/configuration.md) 和 env 模板。

步骤 3（可选）：设置输出语言。Web UI 用户可以进入 **AI Assistant 设置 → 连接 → 界面与分析语言**，选择**自动（跟随浏览器）**、**简体中文**或 **English**。保存后的偏好同时作用于界面、内置 Skill 呈现、流式分析和新报告；切换语言会退役当前后端 agent 会话，避免同一会话混用语言。

`SMARTPERFETTO_OUTPUT_LANGUAGE` 仍是 CLI、服务端调用和未显式携带语言的客户端所使用的后端默认值。Web 中的显式偏好属于请求上下文，优先级更高。没有偏好或覆盖值时，SmartPerfetto 默认使用简体中文：

```env
SMARTPERFETTO_OUTPUT_LANGUAGE=en
```

步骤 4：启动或重启服务。Docker 运行用 `docker compose -f docker-compose.hub.yml up -d` 或 `docker compose -f docker-compose.hub.yml restart`；本地源码运行用 `./start.sh`，如果只改了 `.env` 且后端已经在跑，用 `./scripts/restart-backend.sh`。通过带鉴权的 `GET /api/runtime-health`（或 Provider 设置页状态）看当前来源：`aiEngine.credentialSource=provider-manager` 表示 UI provider 正在覆盖 env，`env-or-default` 表示正在使用 `.env` 或本机 Claude Code fallback；公开的 `GET /health` 只提供存活状态。本地 Claude Code 路径则以同一终端里 `claude` 能正常请求为准。

## Perfetto 参考资源

| 资源 | 英文 | 中文 |
|------|------|------|
| Android Performance Blog | [androidperformance.com/en](https://www.androidperformance.com/en) | [androidperformance.com](https://www.androidperformance.com/) |
| Perfetto 官方文档 | [perfetto.dev/docs](https://perfetto.dev/docs/) | [gugu-perf.github.io/perfetto-docs-zh-cn](https://gugu-perf.github.io/perfetto-docs-zh-cn/) |

## 项目做什么

- 分析 Android Perfetto trace 中的滑动卡顿、启动、ANR、交互延迟、内存、游戏和渲染管线问题。
- 保留 Perfetto 的时间线和 SQL 能力，并在 Perfetto UI 里增加 AI Assistant 面板。
- 智能模式会先还原混合 trace 的场景时间线，再让用户选择全部场景，或只深钻启动、滑动、点击、导航、设备状态、ANR 等范围。
- 支持跨多个 Trace、多个窗口或同一 workspace 用户的已完成分析结果对比，不要求另一个 Perfetto UI 窗口持续打开。
- 随产品分发签名 Android Internals Knowledge Pack，用于预算受控的背景检索；私有源码/知识仍需显式授权，并与 trace 证据分离。
- 支持确定性多 Trace Skill batch，以及在显式连接设备抓取前生成无副作用 Android 采集建议。
- 通过 TypeScript 后端编排 Agent 流程、查询 `trace_processor_shell`、调用 YAML Skill，并把结果实时流式传给浏览器。
- 支持 Anthropic 直连、Claude/Anthropic-compatible provider、通过 OpenAI Agents SDK 接入 OpenAI/OpenAI-compatible provider，以及 Pi Agent Core / OpenCode custom model 和显式启用的 Qoder Agent SDK profile。
- 内置通过 registry/file-tree 发现的 YAML Skill/配置文件和多场景分析策略，用于 Android 性能排查。

## 功能总览

- [功能总览](docs/getting-started/features.md)：AI Assistant 工作流、智能场景盘点与选择性深钻、常见性能场景、选区分析、报告、raw/result 对比、Android Internals 知识、Code-Aware 本机源码分析、Provider 管理、batch/capture 自动化和运行方式。

## 技术栈

| 模块 | 技术 |
|------|------|
| 前端 | Fork 后的 Perfetto UI，内置 `com.smartperfetto.AIAssistant` 插件 |
| 后端 | Node.js 24 LTS、TypeScript strict mode、Express |
| Agent 运行时 | Runtime selector、Claude Agent SDK、OpenAI Agents SDK、Pi Agent Core、OpenCode、Qoder Agent SDK、MCP 工具、场景策略、Verifier、SSE 流式输出 |
| Trace 引擎 | Perfetto `trace_processor_shell`，通过 HTTP RPC 调用 |
| 分析逻辑 | `backend/skills/` 下的 YAML Skill，`backend/strategies/` 下的 Markdown 策略 |
| 存储 | 本地上传文件、Session 日志、报告、运行时学习文件 |
| 测试 | Jest、Skill 校验、Strategy 校验、6 条 canonical trace 回归 |
| 部署 | Docker Compose、GitHub 免安装包、npm CLI 包或本地脚本 |

## 公开发布渠道

| 渠道 | 安装 / 运行 | Node 要求 | 包含内容 |
|------|-------------|-----------|----------|
| Docker Hub | `docker compose -f docker-compose.hub.yml up -d` | 不需要宿主机 Node.js | 后端、提交的预构建 UI、固定 `trace_processor_shell`、签名 Knowledge Pack |
| GitHub 免安装包 | 下载 `smartperfetto-v<version>-*.zip` / `.tar.gz` | 包内自带 Node.js 24 | 启动器、后端、预构建 UI、原生依赖、固定 `trace_processor_shell`、签名 Knowledge Pack |
| npm CLI | `npm install -g @gracker/smartperfetto` | 宿主机 Node.js `>=24 <25` | `smp` / `smartperfetto` CLI、Skill、Strategy、SQL、trace-processor 预编译产物、签名 Knowledge Pack |
| 源码 checkout | `./start.sh` | 宿主机 Node.js 24 LTS | 后端源码、提交的预构建 UI、签名 Knowledge Pack、可选 `perfetto/` submodule 用于 UI 开发 |

维护者发布规则见 [发布手册](docs/reference/release.md) 和
[`.claude/rules/release.md`](.claude/rules/release.md)。Feature/Bug 修改还要先查
[`.claude/rules/product-surface.md`](.claude/rules/product-surface.md)，确保 Web UI、CLI、API、报告、Docker、免安装包、runtime/provider、预置内容和 Node 边界同步考虑。

## 使用者

### Docker 运行（推荐）

只想把 SmartPerfetto 跑起来时，推荐使用这个方式。你只需要 Docker Desktop/Engine；AI provider 可以启动后在 UI Provider Manager 里配置，只有脚本化部署时才需要使用仓库根目录 `.env`。不需要安装 Node.js，不需要 C++ 工具链，也不需要初始化 `perfetto/` submodule。Docker Hub 镜像每天从 `main` 自动发布，镜像内已经包含后端、预构建 Perfetto UI 和固定版本的 `trace_processor_shell`，也能避开本地首次启动时访问 Google artifact bucket 失败的问题。

Docker Hub 镜像和源码 Docker build 都直接使用根目录 `frontend/` 里已经提交的预构建 UI；Docker 用户不会在本地构建 Perfetto submodule 前端。

容器在没有本地 `.env` 文件时也能启动，用于 health/UI smoke check；真正执行 AI 分析需要一个明确的 provider 来源：可以是 UI Provider Manager profile，也可以是一个 env provider block，例如 Anthropic 直连用 `ANTHROPIC_API_KEY`，Claude-compatible provider 用 `ANTHROPIC_BASE_URL` 加 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`，OpenAI-compatible provider 用 `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk` 加 `OPENAI_*` 字段，或 Pi Agent Core / OpenCode custom block。

在 UI 里创建的 Provider profile 会保存在 `provider-data` Docker volume 里。普通容器重启和 `docker compose down` 后仍会保留；`docker compose down -v` 会删除它。

active Provider Manager profile 的优先级高于 Docker `.env`。容器启动日志和带鉴权的 `GET /api/runtime-health` 会显示当前凭证来源是 `provider-manager` 还是 `env-or-default`。如果想强制使用 Docker `.env`，请在 AI Assistant 设置里停用 active provider。

Windows 用户使用 Docker Desktop，并启用 WSL2 backend。发布的是 Linux container 镜像，由 Docker Desktop 承载运行；不需要单独编译 Windows 版镜像。

步骤 1：下载源码。运行 `git clone https://github.com/Gracker/SmartPerfetto.git`，然后运行 `cd SmartPerfetto`。

步骤 2（可选）：创建 Docker env 文件。运行 `cp .env.example .env`，编辑 `.env`，解注释一个 provider block，先替换 API key/token。如果 provider 控制台给出不同 Base URL 或模型 ID，以控制台为准。如果准备在 UI 里配置 provider，可以跳过这一步；真正执行 AI 分析必须有一个 provider 来源。

步骤 3：拉取 Docker Hub 镜像。运行 `docker compose -f docker-compose.hub.yml pull`。

步骤 4：启动容器。运行 `docker compose -f docker-compose.hub.yml up -d`。

步骤 5：打开服务地址。

- 前端：[http://localhost:10000](http://localhost:10000)
- 后端健康检查：[http://localhost:3000/health](http://localhost:3000/health)

如果需要改默认端口，启动 Compose 前设置 `SMARTPERFETTO_BACKEND_PORT` 和
`SMARTPERFETTO_FRONTEND_PORT`。如果浏览器可访问的后端地址和容器内监听端口
不同，设置 `SMARTPERFETTO_BACKEND_PUBLIC_URL`。

停止容器时运行 `docker compose -f docker-compose.hub.yml down`。

上传文件、日志和 Provider Manager profile 保存在 Docker volume 中，容器重启后仍会保留。

### 免安装包

如果用户不想安装 Docker，可以使用维护者打出的 Windows、macOS、Linux 免安装包。包内包含 Node.js 24 runtime、目标平台原生 `node_modules`、预构建 Perfetto UI、后端运行时代码、固定版本的 `trace_processor_shell` 和签名 Android Internals Knowledge Pack。

产物：

- `smartperfetto-v<version>-windows-x64.zip`：解压后双击 `SmartPerfetto.exe`。
- `smartperfetto-v<version>-macos-arm64.zip`：解压后双击 `SmartPerfetto.app`。
- `smartperfetto-v<version>-linux-x64.tar.gz`：解压后运行 `./SmartPerfetto`。

启动器会拉起后端和预构建 Perfetto UI，并打开 [http://localhost:10000](http://localhost:10000)。端口可用 `SMARTPERFETTO_BACKEND_PORT` 和 `SMARTPERFETTO_FRONTEND_PORT` 覆盖。AI 分析需要在 UI 里配置 Provider profile，或在对应平台的用户数据 env 文件中配置凭证。

维护者打包命令：

```bash
npm run package:portable
```

版本号以根目录 `package.json` 为源头，并同步到 `backend/package.json` 和 lockfile。正常公开发布先发 npm，再发 GitHub 免安装包：

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

跨平台产物在 `dist/portable/`；兼容的 Windows 命令仍会输出到 `dist/windows-exe/`。npm smoke、GitHub release 校验和签名说明见 [发布手册](docs/reference/release.md) 和 [免安装包打包](docs/reference/portable-packaging.md)。

### 本地脚本运行

如果你希望直接从源码 checkout 启动，使用这个方式。前置条件：**Node.js 24 LTS**、`curl`、`lsof`、`pkill`，以及 Claude Code 登录态或大模型凭证。Windows 源码开发请使用 [WSL2](https://learn.microsoft.com/zh-cn/windows/wsl/install)，不要使用原生 Windows shell。

仓库已经带上 `.nvmrc`、`.node-version`，并在 `package.json` 和 `backend/package.json` 里固定了 Volta Node 版本；npm 也开启了 `engine-strict=true`。`./start.sh`、`./scripts/start-dev.sh` 和 `./scripts/restart-backend.sh` 会优先通过 Volta、nvm 或 fnm 自动切到 Node 24。如果后端依赖曾经用其他 Node ABI 安装过，脚本会在启动前自动重装 `backend/node_modules`，避免 `better-sqlite3` 这类 native module 在 Node 20/24/25 之间混用。

macOS 用户如果看到 `trace_processor_shell failed the --version smoke test`、`cannot be opened because the developer cannot be verified` 或终端里只显示 `killed`，通常是系统安全策略拦截了下载的 `trace_processor_shell`。打开 **系统设置 → 隐私与安全性 → 安全性**，对 `trace_processor_shell` 点 **仍要打开 / Allow Anyway**，然后重新运行 `./start.sh` 并在弹窗里选择 **打开**。如果你确认 binary 来源可信，也可以依次运行 `xattr -dr com.apple.quarantine /absolute/path/to/trace_processor_shell` 和 `chmod +x /absolute/path/to/trace_processor_shell`。

步骤 1：下载源码。运行 `git clone https://github.com/Gracker/SmartPerfetto.git`，然后运行 `cd SmartPerfetto`。

步骤 2：选择模型凭证来源。如果同一终端里的 Claude Code 已经能用，先运行 `claude` 验证，不需要创建 `.env`。如果要显式配置 API key 或兼容代理，运行 `cp backend/.env.example backend/.env`，然后编辑 `backend/.env`：Anthropic 直连解注释 `ANTHROPIC_API_KEY`，第三方 Claude Code / Anthropic 兼容 provider 解注释一个 provider block，OpenAI / OpenAI-compatible provider 使用 OpenAI Agents SDK 相关字段，或使用 Pi Agent Core / OpenCode custom 配置段。Qoder 需要先审阅其条款并显式安装 `@qoder-ai/qoder-agent-sdk`，再通过 Qoder 配置段使用本机 `qodercli` 登录态或 PAT。

步骤 3：启动服务。运行 `./start.sh`。这个脚本会同时启动后端 `http://localhost:3000` 和仓库内置的预构建 Perfetto UI `http://localhost:10000`；普通使用不需要初始化 `perfetto/` submodule，也不需要等待 Perfetto UI 从源码编译。如果默认端口和本机其他服务冲突，用 `SMARTPERFETTO_BACKEND_PORT` 和 `SMARTPERFETTO_FRONTEND_PORT` 覆盖。

## 开发者

### 运行脚本

普通使用、后端改动、策略/Skill 改动都优先使用 `./start.sh`。它会启动 backend，并使用仓库内置的预构建 Perfetto UI 启动 frontend。只有修改 AI Assistant 插件 UI、调试 Perfetto UI 源码，或明确需要 `perfetto/` submodule 的 watch 构建时，才使用 `./scripts/start-dev.sh`。不要只跑 `cd backend && npm run dev`：它只能启动 Express 后端，不会启动/校验前端和 trace-processor 路径。

Linux 本地运行时，如果分析失败并报 `Claude Code native binary not found at .../node_modules/@anthropic-ai/claude-agent-sdk-.../claude`，说明 backend 依赖安装时没有装上当前平台对应的 Claude Agent SDK optional native 包。修复步骤：步骤 1，运行 `rm -rf backend/node_modules`；步骤 2，运行 `cd backend && npm ci --include=optional`；步骤 3，运行 `cd .. && ./scripts/start-dev.sh`。

| 脚本 | 使用场景 |
|------|---------|
| `./start.sh` | ✅ **默认推荐** — 日常使用、修改后端/策略/Skill，会同时启动 backend 和预构建 frontend |
| `./scripts/start-dev.sh` | 修改 AI 插件 UI（`ai_panel.ts`、`styles.scss` 等）或调试 Perfetto UI 源码时使用，需要 `perfetto/` submodule |

### 源码构建 Docker 镜像

只有测试 Docker 改动或构建未发布的本地代码时，才需要从源码构建镜像。步骤 1：运行 `cp .env.example .env` 并按需编辑 provider。步骤 2：运行 `docker compose up --build`。

源码构建会使用仓库内提交的 `frontend/` 预构建包，不会重新构建 `perfetto/` submodule。

### 前端插件开发（修改 AI 面板 UI）

如果需要修改 AI Assistant 插件的前端代码，步骤 1（第一次）：运行 `git submodule update --init --recursive` 初始化 `perfetto/` submodule。步骤 2：运行 `./scripts/start-dev.sh`，保存文件后会自动重编译。

在浏览器中确认修改效果后，步骤 1：运行 `./scripts/update-frontend.sh` 更新预编译产物。步骤 2：运行 `git add frontend/`。步骤 3：运行 `git commit -m "chore(frontend): update prebuilt"`。

## Runtime 设置

前面的快速配置已经说明凭证写在哪里。详细 provider 接入方式、模型 ID、地区 Base URL 变体、OpenAI-compatible runtime 字段、Anthropic-compatible preset、Pi Agent Core/OpenCode/Qoder custom runtime 字段、代理建议和排障说明都在 [docs/getting-started/configuration.md](docs/getting-started/configuration.md)。修改 provider 配置后，可以用带鉴权的 `GET /api/runtime-health` 查看 `aiEngine.runtime`、`aiEngine.credentialSource`、`aiEngine.providerMode` 和 `aiEngine.diagnostics`。

Claude Code 本地认证/配置只适用于本地源码运行，不适用于 Docker。Codex CLI、Gemini CLI、OpenCode 等其他工具管理的是各自独立的配置和登录态；SmartPerfetto 不会自动读取这些凭证。即使选择 `opencode` runtime，也使用显式 Provider Manager/env model 配置，并运行在隔离 server/project 边界内。Qoder 是显式例外：安装可选 SDK 后，`qoder-agent-sdk` 可使用本机 `qodercli` 登录态或显式 PAT。前端设置弹窗的 `Connection` 页保存后端地址；只有后端开启保护时，才需要在高级项里填写可选的 `SMARTPERFETTO_API_KEY` access token。`Providers` 页可以把模型 provider profile 写入后端 Provider Manager。

### 输出语言

Web UI 中进入 **AI Assistant 设置 → 连接 → 界面与分析语言**：

- **自动**跟随浏览器语言。
- **简体中文**和 **English** 是显式且会持久化的选择。
- 所选语言覆盖前端自有文案、内置 Skill 呈现、AI 回答、流式进度、教学模式、关键路径结果和生成的报告。
- 切换语言会在下一次分析前退役当前后端 agent 会话。

浏览器只向后端发送规范值 `zh-CN` 或 `en`。CLI、服务端默认值和未显式携带语言的客户端可以配置：

```bash
SMARTPERFETTO_OUTPUT_LANGUAGE=en
```

可用值为 `zh-CN` 和 `en`。显式请求或已保存的 Web 偏好优先于该环境默认值。修改 `.env` 后需要重启 backend。

### 轮次预算

SmartPerfetto 区分 fast 和 full 两套轮次预算。Claude runtime 使用 `CLAUDE_*`；OpenAI runtime 使用语义相同的 `OPENAI_*`：

```bash
CLAUDE_QUICK_MAX_TURNS=50  # fast 模式默认值
CLAUDE_MAX_TURNS=100       # full 模式默认值
OPENAI_QUICK_MAX_TURNS=50  # 可选 OpenAI runtime 覆盖
OPENAI_MAX_TURNS=100       # 可选 OpenAI runtime 覆盖
```

如果使用较慢模型，或某些 trace 需要更多工具调用轮次，可以调高这些值。总 safety timeout 会随轮次预算放大：full 模式每轮使用 `CLAUDE_FULL_PER_TURN_MS` / `OPENAI_FULL_PER_TURN_MS`，fast 模式每轮使用 `CLAUDE_QUICK_PER_TURN_MS` / `OPENAI_QUICK_PER_TURN_MS`。修改 `.env` 后需要重启 backend。

## 基本用法

1. 打开 [http://localhost:10000](http://localhost:10000)。
2. 加载 Perfetto trace 文件（`.pftrace` 或 `.perfetto-trace`）。
3. 打开 AI Assistant 面板。
4. 输入问题，例如：
   - `分析滑动卡顿`
   - `启动为什么慢？`
   - `CPU 调度有没有问题？`
   - `帮我看看这个 ANR`

SmartPerfetto 最适合分析包含 FrameTimeline 数据的 Android 12+ trace。建议采集的 atrace category：

| 场景 | 最低 category | 建议额外添加 |
|------|---------------|--------------|
| 滑动 | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| 启动 | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |

## CLI 用法

SmartPerfetto 同时提供终端 CLI，可以不打开浏览器 UI 直接分析 trace。CLI 复用和 Web 端相同的 runtime selection、工具、Skill 和报告管线，并把本地 session、transcript 和报告写到 `~/.smartperfetto/`。

```bash
# 需要 Node.js 24 LTS
npm install -g @gracker/smartperfetto

# 分析 trace，并继续追问或打开报告。
smp doctor
smp run trace.pftrace "分析滑动卡顿"
smp ask <sessionId> "为什么 RenderThread 这么慢？"
smp list
smp report <sessionId> --open

# 从已连接 Android 设备抓 trace，并可直接分析。
smp capture presets
smp capture suggest "分析 Camera 打开到首帧预览延迟" --app com.example.camera
smp capture config --preset camera --app com.example.camera --duration 20
smp capture android --preset startup --app com.example.app --duration 10 --out launch.perfetto-trace
smp capture android --preset cpu --app '*' --duration 30 --categories dalvikviktime my_custom_tag --out cpu-custom.perfetto-trace
smp capture android --config ~/tools/perfetto_shell/perfetto.config --out ~/tools/perfetto_shell/trace/dut-game-launch.ptrace --analyze --query "分析应用启动"

# 或者直接进入 SmartPerfetto 交互 REPL。
smp repl
```

`camera` 预设会采集设备可能提供的 Camera/HAL/厂商 atrace 候选、Binder 与
scheduler 上下文、FrameTimeline，以及 DMA-BUF 或旧版 ION ftrace 事件。atrace
候选和这些内存 ftrace 事件均为可选证据，具体是否可用取决于 Android 版本、
设备/厂商实现与内核支持。trace 仍可能缺少可移植的 Camera open、request/result、
buffer 或预览 presentation 锚点；遇到这种证据缺口时，SmartPerfetto 会明确报告
缺失，而不会编造“打开到首帧”耗时。

npm CLI 包是正式独立终端产品，不启动也不包含 Web UI launcher；需要浏览器体验时使用 Docker 或 GitHub 免安装包。第一次分析时，CLI 会优先使用包内固定版本 `trace_processor_shell`；当前平台没有内置 binary 时会自动下载固定版本。Android 抓 trace 本身不会现场下载工具：`adb` 按 `ADB_PATH`、已批准的包内 slot、`PATH` 顺序解析；Android Q 之前或显式 `--sideload` 的 tracebox 抓取需要已批准的包内 `tracebox`，或通过 `--tracebox /path/to/tracebox` 指定。若网络无法访问 Google artifact bucket，可以设置 `TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell` 使用本机已有 binary，或设置 `TRACE_PROCESSOR_DOWNLOAD_BASE` / `TRACE_PROCESSOR_DOWNLOAD_URL` 指向可信镜像；下载内容仍会按固定 SHA256 校验。`smartperfetto` 仍保留为长命令名；源码 checkout 里的脚本只用于维护者调试 CLI。完整命令、抓取预设、REPL slash 命令、存储布局和 resume 语义见 [CLI 参考](docs/reference/cli.md)。

## API 接入

浏览器 UI 通过 REST 和 SSE 与后端通信。如果你要自建 UI 或自动化流程，可以从这些接口开始：

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/agent/v1/analyze` | 启动分析 |
| `GET` | `/api/agent/v1/:sessionId/stream` | 订阅 SSE 进度和 answer token |
| `GET` | `/api/agent/v1/:sessionId/status` | 查询分析状态 |
| `POST` | `/api/agent/v1/:sessionId/respond` | 继续多轮会话 |
| `POST` | `/api/agent/v1/resume` | 恢复已有 session 的 SDK 上下文 |
| `POST` | `/api/agent/v1/scene-reconstruct` | 启动场景重建 |
| `GET` | `/api/agent/v1/:sessionId/report` | 获取生成的分析报告 |

本地单人使用时不要设置 `SMARTPERFETTO_API_KEY` 也可以正常运行。如果后端不只在本机使用，建议在 `backend/.env` 设置它。开启后，受保护接口需要带上 `Authorization: Bearer <token>`。这个静态 key 是具有本地管理权限的部署运维凭证，不应分发给普通用户。

企业或共享部署还应单独设置至少 32 字节的 `SMARTPERFETTO_TP_PROXY_CAPABILITY_SECRET`。它只用于签发 trace-processor proxy 的短期浏览器 WebSocket capability，长期 backend API key 不会被放进 URL；轮换该 secret 会立即使尚未过期的 capability 失效。Docker Compose 会通过项目根目录的 `.env` 传入该变量。

## 架构

```text
Frontend (Perfetto UI @ :10000)
  └─ SmartPerfetto AI Assistant plugin
       └─ SSE / HTTP
Backend (Express @ :3000)
  ├─ Runtime selector: Claude Agent SDK、OpenAI Agents SDK、Pi Agent Core、OpenCode 或 Qoder
  ├─ Agent 编排: 场景路由、Prompt、MCP 工具、Verifier
  ├─ Web UI 和 CLI 共用的对比证据/报告合约
  ├─ Skill engine: YAML 分析管线
  ├─ Session/report/log 服务
  └─ trace_processor_shell 进程池（HTTP RPC, 9100-9900）
```

目录结构：

```text
SmartPerfetto/
├── backend/
│   ├── src/agentRuntime/   # SDK/server runtime 选择与各 runtime adapter
│   ├── src/agentv3/        # Claude Agent SDK 编排
│   ├── src/agentOpenAI/    # OpenAI Agents SDK 编排
│   ├── src/services/       # Trace processor、Skill、Report、Session 服务
│   ├── skills/             # YAML 分析 Skill 和配置
│   ├── strategies/         # 场景策略和 Prompt 模板
│   └── tests/              # Skill eval 和回归测试
├── docs/                   # 架构、MCP、Skill、渲染管线文档
├── scripts/                # 开发和重启脚本
└── perfetto/               # Fork 后的 Perfetto UI submodule
```

## 开发

常用命令：

```bash
./scripts/start-dev.sh
./scripts/restart-backend.sh

# 提 PR 前运行：包含质量检查、构建/类型检查、Skill/Strategy 校验、
# 核心单测和 6 条 canonical trace 回归。
npm run verify:pr

cd backend
npm run build
npm run cli:build-run -- --help
npm run test:scene-trace-regression
npm run validate:skills
npm run validate:strategies
npm run test:core
```

必须满足的检查：

- 提 PR 前：在仓库根目录运行 `npm run verify:pr`
- 代码改动按类别：
  - Contract / 纯类型（`backend/src/types/sparkContracts.ts` 等）：`cd backend && npx tsc --noEmit` + 相关 `__tests__/sparkContracts.test.ts`
  - CRUD-only service（仅文件 IO，未触 agent 路径）：该 service 的单测
  - 触 mcp / memory / report / agent runtime：`cd backend && npm run test:scene-trace-regression`
- Skill YAML 改动：`cd backend && npm run validate:skills` 加场景回归
- Strategy/template Markdown 改动：`cd backend && npm run validate:strategies` 加场景回归
- 构建或类型问题：`cd backend && npm run typecheck`

不要在 TypeScript 里硬编码 Prompt 内容。场景逻辑应放在 `backend/strategies/*.strategy.md`，可复用内容放在 `*.template.md`。

## 文档

- [文档中心](docs/README.md)
- [快速开始](docs/getting-started/quick-start.md)
- [Code-Aware Analysis](docs/getting-started/code-aware-analysis.md)
- [架构总览](docs/architecture/overview.md)
- [API 参考](docs/reference/api.md)
- [CLI 参考](docs/reference/cli.md)
- [MCP 工具参考](docs/reference/mcp-tools.md)
- [Skill 系统指南](docs/reference/skill-system.md)
- [数据合约](backend/docs/DATA_CONTRACT_DESIGN.md)
- [Android 17 渲染类型参考](docs/rendering_pipelines/S01_rendering_types_overview.md)
- [安全策略](SECURITY.md)

## 贡献

欢迎贡献。比较适合开始的方向：

- 用一条小 trace 复现具体性能问题，并写清楚问题和期望输出
- 新增或改进 YAML Skill
- 改进场景策略和输出模板
- 修复 Perfetto 插件里的 UI 问题
- 为已知 trace 场景补充回归测试

提交 PR 前：

1. 阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
2. Fork 仓库，并基于 `main` 创建分支。
3. 保持改动范围清晰，并写明测试计划。
4. 运行上方对应检查。
5. 遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 联系

- Bug 和功能建议：[GitHub Issues](https://github.com/Gracker/SmartPerfetto/issues)
- 安全问题：[GitHub private advisory](https://github.com/Gracker/SmartPerfetto/security/advisories/new) 或 `smartperfetto@gracker.dev`
- 合作、商业支持、赞助：微信 `553000664`

## 赞助

SmartPerfetto 接受个人赞助、AI Credits / Token 厂商赞助、企业支持和商业授权咨询。

- 赞助页面：[docs/sponsor.md](docs/sponsor.md)
- 微信 / 支付宝二维码：[docs/sponsor.md#personal-donations](docs/sponsor.md#personal-donations)
- AI Credits / Token 厂商赞助：[docs/sponsor.md#ai-credits-token-sponsorship](docs/sponsor.md#ai-credits-token-sponsorship)
- 企业支持和商业授权：微信 `553000664`

## 许可证

SmartPerfetto 核心代码使用 [AGPL-3.0-or-later](LICENSE)。

`perfetto/` submodule 是 [Google Perfetto](https://github.com/google/perfetto) 的 fork，继续使用 [Apache-2.0](https://github.com/google/perfetto/blob/main/LICENSE)。

如需不受 AGPL 义务约束的商业授权，请通过微信 `553000664` 联系维护者。
