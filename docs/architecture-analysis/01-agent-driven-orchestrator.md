# AgentDrivenOrchestrator 深度解析（目标驱动 Agent 主链路）

> 对齐版本：2026-02-06
> 范围：`backend/src/agent/core/agentDrivenOrchestrator.ts` 及其直接依赖
> 目标：解释"为什么它更像 Agent 而不是 pipeline"，以及关键闭环如何形成。

---

## 0. 先给结论：Orchestrator 的职责边界（Thin Coordinator）

AgentDrivenOrchestrator 不是"把所有能力写在一个文件里的超级大脑"，它应当是薄协调层，主要做 6 件事：

1. **trace-scoped 状态装配**：获取 `EnhancedSessionContext(sessionId, traceId)`，初始化/恢复 `TraceAgentState`（目标/偏好/实验/证据摘要）。
2. **理解本轮意图**：`understandIntent(...)` + follow-up 分类（drill_down/extend/compare/clarify）。
3. **决定本轮"怎么跑"**：选择 executor（6 个专用 executor + strategy / hypothesis 双路径）。
4. **将结果变成"可持续记忆"**：把 tool 输出压缩为 evidence digest（写入 TraceAgentState），把结论抽取为 working memory。
5. **生成"结论 + 证据链摘要"**：`generateConclusion(...)` 强制结构化输出（洞见优先模式），减少模板化复述。
6. **可观测与可控**：SSE 事件、CircuitBreaker、InterventionController（不确定时请求用户选择方向）。

> 重要：Orchestrator 不应该直接写大量业务分析 SQL。SQL/规则应落在 skills（YAML）与 domain agents 工具层。

---

## 1. 不变式（必须长期保持的系统约束）

### 1.1 严格 trace-scoped（防跨 trace 泄漏）

- SessionContextManager 的 key：`sessionId::traceId`（`backend/src/agent/context/enhancedSessionContext.ts`）
- TraceAgentState 的迁移守卫：`migrateTraceAgentState(expected: { sessionId, traceId })`

含义：即便 sessionId 相同，切换 traceId 也必须创建新上下文，避免"上一条 trace 的结论污染下一条"。

### 1.2 预算语义：软偏好 vs 硬上限（质量优先）

用户偏好是"每轮最多实验数"（默认 3），但用户明确允许"没有硬约束，以结果为准"。

因此：
- `config.softMaxRounds`：**偏好预算**（到达后仅当结果足够好才收敛）
- `config.maxRounds`：**硬安全上限**（防跑飞，默认 5）

这解决了"3 轮就停导致结论质量被预算绑架"的问题。

### 1.3 每轮必须注入"同一 trace 的历史上下文"

Orchestrator 要保证 domain agents 与 conclusion 生成时都能看到：
- 目标与偏好（Goal/Preferences）
- 最近实验记录（Experiments）
- 可引用证据摘要（Evidence digests）
- 已确认发现（Findings）与可 drill-down 的实体（EntityStore）

实现点：
- `EnhancedSessionContext.generatePromptContext(...)` 生成压缩上下文
- 任务规划：`planTaskGraph(..., hints.historyContext)`
- agent 执行：`additionalData.historyContext` 注入到 `BaseAgent` prompt
- 结论生成：`generateConclusion(..., options.historyContext)`

---

## 2. analyze() 的真实执行路径（按"体验影响"排序）

### 2.1 Session 与 Goal 状态装配

1. `sessionContextManager.getOrCreate(sessionId, traceId)`
2. `sessionContext.getOrCreateTraceAgentState(query)`：把用户首句作为 goal seed（后续可被 intent 归一化）
3. 发射 `progress: agent_state_loaded`（便于前端观测）

### 2.2 ADB context（可选协作能力，默认只读）

- `detectAdbContext(options.adb, traceProcessorService, traceId)`
- 写入 `sharedContext.userContext.adb`
- 强约束：除非明确 full，否则工具层不允许改变设备状态
- 发射 `progress: adb_context`（含设备序列号、匹配状态、启用/禁用）

### 2.3 Trace 配置检测（refresh rate / vsync / VRR）

目的：避免"用错帧预算导致 jank 误判/矛盾"。

