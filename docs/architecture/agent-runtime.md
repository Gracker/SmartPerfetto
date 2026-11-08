# Agent Runtime 架构

[English](agent-runtime.en.md) | [中文](agent-runtime.md)

<!-- i18n-headings: paired -->

SmartPerfetto 后端现在把“模型 SDK”与“Perfetto 分析能力”分层。HTTP/CLI 会话层只依赖统一的 `IOrchestrator` 合约；具体运行时由 Provider 或 env 选择：

| Runtime | SDK | Provider 类型 | 说明 |
|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic、Bedrock、Vertex、DeepSeek、Anthropic-compatible gateway | env 已有 Claude 凭据时的默认运行时，需要显式 provider/env 凭据，支持 MCP server 和可配置 sub-agent，复用共享终态与验证合约 |
| `openai-agents-sdk` | OpenAI Agents SDK | OpenAI、Ollama、OpenAI-compatible gateway | 原生 OpenAI runtime，通过 function tools 复用同一套 SmartPerfetto 工具 |
| `pi-agent-core` | Pi Agent Core | custom、GLM、DeepSeek、Kimi、Kimi Code、MiniMax | 可选 public runtime；真实模型配置下复用 SmartPerfetto 共享 prompt/tool/report 管线，fake-stream 仅用于 smoke；不启用 `.pi` discovery、package extension、shell/file tools |

OpenCode 与 Qoder 引擎及其 SDK 依赖已删除。记录里出现的 `opencode`、`qoder-agent-sdk` 标签仍可读取
（`RECORDED_PRODUCTION_RUNTIME_KINDS`），执行时使用 effective runtime。

## 入口

HTTP 主路径：

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> PiAgentCoreRuntime.analyze() | ClaudeRuntime.analyze() | OpenAIRuntime.analyze()
```

恢复和场景还原也走同一个 runtime factory：

```text
POST /api/agent/v1/resume
POST /api/agent/v1/scene-reconstruct
  -> createAgentOrchestrator()
```

CLI 路径复用 `AgentAnalyzeSessionService`，因此 Provider/runtime 选择规则与 HTTP 一致。

CLI npm 包是独立终端产品，入口是 `smp` / `smartperfetto`；它不启动 Web UI，但会复用同一套 runtime、MCP 工具、Skill、report 和 session snapshot。

## 运行时选择

Pi Agent Core（`pi-agent-core`）是唯一可选的 runtime（`runtimeKinds.ts` 的 `SELECTABLE_RUNTIME_KINDS`）。
`runtimeSelection.ts` 仍按来源优先级给出 selection：请求/会话的 `providerId`、Provider Manager 当前
active provider、记录下的 runtime pin（session snapshot、CLI session）、`SMARTPERFETTO_AGENT_RUNTIME`、
默认；每个来源都解析到同一个 effective runtime（`legacyRuntimeFallback.ts` 的 `effectiveAgentRuntimeKind`）。

- `SMARTPERFETTO_AGENT_RUNTIME` 已废弃：曾经有效的值（`claude-agent-sdk`、`openai-agents-sdk`、
  `pi-agent-core`、`opencode`、`qoder-agent-sdk`、实验 kind）都映射为 effective runtime，并只记录一次
  废弃警告；未知值（例如 `deepseek` 这类 provider 名称）仍 fail closed。
  `SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME` 开关已退役并被忽略。
- 记录在数据里的 runtime 标签（`RECORDED_RUNTIME_KINDS`，含已退役 kind）只作 provenance：会话描述、
  snapshot、run manifest、receipt、external-issue pin 和 Self-Evolution pin 照常解析；执行时重新解析为
  effective runtime。固定到已退役 runtime 的 Self-Evolution baseline 报告
  `evaluation_baseline_runtime_retired`，需要重新建立 baseline。
- 维护者说明：Claude Agent SDK 与 OpenAI Agents SDK 引擎在本版本内保留一个不写入用户文档、只读
  进程环境的回退开关 `SMARTPERFETTO_LEGACY_AGENT_RUNTIME=claude-agent-sdk|openai-agents-sdk`。它只恢复
  provider record 原本运行的那个引擎；原本运行在其他引擎上的 record 仍走 Pi（Pi 路由保持该 record
  自己的 endpoint 和凭据），因此不会把 key 发到另一家服务。provider env 与 `custom.envOverrides` 都不能
  携带它；记录下的 pin 走同一个函数，
  `smp doctor` 与健康检查会报告它处于激活状态。下一版本连同两个引擎一起删除。

每个分析 session 会固定自己的 credential source：具体 Provider Manager profile，或显式的 env/default fallback。恢复历史 session 时不会重新读取后来切换的 active provider；如果快照绑定的 provider 已被删除，后端会 fail-fast，而不是静默回退到另一个 provider。

### Provider 到 Pi 模型的映射

`piProviderCatalog.ts` 是唯一的映射：先确定 profile 迁移前运行在哪个 runtime
（`providerRuntimeMatrix.ts` 的 `previousProviderAgentRuntime`：`apiSurface`、尚未保存的旧
`agentRuntime`、已在 Pi 上的 profile、否则按类型的原默认值），再由该 runtime 原本收到的 env
推出 Pi route（`resolvePiRouteFromLegacyEnv`），因此 API、请求 origin（scheme、host、port、base path）、
模型 ID 和凭据形式都与原 runtime 一致：

| 原 runtime | Pi API | origin | 凭据 |
|---|---|---|---|
| Claude（Anthropic 或兼容网关） | `anthropic-messages` | `ANTHROPIC_BASE_URL`，默认 `https://api.anthropic.com` | `ANTHROPIC_API_KEY` → `x-api-key`；`ANTHROPIC_AUTH_TOKEN`（双端点 provider 的共享 key）→ 请求头 `Authorization: Bearer`，不写入 model JSON |
| Claude on Bedrock | `bedrock-converse-stream` | `ANTHROPIC_BEDROCK_BASE_URL`，默认 `bedrock-runtime.<region>.amazonaws.com` | bearer token、显式 key，或 provider record 的 AWS profile（每次请求严格 `fromIni({profile})`，fingerprint 绑定 profile+region） |
| Claude on Vertex | `anthropic-vertex`（注入 `AnthropicVertex` client 的 anthropic-messages） | `<region>-aiplatform.googleapis.com/v1`（`global` 为 `aiplatform.googleapis.com/v1`） | 仅 `GOOGLE_APPLICATION_CREDENTIALS` 指定的文件 |
| OpenAI Agents SDK | `openai-responses` 或 `openai-completions`（按 `OPENAI_AGENTS_PROTOCOL`） | `OPENAI_BASE_URL`，默认 `https://api.openai.com/v1` | Bearer；本机 endpoint 无 key 时用占位 key |
| OpenCode | `openai-completions` | 其 OpenAI-compatible 字段或 model JSON 的 `baseURL` | Bearer |
| Qoder，或没有 endpoint 的 OpenCode JSON | 无（`SMARTPERFETTO_PI_AGENT_CORE_MODEL_UNAVAILABLE` 给出原因） | — | — |
| 已在 Pi 上（catalog 类型或显式 JSON） | 不变（冻结的 `PI_CATALOG_ROUTES` catalog reference 或用户 JSON） | 不变 | 不变 |

