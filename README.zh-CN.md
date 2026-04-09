# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

> 基于 [Perfetto](https://perfetto.dev/) 的 AI 驱动 Android 性能分析平台。

加载 Perfetto trace 文件，用自然语言提问，获得结构化的、有证据支撑的分析结果，包含根因推理链和优化建议。

> **项目状态：活跃开发中（预发布）**
>
> SmartPerfetto 正在积极开发中，已在大规模 Android 性能分析场景中投入生产使用。核心分析引擎、Skill 系统和 UI 集成已稳定。API 在 1.0 正式发布前可能会有变化。欢迎贡献和反馈。

## 核心能力

- **AI Agent 分析** — Claude Agent SDK 编排 20 个 MCP 工具，查询 trace 数据、执行分析 Skill、推理性能问题。支持通过 API 代理接入[第三方大模型](#接入第三方大模型)（GLM、DeepSeek、Qwen、Kimi、OpenAI、Gemini 等）
- **146 个分析 Skill** — 基于 YAML 的声明式分析管线（87 原子 + 29 组合 + 28 管线 + 2 深度），四层结果（L1 概览 → L4 深度根因）
- **12 种场景策略** — 场景专属分析剧本（滑动、启动、ANR、交互、内存、游戏等）
- **21 种卡顿根因码** — 优先级排序的决策树，双信号检测（present_type + present_ts interval）
- **多架构支持** — 标准 HWUI、Flutter（TextureView/SurfaceView、Impeller/Skia）、Jetpack Compose、WebView
- **厂商定制** — 设备级分析覆盖 Pixel、三星、小米、OPPO、vivo、荣耀、高通、联发科
- **深度根因链** — 阻塞链分析、Binder 追踪、因果推理（Mermaid 图）
- **实时流式传输** — 基于 SSE 的实时分析，阶段转换和中间推理过程可见
- **Perfetto UI 集成** — 自定义插件，支持时间线导航、数据表格和图表可视化

## 快速开始

### 方式一：Docker（推荐普通用户使��）

最快的启动方式，无需安装编译工具链，只需要 Docker 和 API Key。

```bash
git clone --recursive https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto

cp backend/.env.example backend/.env
# 编辑 backend/.env — 设置 ANTHROPIC_API_KEY（或配置第三方大模型，见下文）

docker compose up --build
```

打开 **http://localhost:10000**，加载 `.pftrace` 文件，开始分析。

### 方式二：本地开发（推荐贡献者使用）

完整开发环境，支持热更新和调试。

**前置条件：**
- Node.js 18+（`node -v`）
- Python 3（Perfetto 构建工具依赖）
- C++ 工具链 — macOS: `xcode-select --install` / Linux: `sudo apt install build-essential python3`
- 大模型 API Key — [Anthropic](https://console.anthropic.com/)（推荐），或任意[支持的第三方大模型](#接入第三方大模型)

```bash
git clone --recursive https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto

cp backend/.env.example backend/.env
# 编辑 backend/.env — 设置 ANTHROPIC_API_KEY（或配置第三方大模型，见下文）

# 首次启动（自动编译 trace_processor_shell，约 3-5 分钟）
./scripts/start-dev.sh
```

打开 **http://localhost:10000**。后端和前端均支持文件保存后自动重新编译 — 修改代码后刷新浏览器即可。

### 使用方法

1. 在浏览器中打开 http://localhost:10000
2. 加载 Perfetto trace 文件（`.pftrace` 或 `.perfetto-trace`）
3. 打开 **AI Assistant** 面板
4. 提出问题：
   - "分析滑动卡顿"
   - "启动为什么慢？"
   - "CPU 调度有没有问题？"
   - "帮我看看这个 ANR"

### Trace 要求

SmartPerfetto 在 **Android 12+** 设备上捕获的 trace 效果最佳：

| 场景 | 最低 atrace 分类 | 建议额外添加 |
|------|-----------------|-------------|
| 滑动 | `gfx`, `view`, `input`, `sched` | `binder_driver`, `freq`, `disk` |
| 启动 | `am`, `dalvik`, `wm`, `sched` | `binder_driver`, `freq`, `disk` |
| ANR | `am`, `wm`, `sched`, `binder_driver` | `dalvik`, `disk` |

## 接入第三方大模型

SmartPerfetto 支持**任何具备函数调用（Function Calling）能力的大模型** — 不仅限于 Claude。你可以通过 API 代理接入国内大模型、OpenAI、Google Gemini 或本地模型。

### 原理

Claude Agent SDK 支持 `ANTHROPIC_BASE_URL` 环境变量。将其指向一个 API 代理，由代理将 Anthropic Messages API 格式转换为目标厂商的 OpenAI 兼容 API：

```
SmartPerfetto → Claude Agent SDK → ANTHROPIC_BASE_URL → API 代理 → 大模型厂商
```

### 配置步骤

1. **部署 API 代理**（支持 Anthropic → OpenAI 格式转换）：
   - [one-api](https://github.com/songquanpeng/one-api) — 最流行，支持 50+ 厂商
   - [new-api](https://github.com/Calcium-Ion/new-api) — one-api 增强版
   - [LiteLLM](https://github.com/BerriAI/litellm) — Python，原生 Anthropic 格式支持

2. **在代理中配置**目标厂商的 API Key 和 endpoint

3. **编辑 `backend/.env`** — 取消注释 `.env.example` 中对应厂商的配置块：

```bash
# 指向你的代理
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_API_KEY=sk-proxy-xxx

# 设置模型名（需与代理中配置的一致）
CLAUDE_MODEL=glm-4-plus
CLAUDE_LIGHT_MODEL=glm-4-flash
```

### 支持的厂商

| 厂商 | 主力模型 | 轻量模型 | 代理后端 URL |
|------|---------|---------|-------------|
| **智谱 GLM** | `glm-4-plus` | `glm-4-flash` | `https://open.bigmodel.cn/api/paas/v4` |
| **DeepSeek** | `deepseek-chat` | `deepseek-chat` | `https://api.deepseek.com/v1` |
| **通义千问 Qwen** | `qwen-max` | `qwen-turbo` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| **月之暗面 Kimi** | `moonshot-v1-128k` | `moonshot-v1-8k` | `https://api.moonshot.cn/v1` |
| **豆包 Doubao** | `ep-xxx`（接入点 ID） | `ep-xxx` | `https://ark.cn-beijing.volces.com/api/v3` |
| **Minimax** | `abab6.5s-chat` | `abab5.5-chat` | `https://api.minimax.chat/v1` |
| **百川 Baichuan** | `Baichuan4` | `Baichuan3-Turbo` | `https://api.baichuan-ai.com/v1` |
| **腾讯混元** | `hunyuan-pro` | `hunyuan-lite` | `https://api.hunyuan.cloud.tencent.com/v1` |
| **OpenAI** | `gpt-4o` | `gpt-4o-mini` | `https://api.openai.com/v1` |
| **Google Gemini** | `gemini-2.5-pro` | `gemini-2.0-flash` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| **Ollama（本地）** | `qwen2.5:72b` | `qwen2.5:7b` | `http://localhost:11434/v1` |

完整配置示例（含各厂商控制台 URL 和特殊说明）见 [`backend/.env.example`](backend/.env.example)。

### 注意事项

- **`CLAUDE_LIGHT_MODEL`** 用于辅助的单轮调用（查询分类、结论验证、场景摘要）。如果代理只映射了一个模型，设为与 `CLAUDE_MODEL` 相同即可。
- **Sub-agent**（`CLAUDE_ENABLE_SUB_AGENTS`）默认对所有用户关闭（Claude Agent SDK 中仍处于 research preview 阶段）。开启后，SDK 内部会将模型缩写（如 `'sonnet'` → `'claude-sonnet-4-6'`）解析为完整模型名并发起独立 API 调用 — 这些调用同样经过你的代理。能否正常工作取决于代理的 Anthropic 格式转换保真度。如果想尝试，设置 `CLAUDE_ENABLE_SUB_AGENTS=true` 并确保代理正确映射了 Anthropic 模型名。
- **Extended Thinking**（`CLAUDE_EFFORT`）是 Claude 专有特性，非 Claude 厂商会忽略此参数。
- **Function Calling 质量**因厂商而异。Function Calling 能力较强的模型（GLM-4、DeepSeek V3、Qwen-Max、GPT-4o）与 SmartPerfetto 的 20 工具 MCP Server 配合效果最佳。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    前端 (Perfetto UI @ :10000)                   │
│         插件: com.smartperfetto.AIAssistant                      │
│         - AI 分析面板（提问、查看结果）                             │
│         - 时间线集成（点击结果跳转到时间线）                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ SSE / HTTP
┌───────────────────────────▼─────────────────────────────────────┐
│                    后端 (Express @ :3000)                        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  agentv3 运行时                                           │   │
│  │    ClaudeRuntime → 场景分类 → 动态 System Prompt            │   │
│  │    → Claude Agent SDK (MCP) → 4 层验证 + 反思重试            │   │
│  │                                                           │   │
│  │  MCP Server (20 工具: 9 常驻 + 11 条件)                    │   │
│  │    execute_sql │ invoke_skill │ detect_architecture       │   │
│  │    lookup_sql_schema │ lookup_knowledge │ ...             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Skill 引擎 (146 个 YAML Skill)                           │   │
│  │  原子(87) │ 组合(29) │ 管线(28) │ 深度(2) │ 厂商覆盖      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  trace_processor_shell (HTTP RPC, 端口池 9100-9900)        │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## Skills-Standard（独立 Skill 包）

`Skills-Standard/` 目录包含导出为 [Anthropic SKILL.md](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/skills) 标准格式的分析 Skill。这些 Skill 可以独立使用，只要你的 Claude 工具链具备对 Perfetto trace 的 SQL 查询能力 — **无需 SmartPerfetto 后端**。

| Skill | 描述 |
|-------|------|
| **scrolling-analysis** | 滑动卡顿检测，21 种根因码，双信号检测，Flutter/Compose/WebView 支持 |
| **startup-analysis** | 启动性能分析，TTID/TTFD 诊断，四象限分析，阻塞链追踪 |

详见 [Skills-Standard/README.md](Skills-Standard/README.md)。

## 开发指南

### 开发工作流

首次 `./scripts/start-dev.sh` 后，后端（`tsx watch`）和前端（`build.js --watch`）均在保存时自动重编译：

| 改动类型 | 需要的操作 |
|---------|-----------|
| TypeScript / YAML / Markdown | 刷新浏览器 |
| `.env` 或 `npm install` | `./scripts/restart-backend.sh` |
| 两个服务都挂了 | `./scripts/start-dev.sh` |

### 测试

每次代码改动都必须通过回归测试：

```bash
cd backend

# 必须 — 每次改动后运行
npm run test:scene-trace-regression

# 验证 Skill YAML 合约
npm run validate:skills

# 验证 Strategy Markdown frontmatter
npm run validate:strategies

# 完整测试套件（约 8 分钟）
npm test
```

### 调试

Session 日志存储在 `backend/logs/sessions/*.jsonl`：

```bash
# 通过 API 查看 session 日志
curl http://localhost:3000/api/agent/v1/logs/{sessionId}
```

| 问题 | 解决方案 |
|------|---------|
| "AI backend not connected" | `./scripts/start-dev.sh` |
| 分析数据为空 | 确认 trace 包含 FrameTimeline 数据（Android 12+） |
| 端口冲突 9100-9900 | `pkill -f trace_processor_shell` |

## 文档

- [技术架构](docs/technical-architecture.md) — 系统设计和扩展指南
- [MCP 工具参考](docs/mcp-tools-reference.md) — 20 个 MCP 工具的参数和行为
- [Skill 系统指南](docs/skill-system-guide.md) — YAML Skill DSL 参考
- [数据合约](backend/docs/DATA_CONTRACT_DESIGN.md) — DataEnvelope v2.0 规范
- [渲染管线](docs/rendering_pipelines/) — 23 份 Android 渲染管线参考文档

## 贡献

欢迎贡献！详见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建、测试要求和 PR 流程。

参与前请阅读 [行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[AGPL v3](LICENSE) — SmartPerfetto 核心代码。

`perfetto/` 子模块是 [Google Perfetto](https://github.com/google/perfetto) 的 fork，使用 [Apache 2.0](perfetto/LICENSE) 许可证。

如需商业授权（无需遵守 AGPL 义务），请联系项目维护者。
