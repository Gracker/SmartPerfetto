# 架构总览

[English](overview.en.md) | [中文](overview.md)

SmartPerfetto 在 Perfetto UI 之上增加 AI 分析层。Perfetto 仍负责 trace 加载、时间线和 SQL 基础能力；SmartPerfetto 后端负责 agent 编排、Skill 执行、报告生成和流式输出。

```text
Frontend: Perfetto UI @ :10000
  └─ com.smartperfetto.AIAssistant plugin
       ├─ trace upload / open trace
       ├─ AI panel / floating window
       ├─ Codebase Config Panel
       ├─ DataEnvelope tables and charts
       └─ SSE client

Backend: Express @ :3000
  ├─ /api/agent/v1/*          agentv3 分析主路径
  ├─ /api/traces/*            trace 上传和生命周期
  ├─ /api/rag/*               RAG 与 codebase 管理
  ├─ /api/skills/*            Skill 查询和执行
  ├─ /api/export/*            导出
  ├─ /api/reports/*           HTML report
  └─ trace_processor_shell    HTTP RPC pool, 9100-9900

Standalone CLI: smp / smartperfetto
  └─ 复用同一后端 runtime、Skill、SQL、session、report 和 comparison contract
```

## 产品入口与发布形态

| 入口 | 用户形态 | 运行边界 |
|---|---|---|
| Web UI | Docker、免安装包、源码 `./start.sh` | 通过 HTTP/SSE 调后端，使用提交的 `frontend/` 预构建 UI |
| CLI | npm 包 `@gracker/smartperfetto` | Node.js `>=24 <25`，不启动 Web UI，写本地 `~/.smartperfetto/` session/report |
| API/SSE | `/api/agent/v1/*` 等 | 前端和外部集成都依赖同一契约 |
| Portable launcher | GitHub 三平台 asset | 包内自带 Node.js 24、native deps、后端、`frontend/` 和 `trace_processor_shell` |
| Docker | Docker Hub image | Linux container，不读取宿主机 Claude Code 登录态 |