创建 provider runtime 时（`piAgentCoreProvider.ts` 的 `resolvePiRouteModel`），installed pi-ai catalog
在同一 host、同一 API 下有该模型时使用目录条目（只替换为 route 的 base URL）；否则在原 API 上合成：
reasoning 关闭、费用为 0、限制取同 host 的目录条目、模板声明或保守默认（context 128000；输出
Anthropic/Bedrock/Vertex 32000、OpenAI 16384），Anthropic-compatible 网关不发送 `eager_input_streaming`。
合成模型只在 env 时派生，从不持久化；显式 `piAgentCoreModelJson` 仍是用户覆盖。

Provider profile 在读取时由 `retiredRuntime.ts` 的 `withMigratedAgentRuntime` 迁移（与
`withoutRetiredTuning` 并列）：旧 `agentRuntime` → `pi-agent-core`，双端点/custom 类型记录 `apiSurface`，
删除只属于 OpenCode/Qoder 的字段；幂等，下一次正常保存时写回。API、`POST /:id/runtime` 写入的旧值
记录警告后按同一规则落到 Pi。无法换算的 Qoder 或无 endpoint 的 OpenCode profile 保留原标签并显式报错。

### 恢复时的连续性

记录在旧 runtime 下的 pin，只有同时满足以下条件才视为兼容（`providerPinContinuity.ts`）：用当前
record 在记录的旧 runtime 下重算的 legacy hash 等于记录的 hash；effective 请求 origin 不变；model ID
不变；`analysisContextFingerprint` 不变。兼容时 pin 重新绑定到新 hash，并记录连续性说明（对话描述的
`runtimeMigration`，session snapshot 的 `retired_runtime_rebound` 条目）；否则沿用原有的显式结果
（409 或 continuity break）。OpenCode 与 Qoder 引擎已删除；它们记录的 pin 所需的冻结 legacy hash 计算
（`ProviderService.toEnvVars` 与 `providerSnapshot.ts`，不依赖引擎或 SDK）保留一个版本。

模型控制由 `modelExecutionProfile.ts` 区分服务端模型能力、实际 SDK 表达能力及已捕获的用户配置，`modelExecutionPolicy.ts` 决定本轮用途允许的参数。匹配依据是实际 endpoint、model ID 和协议，未知 gateway 或尚未建模的协议保持 unknown；已由原生 SDK 验证的合法配置继续保留。不能根据 provider 名称、请求耗时或模型自述推断能力，也不能静默切换 pinned provider/model。

主分析与普通续写保留原生设置。分类及显式 output-only 交付，只有在服务端与当前 adapter 都支持时才选择最低合法思考设置。例如已知 GLM 5.3 Flash 不能关闭思考，使用 enabled/low；已知 DeepSeek Flash 支持的相应接口可以关闭。用户显式设置优先，已知不合法的设置在派发前返回配置错误，不能作为临时网络错误重试。SDK 不支持或能力未知时不猜参数。

Pi 的 model JSON 可显式设置 `thinkingLevel`（`off/minimal/low/medium/high/xhigh/max`）；installed SDK 不支持的设置会在调用前拒绝，不静默换档。`thinkingLevelMap` 保留 SDK 的原生映射。官方 GLM 未显式设置时不会因 Pi Agent 的默认 off 而自动发送 disabled；已知强制思考模型的显式 off 会被拒绝。缺失的模型温度、工具、成本能力不伪造为已知值，独立轻模型不继承主模型的能力和限制。

`model_execution_fingerprint@1` 独立于既有 provider snapshot，绑定实际模型、接口、有效配置及已知 SDK/adapter 事实；未知版本明确保留 unknown。内部 `policyObservations` 只记录策略选择，固定 `wireObservation: not_observed`，不等于实际派发或服务端执行事实。真实 wire 行为使用维护入口 `test:pi-provider-runtime` 验证；这个本地 fake-provider 合同测试不替代真实模型准确度和时延验收。

`OPENAI_ANALYSIS_REASONING_EFFORT` 可显式配置 OpenAI runtime 的主分析与普通续写，省略时保留服务商默认。它不覆盖分类或超时无工具收尾各自的用途策略。合法性按实际选中的模型、端点、协议与当前 SDK 验证；通用 effort 通过 SDK 原生字段发送，不向未知网关注入 `thinking`。已识别 DeepSeek Chat 的 `none` 映射为关闭思考；强制思考的 GLM 拒绝 `none`。当前 adapter 仅在已识别且支持的 Chat 接口通过透传表达 `max`，未知网关与 Responses 的显式 `max` 暂不支持。配置进入同一隔离环境的 provider snapshot，非法值不进入公开快照。较低 effort 的准确性仍需真实验证。

`server.outputTokens` 只记录有来源的输出参数范围与条件默认值。当前仅为官方 DeepSeek
Chat 的 `deepseek-flash` / `deepseek-v4-pro` 记录 `max_tokens`：参数范围 1–393216，
非思考默认 8192、思考默认 65536、`max` effort 默认 131072；输入与输出仍受总上下文约束。
其他模型、协议及网关保持 unknown。文档默认值不填入未配置的 `effective.maxOutputTokens`，
也不自动改变请求、预算或既有 provider snapshot。显式 `OPENAI_MAX_OUTPUT_TOKENS` 仍由现有
SDK 路径发送；实际请求、原生终态和使用量须分别观测，不能仅由输出数量推断截断原因。
事实来源见 [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)。

所有 runtime 都交付模型的普通 assistant 回答（`assistant_text`）：没有模型编写的声明
sidecar、typed 最终提交或最终文档工具。`SMARTPERFETTO_FINAL_SUBMISSION` 与
`SMARTPERFETTO_CONCLUSION_AUTHORING` 已退役；环境中残留的值只在进程内告警一次并被忽略，
不会让运行失败。历史 manifest 与回执仍可能带有旧模式标签或 `declarationSyntax`，按原样读取。
模型若仍写出声明，finalizer 会把它从正文中剥离且不保存。

内部性能观察区分实际 main、分类和续写派发，记录原生结束、工具排空、候选选择与
finalizer 的对应关系；最终复核记为 `not_required`。配置承诺、实际发送参数和服务端明确返回的模型身份分别保存，缺失
事实保持 unknown。请求的 normalized JSON 字节数与原始 wire body 大小分别计量。运输
对照须使用同源观察器、固定配置和逐样本质量门，并计入完整工具 schema 与提示词成本。
不完整或不可比的样本给出 inconclusive。