- `detectTraceConfig(...)` 执行 `vsync_config` 和 `vrr_detection` skills
- 写入 `sharedContext.traceConfig`
- 同时镜像到 `sharedContext.globalMetrics.*`（兼容旧链路）
- 发射 `progress: trace_config`

检测结果示例：
```typescript
interface TraceConfig {
  vsyncPeriodNs: number;      // 8333333 (120Hz)
  refreshRateHz: number;       // 120
  vsyncPeriodMs: number;       // 8.33
  vsyncSource: string;         // 'perfetto_vsync_timeline'
  isVRR: boolean;              // true/false
  vrrMode: string;             // 'FIXED_RATE' | 'ADAPTIVE' | 'CONTINUOUS'
  minFrameBudgetMs?: number;   // VRR 下最短帧预算
  maxFrameBudgetMs?: number;   // VRR 下最长帧预算
}
```

### 2.4 意图理解 + follow-up 解析

- `understandIntent(query, sessionContext, modelRouter, emitter)`：识别 followUpType、引用实体、目标描述
- `resolveFollowUp(intent, sessionContext)`：把"引用实体/前一轮发现"解析成可执行参数
- drill_down 进一步通过 `resolveDrillDown(...)` 获取精确 intervals（cache 优先、SQL enrichment 兜底）

Follow-up 类型：

| followUpType | 含义 | 示例 |
|---|---|---|
| `initial` | 首次查询 | "分析滑动性能" |
| `drill_down` | 深入分析具体实体 | "分析帧 1436069" |
| `clarify` | 解释/说明 | "什么是 App Deadline Missed?" |
| `extend` | 扩展分析更多实体 | "继续分析其他卡顿帧" |
| `compare` | 对比多个实体 | "比较帧 456 和 789" |

### 2.5 Focus 记录 + 增量范围（Incremental Scope）

为"像专家一样承接上下文"提供结构化输入：

- `FocusStore`：记录用户最近关注（实体/时间段/指标/问题），支持 `query` / `drill_down` / `compare` / `extend` / `explicit` 等交互类型
- `IncrementalAnalyzer`：结合 Focus + EntityStore + 历史 findings，决定本轮是 full 还是 incremental

```typescript
interface IncrementalScope {
  type: 'entity' | 'timeRange' | 'question' | 'full';
  entities?: Array<{ type: FocusEntityType; id: EntityId }>;
  timeRanges?: Array<{ start: string; end: string }>;
  focusIntervals?: FocusInterval[];
  relevantAgents: string[];
  relevantSkills: string[];
  isExtension: boolean;
  reason: string;
}
```

发射 `incremental_scope` 事件用于可观测。

收益：避免 follow-up 每次都从"全局概览"重跑一遍。

### 2.6 假设生成（智能跳过）

假设生成前会检测以下条件，决定是否跳过：

1. **Clarify follow-up** → 跳过（只读解释，不需要调查假设）
2. **Drill-down + 缓存命中**（`entityStore.wasFrameAnalyzed/wasSessionAnalyzed`）→ 跳过（使用缓存实体数据）
3. **其他情况** → `generateInitialHypotheses(query, intent, sessionContext, modelRouter, agentRegistry, emitter)`

假设生成支持：
- LLM 驱动生成（带对话历史上下文注入）
- 关键词回退（当 LLM 失败时，基于 query 关键词匹配生成默认假设）
- Follow-up 感知（drill_down / extend / compare 各有专门的假设模板）

### 2.7 Executor 路由（从 pipeline 走向 goal-driven loop）

路由优先级（从最确定到最自适应）：

```
1. clarify     → ClarifyExecutor      （只读解释，不跑 SQL）
2. compare     → ComparisonExecutor    （多实体对比）
3. extend      → ExtendExecutor        （增量补分析未覆盖实体）
4. drill_down  → DirectDrillDownExecutor（有 intervals 时直接跑目标 skill）
5. 其余        → strategy match（keyword_first + LLM fallback）
   5a. 匹配到 strategy：
       - 默认偏好 (hypothesis_experiment) 时 → HypothesisExecutor
         （strategy 作为 suggestedStrategy hint 注入，不强制执行）
       - SMARTPERFETTO_FORCE_STRATEGY=1 时 → StrategyExecutor
   5b. 未匹配到 strategy → HypothesisExecutor
```

