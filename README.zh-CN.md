# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Gracker/SmartPerfetto)](LICENSE)
[![Backend Regression Gate](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml)
[![Node.js >=18](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](backend/tsconfig.json)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed)](docker-compose.yml)
[![Perfetto UI fork](https://img.shields.io/badge/Perfetto-UI%20fork-4285f4)](https://perfetto.dev/)
[![Sponsor](https://img.shields.io/badge/Sponsor-WeChat%20553000664-f66f6f)](#赞助)

> 基于 [Perfetto](https://perfetto.dev/) 的 AI 驱动 Android 性能分析平台。

SmartPerfetto 在 Perfetto trace 之上增加了一层 AI 分析能力。你可以加载 trace，用自然语言提问，然后得到带 SQL 证据、Skill 结果、根因推理和优化建议的分析结论。

项目已经开源，当前处于活跃开发阶段。UI、后端运行时和 Skill 系统已经可用，但公开 API 和内部合约仍可能继续调整。

## Perfetto 参考资源

| 资源 | 英文 | 中文 |
|------|------|------|
| Android Performance Blog | [androidperformance.com/en](https://www.androidperformance.com/en) | [androidperformance.com](https://www.androidperformance.com/) |
| Perfetto 官方文档 | [perfetto.dev/docs](https://perfetto.dev/docs/) | [gugu-perf.github.io/perfetto-docs-zh-cn](https://gugu-perf.github.io/perfetto-docs-zh-cn/) |

## 项目做什么

- 分析 Android Perfetto trace 中的滑动卡顿、启动、ANR、交互延迟、内存、游戏和渲染管线问题。
- 保留 Perfetto 的时间线和 SQL 能力，并在 Perfetto UI 里增加 AI Assistant 面板。
- 通过 TypeScript 后端编排 Agent 流程、查询 `trace_processor_shell`、调用 YAML Skill，并把结果实时流式传给浏览器。
- 支持 Anthropic 直连，也支持通过 Anthropic 兼容 API 代理接入其他具备 tool/function calling 能力的大模型。
- 内置 160+ 个 YAML Skill/配置文件和多场景分析策略，用于 Android 性能排查。

## 技术栈

| 模块 | 技术 |
|------|------|
| 前端 | Fork 后的 Perfetto UI，内置 `com.smartperfetto.AIAssistant` 插件 |
| 后端 | Node.js 18+、TypeScript strict mode、Express |
| Agent 运行时 | Claude Agent SDK、MCP 工具、场景策略、Verifier、SSE 流式输出 |
| Trace 引擎 | Perfetto `trace_processor_shell`，通过 HTTP RPC 调用 |
| 分析逻辑 | `backend/skills/` 下的 YAML Skill，`backend/strategies/` 下的 Markdown 策略 |
| 存储 | 本地上传文件、Session 日志、报告、运行时学习文件 |
| 测试 | Jest、Skill 校验、Strategy 校验、6 条 canonical trace 回归 |
| 部署 | Docker Compose 或本地开发脚本 |

## 使用者

### Docker 运行（推荐）

只想把 SmartPerfetto 跑起来时，推荐使用这个方式。你只需要 Docker Desktop/Engine 和一个大模型 API Key；不需要安装 Node.js，不需要 C++ 工具链，也不需要初始化 `perfetto/` submodule。Docker Hub 镜像每天从 `main` 自动发布，镜像内已经包含后端、预构建 Perfetto UI 和固定版本的 `trace_processor_shell`。

Windows 用户使用 Docker Desktop，并启用 WSL2 backend。发布的是 Linux container 镜像，由 Docker Desktop 承载运行；不需要单独编译 Windows 版镜像。

```bash
git clone https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto
cp backend/.env.example .env
# 编辑 .env，设置 ANTHROPIC_API_KEY，或为代理设置 ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
```

- 前端：[http://localhost:10000](http://localhost:10000)
- 后端健康检查：[http://localhost:3000/health](http://localhost:3000/health)

停止容器：

```bash
docker compose -f docker-compose.hub.yml down
```

上传文件和日志保存在 Docker volume 中，容器重启后仍会保留。

### 本地脚本运行

如果你希望直接从源码 checkout 启动，使用这个方式。前置条件：**Node.js 18+**、`curl`、`lsof`、`pkill`，以及一个大模型 API Key。Windows 源码开发请使用 [WSL2](https://learn.microsoft.com/zh-cn/windows/wsl/install)，不要使用原生 Windows shell。

```bash
git clone https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto
cp backend/.env.example backend/.env
# 编辑 backend/.env，设置 ANTHROPIC_API_KEY（直连）或
# ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY（API 代理）

./start.sh
```

仓库内置了预构建 Perfetto UI（`frontend/` 目录），所以本地脚本方式也不需要初始化 submodule，不需要等待 Perfetto UI 长时间编译。

## 开发者

### 运行脚本

| 脚本 | 使用场景 |
|------|---------|
| `./start.sh` | ✅ **默认推荐** — 日常使用、修改后端/策略/Skill |
| `./scripts/start-dev.sh` | 修改 AI 插件 UI（`ai_panel.ts`、`styles.scss` 等）时使用，需要 `perfetto/` submodule |

### 源码构建 Docker 镜像

只有测试 Docker 改动或构建未发布的本地代码时，才需要从源码构建镜像：

```bash
cp backend/.env.example backend/.env
docker compose up --build
```

源码构建会使用仓库内提交的 `frontend/` 预构建包，不会重新构建 `perfetto/` submodule。

### 前端插件开发（修改 AI 面板 UI）

如果需要修改 AI Assistant 插件的前端代码：

```bash
# 一次性：初始化 perfetto submodule
git submodule update --init --recursive

# 启动（保存文件自动重编译）
./scripts/start-dev.sh
```

在浏览器中确认修改效果后，更新预编译产物并提交：

```bash
./scripts/update-frontend.sh
git add frontend/
git commit -m "chore(frontend): update prebuilt"
```

## 接入大模型

直连 Anthropic 的最小配置：

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

如果要接入第三方大模型，可以使用一个接受 Anthropic Messages 请求、再转发到目标厂商的 API 代理：

```bash
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_API_KEY=sk-proxy-xxx
CLAUDE_MODEL=your-main-model
CLAUDE_LIGHT_MODEL=your-light-model
```

常见代理包括 [one-api](https://github.com/songquanpeng/one-api)、[new-api](https://github.com/Calcium-Ion/new-api) 和 [LiteLLM](https://github.com/BerriAI/litellm)。选择的模型需要稳定支持流式输出和 tool/function calling。完整厂商示例和调优参数见 [backend/.env.example](backend/.env.example)。

### 轮次预算

SmartPerfetto 区分 fast 和 full 两套轮次预算：

```bash
CLAUDE_QUICK_MAX_TURNS=5   # fast 模式默认值
CLAUDE_MAX_TURNS=30        # full 模式默认值
```

如果使用较慢模型，或某些 trace 需要更多工具调用轮次，可以调高这些值。总 safety timeout 会随轮次预算放大：full 模式每轮使用 `CLAUDE_FULL_PER_TURN_MS`，fast 模式每轮使用 `CLAUDE_QUICK_PER_TURN_MS`。修改 `.env` 后需要重启 backend。

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

如果后端不只在本机使用，建议在 `backend/.env` 设置 `SMARTPERFETTO_API_KEY`。开启后，受保护接口需要带上 `Authorization: Bearer <token>`。

## 架构

```text
Frontend (Perfetto UI @ :10000)
  └─ SmartPerfetto AI Assistant plugin
       └─ SSE / HTTP
Backend (Express @ :3000)
  ├─ agentv3 runtime: 场景路由、Prompt、MCP 工具、Verifier
  ├─ Skill engine: YAML 分析管线
  ├─ Session/report/log 服务
  └─ trace_processor_shell 进程池（HTTP RPC, 9100-9900）
```

目录结构：

```text
SmartPerfetto/
├── backend/
│   ├── src/agentv3/        # 主 AI 运行时
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

cd backend
npm run build
npm run test:scene-trace-regression
npm run validate:skills
npm run validate:strategies
npm run test:core
```

必须满足的检查：

- 任何代码改动：`cd backend && npm run test:scene-trace-regression`
- Skill YAML 改动：`npm run validate:skills` 加场景回归
- Strategy/template Markdown 改动：`npm run validate:strategies` 加场景回归
- 构建或类型问题：`cd backend && npx tsc --noEmit`

不要在 TypeScript 里硬编码 Prompt 内容。场景逻辑应放在 `backend/strategies/*.strategy.md`，可复用内容放在 `*.template.md`。

## 文档

- [文档中心](docs/README.md)
- [快速开始](docs/getting-started/quick-start.md)
- [架构总览](docs/architecture/overview.md)
- [API 参考](docs/reference/api.md)
- [MCP 工具参考](docs/reference/mcp-tools.md)
- [Skill 系统指南](docs/reference/skill-system.md)
- [数据合约](backend/docs/DATA_CONTRACT_DESIGN.md)
- [渲染管线参考](docs/rendering_pipelines/)
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

开源项目常见的赞助方式包括 GitHub Sponsors、OpenCollective、Buy Me a Coffee、爱发电、微信/支付宝收款码，以及企业商业支持或商业授权。

SmartPerfetto 目前还没有公开支付页面。如果你想赞助、捐赠、试用企业支持或咨询商业授权，请通过微信联系维护者：`553000664`。

## 许可证

SmartPerfetto 核心代码使用 [AGPL-3.0-or-later](LICENSE)。

`perfetto/` submodule 是 [Google Perfetto](https://github.com/google/perfetto) 的 fork，继续使用 [Apache-2.0](perfetto/LICENSE)。

如需不受 AGPL 义务约束的商业授权，请通过微信 `553000664` 联系维护者。