## M10 独立反馈 triage

Agent 辅助 GitHub 反馈不是主分析 session 的 resume。分析完成时，新 RunManifest 可保存
`providerSnapshotHash`；用户点击反馈 CTA 后，后端重新解析持久化源 run，并要求当前可用
provider snapshot 与该 hash 完全一致。它不会读取后来切换的 active provider，也不会
回退到另一个 runtime。

Claude/Anthropic-compatible 源 run 通过无工具 Claude SDK 调用执行 triage；
OpenAI/OpenAI-compatible 源 run 通过轻量 Chat Completions 调用执行。两者都只接收有界的
公开 source context，不共享主分析 SDK session。Pi Agent Core、记录在已删除的 Qoder runtime
下的 run、旧 manifest、凭据不可用、snapshot 漂移或非法模型输出在 V1 中使用明确的确定性 fallback，
不会伪装成同一 Agent 已复核。完整用户边界见
[Agent 辅助 GitHub 反馈](../getting-started/agent-assisted-feedback.md)。

## 关键文件

| 文件 | 责任 |
|---|---|
| `backend/src/agentRuntime/runtimeSelection.ts` | runtime 选择与统一 orchestrator factory |
| `backend/src/agentRuntime/runtimeKinds.ts` | production runtime kind 与当前注册集合 |
| `backend/src/agentRuntime/runtimeDescriptors.ts` | runtime descriptor、`EngineCapabilities` 和 canonical loader |
| `backend/src/agentRuntime/engines/claude/claudeRuntime.ts` | Claude Agent SDK orchestrator |
| `backend/src/agentRuntime/engines/openai/openAiRuntime.ts` | OpenAI Agents SDK orchestrator |
| `backend/src/agentRuntime/engines/openai/openAiToolAdapter.ts` | shared MCP descriptor 到 OpenAI function tool 的适配 |
| `backend/src/agentRuntime/engines/pi/piAgentCoreRuntime.ts` | Pi Agent Core runtime adapter |
| `backend/src/agentRuntime/runtimeExecutionGuard.ts` | runtime/session 单活执行、取消与 stale settle 隔离 |
| `backend/src/agentRuntime/analysisTurnIntent.ts`, `runtimeTurnPolicy.ts` | 各原生引擎共享的 typed intent、预算、范围和证据访问策略 |
| `backend/src/agentRuntime/analysisFinalizationContext.ts`, `runtimeEvidenceContext.ts` | 私有 finalization 上下文、原 deadline、受授权的原始证据读取及跨轮 lease |
| `backend/src/services/providerManager/modelExecutionProfile.ts`, `backend/src/agentRuntime/modelExecutionPolicy.ts` | 实际模型与 SDK 能力、独立执行指纹、按用途选择合法模型参数 |
| `backend/src/agentRuntime/runtimeTaskDeadline.ts` | 单轮内部 admission 身份与显式工作期限；不替代用户取消或授权 |
| `backend/src/agentRuntime/runtimeCandidateAdmission.ts` | 维护者控制的并发候选准入边界 |
| `backend/src/agentRuntime/runtimePerformance.ts` | RunManifest 内部阶段、工具与 SQL 排队/执行耗时 receipt |
| `backend/src/agentRuntime/runtimeActivity.ts`, `runtimePerformanceContext.ts` | 有界调用与采集活动、私有运行归属及迟到回调隔离 |
| `backend/src/agentRuntime/runtimeToolResultAudit.ts` | RunManifest 内部工具结果交接 receipt：每次调用交给 runtime 的文本规模与受审计字段是否逐字可见 |
| `backend/src/agentRuntime/runtimeToolConcurrency.ts` | request-scoped 公平读写调度与默认独占策略 |
| `backend/src/agentv3/claudeMcpServer.ts` | SmartPerfetto 工具注册，仍是工具单一事实源 |
| `backend/src/agentv3/mcpToolRegistry.ts` | 工具 descriptor、exposure level 和 allowlist 单一事实源 |
| `backend/src/services/canonicalAnalysisResult.ts`, `finalizeAnalysisResult.ts` | canonical 正文（剥离模型残留声明）与产品层唯一异步 finalizer |
| `backend/src/services/finalResultQualityGate.ts`, `evidence/evidenceReadView.ts` | 交付保证（完成状态、对比身份、源码引用）与原始采集读取 |
| `backend/src/services/providerManager/` | Provider 配置、runtime/protocol/env 映射 |
| `backend/src/agentv3/sessionStateSnapshot.ts` | 统一会话快照：各 runtime 的 provider 钉定、产品状态，以及各 engine 自己的 `engineState` |
| `backend/src/services/externalIssueReporting/providerPin.ts` | M10 源 run provider snapshot 校验 |
| `backend/src/services/externalIssueReporting/triageRunner.ts` | M10 无工具 Agent triage 与确定性 fallback |

`backend/src/agentOpenAI/` 以及 `agentv3/claudeRuntime.ts` 等具体文件继续提供
旧 import path 的 compatibility re-export；`agentv3/` 目录内的 MCP、strategy、
planning 仍是 canonical shared layers；共享的结构化交付诊断
（`agentRuntime/runtimeConclusionVerifier.ts`）只由 runtime 经 `agentRuntime/runtimeDraftDiagnostics.ts`
读取，用来决定本轮是否做同轮修正；终态统一交给 finalizer。

## 工具层

SmartPerfetto 的分析能力由 `createClaudeMcpServer()` 实现，并通过 `McpToolRegistry` 描述和筛选。工具面按真实 request scope、artifact store、codebase permission、referenceTraceId、comparison context 和 evidence access 生成。预算模式不授予权限，也不自动缩减已授权工具；`existing_only` 严格禁止新采集。

注册表只保存与 SDK 无关的共享工具规格（`agentRuntime/runtimeToolSpec.ts`，结果和注解采用 MCP `CallToolResult` / `ToolAnnotations` 形状）；Claude runtime 在自身 engine 内（`engines/claude/claudeSdkTools.ts`）把它们适配为 in-process MCP server。

`list_skills(metricId, offset)` 可从本轮固定的 Skill 定义与 SQL fragments 发现对应指标的真实生产者、输入、身份选择器和范围限制。发现不执行工具，也不签发证据；raw SQL 列名或模型正文不能替代私有 producer binding。未知指标返回未找到，不能静默退回整个目录。

OpenAI runtime 不复制工具逻辑，而是读取同一份 `McpToolRegistry`，把每个 tool descriptor 适配为 OpenAI Agents SDK function tool。工具名称保留 `mcp__smartperfetto__*` 前缀，便于 SSE、日志和报告复用现有语义。