这一步是关键设计：**strategy 不再是唯一正确路径，而是 agent 可调用的一类工具/脚手架**。

### 2.8 执行 + 证据写回（让后续轮次更聪明）

executor 产出统一为 `ExecutorResult`：

```typescript
interface ExecutorResult {
  findings: Finding[];
  lastStrategy: StrategyDecision | null;
  confidence: number;
  informationGaps: string[];
  rounds: number;
  stopReason: string | null;
  capturedEntities?: CapturedEntities;
  analyzedEntityIds?: { frames?: string[]; sessions?: string[] };
  interventionRequest?: InterventionRequest;
  pausedForIntervention?: boolean;
}
```

同时，tool 输出会被压缩为 evidence digest（写入 TraceAgentState），用于：
- 后续 prompt 注入（避免重复与遗忘）
- 结论中的"证据链摘要"
- 矛盾/反例的可解释记录

写回步骤：
1. `applyCapturedEntities(...)` → 写入 EntityStore
2. `store.markFrameAnalyzed/markSessionAnalyzed(...)` → 标记已分析
3. `sessionContext.refreshTraceAgentCoverage()` → 刷新覆盖率快照
4. `incrementalAnalyzer.mergeFindings(...)` → 增量合并（如果是 extension turn）

### 2.9 Intervention：不确定时与用户协作

当 executor 返回 `interventionRequest` 时，Orchestrator 通过 `InterventionController` 创建干预点：

```typescript
type InterventionType =
  | 'low_confidence'      // 置信度过低
  | 'ambiguity'           // 多方向歧义
  | 'timeout'             // 超时
  | 'agent_request'       // Agent 主动请求
  | 'circuit_breaker'     // 断路器触发
  | 'validation_required' // 需要验证
```

干预选项通过 SSE `intervention_required` 事件推送到前端，用户可通过 `POST /api/agent/:sessionId/intervene` 响应。

设计要点：
- **非阻塞**：发出干预事件后分析继续（当前轮结果不丢弃）
- **超时自动处理**：默认 60 秒超时，自动执行 abort
- **下一轮生效**：用户响应在下一个分析 turn 中被消费

### 2.10 结论生成 + 多轮记忆更新

`generateConclusion(...)` 支持三种输出模式：

| 模式 | 触发条件 | 特点 |
|---|---|---|
| `initial_report` | 首轮 + 有证据 | 完整报告，引用具体数据 |
| `focused_answer` | 后续轮 + 有证据 | 直接回答本轮焦点，不复述历史（< 25 行） |
| `need_input` | 证据不足 | 低置信度方向 + 提问引导用户 |

输出约束（洞见优先 v2.0）：
- 固定 4 段：`结论（按可能性排序）/ 证据链（C1/C2/C3 对齐）/ 不确定性与反例 / 下一步`
- 结论最多 3 条，每条给出置信度百分比
- 证据链必须包含 evidence id（`ev_xxxxxxxxxxxx`）
- 自动补全机制：`injectPerConclusionEvidenceMapping` + `injectEvidenceIndexIntoEvidenceChain` 确保审计性

本轮落盘（为下一轮"更像专家"）：
- `sessionContext.addTurn(...)`：保存 turn 与 findings
- `sessionContext.updateWorkingMemoryFromConclusion(...)`：确定性抽取摘要（减少机械化遗忘）
- `sessionContext.recordTraceAgentTurn(...)`：写 TraceAgentState.turnLog（审计线）

---

## 3. Executor 详解

### 3.1 Executor 统一接口

```typescript
interface AnalysisExecutor {
  execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult>;
}
```

所有 executor 遵循此契约，Orchestrator 无需关心内部实现差异。

### 3.2 Executor 列表

