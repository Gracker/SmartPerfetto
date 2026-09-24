# Agent Runtime 架构

[English](agent-runtime.en.md) | [中文](agent-runtime.md)

<!-- i18n-headings: paired -->

SmartPerfetto 后端现在把“模型 SDK”与“Perfetto 分析能力”分层。HTTP/CLI 会话层只依赖统一的 `IOrchestrator` 合约；具体运行时由 Provider 或 env 选择：

| Runtime | SDK | Provider 类型 | 说明 |
|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic、Bedrock、Vertex、DeepSeek、Anthropic-compatible gateway | 默认运行时，需要显式 provider/env 凭据，支持 MCP server 和可配置 sub-agent，复用共享终态与验证合约 |
| `openai-agents-sdk` | OpenAI Agents SDK | OpenAI、Ollama、OpenAI-compatible gateway | 原生 OpenAI runtime，通过 function tools 复用同一套 SmartPerfetto 工具 |
| `pi-agent-core` | Pi Agent Core | custom only | 可选 public runtime；真实模型配置下复用 SmartPerfetto 共享 prompt/tool/report 管线，fake-stream 仅用于 smoke；不启用 `.pi` discovery、package extension、shell/file tools |
| `opencode` | OpenCode server / SDK | custom only | 可选 public runtime；使用显式 OpenAI-compatible 或 OpenCode model 配置、request-scoped SmartPerfetto MCP 工具和加固隔离的 OpenCode server；不读取本地 OpenCode 登录态/project state，也不启用内建 file/shell/web/edit tools |
| `qoder-agent-sdk` | Qoder Agent SDK / `qodercli` | custom only 或 env | 可选 public runtime；SDK 是 opt-in optional peer，使用本机 Qoder CLI 登录态或 PAT，只暴露 request-scoped SmartPerfetto MCP 工具，并隔离私有知识的流式输出、session 和 snapshot |

## 入口

HTTP 主路径：

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> ClaudeRuntime.analyze() | OpenAIRuntime.analyze() | PiAgentCoreRuntime.analyze() | OpenCodeRuntime.analyze() | QoderRuntime.analyze()
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

优先级从高到低：

1. 请求体或会话内的 `providerId`。
2. Provider Manager 当前 active provider。
3. `SMARTPERFETTO_AGENT_RUNTIME` env。
4. 默认 `claude-agent-sdk`。

`SMARTPERFETTO_AGENT_RUNTIME` 只接受 `claude-agent-sdk`、`openai-agents-sdk`、`pi-agent-core`、`opencode` 或 `qoder-agent-sdk`。`deepseek`、`openai` 这类 provider 名称不能写在 runtime env 里；DeepSeek 应通过 Provider Manager 或 Claude/Anthropic-compatible env 配置。

环境变量不会被用来猜运行时。没有 active provider 且未设置 `SMARTPERFETTO_AGENT_RUNTIME` 时，即使同时存在 `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`，默认仍是 `claude-agent-sdk`。Provider Manager 内的 active provider 会优先于 env；双端点 provider 通过 `connection.agentRuntime` 显式决定当前 SDK。

每个分析 session 会固定自己的 credential source：具体 Provider Manager profile，或显式的 env/default fallback。恢复历史 session 时不会重新读取后来切换的 active provider；如果快照绑定的 provider 已被删除，后端会 fail-fast，而不是静默回退到另一个 provider。

Provider 默认映射：

| Provider type | Runtime | Protocol |
|---|---|---|
| `anthropic` / `bedrock` / `vertex` / `deepseek` | `claude-agent-sdk` | Claude/Anthropic |
| `openai` | `openai-agents-sdk` | OpenAI Responses |
| `ollama` | `openai-agents-sdk` | OpenAI-compatible Chat Completions |
| `custom` | 由 `connection.agentRuntime` 或 `connection.openaiProtocol` 决定 | 显式配置；Pi Agent Core、OpenCode 和 Qoder 只允许 custom provider |

Provider connection 支持两套端点字段：