当前 production runtime 保持同一个产品合约：输入通过各自 pinned provider 的原生无工具 transport 解析为共享 typed intent，输出交给同一个产品层 finalizer 和报告边界。Claude 使用 in-process MCP、tool allowlist 和可配置 sub-agent，每轮开启新的 SDK session；OpenAI 使用同一工具注册表适配的 function tools，SDK history 只在本轮内用于续写/恢复调用，不写入快照、也不用 `previousResponseId` 跨轮续接；Pi 使用 request-scoped native tools。各 SDK 的调用节奏、流式事件、恢复和成本/超时语义仍有差异。

SQL 工具的 `executionContext` 独立于模型、预算和源码权限。省略或 `working` 使用
当前工作区（包括已加载模块和临时表）；`original_trace` 显式请求本轮原始 Trace 的
受限原生读取。后者不改写 SQL、不自动加载模块，也不在拒绝后换回工作区。它只接受
当前 parser 完整支持的单一原生关系查询，单位与行身份仍来自实际执行回执。

普通分析、CLI 和有 Trace 的 Conversation 在同一 run 租约内持有读取资源到 finalization；
无 Trace 对话不创建处理器。原生读取实例按已授权 Trace 懒创建并复用，当前与对比 Trace
保持各自身份。上下文标签和 Query Review 只描述实际执行，不授予证据权威；历史缺失标签
保持未知。来源、配额、授权或运行状态不足时明确拒绝，取消和撤权继续终止原运行。

## 并发、观测与准入

并发默认 fail closed。一个 runtime/session 同时只允许一个分析执行；工具默认独占，只有显式标记且已准入的可交换只读工具可在同一 request 内重叠。每个 trace processor 实例仍由一个 SQL worker 串行执行查询，因此同一 trace/processor 的 SQL 不会因为工具并发而同时进入 processor；不同 processor/trace 或已准入的纯读准备工作可以重叠。processor 创建与恢复使用 single-flight，取消后旧执行不能覆盖新 session state。

后端把真实阶段、first output、工具调度等待，以及 SQL 排队/执行耗时记录到内部 `RunManifest.performance`。该 `RuntimePerformance` receipt 不进入公开 SSE；公开流也不提供可用于准入的 model、provider snapshot、provider usage 或 performance 字段。它用于内部归因和受控 benchmark，不能单独证明真实 provider 的速度或准确性。

Pi 在每次原生 provider 请求前（包括第一次）经 `prepareRequest` 适配层记录一条有界的 `investigationRequests` receipt：Agent context 的消息/工具数量和近似字符数（`agentContext`，provider 转换前的估算，不同于 fetch 时测得的 `modelRequests[].body` wire 字节）、调查契约要求按 `observed`/`not_observed`/`unknown_no_producer`/`not_applicable` 的计数，以及轮次和截止时间预算；对应的 `modelCalls[].requestIndex` 用于关联 provider usage（含 cache-read）。调查视图只读取 typed intent、钉住的契约、producer ledger 和运行预算，按 run 创建并在收尾时释放；适配层不返回任何请求修改。

第 1 次请求默认在已有的 `investigation_requirements` 段里为每条要求附上 run 开始时的 ledger `acquisition` 状态（`prompt-investigation-acquisition.template.md` 解释取值），`SMARTPERFETTO_INVESTIGATION_ACQUISITION_STATUS=false` 可关闭；ledger 不可读时不附状态。它只是状态，不是催促：不代表义务或结论，语义条件不求值，也不改变 Agent 循环和请求次数。

共享工具交接边界另外记录有界的 `activity`：调用尝试、进入受控执行链、返回、拒绝、
异常和取消，以及完整参数完全相同的重复调用数。参数只参与本轮内存中的随机密钥哈希，
不写入回执；无法完整观察时明确为 `partial/unavailable`，不补零。进入受控执行链不代表
权限检查已通过。自适应路由仅把完整观测的重复数用于 shadow 诊断，不据此停止调查或增加预算。

`captureActivity` 只统计证据存储已接纳的签发 capture 注册，同一 witness 在本轮去重，
来源分为本轮、复用和未知。`rowSlots` 包含不可用表的行槽，不能解释为可用证据量。
累计注册数不因后续淘汰而减少，也不涵盖所有读取或直接复用路径；它不证明证据被使用、
调查覆盖或语义新颖性。没有采集观测与观察到空表保持可区分。

没有 RunManifest 的 Conversation 使用独立的私有运行作用域，复用同一观测器。
SDK 回调即使脱离原异步链也保持本轮绑定；归属冲突会抑制整条调用链的观测，
不修改工具执行、授权或固定 attribution。运行结束后冻结回执，迟到回调不能写入后继运行。
观测失败不改变分析结果，工具和采集计数也不能决定交付完成或核验通过。

SSE 与 session log 里的工具结果会被截断到 2000 字符，截断后看不出模型是否拿到了尾部的 `vendorOverride` 这类提示。为此，内部 `RunManifest.toolResults` 在最外层共享工具边界上记录每次调用交给 runtime 的内容，记录发生在所有产品包装（包括 pacing 提醒）之后、传输截断之前。记录项包括：工具名、调用 id（仅当 adapter 提供时，目前是 OpenAI、Pi）、结果状态、receipt 事实（`planPhaseId` 只记是否存在），以及 adapter 序列化之前的文本规模。对 `RUNTIME_TOOL_RESULT_AUDITED_FIELDS` 中的每个字段，还会记录它的 key 和值是否逐字出现在交接文本里。这份记录不复制任何 payload 的值。它只能证明内容交给了 runtime adapter，runtime 自身的输出上限不在产品视野内。

性能分支由严格的维护者开关 `SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES` 控制；默认没有任何候选获准。值只能是无空白、无重复的 `task4` 到 `task7` 逗号列表（随 OpenCode、Qoder 引擎删除的 `task8`、`task9` 已是未知项），任意空白、未知项、重复项或格式错误都会让整项 fail closed。它不是 Provider Manager、UI 或 provider env，也不会从 benchmark artifact 自动激活：

| 候选 | 范围 |
|---|---|
| `task4` | 各 runtime 复用一次 quick evidence/focus 预取结果 |
| `task5` | 各 runtime 的显式可交换只读工具使用有界公平并发；其余工具仍独占 |
| `task6` | Claude/OpenAI 的独立 preflight DAG 重叠 |
| `task7` | Pi 并发加载独立 SDK/provider，并在 quick 模式启用 parallel batch 调度；descriptor/tool gate 仍串行独占工作 |

`task5` 获准后默认启用其安全只读策略；`SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false` 只是回滚到独占执行，不能在缺少 `task5` 准入时绕过边界。缓存 single-flight、执行隔离、取消清理、receipt 和确定性修复属于 correctness/observability 基础能力，不依赖性能候选开关。