| Executor | 文件 | 模式 | 触发条件 | 描述 |
|----------|------|------|---------|------|
| `ClarifyExecutor` | clarifyExecutor.ts | Read-only | `followUpType === 'clarify'` | 纯 LLM 推理解释，不查询 trace SQL |
| `ComparisonExecutor` | comparisonExecutor.ts | Comparison | `followUpType === 'compare'` | 多实体对比 + 差异表格 + 叙事 |
| `ExtendExecutor` | extendExecutor.ts | Extend | `followUpType === 'extend'` | 从 EntityStore 获取未分析候选，批量运行 drill-down |
| `DirectDrillDownExecutor` | directDrillDownExecutor.ts | Direct bypass | drill_down + intervals | 直接调用目标 skill（零 LLM 开销） |
| `StrategyExecutor` | strategyExecutor.ts | Deterministic | Strategy matched + force | 确定性多阶段流水线 |
| `HypothesisExecutor` | hypothesisExecutor.ts | Adaptive LLM | No strategy / prefer hypothesis | 假设驱动多轮分析 |
| `DirectSkillExecutor` | directSkillExecutor.ts | Internal | `executionMode === 'direct_skill'` | StrategyExecutor 内部使用，零 LLM 开销执行 skill |

### 3.3 StrategyExecutor（确定性流水线）

```
Query → Strategy.trigger() match → Multi-stage pipeline → Fixed output
```

**特点：**
- 预定义分析流水线（Stages 由 Strategy 定义）
- 确定性阶段转换，支持 `extractIntervals()` 和 `shouldStop()` 回调
- 支持 `direct_skill` 模式（零 LLM 开销，通过 DirectSkillExecutor 执行 SQL）
- 跨阶段实体捕获（`captureEntitiesFromResponses` / `captureEntitiesFromIntervals`）
- JankCauseSummary 聚合（`summarizeJankCauses`）
- TraceConfig 检测确保准确帧预算
- `stage_transition` SSE 事件用于可观测

### 3.4 HypothesisExecutor（自适应 LLM 循环）

```
Query → LLM 假设生成 → Multi-round refinement → Variable output
```

**特点：**
- LLM 驱动任务规划（`planTaskGraph` → `buildTasksFromGraph`）
- 依赖图执行（`executeTaskGraph`）+ 并行调度
- 反馈综合（`synthesizeFeedback`）含矛盾检测与假设更新
- 迭代策略决策（`IterationStrategyPlanner` → continue/deep_dive/pivot/conclude）
- Focus-aware 分析规划（通过 `setFocusStore`）
- 干预触发（置信度/超时/无进展）
- Circuit Breaker 集成

### 3.5 DirectDrillDownExecutor

```
drill_down intent → entityType mapping → skill invocation → findings
```

**Skill 映射：**
- `frame` → `jank_frame_detail`
- `session` → `scrolling_analysis`

支持 timestamp enrichment：当 interval 只有 entity ID 没有时间戳时，通过轻量 SQL 查询补全。

### 3.6 ClarifyExecutor

纯 LLM 推理，输入：
- EntityStore 中的缓存数据（FrameEntity / SessionEntity）
- 历史 findings
- 对话上下文

输出：解释性 finding（severity: info）。

### 3.7 ComparisonExecutor

1. 要求至少 2 个引用实体
2. 通过 DrillDownResolver 解析各实体（cache-first）
3. SQL enrichment 仅用于未缓存实体
4. 生成对比表格 + 叙事差异

### 3.8 ExtendExecutor

1. 从 EntityStore 获取未分析候选帧/会话（`getCandidateFrames/getCandidateSessions`）
2. FocusStore 优先排序（`setFocusStore` → focus-aware prioritization）
3. 批量执行 drill-down（默认 batch size = 5）
4. 返回 `capturedEntities` 和 `analyzedEntityIds` 供 Orchestrator 写回

---

## 4. 核心模块详解

### 4.1 Model Router（多模型路由）

`backend/src/agent/core/modelRouter.ts`

**支持的 Provider：**

| Provider | 模型 ID | 默认启用 | 强项 |
|----------|---------|---------|------|
| DeepSeek | `deepseek-chat` | Yes | reasoning, coding, cost |
| DeepSeek | `deepseek-coder` | Yes | coding, cost |
| GLM (智谱) | `glm-4` | Yes | reasoning, coding, cost |
| Anthropic | `claude-sonnet` (claude-sonnet-4) | No | reasoning, coding |
| Anthropic | `claude-haiku` (claude-haiku-4) | No | speed, cost |
| OpenAI | `gpt-4o` | No | reasoning, vision |
| Mock | mock | No | 测试用 |

**任务类型路由：**