Feature/Bug 设计要同时判断 Web UI、CLI、API、报告、Docker、免安装包、runtime/provider、
预构建内容和 Node 版本边界。LLM/Agent 的具体检查清单在
[`../../.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md)。

## 启动生命周期边界

源码入口共享 `scripts/service-lifecycle.sh`：PID 文件记录 launch generation、
OS 进程启动身份、可执行文件、cwd 和用于诊断的命令快照，并原子写入。启动/停止
只操作稳定身份仍匹配且属于当前 checkout 的进程树；端口冲突默认只诊断，不按
端口或模糊命令名杀进程。Backend 和 Frontend 都是必需服务，任一在 readiness
前退出、超时或运行中意外退出，launcher 都会停止另一端并返回非零。Docker 使用
`tini` 承担 PID1 信号转发/子进程回收，entrypoint 和 container health 同时覆盖
backend 与 frontend。

## 核心模块

| 模块 | 位置 | 责任 |
|---|---|---|
| Perfetto UI plugin | `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/` | 面板、SSE、结果渲染、场景导航、选区交互 |
| Express backend | `backend/src/index.ts` | 路由注册、健康检查、中间件、进程清理 |
| Runtime selector | `backend/src/agentRuntime/` | 每个 session 选择 Claude Agent SDK、OpenAI Agents SDK、Pi Agent Core、OpenCode 或 Qoder |
| Claude runtime | `backend/src/agentv3/` | Claude Agent SDK 编排、MCP server、策略注入、verifier、记忆 |
| OpenAI runtime | `backend/src/agentOpenAI/` | OpenAI Agents SDK 编排，通过同一 assistant contract 输出 |
| 第三方 runtime adapters | `backend/src/agentRuntime/engines/pi/`、`backend/src/agentRuntime/engines/opencode/`、`backend/src/agentRuntime/engines/qoder/` | custom third-party runtime，复用共享分析契约、request-scoped tools 和 runtime-specific 安全边界 |
| assistant application | `backend/src/assistant/` | session 管理、stream projection、结果 contract |
| Skill engine | `backend/src/services/skillEngine/` | YAML Skill 加载、参数替换、SQL 执行、DataEnvelope 输出 |
| Skills | `backend/skills/` | 原子、组合、深度、渲染管线分析 |
| Strategies | `backend/strategies/` | 场景策略、Prompt 模板、知识模板 |
| Code-aware analysis | `backend/src/services/codebase/`, `backend/src/services/rag/`, `backend/src/services/symbol/` | 本地代码库注册、源码索引、符号解析、lookup 过滤、patch 三态校验 |
| External Android knowledge | `backend/src/services/androidInternalsWiki/`, `externalKnowledgeSourceRegistry.ts`, `ragStore.ts` | 外部 Wiki 全库审计、版本/指纹、分代索引、许可/同意/scope 和私有内容投影 |
| Trace processor | `backend/src/services/traceProcessorService.ts` | trace 加载、RPC 管理、SQL 查询 |
| Reports | `backend/src/services/htmlReportGenerator.ts` | HTML 报告生成 |
| Result quality pipeline | `backend/src/services/agentResultNormalizer.ts`, `finalReportContractGate.ts`, `evidence/`, `verifier/`, `analysisResultSnapshotPipeline.ts` | final report contract、evidence/claim verification、identity resolution、snapshot |
| CLI | `backend/src/cli-user/` | `smp` / `smartperfetto` 命令、session/history/report export |
| Comparison services | `backend/src/services/comparison*Service.ts` | Raw trace 与 analysis-result 对比共享证据/报告 contract |

## 主分析数据流

```text
1. 用户加载 trace
   UI -> /api/traces/upload -> TraceProcessorService -> trace_processor_shell

2. 用户发起分析
   UI -> POST /api/agent/v1/analyze
      -> AgentAnalyzeSessionService.prepareSession()
      -> createAgentOrchestrator()
      -> selected runtime analyze()

3. Agent 获取证据
   Runtime -> MCP tools
      -> execute_sql -> trace_processor_shell
      -> invoke_skill -> SkillExecutor -> SQL / DataEnvelope
      -> lookup_knowledge / lookup_sql_schema / fetch_artifact
      -> lookup_blog_knowledge(source=android_internals_pack)
         -> 会话固定签名 Pack 版本 -> FTS5/BM25 -> 脱敏、预算控制的背景引用
      -> lookup_blog_knowledge(source=android_internals_wiki)
         -> request source allowlist + live registry consent/scope check
         -> active RAG generation -> bounded attributed background context
      （两种 Android Internals 来源都不是当前 trace 证据）
      -> resolve_symbol / lookup_app_source / lookup_aosp_source / lookup_kernel_source
         -> LookupResponseFilter -> CodeRef metadata
      -> propose_patch -> PatchProposer -> verified / sketch / unverified

4. 结果归一化与质量产物
   raw runtime result -> agentResultNormalizer
      -> final_report_contract gate
      -> evidence contract / claim verification / identity resolutions
      -> QueryReviewV1（查询可审查元数据，不是独立证据）

5. 后端流式输出
   SDK/server events -> runtime bridge -> StreamProjector -> SSE
      -> frontend renders progress, tables, thought, answer tokens

6. 结束与报告
   conclusion -> analysis_completed -> sanitized CodeRef/patch metadata
      -> AnalysisReceiptV1
      -> HTML report + CLI artifacts + analysis-result snapshot
      -> /api/reports/:id
```

CLI `smp run` / `smp ask` / `smp compare` 复用同一 session、runtime、Skill、report
和 trace_processor 路径；区别只是本地存储在 `~/.smartperfetto/`，输出可以是
`text`、`json` 或 `ndjson`。

外部 Wiki 与 trace 证据是两条独立数据流。正文只在显式请求 capability 下进入当前
provider 的 tool result；运行时桥接到 SSE、日志、报告或 snapshot 时统一投影为
chunk 引用/哈希/许可/出处。Wiki 背景不能被 claim verifier 当作当前 trace 的测量值。

源码与外部知识的选择、授权指纹、非恢复策略和删除生命周期见
[私有分析上下文架构](private-analysis-context.md)。该边界同时覆盖普通分析、Smart
Profile 深度分析、Web UI、CLI 和四个 runtime adapter。

## Runtime 与 Provider 边界

| Runtime | Provider | 关键边界 |
|---|---|---|
| `claude-agent-sdk` | Anthropic、Bedrock、Vertex、Claude/Anthropic-compatible provider、本地 Claude Code fallback | 本地 Claude 登录态只适用于源码运行；Docker/portable/npm CLI 需要显式 provider/env |
| `openai-agents-sdk` | OpenAI、Ollama、OpenAI-compatible provider | 按 OpenAI runtime 规则验证凭证和 chat-completions/Responses 协议 |
| `pi-agent-core` | Custom provider | 需要显式 Pi model JSON 或等价 env；不读取 `.pi` project config、package extension、shell tool 或 file tool |
| `opencode` | Custom provider | 需要显式 OpenCode/OpenAI-compatible model 配置；使用隔离 OpenCode server 和 request-scoped MCP tools，不读取个人 OpenCode 登录态/project state |

Provider Manager active profile 优先于 `.env` fallback。历史 session 恢复时必须保留
原 provider/runtime/comparison identity，不能因为当前 active provider 变化而静默切换。

## AI 输出合约

SmartPerfetto 的最终回答不是单一 Markdown 字符串，而是一组共享但分工不同的产物：

| 产物 | 消费者 | 边界 |
|---|---|---|
| visible chat conclusion | 前端 AI panel | 保持可读，隐藏低价值 SQL/appendix/audit 噪音 |
| HTML report | 浏览器、导出、分享 | 保留 evidence、claim verification、identity resolution 和 appendix |
| CLI artifacts | `smp run` / `smp ask` / `smp capture --analyze` / `smp report` | 持久化 turn、report、claim verification 和 identity files |
| analysis-result snapshot | 多结果对比、历史回看 | 保存 conclusion contract、claim support、verification 和 identity metadata |
| Query Review | AI panel、HTML report、Artifact | 说明实际查询的读取、过滤、输出和限制；固定为 review metadata，不能单独支撑诊断结论 |
| Analysis Receipt | AI panel、HTML report、CLI、snapshot | 绑定 run/session/trace/runtime，汇总证据计数、claim audit、质量门禁和实际输出 |

这些结构的字段和投影规则以
[Data Contract](../../backend/docs/DATA_CONTRACT_DESIGN.md) 为准。不同表面可以压缩显示，
但不能把 Query Review 提升成证据，也不能把 Receipt 的 `partial`/`not_applicable` 显示为通过。

修复结论质量时先确认是哪一层出了问题：runtime 产物、contract/gate、evidence/verification、report 生成、snapshot，还是 frontend projection。不要为了让聊天更干净而删除报告或 snapshot 需要的来源信息。

## 对比模式

| 模式 | 入口 | 数据来源 | 合约 |
|---|---|---|---|
| Raw Trace Compare | 前端 reference trace、CLI `smp compare` | current trace + reference trace 实时查询 | 共享 comparison identity、evidence pack、session snapshot 和 report section |
| Analysis Result Compare | 前端多结果对比 API | 已完成分析结果 snapshot | 保留 workspace/RBAC/matrix 能力，并复用共享 report section |

Web UI 的双 Trace 工作区操作状态机见
[双 Trace 工作区操作模型](dual-trace-workspace.md)。

## 文档与策略分工

SmartPerfetto 有两类“内容”：

| 内容 | 位置 | 运行时角色 |
|---|---|---|
| Strategy / Prompt template | `backend/strategies/*.strategy.md`, `*.template.md` | 进入系统 Prompt，约束 agent 思考方式 |
| YAML Skill | `backend/skills/**/*.skill.yaml` | 被 MCP `invoke_skill` 调用，确定性执行 SQL 分析 |
| Rendering pipeline catalog | `backend/skills/pipelines/index.yaml` | 固定上游 commit 与文档哈希，并把检测条目区分为主类型 variant 或附加 feature |
| Rendering pipeline docs | `docs/rendering_pipelines/*.md` | 从 `Gracker/rendering_pipelines` 同步的 Android 17 权威教学来源；构建时复制到 `backend/dist/rendering_pipelines/` |
| 普通 docs | `docs/` 其他目录 | 面向用户和贡献者 |

不要在 TypeScript 中硬编码 Prompt 内容。TypeScript 只负责加载、变量替换和结构性编排。
不要在文档或代码中写死 MCP 工具总数、Skill 总数或 scene 总数；这些分别由
tool registry、`backend/skills/` 文件树和 strategy frontmatter 决定。

渲染管线输出需要同时保留两层身份：教学文档定义 `rendering type`，
catalog 中的 pipeline 条目定义 trace 检测子路径或 feature。只有 catalog 中
`classification_role: variant` 且 `primary_eligible: true` 的条目能成为主判定；
同步、哈希和引用完整性由 `npm run check:rendering-pipelines` 校验。