当前发布默认仍是串行策略：各真实 adapter 的确定性准入 harness 为 `NOT CONFIGURED`，真实 provider 的有界 base/candidate A/B 尚未执行，因此速度/准确性准入结论是 `INCONCLUSIVE`。合成 scorer 只能验证计分器机械逻辑，不能批准候选默认开启。真实 provider 不可用时必须分别记录 `NOT AVAILABLE` 或 `NOT CONFIGURED`。单元测试、typecheck、build 和确定性 gate 都不能替代真实 provider 结果。

## 源码分析的 Runtime 一致性

各 production runtime 不各自实现一套源码规则。它们共用 strategy asset 中的
source-use prompt 和同一 MCP registry/handler 产生的实际 `SourceUseDecisionV1`。
运行时把真实 source-use 状态附给产品层 finalizer；没有当前 run accessor 时，模型自己
编写的源码决策/绑定不会成为已执行事实。`pending` 或 `attempted` 本身不强制整轮失败，
真实检索、同意和引用失败仍按各自合约报告。

已授权源码按问题需要访问；fast/full 不自动插入 lookup、固定计划或额外源码 pass。
`existing_only` 不能用源码或 RAG 工具补采集。Trace capture 支撑所引用的观测，源码证据
提供机制分析背景，`CodeRef` 元数据本身只负责定位。`SourceUseDecision.status` 的
`corroborated` 只记录本轮获准取得正文及引用的 lookup 审计，不证明 Trace 发生、机制或
因果关系。

新回答不携带模型编写的 claim 或源码绑定。共享 finalizer 的 `source_claim_verifier@2`
只做引用检查：正文写出的每个源码位置都与本轮签发的引用比对。没有源码访问权限，或有权限
但正文没有写出源码引用时，源码保证为 `not_applicable`（`Foo.java:N` 这类公开 AOSP 帧很常见）；
全部匹配为 `passed`；任一引用未匹配或有歧义时记为提示性的 `coverage_incomplete`。这是质量
标注而非隐私控制，隐私仍由 `sanitizeCodeAwareText` 与私有投影保证。任何检查都不能把一般
机制提升为已证明，检索审计状态也不能替代证据。已保存的结果保留历史的逐 claim 状态
（`trace_linked`、`source_only` 等），按原样展示。

路由层使用一个 canonical safe projector 把同一份决策/绑定送到初始与重放 SSE、
HTML report、CLI JSON/Markdown/HTML、analysis-result snapshot 和报告/snapshot API。Web chat 再缩减
为不含 `CodeRef` 的当前 run 回执。这些路径都不保留绝对 root、snippet、检索 query 或
模型自由文本 binding reason。

确定性 runtime 执行/终态 gate 与 A0–A4 语义 gate 证明产品契约，不证明真实
provider 的模型质量。真实 Claude、OpenAI 和 Pi 必须在凭证可用时分别重复验收；
不可用必须标记 `REAL PROVIDER NOT AVAILABLE`，不能被单测或确定性 fixture 替代。

## 分析模式

| 模式 | 行为 |
|---|---|
| `fast` | 固定 quick budget，保留该请求已授权的工具与共享 finalization |
| `full` | 固定 full budget，不自动要求完整报告、计划或额外源码查询 |
| `auto` | 使用统一 typed intent 的复杂度建议；不可用时使用明确 fallback，不按关键词猜测 |

typed intent 分开声明 task kind、scene、scope、复杂度建议、deliverable 和 evidence access，
scene 必须属于本 run 固定的 registry。声明通过 schema 校验不等于语义正确，更不扩大
请求权限。`existing_only` 只读已保留证据；`read_new` 仍受授权限制。bounded/unavailable
`RuntimeTurnPolicy.preflight` 分三档，与预算档无关：`existing_only` 为 `none`，什么都不取；
已解析的 `scene_wide` 读取为 `full`，额外预取记忆类上下文（知识库、模式、案例、SQL 修复对）；
bounded 问题和 unavailable 分类为 `trace_facts`，仍然检测焦点应用、架构和 trace 完整性——
问题再窄，也是针对一份模型没见过的 trace 提出的。没有挂载 trace 的 Conversation 不做任何探测，也不绑定 trace
身份或证据 trace（`resolveRunTurnPolicy`、`runtimeTraceAttachment.ts`，各 runtime 共用）。厂商不是预检阶段：`invoke_skill` 只在 Skill 有厂商
override 时、在其自身查询完成后，经共享缓存的 `traceVendorResolver`（只读 trace metadata）
有上限地等待解析结果，并挂上 `vendorOverride` 提示；各 runtime 规则相同。
焦点应用检测在分析窗口内对候选进程统一打分（前台时长、帧、启动、battery top、CPU），没有任何活动的进程
直接排除，并给出 `high`/`medium`/`ambiguous` 置信度。各 runtime 共用 `focusAppTarget` 决定生效包名：
用户指定为 `user`，high/medium 推断为 `auto_detected`，ambiguous 不设包名，只给候选。只有 `user` 包名和选区
约束分析目标；推断包名只作为 Skill 的默认范围（结果中的 `appliedDefaultProcess` 会注明），不作为对比身份门禁的
期望值；答案说明理由后可以改看有证据的候选。

**场景入口证据（产品采集）。** 策略 frontmatter 可声明 `entry_skill`（Skill id + 闭合参数绑定：
`focus_app`/`user_target`/`trace_start`/`trace_end`/`selection_start`/`selection_end`）。已解析的
`scene_wide`、`read_new` investigation（须挂载 trace；不含 comparison 回合或带参考 trace 的运行）在各 runtime 的预检中、构造带取证工具的
MCP server 之前，由产品运行该 Skill（`agentRuntime/sceneEntryEvidence.ts`）：包名绑定只接受用户包名或
high/medium 焦点，并须经 Skill 自身的身份门（`prepareInvocation`）`verified` 才运行，`ambiguous` 时只把候选
写进提示。它与模型的 `invoke_skill` 共用核心层 `agentv3/skillRunCore.ts`，同参数产生同样的 evidenceRefId、
artifact、capture 与 queryReview；但它不是模型工具调用：不进 RunManifest `toolResults`、registry 工具观察、
取证节奏、工具计时或计划调用记录。守卫按序为请求 scope、`canInvokeTool`、lease/截止时间、只做授权检查的
`withRunAuthorizationOnly`、以及核心层在 Skill 返回后、写入前的复查；单次 20 s 上限。capture 经产品 call id
`scene-entry:<skill>:<hash>` 与 started/completed|failed 观察进入调查账本。结果以 tier 2 不可整体丢弃的
`scene_evidence` 段给模型（≤24 单元格、≤2 KiB，超限先丢 summary 再丢 key 单元格），并记入
`RuntimePerformance` 的 `scene_evidence` 阶段与闭合回执 `sceneEvidence`。`allowMemoryPrefetch` 只控制记忆层预取，
与入口证据无关。