| TaskType | 优先强项 |
|----------|---------|
| `intent_understanding` | reasoning |
| `planning` | reasoning |
| `synthesis` | reasoning |
| `evaluation` | reasoning |
| `sql_generation` | coding |
| `code_analysis` | coding |
| `simple_extraction` | speed, cost |
| `formatting` | speed, cost |
| `general` | reasoning |

**故障转移链（默认）：** `deepseek-chat → deepseek-coder → glm-4`

**Ensemble（多模型投票）：** 并行调用多个模型，基于响应长度一致性计算 agreement score。默认禁用。

**隐私保护：** 所有 prompt 经过 `redactTextForLLM()` 处理，发射 `llmTelemetry` 事件用于审计（只包含 hash 和统计信息，不包含原文）。

### 4.2 Circuit Breaker（断路器）

`backend/src/agent/core/circuitBreaker.ts`

**状态转换：**

```
CLOSED → (failure threshold) → OPEN → (cooldown) → HALF_OPEN → (success threshold) → CLOSED
```

**关键特性：**
- 指数退避重试（base delay × 2^attempt，加 ±20% jitter）
- 用户响应超时（默认 `userResponseTimeoutMs`，超时自动 abort）
- `forceClose` 冷却期（防快速连续 continue）
- `forceClose` 次数限制（`maxForceCloseCount`，防无限循环）
- 渐进式半开恢复（需多次成功才完全关闭）
- 跨 turn 持久化（CircuitBreaker 不在每次 analyze 时重置）

**用户响应处理（`handleUserResponse`）：**

| 选择 | 行为 |
|------|------|
| `continue` | 检查次数限制 + 冷却期，然后 `forceClose()` |
| `abort` | 直接中止 |
| `skip` | 跳过当前阶段 |

### 4.3 Intervention Controller

`backend/src/agent/core/interventionController.ts`

基于 EventEmitter 的干预管理器，负责：
1. 创建干预点（`createAgentIntervention`）
2. 处理用户决策（`resolveIntervention`）
3. 超时自动处理
4. 事件转发到 SSE（`intervention_required` / `intervention_resolved` / `intervention_timeout`）

**配置：**

```typescript
{
  confidenceThreshold: 0.7,      // 触发阈值
  timeoutThresholdMs: 120000,    // 2 分钟
  userResponseTimeoutMs: 60000,  // 用户响应超时
}
```

### 4.4 Intent Understanding

`backend/src/agent/core/intentUnderstanding.ts`

**输出结构：**

```typescript
interface Intent {
  primaryGoal: string;
  aspects: string[];
  expectedOutputType: 'diagnosis' | 'comparison' | 'timeline' | 'summary';
  complexity: 'simple' | 'moderate' | 'complex';
  followUpType?: 'initial' | 'drill_down' | 'clarify' | 'extend' | 'compare';
  referencedEntities?: ReferencedEntity[];
  extractedParams?: Record<string, any>;
}
```

**实体提取规则：**
- 帧引用：`帧123` / `frame 123` → `{ type: 'frame', id: 123 }`
- 会话引用：`会话2` / `session 2` → `{ type: 'session', id: 2 }`
- 进程引用：`com.example.app` → `{ type: 'process', id: 'com.example.app' }`
- 时间范围：`1.2s~1.5s` → `{ type: 'time_range', value: { start: '1.2s', end: '1.5s' } }`

### 4.5 Task Graph Planner

`backend/src/agent/core/taskGraphPlanner.ts`

LLM 驱动的任务图规划，关键特性：
- **矛盾优先**：prompt 显式要求优先消解已检测到的矛盾
- **预算控制**：`maxTasks` 参数限制单轮任务数
- **域名归一化**：`DOMAIN_ALIASES` 映射（gpu → frame，ipc → binder 等）
- **必要域注入**：当查询涉及滑动/卡顿但 LLM 遗漏 frame 域时，自动补充
- **heuristic 回退**：LLM 失败时基于 `agentRegistry.getAgentsForTopic(query)` 生成
- **Strategy hint 注入**：当有 `suggestedStrategy` 时注入 prompt 供参考

### 4.6 Task Graph Executor

`backend/src/agent/core/taskGraphExecutor.ts`

