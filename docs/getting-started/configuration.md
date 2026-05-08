# 配置指南

SmartPerfetto 本地源码运行时可以直接使用 Claude Code 的本地认证/配置；如果这个终端里的 `claude` 已经能正常写代码，可以不创建 `.env`。这既包括 Claude Code 官方订阅，也包括 Claude Code 已经配置好的第三方 base URL + API key。需要显式配置 API key、代理或 Docker 运行时，再使用 env 文件。

Perfetto UI 的 AI Assistant 设置面板只配置 SmartPerfetto 后端连接。其中 `Backend API Key` 对应 `SMARTPERFETTO_API_KEY` 后端鉴权，不是第三方大模型 provider key。模型 provider 凭证来自 Claude Code 本地配置，或来自下面的后端/Docker env 文件。

本地源码运行的后端配置位于 `backend/.env`。推荐从模板开始：

```bash
cp backend/.env.example backend/.env
```

## LLM 配置

SmartPerfetto 后端支持两个一等 SDK runtime：

- `claude-agent-sdk`：默认 runtime。适合 Anthropic、Claude Code 本地认证、Bedrock、Vertex，以及 Anthropic/Claude Code-compatible provider。
- `openai-agents-sdk`：OpenAI runtime。适合 OpenAI Responses API、Ollama 和支持流式 function/tool calling 的 OpenAI-compatible gateway。

运行时选择不会根据“哪个 key 存在”自动猜。优先级是：请求/会话里的 `providerId`、Provider Manager 当前 active provider、`SMARTPERFETTO_AGENT_RUNTIME`、最后默认 `claude-agent-sdk`。因此如果 `.env` 里同时写了 `ANTHROPIC_*` 和 `OPENAI_*`，但没有设置 `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk`，实际仍会走 Claude Agent SDK。

Perfetto UI 的 Provider Management 支持把同一个 provider 的两组端点一起保存：`claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` 对应 Claude Code SDK，`openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` 对应 OpenAI SDK。AI 输入框旁的 provider switcher 会显示当前 SDK runtime；对 DeepSeek、Qwen、Kimi、MiMo、TokenHub 或 custom 这类双端点 provider，可以在同一个下拉菜单里显式切换 Claude SDK / OpenAI SDK。切换 provider 或 SDK runtime 会开启新的 SDK session。

已创建的分析 session 会固定当时使用的 credential source。也就是说，一个用 Provider A 创建的 session 恢复后仍尝试使用 Provider A；一个用 `.env` fallback 创建的 session 恢复后不会因为后来设置了 active provider 就改用该 provider。

本机 Claude Code 已经可用时，可以依赖 Claude Code 的本地认证/配置；如果要显式直连 Anthropic API，则配置：

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

已经提供 Claude Code / Anthropic 兼容端点的第三方模型，可以直接使用 `backend/.env.example` 里的预置 provider block。Base URL 已经写好，只替换 API key/token，并保留 SmartPerfetto 的模型变量名：

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-your-deepseek-key
CLAUDE_MODEL=deepseek-v4-pro
CLAUDE_LIGHT_MODEL=deepseek-v4-flash
```

小米 MiMo Token Plan 示例：

```bash
# Anthropic-compatible / Claude SDK
ANTHROPIC_BASE_URL=https://token-plan-sgp.xiaomimimo.com/anthropic
ANTHROPIC_API_KEY=your_xiaomi_mimo_api_key_here
CLAUDE_MODEL=mimo-v2.5-pro
CLAUDE_LIGHT_MODEL=mimo-v2.5-pro