策略可在 `entry_skill` 下声明 `evidence_first`（`scopes: [bounded_question]`、`when_target_absent: omit`）。只有 Pi 在 `SMARTPERFETTO_EVIDENCE_FIRST` 开启时读取它，默认关闭。开启后，声明了该 scope 的场景对无选区的 `bounded_question` investigation 也运行入口 Skill（`fact` 问题和带选区的问题不运行），并使用不含“展开分析”指引的 `prompt-scene-evidence-bounded` 模板，`scope` 决定运行哪些采集，不扩大回答范围。`when_target_absent: omit` 只允许用于进程选择器可选的 Skill：目标未解析时跨全部进程运行并在段内标记 `targetScope: all_processes`；用户指定过进程时不会退化为全部进程。其余守卫不变。
字符串单元格若被上游截短，就不作为精确值交给模型；artifact 定位仍可用于读取原始证据。

Pi 运行时另外按运行创建 Skill 结果注释记忆，并让执行器产出规则事实（`agentv3/skillResultSemanticNotes.ts`，
`SMARTPERFETTO_SKILL_RESULT_FACTS` 设为关闭值时关闭），隐藏的回退运行时两者都没有：`invoke_skill` 的两条返回路径、
`fetch_artifact` 和 `scene_evidence` 段带 producer 的 `resultNotes`（列含义、`row_semantics`、调查指标的
聚合/覆盖/分母声明；每个 `skillId.stepId.column` 每次运行只说一次，每个结果最多 24 列），以及命中诊断规则的
`facts`（`ruleId`、带源列单位的绑定值、结果定位，不含严重度、诊断或建议文本，≤2 KiB）。`scene_evidence` 超限时先丢
summary 单元格，再丢 `resultNotes`、key 单元格和 `facts`；未送达的注释留给后续结果。`facts` 只从运行已写的
`_diagnostics` 诊断投影；事实不是证据授权。

**当前选区的最低取证。** 已解析的 `bounded_question`、`read_new` investigation 还必须明确
`targetUse=current_selection`，才可进入 `selectedEvidenceFoundation.ts`。UI 只在真实 renderer 的
`rootTableName` 为 `slice` 时发送 `nativeTable: 'slice'`；后端重查同一 trace 的原生行及时间窗，
并按原身份门核对精确 UTID/UPID。显式用户 selector 未被验证时不登记 capture。profile 的可选
`entry_acquisition` 声明一个最低 metric 和四个精确参数绑定；产品只运行 pinned registry 中唯一安全的
root producer，不按 Skill 名称选择。缺省或不明 target-use、旧客户端缺表提示、其他选择类型、另一目标、
existing-only 和双 trace 均不启用此路径。

各 runtime 在通用焦点、架构和完整性预取之前完成该采集：先从同一 processor 的原始响应签发
native witness，再运行身份门与最低 metric，避免预取加载模块后失去原生证据资格。已不可信的 processor
不会因此恢复资格。早期采集与后续模型工具、finalizer 复用本轮同一个 evidence store、executor 和
pinned registry；失败或不可用结果也只处理一次。后续预检失败不删除或重新归属已合法提交的捕获，
整体运行仍按实际失败状态结束。

原生 capture 与 metric 执行使用两个独立状态轴，`captured`/`committed` 不表示证据完整或断言 verified。
合法的 native capture 可在后续 metric 失败时保留；所有工作共用原截止时间内至多 20 s 的采集预算，
取消后等待已启动工作收尾，不能再开始采集或提交。提示仍受同一 24 单元格/2 KiB 预算约束，保留定位符和缺口；
数值仍以 Skill 结果和生产者单位为准，finalizer 不重新推导。

工具结果中的 `modelEvidence` 仅反馈完整 backing capture 的行可用性、可信列单位是否存在、私有注册 metric
binding 是否存在；分页空页不等于空 capture，binding 存在不表示 metric 已观测。恢复数据不会重建这些权限或 witness。
完整性探测在检查 stdlib 视图前先加载其定义模块（能力定义静态声明 `requiredModules`，并由测试守住）；
模块加载失败或查询未完成的能力带 `reasonCode`，表示“未探测”，不是“缺失”。计划按需产生，阶段完成标记必须有真实成功证据或明确处置。
未结束的探索计划和假设保留原状态，不自动触发续跑，也不单独决定回答是否完整。

## 轮次预算与收尾

HTTP、CLI、conversation 与直接 runtime 调用共用私有 `RuntimeAdmission` 身份。预算从本轮获准开始处理时计算，包含分类与准备阶段，不能在进入 native SDK 时重新起算。显式任务上限、工作停止信号与用户取消/授权保持分离；未配置显式上限时不增加配置解析前的硬定时器。已开始的准备查询可以排空。超时保留已完成候选，guard 等待真实 native 工作、工具与清理结束后才释放，迟到结果不能影响后继 run。

完整模式默认 100 轮，快速模式默认 50 轮；5 轮 quick target 仅为软目标。
总预算大于 1 时预留一次无工具交付。原生 `length/output_limit` 表示单次输出未写完，可在原始
预算和截止时间内使用这一次预留额度补齐完整正文；已完成但没有回答正文的候选可用它做一次
空正文续写；已完成候选的结构化交付诊断报告可修正缺口时，可用它做一次同轮修正。只有新候选
获得自身 completed/stop 记录后才接受；失败、取消、未知、pending tool/deferred 状态不能据此
续写，续写失败保留原始未完成凭据；acknowledgement 不额外调用模型。补齐期间关闭工具且不重复
推送正文。回答不带声明，因此不存在声明补交或声明修复调用。调查触顶后，
收尾使用本轮固定的模型、Provider、授权与原始截止时间，基于已返回数据和已有正文
说明有限结论、证据不足及下一轮可追问的问题。它不会继续查询，也不会把调查升级为
完成；`partial`、`completion.reason=turn_limit` 和 `terminationReason=max_turns` 保留。
收尾之后不再追加复核调用。

共享正文扫描器对规范 marker 保持常量状态。对于列首、独占行的其他 `smartperfetto:` 注释，最多暂存 64 KiB；独占闭合行内含唯一完整 `conclusion_contract_v1` JSON 对象时视为模型残留的声明，从正文剥离且不保存。这个识别缓冲不增加原生输出额度，也不接受 marker 别名。普通说明、conversation-control、引用/代码示例、嵌套、截断或超出缓冲的注释仍原样保留；流式和最终解析使用同一语法。

OpenAI 的采集截止时间可随实际进展延后，但不侵占预留交付和 finalization 预算；
采集超时且已有返回数据时可在交付预算内做一次无工具收尾，结果保留 `partial/timeout`，
不追加复核调用。收尾失败时保留原候选；取消、硬 deadline 到期、授权失效
或已耗尽的显式费用预算不会启动额外调用。
只有 1 轮的配置没有额外收尾额度。

