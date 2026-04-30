# 配置指南

SmartPerfetto 的后端配置位于 `backend/.env`。推荐从模板开始：

```bash
cp backend/.env.example backend/.env
```

## LLM 配置

SmartPerfetto 当前主运行时是 agentv3，基于 Claude Agent SDK 编排 MCP 工具、Skill 和策略。默认配置是 Anthropic 直连：

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
| `fast` | 默认 5 turns（`CLAUDE_QUICK_MAX_TURNS` 可调），3 个轻量 MCP 工具，跳过 verifier 和 sub-agent | 包名、进程、简单事实查询 |
| `full` | 默认 30 turns（`CLAUDE_MAX_TURNS` 可调），完整 MCP 工具，启用 verifier 和可选 sub-agent | 启动、滑动、ANR、复杂根因分析 |
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