# OpenAI-compatible / OpenAI Agents SDK
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
OPENAI_API_KEY=your_xiaomi_mimo_api_key_here
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=mimo-v2.5-pro
OPENAI_LIGHT_MODEL=mimo-v2.5-pro
```

当前模板内置的国内主流 Anthropic-compatible / Claude Code-compatible 和 OpenAI-compatible 入口是截至 2026-05-08 的官方文档来源示例。Provider 模型目录、Base URL 和套餐权限会变化；如果你的账号控制台列出的模型 ID 或专属域名不同，以控制台为准替换对应字段。
Provider Manager 中建议把同一个 provider 的 Anthropic-compatible URL、OpenAI-compatible URL 和共享 API key 一起预置；用户运行时通过界面选择 SDK Runtime，选择 Claude SDK 就使用 Anthropic-compatible URL，选择 OpenAI Agents SDK 就使用 OpenAI-compatible URL。

| Provider | Claude / Anthropic-compatible Base URL | OpenAI-compatible Base URL | 推荐主模型 | 推荐轻模型 |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/v1` | `deepseek-v4-pro` | `deepseek-v4-flash` |
| GLM / 智谱 | `https://open.bigmodel.cn/api/anthropic` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.1` | `glm-4.5-air` |
| Qwen / 百炼按量 | `https://dashscope.aliyuncs.com/apps/anthropic` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.6-plus` | `qwen3.6-flash` |
| Qwen Coding Plan | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `https://coding-intl.dashscope.aliyuncs.com/v1` | `qwen3-coder-plus` | `qwen3-coder-plus` |
| Kimi Code 会员 | `https://api.kimi.com/coding/` | `https://api.kimi.com/coding/v1` | `kimi-for-coding` | `kimi-for-coding` |
| Kimi / Moonshot 平台 | `https://api.moonshot.cn/anthropic` | `https://api.moonshot.cn/v1` | `kimi-k2.5` | `kimi-k2.5` |
| Doubao / 火山方舟 Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `doubao-seed-2.0-code` | `doubao-seed-2.0-code` |
| MiniMax 国内 | `https://api.minimaxi.com/anthropic` | `https://api.minimaxi.com/v1` | `MiniMax-M2.7` | `MiniMax-M2.7` |
| 小米 MiMo Token Plan | `https://token-plan-sgp.xiaomimimo.com/anthropic` | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.5-pro` | `mimo-v2.5-pro` |
| 腾讯 TokenHub Token Plan | `https://api.lkeap.cloud.tencent.com/plan/anthropic` | `https://api.lkeap.cloud.tencent.com/plan/v3` | `tc-code-latest` | `tc-code-latest` |
| 腾讯 TokenHub Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/anthropic` | `https://api.lkeap.cloud.tencent.com/coding/v3` | `tc-code-latest` | `tc-code-latest` |
| 腾讯混元 legacy | `https://api.hunyuan.cloud.tencent.com/anthropic` | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-2.0-thinking-20251109` | `hunyuan-2.0-instruct-20251111` |
| 百度千帆 | `https://qianfan.baidubce.com/anthropic` | `https://qianfan.baidubce.com/v2` | `deepseek-v3.2` | `deepseek-v3.2` |
| 阶跃星辰 Step Plan | `https://api.stepfun.com/step_plan` | `https://api.stepfun.com/step_plan/v1` | `step-3.5-flash-2603` | `step-3.5-flash` |
| 硅基流动 | `https://api.siliconflow.com/` | `https://api.siliconflow.com/v1` | `Qwen/Qwen3-235B-A22B-Thinking-2507` | `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| 华为云 ModelArts MaaS | `https://api.modelarts-maas.com/anthropic` | `https://api.modelarts-maas.com/v1` | `deepseek-v3.2` | `qwen3-32b` |

Provider 官方文档可能写 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`，但 SmartPerfetto 后端使用 `CLAUDE_MODEL` / `CLAUDE_LIGHT_MODEL`。模型必须稳定支持流式输出和 tool/function calling。
如果百度千帆的自定义应用要求额外 `appid` header，请使用千帆默认 appid，或在前面加一层自定义网关；SmartPerfetto env 文件目前不会注入任意 provider header。

OpenAI 官方 API 不需要伪装成 Anthropic 代理，直接走 OpenAI Agents SDK：

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_API_KEY=sk-your-openai-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_AGENTS_PROTOCOL=responses
OPENAI_MODEL=gpt-5.5
OPENAI_LIGHT_MODEL=gpt-5.4-mini
```

Ollama 或 OpenAI-compatible gateway 走 Chat Completions 协议：

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=qwen3:30b
OPENAI_LIGHT_MODEL=qwen3:30b
```

如果第三方 provider 同时提供 Anthropic-compatible 和 OpenAI-compatible endpoint，Provider Manager 里应同时填写两组 Base URL，再用 `agentRuntime` 或前端 switcher 选择当前使用哪一侧。只用 `.env` 时，同一时刻只能通过 `SMARTPERFETTO_AGENT_RUNTIME` 选择一侧：Claude-compatible 走 `ANTHROPIC_*` + `CLAUDE_*` 变量；OpenAI-compatible 走 `OPENAI_*` 变量。

### 运行时与 Provider 诊断

Claude Code 自己的本地认证/配置是 Claude Agent SDK 的原生认证路径，不管它背后是 Anthropic 订阅还是 Claude Code 里配置好的第三方 endpoint。SmartPerfetto 不会自动读取 Codex CLI、Gemini CLI 或 OpenCode 的登录态；那些工具管理的是各自 CLI 的配置文件。

接入 Gemini 等 provider 时，如果账号只提供 OpenAI-compatible API，可以直接使用 `openai-agents-sdk`；如果该接口的 streaming tool call 不稳定，再让代理层暴露 Anthropic Messages 兼容接口，然后配置：

```bash
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_AUTH_TOKEN=sk-proxy-xxx
CLAUDE_MODEL=your-provider-main-model
CLAUDE_LIGHT_MODEL=your-provider-light-model
```

修改 `.env` 后需要重启后端。显式 env/proxy 凭证可通过健康检查确认当前配置：

```bash
curl http://localhost:3000/health
```

响应中的 `aiEngine.providerMode` 会显示：

| providerMode | 含义 |
|---|---|
| `anthropic_direct` | 使用 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 且未设置自定义 Base URL |
| `anthropic_compatible_proxy` | 使用 `ANTHROPIC_BASE_URL` 接入 Claude Code / Anthropic 兼容 provider 或代理 |
| `aws_bedrock` | 使用 AWS Bedrock |
| `openai_responses` | 使用 OpenAI Agents SDK + Responses API |
| `openai_chat_completions_compatible` | 使用 OpenAI Agents SDK + Chat Completions-compatible endpoint |
| `unconfigured` | 没有显式 env 凭证；如果本机 `claude` 已经能正常请求，SDK 仍可在分析时走 Claude Code 本地 auth/config 路径 |

## 分析预算与超时

慢模型或本地模型通常需要更长的 per-turn timeout：

```bash
CLAUDE_FULL_PER_TURN_MS=60000
CLAUDE_QUICK_PER_TURN_MS=40000
CLAUDE_VERIFIER_TIMEOUT_MS=60000
CLAUDE_CLASSIFIER_TIMEOUT_MS=30000