收尾和续写调用在派发前通过 `services/runtimeCallStats.ts` 估计所需时长，
按 provider origin、model、purpose 和输入大小档使用成功调用的 p75；样本不足时采用
当前提供方默认值（GLM 180 s、DeepSeek 120 s、其他 90 s）。剩余时间不足时跳过调用并
保留正文。报告交付和缺少正文时的续写仍可
派发，由原截止时间约束；估计不能延长 deadline 或绕过取消、授权和费用限制。
服务端从 sealed RunManifest 的成功调用生成本机时长样本；CLI 不汇总样本，使用默认值，
回执注明 `stats_not_configured`。准入决策和实际调用时长是内部性能记录，不是证明或公开 SSE。

## SSE 事件

所有 runtime 都向路由层发同一类 SmartPerfetto streaming update：

| Event | 含义 |
|---|---|
| `progress` | 阶段变化 |
| `thought` | 中间推理或阶段提示 |
| `agent_task_dispatched` | 工具调用开始 |
| `agent_response` | 工具结果 |
| `answer_token` | 最终答案 token |
| `conclusion` | 已 finalization 并按 owner 投影的回答正文，先于报告和快照生成发出 |
| `analysis_completed` | 产品 finalization 后的终态元数据与实际报告结果 |
| `error` | 错误 |

`analysis_completed` 由产品层在 finalization 和报告处理后发出。native completion、
交付保证和报告生成各自保留状态；报告失败不能被成功的聊天投影掩盖。当前后端不再发出
临时答案、`provisional_answer`、`review_stop_requested` 或 `final_review` 进度。

Pi Agent Core 的真实模型路径复用 SmartPerfetto 的 scene strategy、系统 prompt、SQL/Skill、plan/hypothesis、artifact、route-owned quality/finalization/report 管线。它不会把 SmartPerfetto 运行时变成 Pi coding-agent harness，也不读取 `.pi` 项目配置、package extension、shell tool 或 file tool。`custom` provider 需要显式 Pi model JSON 或等价 env。GLM、DeepSeek、Kimi、Kimi Code、MiniMax 在未填写 model JSON 时由 Provider Manager 生成 catalog reference：`{catalog: {providers, id, baseUrl, defaultThinkingLevel: 'lowest_supported'}, apiKeyEnv}`，模型能力取自已安装 pi-ai 的内置目录（不联网刷新、不伪造），endpoint 沿用 provider 自己的配置，key 只写入 Pi 的 key env；未显式设置时 reasoning 取该模型支持的 off/minimal/low 中最低一档。GLM、DeepSeek 新建模板默认 Pi；已保存的 provider 和未写 runtime 的 API 记录不迁移。快照固定 key env 和已安装 pi-ai 版本。`SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1` 只用于本地 smoke/test，输出必须继续标记为 capability-limited。

## Final Result 与质量产物

所有 runtime 返回原始 `AnalysisResult`，并私下附带同一 run 的 finalization context：

```text
exact runtime result + private RuntimeFinalizationContext
  -> product-owned finalizeAnalysisResult (once, no model call)
  -> canonical body (a stray model declaration is stripped, never stored)
  -> identity resolution from the run's own data envelopes / source citation check
  -> delivery assurance: completion / identity / source
  -> HTML report / CLI turn files / analysis-result snapshot
  -> frontend visible projection
```

数据准确性来自 Skill 与 SQL。回答是根据本轮工具和 Skill 结果写出的普通文本，由共享的
tier-1 `answer_guidance` prompt 段约束：不超出问题范围；判定“异常”必须给出指标、范围和阈值；
核对单位换算；缺失数据按未知处理；优先采用 Skill 给出的单位和汇总值，而不是从原始行重新推算。
finalizer 不逐个核验数字或句子；数值错误应在数据获取（Skill、SQL 或生产者单位）层面修复。

runtime 在结果和写入会话的轮次上只记录原生事实（完成状态、轮次上限、超时、provider 失败、
取消、空正文、隐私替换），不调用质量闸门、不写 `quality_gate_failed`、不发草稿阶段的
`degraded`；finalizer 仅因空正文或真实原生交付失败写入质量终止状态，路由与 CLI
随后回写已记录的轮次。

