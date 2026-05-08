# 快速开始

[English](quick-start.en.md) | [中文](quick-start.md)

本页用于把 SmartPerfetto 跑起来。更多模型和代理参数见 [配置指南](configuration.md)。

## 1. 克隆仓库

普通使用不需要初始化 `perfetto/` submodule。仓库已经包含预构建 Perfetto UI。

步骤 1：运行 `git clone https://github.com/Gracker/SmartPerfetto.git`。

步骤 2：运行 `cd SmartPerfetto`。

只有修改 AI Assistant 前端插件代码时，才需要初始化 submodule 并使用开发脚本。

## 2. 准备模型配置

本地源码运行时，如果这个终端里的 Claude Code 已经能正常写代码，可以不配置 API key；这也包括 Claude Code 自己已经接入第三方模型的情况。先运行 `claude` 验证。

显式 API key/proxy 场景再创建 env 文件：

步骤 1：运行 `cp backend/.env.example backend/.env`。

步骤 2：编辑 `backend/.env`。Anthropic 直连时解注释 `ANTHROPIC_API_KEY`；第三方 Claude Code / Anthropic-compatible provider 解注释一个 provider block，只替换 API key/token；OpenAI / OpenAI-compatible provider 使用 OpenAI Agents SDK 相关字段。

`backend/.env.example` 已经内置 DeepSeek、GLM、Qwen、Kimi、Doubao、MiniMax 等常见 Claude Code 兼容 Base URL 和推荐主/轻模型。Docker Hub 镜像使用仓库根目录 `.env`：

步骤 1：运行 `cp backend/.env.example .env`。

步骤 2：编辑 `.env` 并解注释一个 provider block。只做 health/UI smoke check 可以跳过；真正执行 AI 分析必须配置 provider。

## 3. Docker 运行

适合只想试用，不想配置本机开发工具链的场景。

步骤 1：运行 `docker compose -f docker-compose.hub.yml pull`。

步骤 2：运行 `docker compose -f docker-compose.hub.yml up -d`。

打开 [http://localhost:10000](http://localhost:10000)，加载 `.pftrace` 或 `.perfetto-trace` 文件，然后打开 AI Assistant 面板。

## 4. 本地开发运行

适合本地使用、调试后端、改策略/Skill 或提交 PR。

步骤 1：运行 `./start.sh`。

`./start.sh` 会同时启动后端和仓库内置的预构建 Perfetto UI。首次启动会安装依赖，并下载 version-pinned 的 `trace_processor_shell` 预编译产物。若当前网络无法访问 Google artifact bucket，优先改用 Docker 方式；或者设置 `TRACE_PROCESSOR_PATH` 指向已有 binary，设置 `TRACE_PROCESSOR_DOWNLOAD_BASE` / `TRACE_PROCESSOR_DOWNLOAD_URL` 指向可信镜像后再运行。服务地址：

| 服务 | 地址 |
|---|---|
| Perfetto UI | `http://localhost:10000` |
| Backend API | `http://localhost:3000` |
| Backend health | `http://localhost:3000/health` |

后端会自动启动，前端使用仓库内的预构建 UI。只有修改 AI Assistant 前端插件时，才需要 `git submodule update --init --recursive` 后运行 `./scripts/start-dev.sh`。

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

按改动类型选择测试层（详见 [测试与验证](../development/testing.md)）：

- Contract / 纯类型：`cd backend && npx tsc --noEmit` + 相关 sparkContracts 单测
- CRUD-only service：该 service 的单测
- 触 mcp / memory / report / agent runtime：运行 `cd backend && npm run test:scene-trace-regression`

- PR landing：`npm run verify:pr`（强制全量）

更多命令见 [测试与验证](../development/testing.md)。
