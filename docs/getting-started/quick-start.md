# 快速开始

[English](quick-start.en.md) | [中文](quick-start.md)

本页用于把 SmartPerfetto 跑起来。更多模型和代理参数见 [配置指南](configuration.md)。

## 1. 克隆仓库

普通使用不需要初始化 `perfetto/` submodule。仓库已经包含预构建 Perfetto UI。

步骤 1：运行 `git clone https://github.com/Gracker/SmartPerfetto.git`。

步骤 2：运行 `cd SmartPerfetto`。

只有修改 AI Assistant 前端插件代码时，才需要初始化 submodule 并使用开发脚本。

## 2. 准备模型配置

不需要把所有 runtime 都配置一遍。第一次只选一个入口：本机 `claude`、UI Provider Manager、一个 Claude-compatible env block、一个 OpenAI-compatible env block、Pi Agent Core / OpenCode custom block，或显式安装的 Qoder SDK 加本机 CLI 登录态/PAT。

本地源码运行时，如果这个终端里的 Claude Code 已经能正常写代码，可以不配置 API key；这也包括 Claude Code 自己已经接入第三方模型的情况。先运行 `claude` 验证。

显式 API key/proxy 场景再创建 env 文件：

步骤 1：运行 `cp backend/.env.example backend/.env`。

步骤 2：编辑 `backend/.env`。Anthropic 直连时解注释 `ANTHROPIC_API_KEY`；第三方 Claude Code / Anthropic-compatible provider 解注释一个 provider block，只替换 API key/token；OpenAI / OpenAI-compatible provider 使用 OpenAI Agents SDK 相关字段；Pi Agent Core / OpenCode 使用 custom 配置段。Qoder 是 opt-in：先审阅条款并安装 `@qoder-ai/qoder-agent-sdk`，再使用 Qoder 配置段。

`backend/.env.example` 已经内置 DeepSeek、GLM、Qwen、Kimi、Doubao、MiniMax 等常见 Claude Code 兼容 Base URL 和推荐主/轻模型。Docker 使用仓库根目录 `.env`，包括 Docker Hub 镜像和本地 source Docker build：

步骤 1：运行 `cp .env.example .env`。

步骤 2：编辑 `.env` 并解注释一个 provider block。如果准备在 UI Provider Manager 里配置 provider，或只做 health/UI smoke check，可以跳过；真正执行 AI 分析必须有一个 provider 来源。

如果 UI 里已经激活了 Provider Manager profile，它会覆盖 `.env` fallback。当前来源可以在容器启动日志、Provider 设置页或带鉴权的 `/api/runtime-health` 中确认；公开 `/health` 只用于存活检查。

## 3. Docker 运行

适合只想试用，不想配置本机开发工具链的场景。

步骤 1：运行 `docker compose -f docker-compose.hub.yml pull`。

步骤 2：运行 `docker compose -f docker-compose.hub.yml up -d`。

打开 [http://localhost:10000](http://localhost:10000)，加载 `.pftrace` 或 `.perfetto-trace` 文件，然后打开 AI Assistant 面板。

Docker image 已包含固定 trace processor、提交版 UI 和签名 Android Internals
Knowledge Pack；不需要宿主机下载这些运行时资产。

## 4. 本地开发运行

适合本地使用、调试后端、改策略/Skill 或提交 PR。

步骤 1：运行 `./start.sh`。

`./start.sh` 会同时启动后端和仓库内置的预构建 Perfetto UI；只有两端都通过 HTTP readiness 后才会报告启动成功。首次启动会安装依赖，并下载 version-pinned 的 `trace_processor_shell` 预编译产物。若当前网络无法访问 Google artifact bucket，优先改用 Docker 方式；或者设置 `TRACE_PROCESSOR_PATH` 指向已有 binary，设置 `TRACE_PROCESSOR_DOWNLOAD_BASE` / `TRACE_PROCESSOR_DOWNLOAD_URL` 指向可信镜像后再运行。若端口被当前 checkout 之外的进程占用，脚本会报告 owner 并退出，不会直接杀掉该进程。服务地址：

| 服务 | 地址 |
|---|---|
| Perfetto UI | `http://localhost:10000` |
| Backend API | `http://localhost:3000` |
| Backend health | `http://localhost:3000/health` |

后端会自动启动，前端使用仓库内的预构建 UI。只有修改 AI Assistant 前端插件时，才需要 `git submodule update --init --recursive` 后运行 `./scripts/start-dev.sh`。
仓库也已包含离线 Knowledge Pack snapshot；后台只会按配置异步检查签名更新，不会让
运行中的 session 静默切换知识版本。

## 5. 第一次分析

步骤 1：打开 `http://localhost:10000`。

步骤 2：加载 Perfetto trace。

步骤 3：打开 AI Assistant。

步骤 4：输入问题，例如 `分析滑动卡顿`。

常用问题：

- `分析启动性能`
- `CPU 调度有没有问题？`
- `帮我看看这个 ANR`
- `这个 trace 的应用包名和主要进程是什么？`

## 6. 必要检查

按改动类型选择最小测试层。维护者和 LLM/Agent 需要先读
[产品面规则](../../.claude/rules/product-surface.md) 和
[测试规则](../../.claude/rules/testing.md)：

- Contract / 纯类型：`cd backend && npx tsc --noEmit` + 相关 sparkContracts 单测
- CRUD-only service：该 service 的单测
- 触 mcp / memory / report / agent runtime：运行 `cd backend && npm run test:scene-trace-regression`
- 文档入口、命令或链接：运行 `npm run verify:docs`
- PR landing：`npm run verify:pr`（强制全量）

发布、npm、Docker 或免安装包相关改动还需要读
[发布手册](../reference/release.md) 和
[发布规则](../../.claude/rules/release.md)。

## 7. Trace 案例库

仓库的 [Trace 案例库](../../Trace/README.md) 分为真实案例和可复现构造案例。真实案例按“一例一目录”保存 trace、分析结果、日志、来源和 Android/API 元数据；构造案例保存真实 base trace 上的确定性 overlay，并覆盖当前全部 Skill 与 Strategy。

- 检查索引、哈希、发布审批和精确覆盖：`npm run trace:validate`
- 构建所有组合 trace：`npm run trace:build`
- 运行完整发布回归：`npm run trace:regression`

新抓取的真实 trace 必须先用 `import-real` 进入被 Git 忽略的 `.private/` 暂存区。完成许可、同意记录、隐私和脱敏审查后，再显式执行 `promote-real`。完整命令、构造场景模板、覆盖质量分级和 Android 版本约定见 [Trace/README.md](../../Trace/README.md)。