新的 finalization 这样记录 `deliveryAssurance`：`completion`（原生完成事实）与 `identity`
（双 Trace 对比身份）继续检查；`source` 是[源码分析的 Runtime 一致性](#源码分析的-runtime-一致性)
中描述的引用检查标注；`claims`、`report`、`investigation` 和 `investigationEvidence` 没有检查
机制，记为 `not_applicable`。调查证据账本仍会记录，仅供展示。新结果不携带
`claimVerificationResult` 或 `claimSupport`，内部性能回执把最终复核记为 `not_required`。
这些标注不会使已完成正文变为 partial，也不降低发现置信度。Web 对这类运行不显示“核验未完成”
提示；CLI 在 completion 通过时显示 `✓`，只有某个保证维度为 `failed` 或 `coverage_incomplete`
时才显示 `~`。

产品必须在复制结果前从 exact result 取出 context。context 固定 provider、原始绝对
deadline、trace identity 和证据读取范围；产品 owner 在 await 前后检查当前 run、取消和
授权，用户取消或释放 context 会中止 finalization 的证据读取。改变已检查输入的隐私投影把
`passed` 降为 `not_checked`，`not_applicable` 保持不变。

`final_report_contract` 仍来自固定 registry 的 strategy frontmatter。`runtimeConclusionVerifier`
只提供结构化交付诊断，不再运行独立语义 LLM 或按误诊词匹配正文；runtime 只用它决定同轮
修正。报告、CLI 和 snapshot 保留 provenance；chat 分开投影正文和结构化 runtime appendix，
不能机械删改自然语言结论。

Skill 的字面 `display.columns[].unit` 经过同一列类型/单位校验后，随定义指纹和实际 SQL
哈希进入捕获；作者校验、运行清洗与 DataEnvelope 不得只保留时间单位。单位目录位于
`utils/claimUnits.ts`，number 列支持其封闭数量维度；percentage/bytes 限相应维度，timestamp/duration 仅接受时间单位。
帧率 `fps` 与 `frames/s` 等价，但与 Hz、帧数互不换算。显示格式、列名及模型正文不能
提供单位权威。原生 SQL 仅在已固定的正式 schema、单关系只读语句及受支持表达式
同时成立时签发数量单位：COUNT 为 count，duration 聚合、时间点差与明确时间缩放
保留相应单位；规则指纹绑定实际 SQL、schema 和 processor epoch。表达式不签发
原生行身份或 clock；未知关系、复杂查询与无单位字段仍保持未知。

结论呈现保留全部正文，不按标题删除段落。Web 将服务器交付详情作为独立消息字段，绑定
候选身份；替换正文时清除旧详情，元数据回填只更新本轮消息中相同候选的记录。CLI 使用
绑定会话、回合和正文的独立呈现文件。这些显示数据不能重新签发 witness、提升保证状态或
参与授权恢复。

历史结果按原样读取：已保存的声明、claim 核验结论、数值呈现结果和逐 claim 源码引用仍在报告、
CLI 产物和 snapshot 中展示。结果没有 claim 核验时，HTML 报告不显示该区块。

## Session 与恢复

统一快照由 route 层调用 `orchestrator.takeSnapshot()` 生成，恢复时调用 `restoreFromSnapshot()`。

每个逻辑追问使用新的模型上下文，保持逻辑 session 与 Provider/runtime 绑定。
原生 SDK 上下文只在本轮调查内部使用，不通过旧 SDK session、`previousResponseId`
或 opaque transcript 隐式带入整段前史。

`analysisHistory.ts` 为分类器和主分析提供同一套有界历史：最近 3 轮问答、最近未完成项和
更早轮次索引，明确保留 partial/unknown、终止原因、不足和下一步。最新一轮与最近
未完成轮分别保留，不能为旧未完成事项挤掉最新回答。默认主分析预览最多 12,000 bytes、
分类器 6,000 bytes，按包含模板的实际 UTF-8 字节测量；详细正文和导航优先让位于身份、
完成状态与未完成项。遗漏计数由最终投影重算，区分未提供详细预览与连索引也未列出的轮次。
极小预算先退化为合法续读索引；连完整身份都放不下时，返回安全的预算错误，不把非空历史
伪装为空历史，也不增加模型调用。`relatedTurnIds` 只在同 Trace、同授权分区且完整定位符
精确相同时提供有限导航，不能依据同名 artifact、相同问题或源码路径推断关联，更不签发证明。
`read_session_history` 只读取产品绑定的当前会话，可按轮分页回查完整问答与声明定位；
它不接受用户/会话选择器，也不执行新 SQL。`fetch_artifact` 仍负责读取可用的原始表格。

完整历史复用 `conversation_turns` 保存；Conversation descriptor 与最终轮记录在
同一事务中写入 `runtime_snapshots` 和历史表。重开/重启后，先验证 tenant、workspace、
当前 owner、Trace、Provider pin 和来源权限，再恢复逻辑会话。旧 running 状态恢复为
interrupted，不重放不存在的执行。写入失败保留回答并报告恢复不可用。
来源派生历史必须匹配原轮授权指纹；缺失或变化时不再次发送给模型。历史记录和定位符
不恢复当前执行 witness，也不自动扩大本轮时间选区或证明范围。

快照还会携带 final result 质量相关字段，例如交付保证、identity resolutions，以及历史结果中的 conclusion contract 和 claim verification result，以便 resume、report export 和 analysis-result comparison 复用。

历史 GET、报告和 snapshot 重放只读取/投影已有状态，不新执行 finalizer 或
签发证据证明；正常访问授权仍生效。恢复的显示行不能重建进程内的原始 witness。

Conversation 的逻辑 session 保留精确 trace pair、授权指纹和 tenant/workspace/user
下的内存 artifact/capture；每轮物理 session/run ID 唯一。签发 binding 通过内部 options
传递，JSON 不能伪造，缺 binding 也不能回退到缓存的受控 store。模型只得到有界 locator
目录，可据此读取已有 artifact；目录本身没有 rows、覆盖或证明权。finalization 固定已
接纳的 capture 集合，结束后释放本轮 lease 并清理物理 session。范围变化/销毁撤销 context，
迟到事件按生产 run 隔离，旧取消和 cleanup 不影响下一轮。

`ConversationPendingContext` 独立管理下一次用户提问的进程内补充队列。状态查询只读
运行事实；补充不改变正在执行的请求、不进入动态历史，也不自动启动下一轮。下一轮先
冻结同一份 effective query，成功持久化启动记录并复核权限后才消费队列；分类、分析和
finalization 使用同一请求。随机队列代际、精确 run 和有界幂等回执隔离重试与重启。
客户端的非打断操作有独立请求归属，绑定会话实际来源，不能借当前设置悄悄改变旧会话。

`assistantWorkCatalogService.ts` 把既有会话、运行和产物投影为工作概览，不拥有执行状态机。
owner 过滤先于候选组、待处理筛选和分页；注入的 live reader 只提供同 owner 的运行事实。
同毫秒轮次不靠随机 ID 推断顺序，缺少一致的最近轮指针时明确未知；分页锚点不充当运行
证据。共享 `assistantWorkProjection.ts` 区分执行阶段和结果可用性，不改变核验结论。
UI 的详情、下载和显式继续在交付前即时复核 owner/来源归属，不能依赖下一帧重绘才撤销。

Raw trace comparison session 还必须持久化 `referenceTraceId`、`comparisonSource`
和 `comparisonReportSection`。同一个 session 不能从 comparison 降级成 single-trace，
也不能静默切到另一个 reference trace；恢复时 provider/runtime identity 必须按
comparison identity 读写。

## 发布与平台边界

- 源码和 npm CLI 要求 Node.js `>=24 <25`。
- 免安装包自带 Node.js 24、后端、预构建 `frontend/` 和固定 trace processor。
- Docker 不读取宿主机 Claude Code 登录态，必须用 Provider Manager 或 env provider。
- typed intent、answer guidance 及 Conversation evidence context 模板都是运行资产。
  变更后必须复核现有 public Skill export、npm CLI 与 Docker/portable 的 bundled 路径，
  防止源码可用但分发缺模板；文档描述不代替这些门禁的实际结果。
- 任何 runtime/provider/session 改动都要检查 Web UI、CLI、API、报告、Docker 和免安装包；详见 [`../../.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md)。

## 健康检查

带鉴权的 `GET /api/runtime-health` 中，`aiEngine.runtime` 会显示实际选择的 runtime；公开 `GET /health` 只返回存活状态与版本：

```json
{
  "aiEngine": {
    "runtime": "openai-agents-sdk",
    "providerMode": "openai_responses",
    "diagnostics": {
      "protocol": "responses",
      "model": "gpt-5.4-mini"
    }
  }
}
```

这能区分“Provider 连接测试通过”和“真实分析 runtime 已切换”这两件事。

## 系统调查的采集与交付边界

场景调查要求与报告格式要求分开固定，普通 answer 与 comparison 也可需要系统调查。统一工具 observer 与原始执行 capture 提供可信采集记录；工具名称、模型自述和截断后的摘要不能证明维度已检查。observer 失败不改变工具自身结果，缺记录保持 unknown / not_checked。

调查义务用于指导采集，finalizer 不再据此判定回答覆盖。新的 finalization 把 `investigation` 与 `investigationEvidence` 保证记为 `not_applicable`，采集账本仅供展示。覆盖缺口不会重写结论、触发补查循环或改变 SDK 原生 completion。历史快照只作为历史记录，不重新签发当前运行的证据权威。