| 字段 | Runtime | 映射到 env |
|---|---|---|
| `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` | `claude-agent-sdk` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` |
| `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` | `openai-agents-sdk` | `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_AGENTS_PROTOCOL` |
| `piAgentCoreModulePath` / `piAgentCoreModelJson` / `piAgentCoreSystemPrompt` | `pi-agent-core` | `SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH` / `SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` / `SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT` |
| `openCodeSdkModulePath` / `openCodeModelJson` / `openCodeSystemPrompt` 加 OpenAI-compatible 端点字段 | `opencode` | `SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH` / `SMARTPERFETTO_OPENCODE_MODEL_JSON` / `SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT`；没有 model JSON 时使用 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` |
| `qoderAccessToken` / `qoderCliPath` / `qoderModel` / `qoderSystemPrompt` | `qoder-agent-sdk` | `QODER_PERSONAL_ACCESS_TOKEN` / `QODERCLI_PATH` / `QODER_MODEL` / `SMARTPERFETTO_QODER_SYSTEM_PROMPT` |
| `baseUrl` / `apiKey` | legacy/shared | 作为旧配置兼容或双协议共享 key |

## M10 独立反馈 triage

Agent 辅助 GitHub 反馈不是主分析 session 的 resume。分析完成时，新 RunManifest 可保存
`providerSnapshotHash`；用户点击反馈 CTA 后，后端重新解析持久化源 run，并要求当前可用
provider snapshot 与该 hash 完全一致。它不会读取后来切换的 active provider，也不会
回退到另一个 runtime。

Claude/Anthropic-compatible 源 run 通过无工具 Claude SDK 调用执行 triage；
OpenAI/OpenAI-compatible 源 run 通过轻量 Chat Completions 调用执行。两者都只接收有界的
公开 source context，不共享主分析 SDK session。Pi Agent Core、OpenCode、Qoder、旧
manifest、凭据不可用、snapshot 漂移或非法模型输出在 V1 中使用明确的确定性 fallback，
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
| `backend/src/agentRuntime/engines/opencode/openCodeRuntime.ts` | OpenCode server/runtime adapter 与 request-scoped MCP bridge |
| `backend/src/agentRuntime/engines/qoder/qoderRuntime.ts` | Qoder Agent SDK adapter、流式投影和 session 隔离 |
| `backend/src/agentRuntime/runtimeExecutionGuard.ts` | runtime/session 单活执行、取消与 stale settle 隔离 |
| `backend/src/agentRuntime/analysisTurnIntent.ts`, `runtimeTurnPolicy.ts` | 五个原生引擎共享的 typed intent、预算、范围和证据访问策略 |
| `backend/src/agentRuntime/analysisFinalizationContext.ts`, `runtimeEvidenceContext.ts` | 私有 finalization 上下文、原 deadline、受授权的原始证据读取及跨轮 lease |
| `backend/src/agentRuntime/runtimeCandidateAdmission.ts` | 维护者控制的并发候选准入边界 |
| `backend/src/agentRuntime/runtimePerformance.ts` | RunManifest 内部阶段、工具与 SQL 排队/执行耗时 receipt |
| `backend/src/agentRuntime/runtimeToolConcurrency.ts` | request-scoped 公平读写调度与默认独占策略 |
| `backend/src/agentv3/claudeMcpServer.ts` | SmartPerfetto 工具注册，仍是工具单一事实源 |
| `backend/src/agentv3/mcpToolRegistry.ts` | 工具 descriptor、exposure level 和 allowlist 单一事实源 |
| `backend/src/services/agentResultNormalizer.ts` | 统一 final result、client projection 和 report data 边界 |
| `backend/src/services/canonicalAnalysisResult.ts`, `finalizeAnalysisResult.ts` | 保留原命题的 canonical 结果与产品层唯一异步 finalizer |
| `backend/src/services/finalSemanticAssessment.ts`, `evidence/evidenceReadView.ts` | 有界无工具语义审核与原始采集读取 |
| `backend/src/services/finalReportContractGate.ts` | 执行 strategy `final_report_contract` 完整性检查 |
| `backend/src/services/providerManager/` | Provider 配置、runtime/protocol/env 映射 |
| `backend/src/agentv3/sessionStateSnapshot.ts` | 统一会话快照，含 Claude/OpenAI SDK 状态和 Pi/OpenCode/Qoder runtime state |
| `backend/src/services/externalIssueReporting/providerPin.ts` | M10 源 run provider snapshot 校验 |
| `backend/src/services/externalIssueReporting/triageRunner.ts` | M10 无工具 Agent triage 与确定性 fallback |

