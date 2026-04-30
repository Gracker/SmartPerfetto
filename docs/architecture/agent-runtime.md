# agentv3 运行时

agentv3 是 SmartPerfetto 当前主运行时。它使用 Claude Agent SDK 作为编排层，通过 MCP 工具访问 trace 数据，并把场景策略、Skill 结果、SQL 证据和 verifier 组合成最终中文 Insight。

## 入口

HTTP 主路径：

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createClaudeRuntime()
  -> ClaudeRuntime.analyze()
```

CLI 路径复用同一套 agentv3 核心模块，不经过 Express：

```text
backend/src/cli-user/
  -> CliAnalyzeService
  -> AgentAnalyzeSessionService
  -> ClaudeRuntime.analyze()
```

## 关键文件

| 文件 | 责任 |
|---|---|
| `claudeRuntime.ts` | 主 orchestrator，实现 `IOrchestrator`，封装 SDK query |
| `claudeMcpServer.ts` | MCP 工具注册和执行 |
| `claudeSystemPrompt.ts` | 动态系统 Prompt 组装 |
| `strategyLoader.ts` | 加载 strategy/template Markdown 和 frontmatter |
| `queryComplexityClassifier.ts` | fast/full/auto 路由 |
| `claudeSseBridge.ts` | SDK stream 到 SSE event 的桥接 |
| `sceneClassifier.ts` | 基于 strategy frontmatter 的场景分类 |
| `claudeVerifier.ts` | 多层 verifier |
| `artifactStore.ts` | Skill 大结果的摘要、分页和 full 读取 |
| `analysisPatternMemory.ts` | 正向/负向 pattern 记忆 |
| `selfImprove/` | 自改进 outbox、review worker、strategy patch、安全扫描 |

## 场景策略

场景策略位于 `backend/strategies/*.strategy.md`。当前主场景包括：

- `scrolling`
- `startup`
- `anr`
- `pipeline`
- `interaction`
- `touch-tracking`
- `teaching`
- `memory`
- `game`
- `overview`
- `scroll-response`
- `general`

Strategy frontmatter 提供关键词、计划模板和 `phase_hints`。Markdown body 提供场景方法论。Prompt 模板位于 `prompt-*.template.md`、`arch-*.template.md`、`knowledge-*.template.md`。

## MCP 工具层

完整模式最多暴露 20 个 MCP 工具，分为：

- 核心数据访问：`execute_sql`、`invoke_skill`、`lookup_sql_schema` 等。
- 规划与假设：`submit_plan`、`update_plan_phase`、hypothesis 相关工具。
- 记忆与模式：pattern memory 相关工具。
- 双 trace 对比：comparison tools。

fast 模式只暴露 `execute_sql`、`invoke_skill`、`lookup_sql_schema`，跳过 plan gate、verifier 和 sub-agent。

完整工具说明见 [MCP 工具参考](../reference/mcp-tools.md)。

## 分析模式

| 模式 | turns | 工具 | verifier | 典型成本 |
|---|---:|---|---|---:|
| `fast` | 默认 5（`CLAUDE_QUICK_MAX_TURNS` 可调） | 3 个轻量工具 | 跳过 | 低 |
| `full` | 默认 30（`CLAUDE_MAX_TURNS` 可调） | 完整工具集 | 启用 | 中高 |
| `auto` | 根据规则路由 | 根据路由结果 | 根据路由结果 | 不定 |

`auto` 的路由顺序：

```text
applyKeywordRules
  -> applyHardRules
  -> Haiku/light model fallback
```

显式 `fast` 或 `full` 会绕过自动分类。

## SSE 事件

agentv3 常见事件：

| Event | 含义 |
|---|---|
| `connected` | SSE 连接建立 |
| `progress` | 阶段变化 |
| `thought` | 中间推理或阶段提示 |
| `agent_response` | MCP/Skill/SQL 工具结果 |
| `answer_token` | 最终答案 token |
| `conclusion` | 结论已到达，用户可以先看到答案 |
| `analysis_completed` | HTML report 已生成，终态事件 |
| `error` | 错误 |
| `end` | 流结束 |

`conclusion` 会早于 `analysis_completed`。这样用户先看到结论，报告生成随后完成。

## Session 与恢复

- API session 存在内存 Map 中，并有清理逻辑。
- SDK session ID 持久化到 `logs/claude_session_map.json`。
- 多轮追问复用 sessionId，并通过 SDK `resume` 恢复上下文。
- 同一 session 的并发分析由 `activeAnalyses` 防重入。
- CLI session 存储在 `~/.smartperfetto/sessions/`，但复用同一套后端持久化能力。