依赖图感知的并行执行器：
- 按依赖拓扑序分批调度
- 独立任务并行执行（通过 `messageBus.dispatchTasksParallel`）
- 死锁检测 + 回退（无依赖可满足时，强制执行所有剩余任务）
- CircuitBreaker 集成（失败/成功计数）
- `emitDataEnvelopes()`：去重 + 空表过滤后通过 SSE 发送

### 4.7 Feedback Synthesizer

`backend/src/agent/core/feedbackSynthesizer.ts`

LLM 驱动的反馈综合：
- 语义去重（按 `category:severity` 分组，保留最高置信度）
- 矛盾检测与标记（`_contradicted` + `_contradictionReason`）
- 假设更新（support/weaken/reject + confidence_delta 裁剪）
- 矛盾写入 TraceAgentState（`sessionContext.recordTraceAgentContradiction`）
- 矛盾自动提升为高优先级信息缺口

### 4.8 Follow-Up Handler

`backend/src/agent/core/followUpHandler.ts`

follow-up 查询解析：
- 实体 ID 归一化（string/number 通用比较）
- snake_case / camelCase 双兼容
- FocusInterval 构建链：finding match → fallback params → minimal construction
- `needsEnrichment` 标记（timestamp 缺失时由 executor 补查）

### 4.9 Conclusion Generator

`backend/src/agent/core/conclusionGenerator.ts`

结论生成 v2.0（洞见优先模式）：
- JankCauseSummary 注入（来自逐帧分析的结构化聚合）
- TraceConfig 上下文（刷新率/帧预算/VRR 信息）
- 矛盾处理规则（6 类常见矛盾及判定条件）
- JSON → Markdown 自动转换（LLM 忽略格式指令时的回退）
- 证据索引自动补全（确保审计性）

---

## 5. 辅助组件

### 5.1 FocusStore

`backend/src/agent/context/focusStore.ts`

用户注意力追踪：
- 记录用户交互（query / drill_down / compare / extend / explicit）
- 按权重排序返回 top focuses
- 与 EntityStore 同步（`syncWithEntityStore`）
- 前端可通过 `POST /api/agent/:sessionId/interaction` 上报点击事件

### 5.2 IncrementalAnalyzer

`backend/src/agent/core/incrementalAnalyzer.ts`

增量分析决策：
- 结合 FocusStore + EntityStore + 历史 findings 判断 scope
- 支持 `entity` / `timeRange` / `question` / `full` 四种 scope
- `mergeFindings()` 智能合并新旧 findings

### 5.3 Strategy Selector

`backend/src/agent/core/strategySelector.ts`

LLM 语义策略选择（增强模式）：
- `detectTraceContext()` 检测 trace 中可用数据（表/进程/帧/CPU/内存/Binder）
- 关键词优先匹配 + LLM 语义回退
- 置信度阈值 gating（低于阈值回退到 hypothesis）
- 策略候选排序（`StrategyCandidate` with confidence + reasoning）

### 5.4 Entity Capture

`backend/src/agent/core/entityCapture.ts`

从 agent 响应中捕获实体（帧/会话）：
- `captureEntitiesFromResponses()` — 从 agent findings 中提取
- `captureEntitiesFromIntervals()` — 从 focus intervals 中提取
- `mergeCapturedEntities()` — 合并多阶段的实体数据
- `applyCapturedEntities()` — 统一写入 EntityStore

### 5.5 Drill-Down Resolver

`backend/src/agent/core/drillDownResolver.ts`

cache-first 的 drill-down 目标解析：
1. 先查 EntityStore 缓存
2. 缓存未命中时通过 SQL 查询补全
3. 返回 `DrillDownResolved` 含 intervals + resolution traces

### 5.6 Emitted Envelope Registry

`backend/src/agent/core/emittedEnvelopeRegistry.ts`

session-scoped DataEnvelope 去重：
- 基于 `meta.skillId + meta.stepId + data hash` 生成去重键
- 防止同一 skill/step 的数据在多轮分析中重复推送给前端

### 5.7 Jank Cause Summarizer

`backend/src/agent/core/jankCauseSummarizer.ts`

