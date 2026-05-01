# 配置指南

SmartPerfetto 本地源码运行时可以直接使用 Claude Code 的本地认证/配置；如果这个终端里的 `claude` 已经能正常写代码，可以不创建 `.env`。这既包括 Claude Code 官方订阅，也包括 Claude Code 已经配置好的第三方 base URL + API key。需要显式配置 API key、代理或 Docker 运行时，再使用 env 文件。

Perfetto UI 的 AI Assistant 设置面板只配置 SmartPerfetto 后端连接。其中 `Backend API Key` 对应 `SMARTPERFETTO_API_KEY` 后端鉴权，不是第三方大模型 provider key。模型 provider 凭证来自 Claude Code 本地配置，或来自下面的后端/Docker env 文件。

本地源码运行的后端配置位于 `backend/.env`。推荐从模板开始：

```bash
cp backend/.env.example backend/.env
```

## LLM 配置

SmartPerfetto 当前主运行时是 agentv3，基于 Claude Agent SDK 编排 MCP 工具、Skill 和策略。本机 Claude Code 已经可用时，可以依赖 Claude Code 的本地认证/配置；如果要显式直连 Anthropic API，则配置：

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

第三方模型需要通过 Anthropic Messages 兼容代理接入：

```bash
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_API_KEY=sk-proxy-xxx
CLAUDE_MODEL=your-main-model
CLAUDE_LIGHT_MODEL=your-light-model
```

模型必须稳定支持流式输出和 tool/function calling。代理层可以使用 one-api、new-api 或 LiteLLM。

### 运行时与 Provider 诊断

Claude Code 自己的本地认证/配置是 Claude Agent SDK 的原生认证路径，不管它背后是 Anthropic 订阅还是 Claude Code 里配置好的第三方 endpoint。SmartPerfetto 不会自动读取 Codex CLI、Gemini CLI 或 OpenCode 的登录态；那些工具管理的是各自 CLI 的配置文件。

接入 MiMo、DeepSeek、OpenAI、Kimi、MiniMax 等第三方模型时，请让代理层暴露 Anthropic Messages 兼容接口，然后配置：

```bash
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_API_KEY=sk-proxy-xxx
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
| `anthropic_direct` | 使用 `ANTHROPIC_API_KEY` 直连 Anthropic |
| `anthropic_compatible_proxy` | 使用 `ANTHROPIC_BASE_URL` 接入兼容代理 |
| `aws_bedrock` | 使用 AWS Bedrock |
| `unconfigured` | 没有显式 env 凭证；如果本机 `claude` 已经能正常请求，SDK 仍可在分析时走 Claude Code 本地 auth/config 路径 |

## 分析预算与超时

慢模型或本地模型通常需要更长的 per-turn timeout：

```bash
CLAUDE_FULL_PER_TURN_MS=60000
CLAUDE_QUICK_PER_TURN_MS=40000
CLAUDE_VERIFIER_TIMEOUT_MS=60000
CLAUDE_CLASSIFIER_TIMEOUT_MS=30000
```

分析模式由请求体 `options.analysisMode` 控制：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `fast` | 默认 10 turns（`CLAUDE_QUICK_MAX_TURNS` 可调），3 个轻量 MCP 工具，跳过 verifier 和 sub-agent | 包名、进程、简单事实查询 |
| `full` | 默认 60 turns（`CLAUDE_MAX_TURNS` 可调），完整 MCP 工具，启用 verifier 和可选 sub-agent | 启动、滑动、ANR、复杂根因分析 |
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

## agentv2 兼容路径

`AI_SERVICE=deepseek` 会激活已废弃的 agentv2 fallback。默认开发和新功能都应走 agentv3，不建议继续扩展 agentv2，除非任务明确要求维护旧路径。
