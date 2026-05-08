# Agent Runtime 架构

SmartPerfetto 后端现在把“模型 SDK”与“Perfetto 分析能力”分层。HTTP/CLI 会话层只依赖统一的 `IOrchestrator` 合约；具体运行时由 Provider 或 env 选择：

| Runtime | SDK | Provider 类型 | 说明 |
|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic、Bedrock、Vertex、DeepSeek、Anthropic-compatible gateway | 默认运行时，继续支持 Claude Code 本地认证、MCP server、verifier 和 sub-agent |
| `openai-agents-sdk` | OpenAI Agents SDK | OpenAI、Ollama、OpenAI-compatible gateway | 原生 OpenAI runtime，通过 function tools 复用同一套 SmartPerfetto 工具 |

## 入口

HTTP 主路径：

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> ClaudeRuntime.analyze() | OpenAIRuntime.analyze()
```

恢复和场景还原也走同一个 runtime factory：

```text
POST /api/agent/v1/resume
POST /api/agent/v1/scene-reconstruct
  -> createAgentOrchestrator()
```

CLI 路径复用 `AgentAnalyzeSessionService`，因此 Provider/runtime 选择规则与 HTTP 一致。

## 运行时选择

优先级从高到低：

1. 请求体或会话内的 `providerId`。
2. Provider Manager 当前 active provider。
3. `SMARTPERFETTO_AGENT_RUNTIME` env。
4. 默认 `claude-agent-sdk`。

`SMARTPERFETTO_AGENT_RUNTIME` 只接受 `claude-agent-sdk` 或 `openai-agents-sdk`。`deepseek`、`openai` 这类 provider 名称不能写在 runtime env 里；DeepSeek 应通过 Provider Manager 或 Claude/Anthropic-compatible env 配置。

环境变量不会被用来猜运行时。没有 active provider 且未设置 `SMARTPERFETTO_AGENT_RUNTIME` 时，即使同时存在 `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`，默认仍是 `claude-agent-sdk`。Provider Manager 内的 active provider 会优先于 env；双端点 provider 通过 `connection.agentRuntime` 显式决定当前 SDK。

每个分析 session 会固定自己的 credential source：具体 Provider Manager profile，或显式的 env/default fallback。恢复历史 session 时不会重新读取后来切换的 active provider；如果快照绑定的 provider 已被删除，后端会 fail-fast，而不是静默回退到另一个 provider。

Provider 默认映射：

| Provider type | Runtime | Protocol |
|---|---|---|
| `anthropic` / `bedrock` / `vertex` / `deepseek` | `claude-agent-sdk` | Claude/Anthropic |
| `openai` | `openai-agents-sdk` | OpenAI Responses |
| `ollama` | `openai-agents-sdk` | OpenAI-compatible Chat Completions |
| `custom` | 由 `connection.agentRuntime` 或 `connection.openaiProtocol` 决定 | 显式配置 |

Provider connection 支持两套端点字段：

| 字段 | Runtime | 映射到 env |
|---|---|---|
| `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` | `claude-agent-sdk` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` |
| `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` | `openai-agents-sdk` | `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_AGENTS_PROTOCOL` |
| `baseUrl` / `apiKey` | legacy/shared | 作为旧配置兼容或双协议共享 key |

## 关键文件

| 文件 | 责任 |
|---|---|
| `backend/src/agentRuntime/runtimeSelection.ts` | runtime 选择与统一 orchestrator factory |
| `backend/src/agentv3/claudeRuntime.ts` | Claude Agent SDK orchestrator |
| `backend/src/agentOpenAI/openAiRuntime.ts` | OpenAI Agents SDK orchestrator |
| `backend/src/agentv3/claudeMcpServer.ts` | SmartPerfetto 工具注册，仍是工具单一事实源 |
| `backend/src/agentOpenAI/openAiToolAdapter.ts` | Claude MCP tool descriptor 到 OpenAI function tool 的适配 |
| `backend/src/services/providerManager/` | Provider 配置、runtime/protocol/env 映射 |
| `backend/src/agentv3/sessionStateSnapshot.ts` | 统一会话快照，含 Claude/OpenAI SDK 状态 |

## 工具层

SmartPerfetto 的分析能力仍由 `createClaudeMcpServer()` 注册：`execute_sql`、`invoke_skill`、`lookup_sql_schema`、plan/hypothesis、artifact、pattern memory、comparison tools 等。

Claude runtime 直接把这些工具暴露为 in-process MCP server。

OpenAI runtime 不复制工具逻辑，而是读取同一份 `McpToolRegistry`，把每个 tool descriptor 适配为 OpenAI Agents SDK function tool。工具名称保留 `mcp__smartperfetto__*` 前缀，便于 SSE、日志和报告复用现有语义。

两套 SDK 在 SmartPerfetto 边界上保持同一个产品合约：输入是同一份分析请求，输出归一化为同一组 SSE event、`AnalysisResult` 和 HTML report。它们的 SDK 机制并不相同：Claude runtime 使用 Claude SDK 的 in-process MCP server、tool allowlist、SDK session resume、verifier/sub-agent；OpenAI runtime 使用从同一工具注册表适配出来的 function tools，Responses API 通过 `previousResponseId` 恢复，Chat Completions-compatible provider 通过历史消息恢复。模型的工具调用节奏、流式事件、恢复能力和成本/超时语义都可能不同。

## 分析模式

| 模式 | Claude runtime | OpenAI runtime |
|---|---|---|
| `fast` | 轻量系统 prompt，3 个核心工具，`CLAUDE_QUICK_MAX_TURNS` | 轻量系统 prompt，3 个核心工具，`OPENAI_QUICK_MAX_TURNS` |
| `full` | 完整工具、plan gate、notes、artifact、verifier/sub-agent 配置 | 完整工具、plan gate、notes、artifact；OpenAI 原生 verifier/sub-agent 后续以同合约扩展 |
| `auto` | 规则和轻量分类器路由 | 默认走完整分析，显式 `fast` 时走轻量路径 |

## SSE 事件

两个 runtime 都向路由层发同一类 SmartPerfetto streaming update：

| Event | 含义 |
|---|---|
| `progress` | 阶段变化 |
| `thought` | 中间推理或阶段提示 |
| `agent_task_dispatched` | 工具调用开始 |
| `agent_response` | 工具结果 |
| `answer_token` | 最终答案 token |
| `conclusion` | SDK 结论已到达 |
| `analysis_completed` | HTML report 已生成，终态事件 |
| `error` | 错误 |

`analysis_completed` 仍由 route 层生成 report 后发出，所以报告链路不关心底层 SDK。

## Session 与恢复

统一快照由 route 层调用 `orchestrator.takeSnapshot()` 生成，恢复时调用 `restoreFromSnapshot()`。

Claude runtime 持久化 `sdkSessionId` 并通过 Claude SDK resume 恢复上下文。

OpenAI runtime 持久化 `openAIHistory`、`openAILastResponseId` 和预留的 `openAIRunState`。恢复后优先用 SDK history 继续多轮对话；Responses API 可附带 `previousResponseId`，Chat Completions-compatible provider 使用完整 history。

## 健康检查

`GET /health` 的 `aiEngine.runtime` 会显示实际选择的 runtime：

```json
{
  "aiEngine": {
    "runtime": "openai-agents-sdk",
    "providerMode": "openai_responses",
    "diagnostics": {
      "protocol": "responses",
      "model": "gpt-5.5"
    }
  }
}
```

这能区分“Provider 连接测试通过”和“真实分析 runtime 已切换”这两件事。