结构化卡顿原因聚合（`JankCauseSummary`）：
- 从逐帧分析结果中提取各帧的 `root_cause` / `primary_cause`
- 统计主因占比（`primaryCause`）
- 格式化为 prompt 友好的字符串（`formatJankSummaryForPrompt`）
- 注入到 conclusionGenerator 用于更精准的结论

---

## 6. Legacy 组件（已废弃）

以下组件在 v5.0 Agent-Driven 架构中已不再使用，保留仅供参考：

| 组件 | 文件 | 状态 |
|------|------|------|
| `AgentStateMachine` | stateMachine.ts | `@deprecated` - 不再驱动主链路 |
| `PipelineExecutor` | pipelineExecutor.ts | `@deprecated` - 被 StrategyExecutor/HypothesisExecutor 替代 |

---

## 7. 可观测性（SSE 事件）

### 7.1 事件映射表

Orchestrator 内部事件通过 `mapToAgentDrivenEventType()` 映射为 SSE 事件：

| Orchestrator Phase | SSE Event Type | 描述 |
|---|---|---|
| `starting` | `progress` | 分析开始 |
| `agent_state_loaded` | `progress` | Agent 状态加载完成 |
| `adb_context` | `progress` | ADB 上下文检测 |
| `trace_config` | `progress` | Trace 配置检测 |
| `understanding` | `progress` | 意图理解中 |
| `follow_up_detected` | `progress` | 检测到 follow-up |
| `follow_up_resolved` | `progress` | follow-up 解析完成 |
| `hypotheses_generated` | `hypothesis_generated` | 假设生成完成 |
| `round_start` | `round_start` | 新一轮分析开始 |
| `stage_start` | `stage_start` | 策略阶段开始 |
| `tasks_dispatched` | `agent_task_dispatched` | 任务批量分派 |
| `task_dispatched` | `agent_dialogue` | 单任务分派 |
| `task_completed` | `agent_response` | Agent 完成任务 |
| `synthesis_complete` | `synthesis_complete` | 综合结果 |
| `strategy_decision` | `strategy_decision` | 迭代策略决定 |
| `concluding` | `progress` | 生成结论中 |
| — | `data` | DataEnvelope(s) 推送 |
| — | `analysis_completed` | 分析完成 |
| — | `error` | 错误 |
| — | `end` | 流结束 |

### 7.2 新增事件（v2.0）

| SSE Event Type | 触发时机 | 描述 |
|---|---|---|
| `strategy_selected` | 策略匹配成功 | 含 strategyId, confidence, selectionMethod |
| `strategy_fallback` | 策略匹配失败或偏好 hypothesis | 含 reason, fallbackTo |
| `stage_transition` | Strategy 阶段切换 | 含 stageIndex, intervalCount |
| `finding` | 实时 findings | 含 round, findings[] |
| `degraded` | 模块降级 | 含 module, fallback |
| `circuit_breaker` | 断路器触发 | 含 agentId, reason |
| `sql_generated` | 动态 SQL 生成 | 含 sql, riskLevel |
| `sql_validation_failed` | SQL 验证失败 | 含 sql, errors[] |
| `intervention_required` | 需要用户干预 | 含 options, context, timeout |
| `intervention_resolved` | 干预已解决 | 含 action, directive |
| `intervention_timeout` | 干预超时 | 含 defaultAction, timeoutMs |
| `focus_updated` | 焦点变更 | 含 focusType, target, weight |
| `incremental_scope` | 增量范围确定 | 含 scopeType, reason |
| `conclusion` | 结论生成 | 含 summary, confidence, rounds |
| `track_data` | 场景重建轨道数据 | 含 scenes, trackEvents |
| `scene_reconstruction_completed` | 场景重建完成 | 含 scenes[], trackEvents[] |

数据输出统一为 DataEnvelope（v2 data contract），并通过 session-scoped `EmittedEnvelopeRegistry` 去重，避免 UI 重复渲染。

---

## 8. API 端点

### 8.1 主分析链路

| Method | Path | 描述 |
|--------|------|------|
| `POST` | `/api/agent/analyze` | 启动分析（Strategy 匹配 → Executor 路由） |
| `GET` | `/api/agent/:sessionId/stream` | SSE 实时流 |
| `GET` | `/api/agent/:sessionId/status` | 轮询状态 |
| `POST` | `/api/agent/:sessionId/respond` | 响应断路器（continue/abort） |
| `DELETE` | `/api/agent/:sessionId` | 清理会话 |