`backend/src/agentOpenAI/` 以及 `agentv3/claudeRuntime.ts` 等具体文件继续提供
旧 import path 的 compatibility re-export；`agentv3/` 目录内的 MCP、strategy、
planning 仍是 canonical shared layers；`claudeVerifier` 的兼容入口指向共享的
结构化交付诊断，内容含义和 claim 支持统一交给 finalizer。

## 工具层

SmartPerfetto 的分析能力由 `createClaudeMcpServer()` 实现，并通过 `McpToolRegistry` 描述和筛选。工具面按真实 request scope、artifact store、codebase permission、referenceTraceId、comparison context 和 evidence access 生成。预算模式不授予权限，也不自动缩减已授权工具；`existing_only` 严格禁止新采集。

Claude runtime 直接把这些工具暴露为 in-process MCP server。

OpenAI runtime 不复制工具逻辑，而是读取同一份 `McpToolRegistry`，把每个 tool descriptor 适配为 OpenAI Agents SDK function tool。工具名称保留 `mcp__smartperfetto__*` 前缀，便于 SSE、日志和报告复用现有语义。

当前 production runtime 保持同一个产品合约：输入通过各自 pinned provider 的原生无工具 transport 解析为共享 typed intent，输出交给同一个产品层 finalizer 和报告边界。Claude 使用 in-process MCP、tool allowlist、SDK session resume 和可配置 sub-agent；OpenAI 使用同一工具注册表适配的 function tools，Responses 通过 `previousResponseId` 恢复，Chat Completions 通过历史消息恢复；Pi 使用 request-scoped native tools；OpenCode 使用每次分析的隔离 server/MCP bridge；Qoder 通过 SDK in-process bridge 复用共享工具。OpenCode/Qoder 的内建文件、shell 等工具隔离规则不变。各 SDK 的调用节奏、流式事件、恢复和成本/超时语义仍有差异。

## 并发、观测与准入

并发默认 fail closed。一个 runtime/session 同时只允许一个分析执行；工具默认独占，只有显式标记且已准入的可交换只读工具可在同一 request 内重叠。每个 trace processor 实例仍由一个 SQL worker 串行执行查询，因此同一 trace/processor 的 SQL 不会因为工具并发而同时进入 processor；不同 processor/trace 或已准入的纯读准备工作可以重叠。processor 创建与恢复使用 single-flight，取消后旧执行不能覆盖新 session state。

后端把真实阶段、first output、工具调度等待，以及 SQL 排队/执行耗时记录到内部 `RunManifest.performance`。该 `RuntimePerformance` receipt 不进入公开 SSE；公开流也不提供可用于准入的 model、provider snapshot、provider usage 或 performance 字段。它用于内部归因和受控 benchmark，不能单独证明真实 provider 的速度或准确性。

性能分支由严格的维护者开关 `SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES` 控制；默认没有任何候选获准。值只能是无空白、无重复的 `task4` 到 `task9` 逗号列表，任意空白、未知项、重复项或格式错误都会让整项 fail closed。它不是 Provider Manager、UI 或 provider env，也不会从 benchmark artifact 自动激活：

| 候选 | 范围 |
|---|---|
| `task4` | 五个 runtime 复用一次 quick evidence/focus 预取结果 |
| `task5` | 五个 runtime 的显式可交换只读工具使用有界公平并发；其余工具仍独占 |
| `task6` | Claude/OpenAI 的独立 preflight DAG 重叠 |
| `task7` | Pi 并发加载独立 SDK/provider，并在 quick 模式启用 parallel batch 调度；descriptor/tool gate 仍串行独占工作 |
| `task8` | OpenCode 并行读取消息/状态并使用自适应轮询 |
| `task9` | Qoder 的 Skill registry 与 SDK 启动重叠 |