OPENAI_FULL_PER_TURN_MS=60000
OPENAI_QUICK_PER_TURN_MS=40000
OPENAI_CLASSIFIER_TIMEOUT_MS=30000
```

分析模式由请求体 `options.analysisMode` 控制：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `fast` | 默认 10 turns（`CLAUDE_QUICK_MAX_TURNS` / `OPENAI_QUICK_MAX_TURNS` 可调），3 个轻量工具 | 包名、进程、简单事实查询 |
| `full` | 默认 60 turns（`CLAUDE_MAX_TURNS` / `OPENAI_MAX_TURNS` 可调），完整工具集 | 启动、滑动、ANR、复杂根因分析 |
| `auto` | 关键词规则、硬规则和轻量分类器自动选择 | 默认模式 |

前端会把选择持久化到 `localStorage['ai-analysis-mode']`。中途切换模式会清空当前 `agentSessionId`，让后端开启新的 SDK session。

## 服务配置

```bash
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:10000
```

本地开发默认端口：

- Backend: `3000`
- Perfetto UI: `10000`
- trace_processor HTTP RPC pool: `9100-9900`

## API 鉴权

如果后端暴露给多人或外网，设置：

```bash
SMARTPERFETTO_API_KEY=replace_with_a_strong_random_secret
```

受保护接口需要请求头：

```http
Authorization: Bearer <SMARTPERFETTO_API_KEY>
```

## 上传与 trace processor

```bash
MAX_FILE_SIZE=2147483648
UPLOAD_DIR=./uploads
TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell
PERFETTO_PATH=/path/to/perfetto
```

默认不需要手动设置 `TRACE_PROCESSOR_PATH`。`./scripts/start-dev.sh` 会优先下载固定版本的 prebuilt `trace_processor_shell`，只有在修改 Perfetto C++ 或需要自编译时才使用：

```bash
./scripts/start-dev.sh --build-from-source
```

如果下载卡在 `commondatastorage.googleapis.com` 或 Google artifact bucket 无法访问，有三种出口：

```bash
# 1. 使用已有 binary，脚本会跳过下载
TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell ./start.sh

# 2. 使用保持相同目录结构的可信镜像
TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts ./start.sh

# 3. 使用当前平台的精确 binary URL
TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell ./start.sh
```

镜像下载仍会按 `scripts/trace-processor-pin.env` 中固定的 SHA256 校验；如果只是想快速使用，优先选择 Docker Hub 镜像，因为镜像内已经包含固定版本的 `trace_processor_shell`。

macOS 如果拦截 `trace_processor_shell`，可能会看到 `cannot be opened because the developer cannot be verified`、终端输出 `killed`，或脚本提示 `--version smoke test failed`。打开 **系统设置 → 隐私与安全性 → 安全性**，对 `trace_processor_shell` 点 **仍要打开 / Allow Anyway**，重新运行脚本并在弹窗里选择 **打开**。如果你确认 binary 来源可信，也可以：

```bash
xattr -dr com.apple.quarantine /absolute/path/to/trace_processor_shell
chmod +x /absolute/path/to/trace_processor_shell
```

## 请求限流

内存级限流，适合公开试用环境的基础保护：

```bash
SMARTPERFETTO_USAGE_MAX_REQUESTS=200
SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS=100
SMARTPERFETTO_USAGE_WINDOW_MS=86400000
```

重启后限流状态会丢失；生产部署如果需要严格配额，应在反向代理或 API 网关层增加持久化限流。

## Runtime 与 Provider 的边界

`SMARTPERFETTO_AGENT_RUNTIME` 只表示后端编排 SDK，只接受 `claude-agent-sdk` 或 `openai-agents-sdk`。Provider 名称不能写在这里：例如 DeepSeek 应配置为 Claude/Anthropic-compatible provider，OpenAI/Ollama 应配置为 OpenAI Agents SDK provider。