### 8.2 Intervention & Focus (v2.0)

| Method | Path | 描述 |
|--------|------|------|
| `POST` | `/api/agent/:sessionId/intervene` | 响应干预请求 |
| `POST` | `/api/agent/:sessionId/interaction` | 上报用户交互（点击时间戳等） |
| `GET` | `/api/agent/:sessionId/focus` | 获取当前焦点列表 |

### 8.3 场景重建

| Method | Path | 描述 |
|--------|------|------|
| `POST` | `/api/agent/scene-reconstruct` | 启动场景重建 |
| `GET` | `/api/agent/scene-reconstruct/:id/stream` | 场景重建 SSE 流 |
| `GET` | `/api/agent/scene-reconstruct/:id/tracks` | 获取轨道事件 |
| `GET` | `/api/agent/scene-reconstruct/:id/status` | 场景重建状态 |
| `DELETE` | `/api/agent/scene-reconstruct/:id` | 清理场景重建会话 |
| `POST` | `/api/agent/scene-detect-quick` | 快速场景检测 |

### 8.4 Pipeline Teaching

| Method | Path | 描述 |
|--------|------|------|
| `POST` | `/api/agent/teaching/pipeline` | 渲染管线检测与教学 |

### 8.5 Session & Log 管理

| Method | Path | 描述 |
|--------|------|------|
| `GET` | `/api/agent/sessions` | 列出会话（含可恢复会话） |
| `POST` | `/api/agent/resume` | 恢复会话 |
| `GET` | `/api/agent/:sessionId/report` | 生成 JSON 报告 |
| `GET` | `/api/agent/logs` | 列出所有日志 |
| `GET` | `/api/agent/logs/:sessionId` | 查看会话日志 |
| `GET` | `/api/agent/logs/:sessionId/errors` | 仅错误/警告 |
| `POST` | `/api/agent/logs/cleanup` | 清理过期日志 |

---

## 9. Session 管理

路由层内存 `Map<sessionId, AnalysisSession>` 管理会话：

```typescript
interface AnalysisSession {
  orchestrator: AgentDrivenOrchestrator;
  sessionId: string;
  sseClients: express.Response[];
  result?: AgentDrivenAnalysisResult;
  status: 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed';
  traceId: string;
  query: string;
  createdAt: number;
  logger: SessionLogger;
  hypotheses: Hypothesis[];
  scenes?: DetectedScene[];
  trackEvents?: TrackEvent[];
  agentDialogue: Array<{ agentId, type, content, timestamp }>;
  dataEnvelopes: any[];
  agentResponses: Array<{ taskId, agentId, response, timestamp }>;
}
```

**多轮对话支持：** 请求 `sessionId` 时复用已有 session（orchestrator + logger），前提是 traceId 匹配。

**会话清理：** 定期清理过期会话。

---

## 10. 设计复盘：当前强项与仍需补齐的点

### 已解决的"机械化来源"

- "每轮只看本轮输入" → `generatePromptContext + historyContext` 全链路注入
- "预算导致早停" → 软预算 + 硬上限（质量优先）
- "skills 不够用就失败" → BaseAgent 动态 SQL 生成/验证/修复（有限次数）
- "结论复述历史" → 洞见优先模式（focused_answer / need_input / initial_report）
- "follow-up 从头重跑" → IncrementalAnalyzer + FocusStore + EntityStore 缓存

### 建议继续增强（下一阶段）

1. **矛盾驱动实验**：把 `TraceAgentState.contradictions` 真正接入 planning（优先做能消解矛盾的实验）
2. **实验成本模型**：为每个 skill/agent 标注 cost（时延/数据量/LLM 次数），让 planner 做信息增益/成本权衡
3. **更强的 stop 条件**：除了 confidence，还要考虑 coverage 与关键缺口（gaps）
4. **strategy 结构复用**：当匹配到 strategy 但走 hypothesis loop 时，可把 stages 转为实验候选（比纯 LLM 规划更稳定）
5. **Intervention UX 闭环**：当前 intervention 是非阻塞的，用户响应在下一 turn 消费。未来可考虑 turn 内阻塞等待。