`task5` 获准后默认启用其安全只读策略；`SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false` 只是回滚到独占执行，不能在缺少 `task5` 准入时绕过边界。缓存 single-flight、执行隔离、取消清理、receipt 和确定性修复属于 correctness/observability 基础能力，不依赖性能候选开关。

当前发布默认仍是串行策略：五个真实 adapter 的确定性准入 harness 为 `NOT CONFIGURED`，真实 provider 的有界 base/candidate A/B 尚未执行，因此速度/准确性准入结论是 `INCONCLUSIVE`。合成 scorer 只能验证计分器机械逻辑，不能批准候选默认开启。真实 provider 不可用时必须分别记录 `NOT AVAILABLE` 或 `NOT CONFIGURED`；尤其 Qoder 除 BYOK 外还需要 PAT 或本机 `qodercli` 登录态。单元测试、typecheck、build 和确定性 gate 都不能替代真实 provider 结果。

## 源码分析的 Runtime 一致性

五个 production runtime 不各自实现一套源码规则。它们共用 strategy asset 中的
source-use prompt 和同一 MCP registry/handler 产生的实际 `SourceUseDecisionV1`。
运行时把真实 source-use 状态附给产品层 finalizer；没有当前 run accessor 时，模型自己
编写的源码决策/绑定不会成为已执行事实。`pending` 或 `attempted` 本身不强制整轮失败，
真实检索、同意、引用和 claim 失败仍按各自合约报告。

已授权源码按问题需要访问；fast/full 不自动插入 lookup、固定计划或额外源码 pass。
`existing_only` 不能用源码或 RAG 工具补采集。Trace capture 支撑所引用的观测，源码证据
提供机制分析背景，`CodeRef` 元数据本身只负责定位。`SourceUseDecision.status` 的
`corroborated` 只记录本轮获准取得正文及引用的 lookup 审计，不证明 Trace 发生、机制或
因果关系。它与 claim binding 的 `mechanismStatus` 是两个不同字段。

共享 finalizer 使用 `semanticsPolicy: declared`：即使有匹配的 Trace 引用和源码正文，
模型声明的 `mechanismStatus: corroborated` 也会降为 `compatible`，并记录
`source_binding_mechanism_unverified`。当前路径没有可把一般机制提升为已证明的 native
proof；未知机制保留未验证/partial，不能拿检索审计状态替代。

路由层使用一个 canonical safe projector 把同一份决策/绑定送到初始与重放 SSE、
HTML report、CLI JSON/Markdown/HTML、analysis-result snapshot 和报告/snapshot API。Web chat 再缩减
为不含 `CodeRef` 的当前 run 回执。这些路径都不保留绝对 root、snippet、检索 query 或
模型自由文本 binding reason。

确定性五 runtime 执行/终态 gate 与 A0–A4 语义 gate 证明产品契约，不证明真实
provider 的模型质量。真实 Claude、OpenAI、Pi、OpenCode 和 Qoder 必须在凭证可用时分别重复验收；
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
bounded 问题和 unavailable 分类为 `trace_facts`，仍然检测焦点应用、架构、厂商和 trace 完整性——
问题再窄，也是针对一份模型没见过的 trace 提出的。
焦点应用检测在分析窗口内对候选进程统一打分（前台时长、帧、启动、battery top、CPU），没有任何活动的进程
直接排除，并给出 `high`/`medium`/`ambiguous` 置信度。五个 runtime 共用 `focusAppTarget` 决定生效包名：
用户指定为 `user`，high/medium 推断为 `auto_detected`，ambiguous 不设包名，只给候选。只有 `user` 包名和选区
约束分析目标；推断包名只作为 Skill 的默认范围（结果中的 `appliedDefaultProcess` 会注明），不作为对比身份门禁的
期望值；答案说明理由后可以改看有证据的候选。
完整性探测在检查 stdlib 视图前先加载其定义模块（能力定义静态声明 `requiredModules`，并由测试守住）；
模块加载失败或查询未完成的能力带 `reasonCode`，表示“未探测”，不是“缺失”。计划按需产生，阶段完成标记必须有真实成功证据或明确处置。
未结束的探索计划和假设保留原状态，不自动触发续跑，也不单独决定回答是否完整。

## 轮次预算与收尾

完整模式默认 100 轮，快速模式默认 50 轮；5 轮 quick target 仅为软目标。
总预算大于 1 时预留一次无工具交付。正常提前完成且已带有效必需声明，或 typed intent
为 acknowledgement 时不额外调用模型；已完成的非 acknowledgement 候选若缺少声明，
可使用这一次预留额度，让同一作者基于完整原生正文补交声明。只有返回候选的可见正文
与冻结原文完全一致且声明有效时才接受；改写、截断、失败或无效响应全部保留原候选，
补交期间关闭工具且不重复推送正文。调查触顶后，
收尾使用本轮固定的模型、Provider、授权与原始截止时间，基于已返回数据和已有正文
说明有限结论、证据不足及下一轮可追问的问题。它不会继续查询，也不会把调查升级为
完成；`partial`、`completion.reason=turn_limit` 和 `terminationReason=max_turns` 保留。
触顶后不再追加模型语义审核，确定性证据检查仍可执行。

收尾或声明补交失败时保留原候选；取消、超时、授权失效或已耗尽的显式费用预算不会启动额外调用。
只有 1 轮的配置没有额外收尾额度。OpenCode 通过观察原生消息停止采集，可能在两次观察
之间过冲；实际轮数照实记录，已无剩余额度时不再请求总结，不能将它宣称为严格调用硬上限。

## SSE 事件

所有 runtime 都向路由层发同一类 SmartPerfetto streaming update：

| Event | 含义 |
|---|---|
| `progress` | 阶段变化 |
| `thought` | 中间推理或阶段提示 |
| `agent_task_dispatched` | 工具调用开始 |
| `agent_response` | 工具结果 |
| `answer_token` | 最终答案 token |
| `conclusion` | SDK 结论已到达 |
| `analysis_completed` | 产品 finalization 后的终态元数据与实际报告结果 |
| `error` | 错误 |

`analysis_completed` 由产品层在 finalization 和报告处理后发出。native completion、
证据/claim、报告完整度各自保留状态；报告失败不能被成功的聊天投影掩盖。

Pi Agent Core 的真实模型路径复用 SmartPerfetto 的 scene strategy、系统 prompt、SQL/Skill、plan/hypothesis、artifact、route-owned quality/finalization/report 管线。它不会把 SmartPerfetto 运行时变成 Pi coding-agent harness，也不读取 `.pi` 项目配置、package extension、shell tool 或 file tool。Provider Manager 只允许 `custom` provider 选择 `pi-agent-core`，并且必须提供 Pi model JSON 或等价 env 配置。`SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1` 只用于本地 smoke/test，输出必须继续标记为 capability-limited。

OpenCode 路径同样只允许 custom provider。它可以使用带 `providerID` / `modelID` / `baseUrl` / `apiKey` 的 `SMARTPERFETTO_OPENCODE_MODEL_JSON`，也可以回退到 OpenAI-compatible 的 `OPENAI_*` env/provider 字段。SmartPerfetto 不复用用户自己的 OpenCode CLI 登录态、配置文件或 project extension；回滚路径是把 custom provider 或 `SMARTPERFETTO_AGENT_RUNTIME` 切回 `claude-agent-sdk` / `openai-agents-sdk`。

Qoder 在 Provider Manager 中同样只允许 custom provider，也可以通过 env 显式选择。SDK 默认不安装，用户必须先审阅条款，再通过 `qoder:install -- --accept-terms` 或显式 module path opt in。`resolveModel` BYOK 由 `QODER_BYOK_API_KEY`、`QODER_BYOK_PROVIDER`、`QODER_MODEL` 及可选 base URL/style/light model 组成；配置不完整时 fail closed。BYOK 只替换模型 provider，不替代 Qoder PAT 或本机 `qodercli` 登录认证。Provider Manager 仅允许 Qoder custom profile 的 `custom.envOverrides` 写入这四个 BYOK 值，不允许借此覆盖 CLI、SDK module 或 worker path。BYOK key 只进入 SDK 的 `resolveModel` 回调，不进入 SDK 子进程 env、诊断或明文快照；provider/base/style 进入非密钥快照，key 只参与 secret fingerprint，确保 provider pin、resume、外部 Issue 和 Self-Evolution proof 能检测配置变化。公开分析的逻辑续问使用产品历史并建立新模型上下文；一旦请求获准访问私有 codebase 或外部知识源，就不会恢复或保存该 provider opaque session，也不会把中间状态写入 durable snapshot。

## Final Result 与质量产物

所有 runtime 返回原始 `AnalysisResult`，并私下附带同一 run 的 finalization context：

```text
exact runtime result + private RuntimeFinalizationContext
  -> product-owned finalizeAnalysisResult (once)
  -> canonical body / original claim semantics
  -> retained execution capture / finite proof / at most one no-tool semantic review
  -> independent completion / claim / report / source / identity assessments
  -> HTML report / CLI turn files / analysis-result snapshot
  -> frontend visible projection
```

产品必须在复制结果前从 exact result 取出 context。context 固定 provider、原始绝对
deadline、trace identity 和证据读取范围；产品 owner 在 await 前后检查当前 run、取消和
授权。语义审核最多一次、无工具，沿用原始绝对 deadline；开始审核或重复读取结果不会
重置或延长预算。用户取消或释放 context 会中止审核。
审核超时记录为 unavailable，保留原正文及 native completion，不重写正文或把因果命题降成数值
命题。审核未知不单独使简短回答失败；完整报告仍需要满足其报告审核契约。
正文、真实 native completion 和原始 claim 是不同输入；合法 JSON 和模型审核
一致都不能单独成为证明。

同一 context 将冻结的输入选区绑定到语义审核。审核根据问题、意图和选中的事件或区间
检查回答是否切题；用户明确要求分析其他对象或整条 Trace 时，以该要求为准，不能被
界面残留选区覆盖。选区元数据仅用于定位，不是执行证据，也不能证明进程身份。
旧调用或 preparation 前路径缺失选区，与当前 run 明确无选区保持可区分；无效选区必须拒绝。
双 Trace 场景中，工作区焦点不能证明选区来自哪条 Trace，因此来源保持未知。
隐私投影无法完整保留本次获准的选区时，审核记录为不完整，不能静默更换分析范围。

语义审核不另加应用层输出 token 上限。OpenAI 只发送本次运行冻结的显式
`maxOutputTokens`；Claude 保留原 SDK 环境；Pi 未显式传入上限时使用已固定模型的
原生 SDK 能力。分类请求仍保留各自的小协议预算。服务商与 SDK 的输出限制仍然有效，
审核也仍校验完整结束状态和已完成 JSON 的 64 KiB 大小边界。
OpenCode 的共享模型配置不伪造 context/output 容量：未提供容量时依赖 SDK 默认值，
未知 context 不触发容量阈值驱动的预压缩，真实 context overflow 仍走原生被动压缩。
这不保证长会话行为与已知容量模型相同，也不增加模型 JSON 的容量配置入口。

`final_report_contract` 仍来自固定 registry 的 strategy frontmatter。`claudeVerifier`
只提供结构化交付诊断，不再运行独立语义 LLM 或按误诊词匹配正文。有限证明目录以
`SUPPORTED_DETERMINISTIC_CLAIM_RULES` 为准。每项规则仅证明其明确覆盖的命题；缺失原始
witness、受信单位/字段语义或覆盖时保留候选/未知状态；
一般因果关系不能由相等数值或端点推导。完整 claim 状态由捕获证据与当前命题的语义审核
联合决定。报告、CLI 和 snapshot 保留 provenance；chat 分开投影正文、machine sidecar
和结构化 runtime appendix，不能机械删改自然语言结论。

结论呈现保留全部正文，不按“证据索引”或“断言验证”等标题删除语义段落。
Web 将服务器核验详情作为独立消息字段，绑定候选身份；替换正文时清除旧详情，
元数据回填只更新本轮消息中相同候选的记录。CLI 使用绑定会话、回合和正文的独立
呈现文件，HTML 报告完整列出声明、各类引用与核验问题。来源表匹配与命题验证分开
标注；这些显示数据不能重新签发 witness、提升验证状态或参与授权恢复。

## Session 与恢复

统一快照由 route 层调用 `orchestrator.takeSnapshot()` 生成，恢复时调用 `restoreFromSnapshot()`。

每个逻辑追问使用新的模型上下文，保持逻辑 session 与 Provider/runtime 绑定。
原生 SDK 上下文只在本轮调查内部使用，不通过旧 SDK session、`previousResponseId`
或 opaque transcript 隐式带入整段前史。

`analysisHistory.ts` 为分类器和主分析提供同一套有界历史：最近 3 轮问答、最近未完成项和
更早轮次索引，明确保留 partial/unknown、终止原因、不足和下一步。默认主分析预览
最多 12,000 bytes、分类器 6,000 bytes；详细正文优先让位于完成状态和未完成项。
`read_session_history` 只读取产品绑定的当前会话，可按轮分页回查完整问答与声明定位；
它不接受用户/会话选择器，也不执行新 SQL。`fetch_artifact` 仍负责读取可用的原始表格。

完整历史复用 `conversation_turns` 保存；Conversation descriptor 与最终轮记录在
同一事务中写入 `runtime_snapshots` 和历史表。重开/重启后，先验证 tenant、workspace、
当前 owner、Trace、Provider pin 和来源权限，再恢复逻辑会话。旧 running 状态恢复为
interrupted，不重放不存在的执行。写入失败保留回答并报告恢复不可用。
来源派生历史必须匹配原轮授权指纹；缺失或变化时不再次发送给模型。历史记录和定位符
不恢复当前执行 witness，也不自动扩大本轮时间选区或证明范围。

快照还会携带 final result 质量相关字段，例如 conclusion contract、claim verification result 和 identity resolutions，以便 resume、report export 和 analysis-result comparison 复用。

历史 GET、报告和 snapshot 重放只读取/投影已有状态，不新执行 finalizer、语义审核或
签发证据证明；正常访问授权仍生效。恢复的显示行不能重建进程内的原始 witness。

Conversation 的逻辑 session 保留精确 trace pair、授权指纹和 tenant/workspace/user
下的内存 artifact/capture；每轮物理 session/run ID 唯一。签发 binding 通过内部 options
传递，JSON 不能伪造，缺 binding 也不能回退到缓存的受控 store。模型只得到有界 locator
目录，可据此读取已有 artifact；目录本身没有 rows、覆盖或证明权。finalization 固定已
接纳的 capture 集合，结束后释放本轮 lease 并清理物理 session。范围变化/销毁撤销 context，
迟到事件按生产 run 隔离，旧取消和 cleanup 不影响下一轮。

Raw trace comparison session 还必须持久化 `referenceTraceId`、`comparisonSource`
和 `comparisonReportSection`。同一个 session 不能从 comparison 降级成 single-trace，
也不能静默切到另一个 reference trace；恢复时 runtime-specific session state 和
provider/runtime identity 都必须按 comparison identity 读写。

## 发布与平台边界

- 源码和 npm CLI 要求 Node.js `>=24 <25`。
- 免安装包自带 Node.js 24、后端、预构建 `frontend/` 和固定 trace processor。
- Docker 不读取宿主机 Claude Code 登录态，必须用 Provider Manager 或 env provider。
- 默认 Docker、portable 和 npm 安装不包含 Qoder SDK；接受其条款并显式安装 optional peer 后才能启用。
- typed intent、claim schema、语义审核及 Conversation evidence context 模板都是运行资产。
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

最终调查解释复用产品边界内同一次无工具语义评估。采集状态与内容覆盖分别输出，绑定正文、contract、intent、registry 与 ledger fingerprint。覆盖缺口不会重写结论、触发补查循环或改变 SDK 原生 completion。历史快照只作为历史记录，不重新签发当前运行的证据权威。
