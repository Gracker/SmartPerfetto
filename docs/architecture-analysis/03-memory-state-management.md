# Memory & State Management 深度解析（短期/长期 + trace 隔离）

> 对齐版本：2026-02-06
> 核心目标：让系统具备"可持续推理的记忆"，同时保证 **不跨 trace 泄漏**、不无限膨胀、可持久化恢复。

---

## 0. 先给结论：SmartPerfetto 需要两种 memory

用户说的"长期/短期 memory"在 SmartPerfetto 里应对应两类不同的职责：

### 0.1 短期 memory（本轮决策所需）

用于支持"下一步实验怎么选"的即时推理：
- 最近 turns 的摘要（不是原文全文）
- 当前目标（Goal）
- 最近实验（Experiments）
- 最近证据摘要（Evidence digests）
- 当前关注点（Focus）
- 覆盖度（Coverage）

实现载体：`EnhancedSessionContext.generatePromptContext(maxTokens)`

### 0.2 长期 memory（跨轮次稳定状态）

用于避免"做过的事丢了、证据链断裂、偏好丢失"：
- Goal & Preferences（含 soft 预算）
- 实验记录（每轮 objective/status/evidence）
- 证据摘要（digest + provenance）
- 矛盾记录（待消解）
- Entity cache（可 drill-down 的 frame/session/cpu_slice/binder/gc/memory/generic）
- FocusStore（用户关注点，带衰减权重）
- Coverage（已分析的 domains/entities/timeRanges/packages）

实现载体：`TraceAgentState` + `EntityStore` + `FocusStore`，并可通过 SQLite 落盘。

---

## 1. 不变式：必须严格 trace-scoped

### 1.1 内存态：SessionContextManager 的复合 key

位置：`backend/src/agent/context/enhancedSessionContext.ts`

- key = `sessionId::traceId`
- 同一 sessionId 切换 traceId 会调用 `cleanupOldTracesForSession()` 清理旧 trace context（防止污染）
- LRU 淘汰策略：默认最多 100 个 session，最大年龄 30 分钟
- 支持 `set()` 方法直接注入反序列化的上下文（持久化恢复场景）

```typescript
export class SessionContextManager {
  private sessions: Map<string, EnhancedSessionContext> = new Map();
  private accessOrder: string[] = []; // LRU tracking
  private maxSessions: number;       // default: 100
  private maxAgeMs: number;          // default: 30 * 60 * 1000

  private buildKey(sessionId: string, traceId: string): string {
    return `${sessionId}::${traceId}`;
  }

  getOrCreate(sessionId: string, traceId: string): EnhancedSessionContext;
  set(sessionId: string, traceId: string, ctx: EnhancedSessionContext): void;
  get(sessionId: string, traceId?: string): EnhancedSessionContext | undefined;
  remove(sessionId: string, traceId?: string): void;
  cleanupStale(): number;
}
```

### 1.2 持久态：TraceAgentState 迁移守卫

位置：`backend/src/agent/state/traceAgentState.ts`

`migrateTraceAgentState(snapshot, expected)` 会校验 snapshot 内的 sessionId/traceId；不匹配直接创建新 state。

```typescript
export function migrateTraceAgentState(
  snapshot: any,
  expected: { sessionId: string; traceId: string }
): TraceAgentState {
  // Trace scoping guard: never accept cross-trace state.
  if (snapSessionId !== expected.sessionId) return createInitialTraceAgentState(...);
  if (snapTraceId !== expected.traceId) return createInitialTraceAgentState(...);
  // v1: normalize and fill defaults...
}
```

---

## 2. 内存对象分层（当前真实实现）

### 2.1 EnhancedSessionContext（会话上下文）

位置：`backend/src/agent/context/enhancedSessionContext.ts`

持有：
- `turns: ConversationTurn[]`：本 trace 的多轮对话记录（带 turnIndex）
- `findings: Map<string, Finding>`：findingId -> Finding
- `findingTurnMap: Map<string, string>`：findingId -> turnId
- `references: FindingReference[]`：跨 finding 的引用关系
- `topicsDiscussed: Set<string>`：讨论过的主题
- `openQuestions: string[]`：待回答问题列表
- `entityStore: EntityStore`：实体缓存 + "是否已分析"追踪
- `workingMemory: WorkingMemoryEntry[]`：从结论中确定性抽取的语义摘要（短文本）
- `traceAgentState: TraceAgentState | null`：目标驱动 durable state

关键方法：

| 方法 | 用途 |
|------|------|
| `addTurn()` | 新增对话轮次，注册 findings |
| `completeTurn()` | 标记轮次完成，追加新 findings |
| `getOrCreateTraceAgentState()` | 获取或创建 durable state |
| `updateTraceAgentGoalFromIntent()` | 从意图理解更新 normalizedGoal |
| `recordTraceAgentTurn()` | 追加 turnLog 审计条目 |
| `ingestEvidenceFromResponses()` | 从 Agent 响应中批量提取 evidence digests |
| `addEvidenceDigest()` | 添加单条 evidence |
| `startTraceAgentExperiment()` / `completeTraceAgentExperiment()` | 实验生命周期管理 |
| `recordTraceAgentContradiction()` | 记录数据矛盾 |
| `refreshTraceAgentCoverage()` | 从 EntityStore + evidence 刷新覆盖度 |
| `updateWorkingMemoryFromConclusion()` | 确定性提取结论摘要到 working memory |
| `extractReferenceableEntities()` | 提取可引用实体（EntityStore 优先，findings fallback） |
| `generatePromptContext(maxTokens)` | 生成 LLM prompt 注入的短期记忆 |
| `generateContextSummary()` | 生成上下文摘要 |
| `serialize()` / `deserialize()` | 序列化/反序列化 |

### 2.2 TraceAgentState（durable state）

位置：`backend/src/agent/state/traceAgentState.ts`

核心接口：

```typescript
export interface TraceAgentState {
  version: number;               // 当前 v1
  sessionId: string;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  goal: TraceAgentGoalSpec;      // userGoal, normalizedGoal, doneWhen, stopWhen
  preferences: TraceAgentPreferences;  // maxExperimentsPerTurn, defaultLoopMode, language, qualityFirst
  coverage: TraceAgentCoverage;  // entities, timeRanges, domains, packages
  turnLog: TraceAgentTurnLogEntry[];
  hypotheses: TraceAgentHypothesis[];
  evidence: TraceAgentEvidence[];
  experiments: TraceAgentExperiment[];
  contradictions: TraceAgentContradiction[];
}
```

关键字段与用途：
- `goal`：用户目标（intent 可更新 normalizedGoal，可选 doneWhen/stopWhen 条件）
- `preferences`：默认 loop 模式（hypothesis_experiment）、输出视图（conclusion_evidence）、maxExperimentsPerTurn（默认 3，范围 1-10）、language（zh）、qualityFirst（true）
- `coverage`：已分析的 frames/sessions 实体 ID、timeRanges、domains、packages（用于"已经查过 X，不要重复"）
- `experiments`：实验记录（type: run_skill/run_sql/repair_sql/ask_user/stop，status: planned/running/succeeded/failed/skipped）
- `evidence`：证据摘要（kind: sql/skill/derived，含 digest + source provenance）
- `contradictions`：矛盾（severity: minor/major/critical，关联 evidenceIds 和 hypothesisIds）
- `hypotheses`：假设（status: proposed/investigating/confirmed/rejected，含 supportingEvidenceIds/contradictingEvidenceIds/gaps）
- `turnLog`：轮次审计日志

### 2.3 EntityStore（实体缓存）

位置：`backend/src/agent/context/entityStore.ts`

Session-scoped 的实体缓存，支持 7 种实体类型：

| 实体类型 | 接口 | ID 字段 | 用途 |
|----------|------|---------|------|
| `frame` | `FrameEntity` | `frame_id` | 帧渲染分析（jank analysis） |
| `session` | `SessionEntity` | `session_id` | 滚动会话 |
| `cpu_slice` | `CpuSliceEntity` | `slice_id` | CPU 调度切片 |
| `binder` | `BinderEntity` | `transaction_id` | IPC/Binder 事务 |
| `gc` | `GcEntity` | `gc_id` | GC 事件 |
| `memory` | `MemoryEntity` | `memory_id` | 内存分配/事件 |
| `generic` | `GenericEntity` | `entity_id` | 可扩展通用类型 |

关键设计原则：
- **String ID**：避免 >2^53 精度丢失（frame token 可以是 64-bit）
- **Snake_case** 规范字段名
- **Provenance 追踪**：source 字段记录来源（table/interval/finding/enrichment）
- **Merge 语义**：upsert 时新非空字段覆盖旧值，更新 updated_at

```typescript
export class EntityStore {
  // 每种实体类型独立 Map 存储
  private framesById = new Map<EntityId, FrameEntity>();
  private sessionsById = new Map<EntityId, SessionEntity>();
  private cpuSlicesById = new Map<EntityId, CpuSliceEntity>();
  private bindersById = new Map<EntityId, BinderEntity>();
  private gcsById = new Map<EntityId, GcEntity>();
  private memoriesById = new Map<EntityId, MemoryEntity>();
  private genericsById = new Map<EntityId, GenericEntity>();

  // 增量分析追踪
  private analyzedFrameIds = new Set<EntityId>();
  private analyzedSessionIds = new Set<EntityId>();
  private lastCandidateFrameIds: EntityId[] = [];
  private lastCandidateSessionIds: EntityId[] = [];
  private analyzedEntityIds = new Map<string, Set<EntityId>>(); // 通用化追踪
}
```

增量分析能力：
- `markFrameAnalyzed()` / `wasFrameAnalyzed()`：标记/检查帧是否已分析
- `setLastCandidateFrames()` / `getUnanalyzedCandidateFrames()`：管理候选帧列表
- `markEntityAnalyzed(entityType, id)` / `wasEntityAnalyzed(entityType, id)`：通用化分析追踪
- 批量操作：`upsertFrames()`, `upsertSessions()`, `upsertCpuSlices()`, `upsertBinders()`, `upsertGcs()`, `upsertMemories()`, `upsertGenerics()`

序列化快照接口：

```typescript
export interface EntityStoreSnapshot {
  version: number;
  framesById: Array<[EntityId, FrameEntity]>;
  sessionsById: Array<[EntityId, SessionEntity]>;
  cpuSlicesById?: Array<[EntityId, CpuSliceEntity]>;
  bindersById?: Array<[EntityId, BinderEntity]>;
  gcsById?: Array<[EntityId, GcEntity]>;
  memoriesById?: Array<[EntityId, MemoryEntity]>;
  genericsById?: Array<[EntityId, GenericEntity]>;
  analyzedFrameIds: EntityId[];
  analyzedSessionIds: EntityId[];
  lastCandidateFrameIds: EntityId[];
  lastCandidateSessionIds: EntityId[];
  analyzedEntityIds?: Record<string, EntityId[]>;
}
```

### 2.4 FocusStore（用户关注点追踪）

位置：`backend/src/agent/context/focusStore.ts`

基于衰减权重的用户关注点追踪，支持跨轮次增量分析：

```typescript
export type FocusType = 'entity' | 'timeRange' | 'metric' | 'question';

export interface UserFocus {
  id: string;
  type: FocusType;
  target: FocusTarget;
  weight: number;               // 0-1，基于交互频率和时间衰减
  lastInteractionTime: number;
  interactionHistory: FocusInteraction[];
  createdAt: number;
}
```

FocusTarget 支持四种关注类型：
- **Entity focus**：entityType (frame/process/thread/session/cpu_slice/binder/gc/memory) + entityId
- **Time range focus**：start/end 纳秒时间戳
- **Metric focus**：metricName + 可选 threshold
- **Question focus**：问题文本 + 可选分类

配置参数（`FocusStoreConfig`）：
- `maxFocuses`: 20（最大追踪数）
- `decayRatePerMinute`: 0.05（5% 每分钟衰减）
- `boostMultiplier`: 1.5（交互增强因子）
- `minWeight`: 0.1（低于此权重自动移除）
- `maxHistoryPerFocus`: 10（每个焦点最大交互历史）

关键方法：
- `recordInteraction()` / `recordEntityClick()` / `recordTimeRangeClick()` / `recordQuestion()` / `recordDrillDown()`：记录交互
- `getTopFocuses(limit)` / `getPrimaryFocus()`：获取当前焦点
- `buildFocusContext(maxFocuses)`：生成 LLM prompt 友好的关注点描述
- `buildIncrementalContext()`：为增量分析构建 focusedEntities/focusedTimeRanges/focusedQuestions
- `syncWithEntityStore(entityStore)`：同步 EntityStore，移除已不存在的实体焦点
- `serialize()` / `deserialize()`：序列化（BigInt-safe）

### 2.5 WorkingMemory（语义记忆）

位置：内嵌于 `EnhancedSessionContext`

确定性（无 LLM 调用）的跨轮次摘要，从结论的 Markdown 结构中提取：

```typescript
interface WorkingMemoryEntry {
  turnIndex: number;
  timestamp: number;
  query: string;
  confidence?: number;
  conclusions: string[];   // 从 ## 结论 section 提取 bullet points
  nextSteps: string[];     // 从 ## 下一步 section 提取
}
```

`updateWorkingMemoryFromConclusion()` 提取逻辑：
1. 用正则匹配 `## 结论` 和 `## 下一步` 两个 Markdown section
2. 提取 bullet points（`-` 或 `*` 或 `1.` 开头的行）
3. 无 bullet 时 fallback 取前两行非空文本
4. 无结论时 fallback 取置信度最高的 3 个 finding titles
5. 最多保留 12 条 entries

---

## 3. 有界增长（避免 memory 膨胀）

当前主链路在写入 TraceAgentState / workingMemory 时有明确上限：

| 数据结构 | 上限 | 截断策略 |
|----------|------|----------|
| `TraceAgentState.turnLog` | 最近 30 条 | `slice(-30)` |
| `TraceAgentState.evidence` | 总量上限 500 | `slice(-500)`，每次 ingest 最多新增 40 |
| `TraceAgentState.experiments` | 最近 80 条 | `slice(-80)` |
| `TraceAgentState.contradictions` | 最近 40 条 | `slice(-40)` |
| `EnhancedSessionContext.workingMemory` | 最近 12 条 | `slice(-12)` |
| `FocusStore.focuses` | 最多 20 个 | 按权重淘汰最低的 |
| `TraceAgentState.coverage.entities.frames` | 最近 120 | `slice(-120)` |
| `TraceAgentState.coverage.entities.sessions` | 最近 60 | `slice(-60)` |
| `TraceAgentState.coverage.timeRanges` | 最近 20 | `slice(-20)` |
| `TraceAgentState.coverage.domains` | 最近 20 | `slice(-20)` |
| `TraceAgentState.coverage.packages` | 最近 20 | `slice(-20)` |

设计原则：
- **长期 memory 存"摘要 + provenance"，不存大表**（大表通过 DataEnvelope/SSE 给前端）
- **摘要要可 dedupe**：evidence digest 基于 SHA1 hash 去重，保持稳定、适度截断，避免每次执行都膨胀
- **Finding 的 evidence 引用列表上限 10 条**：`ensureEvidenceIdOnFinding()` 中 `merged.slice(0, 10)`

---

## 4. 证据摘要（Evidence digests）：从"文本复述"到"可引用链路"

### 4.1 为什么需要 evidence digest

LLM 直接读表格会出现两类问题：
- 机械化复述（缺洞见）
- 多轮后遗忘/重复（缺闭环）

Evidence digest 的目标是把"工具输出"压缩成可注入 prompt 的短证据片段，并保留 provenance：
- agentId / toolName / skillId / executionMode / scopeLabel / group / timeRange / packageName / stageName / round

实现入口：`EnhancedSessionContext.ingestEvidenceFromResponses(responses, hint?)`

### 4.2 Evidence ID 生成

Evidence ID 基于内容 hash 保证幂等去重：

```typescript
const key = `${state.traceId}|${kind}|${title}|${digest}`;
const id = `ev_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
```

同样，contradiction ID 也基于 hash：
```typescript
const key = `${state.traceId}|${description}`;
const id = `cx_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
```

### 4.3 digest 的内容

`buildToolResultDigest()` 从 tool result 中提取紧凑摘要，包括：
- `scope`、`pkg`、`t`（时间范围）
- `success`、`rows`、`envelopes`、`tables`、`tableRows`
- `findings` 统计（crit/warn/info 分布）
- `kpi`：从 overview/summary envelope 提取关键指标
- `sample`：从 data 中提取首行 KPI 字段
- 最终截断到 260 字符

### 4.4 digest 的边界

digest 不是为了复现整张表：
- 仅保留 rowCount、表标题、关键 KPI 片段、错误摘要、少量 sample
- 严格截断（稳定性与去重优先）
- stage/round 信息存于 `evidence.source`（不参与 digest hash，避免同一数据因不同阶段产生重复）

---

## 5. Prompt 注入策略（短期 memory 的工程化落点）

入口：`EnhancedSessionContext.generatePromptContext(maxTokens)`

内容结构（实际拼接顺序）：

1. **目标与偏好**：Goal（normalizedGoal > userGoal）+ maxExperimentsPerTurn
2. **覆盖度**：domains、entities (frames/sessions count)、packages、timeRanges (count + tail samples)
3. **最近实验**：最后 3 条实验的 status + objective + evidence count
4. **证据摘要**：最后 8 条 evidence 的 id + title + digest (截断 140 字符)
5. **矛盾摘要**：最后 3 条 contradiction 的 severity + description
6. **语义记忆**：最后 6 条 WorkingMemoryEntry（turnIndex、confidence、结论 bullets、下一步）
7. **对话历史**：最后 3 轮 turns（query、severity-prioritized findings top 5、可引用实体 identifiers）
8. **关键发现**：high/critical/warning severity 的 top 5 findings
9. **讨论主题**：topicsDiscussed (top 5)
10. **待回答问题**：openQuestions (top 3)

末端保护：
- 粗略 token 估算（中文按 4 chars/token）
- 超限按比例截断（`result.substring(0, Math.floor(result.length * ratio)) + '...'`）

---

## 6. Context Isolation（上下文隔离系统）

### 6.1 设计理念

位置：`backend/src/agent/context/contextBuilder.ts`、`contextTypes.ts`、`policies/`

为不同角色的 Agent 提供适当的可见性，减少不必要的 token 消耗。

### 6.2 ContextBuilder

```typescript
export class ContextBuilder {
  private config: ContextBuilderConfig;
  private policies: Map<string, ContextPolicy>;

  buildContext(context: SubAgentContext, stage: PipelineStage): SubAgentContext | IsolatedContext;
}
```

根据 `PipelineStage.agentType` 查找匹配的 `ContextPolicy`，生成 `IsolatedContext`。

### 6.3 隔离后的上下文

```typescript
export interface IsolatedContext extends Omit<SubAgentContext, 'intent' | 'plan' | 'previousResults'> {
  intent?: Intent | IntentSummary;
  plan?: AnalysisPlan | PlanSummary;
  previousResults?: (StageResult | StageResultSummary)[];
  isIsolated: true;
  appliedPolicy: string;
}
```

### 6.4 Context Policies

三种内置策略（`backend/src/agent/context/policies/`）：

| 策略 | Agent 类型 | 可见字段 | 特点 |
|------|-----------|---------|------|
| `plannerPolicy` | planner | intent (full), previousResults (summary) | 只看高优先级 findings (top 5)，不看 plan/traceProcessor |
| `evaluatorPolicy` | evaluator | intent (full), plan (full), previousResults (full) | 看所有结果但简化大型 data（数组 >10 项只保留 count + sample 3 项）|
| `workerPolicy` | worker, analysisWorker, scrollingExpert | intent (summary), plan (summary), traceProcessor (full) | 只看最近 2 个 stage 的 critical findings (top 3) |

Worker 策略支持阶段级定制：`createWorkerPolicyForStage(stageId, dependencies)` 只保留声明依赖阶段的结果。

字段可见性级别：

```typescript
export type VisibilityLevel = 'full' | 'summary' | 'none';
export type ContextField = 'sessionId' | 'traceId' | 'intent' | 'plan'
  | 'previousResults' | 'traceProcessor' | 'traceProcessorService' | 'metadata';
```

---

## 7. Token 溢出防护（Compaction 系统）

### 7.1 架构概览

位置：`backend/src/agent/compaction/`

```
SubAgentContext → TokenEstimator.needsCompaction(threshold) → true?
    → ContextCompactor.compact(context, reason) → CompactionResult
        → SlidingWindowStrategy: 保留最近 N 个 results，历史压缩为摘要
```

### 7.2 CompactionConfig

```typescript
export interface CompactionConfig {
  maxContextTokens: number;         // 默认 8000
  compactionThreshold: number;      // 默认 6000 (80%)
  preserveRecentCount: number;      // 默认 3
  strategy: CompactionStrategy;     // 'sliding_window' | 'severity' | 'hybrid'
  useLLMSummarization: boolean;     // 默认 false
  preserveCriticalFindings?: boolean; // 默认 true
}
```

### 7.3 TokenEstimator

```typescript
export class TokenEstimator {
  // 估算配置
  charsPerToken: 0.4;        // 中英文混合
  jsonOverheadFactor: 1.2;   // JSON 结构开销

  estimate(context): TokenEstimate;          // 详细分解
  needsCompaction(context, threshold): boolean; // 快速检查
  estimateWithThreshold(context, config): TokenEstimate; // 带阈值判断
}
```

`TokenEstimate` 包含各字段 token 分解：sessionId、traceId、intent、plan、previousResults、findings、other。

### 7.4 SlidingWindowStrategy

位置：`backend/src/agent/compaction/strategies/slidingWindowStrategy.ts`

压缩流程：
1. 检查 `previousResults.length > preserveRecentCount`
2. 分离：前 N-preserve 个结果压缩，后 preserve 个保留
3. 收集被压缩的 findings，保留 critical 级别的
4. 生成规则基础的 `CompactionSummary`：
   - `historicalResultsSummary`：压缩了多少个结果、成功/失败数、涉及的阶段、总耗时
   - `keyFindingsSummary`：Critical/Warning/Info 统计、保留的 Critical 发现标题、涉及的类别
5. 返回 `CompactionResult` 包含压缩后的上下文、压缩比、移除数量

### 7.5 ContextCompactor

- 全局 singleton：`getContextCompactor()`
- `compactIfNeeded(context)` 自动检查并压缩
- 维护每 session 的 `CompactorState`：压缩次数、累计移除数、历史摘要

---

## 8. Checkpoint 系统（暂停/恢复）

位置：`backend/src/agent/state/checkpointManager.ts`

### 8.1 设计

文件系统基础的检查点管理，将分析进度快照写入磁盘，支持进程重启后恢复。

```typescript
export interface CheckpointManagerConfig {
  checkpointDir?: string;              // 默认: ./agent-checkpoints
  retentionMs?: number;                // 默认: 24 小时
  maxCheckpointsPerSession?: number;   // 默认: 10
}
```

### 8.2 Checkpoint 结构

每个检查点包含：
- `id`：`${sessionId}_${stageId}_${timestamp}`
- `stageId`：当前阶段 ID
- `phase`：当前 AgentPhase
- `agentState`：序列化的 agent 状态（query, traceId, intent, plan, expertResults, iterationCount, metadata）
- `stageResults`：阶段结果数组
- `findings`：发现列表
- `canResume`：是否可恢复

### 8.3 主要操作

| 操作 | 说明 |
|------|------|
| `createCheckpoint()` | 创建检查点，自动清理超过限制的旧检查点 |
| `loadCheckpoint()` | 加载指定检查点 |
| `getLatestCheckpoint()` | 获取最新检查点 |
| `listCheckpoints()` | 列出所有检查点 |
| `canResume()` | 检查是否有可恢复检查点 |
| `cleanupExpired()` | 清理过期检查点 |
| `listRecoverableSessions()` | 列出所有可恢复的 session |

---

## 9. SessionStore（会话生命周期管理）

位置：`backend/src/agent/state/sessionStore.ts`

### 9.1 设计

文件系统 + 内存缓存的会话管理，继承 EventEmitter 支持事件通知。

```typescript
export interface SessionStoreConfig {
  sessionDir?: string;          // 默认: ./agent-sessions
  retentionMs?: number;         // 默认: 7 天
  maxActiveSessions?: number;   // 默认: 100
}

export interface SessionData extends SessionInfo {
  intent?: Intent;
  plan?: AnalysisPlan;
  startTime: number;
  endTime?: number;
  metadata: Record<string, any>;
}
```

### 9.2 阶段状态机

AgentPhase 状态：`idle` | `planning` | `executing` | `evaluating` | `refining` | `awaiting_user` | `completed` | `failed`

可恢复阶段：除 `idle`、`completed`、`failed` 外的所有阶段。

### 9.3 事件

| 事件 | 触发时机 |
|------|---------|
| `sessionCreated` | 新会话创建 |
| `sessionUpdated` | 阶段状态变更 |
| `intentUpdated` | 意图更新 |
| `planUpdated` | 计划更新 |
| `sessionFailed` | 会话失败 |
| `checkpointSet` | 设置检查点 |
| `sessionDeleted` | 会话删除 |
| `closed` | 存储关闭 |

---

## 10. 会话分叉系统（Fork / Merge）

### 10.1 ForkManager

位置：`backend/src/agent/fork/forkManager.ts`

允许从检查点创建分叉会话，探索不同的分析路径，之后可以比较和合并结果。

```typescript
export interface ForkManagerConfig extends ForkConfig {
  stateDir?: string;    // 默认: ./agent-state/forks
}

// ForkConfig 默认值
enabled: boolean;
maxForkDepth: number;
maxForksPerSession: number;
allowNestedForks: boolean;
autoCleanupMerged: boolean;
```

Fork 操作流程：
1. 验证启用状态、深度限制、数量限制、嵌套限制
2. 加载源检查点
3. 生成新 session ID：`fork_${uuid.slice(0, 8)}`
4. 在 SessionTree 中添加分叉节点
5. 复制检查点到新 session（添加 forkedFrom/sourceCheckpoint metadata）
6. 复制父 context 到新 session
7. 持久化状态

### 10.2 SessionTree

位置：`backend/src/agent/fork/sessionTree.ts`

树形结构管理会话间的父子关系：

```typescript
export interface SessionNode {
  sessionId: string;
  parentSessionId: string | null;
  childSessionIds: string[];
  branchName: string;
  forkCheckpointId: string | null;
  depth: number;
  createdAt: number;
  status: SessionNodeStatus;   // 'active' | 'completed' | 'merged' | 'abandoned' | 'expired'
  hypothesis?: string;
  summary?: SessionNodeSummary;
}
```

查询能力：
- `getAncestors()` / `getDescendants()` / `getSiblings()` / `getChildren()`
- `getLeaves()` / `getNodesByStatus()` / `getNodesByDepth()`
- `findLowestCommonAncestor()` / `haveCommonAncestor()`
- `getPathFromRoot()` / `getPathBetween()`
- `getActiveForkCount()` / `getMaxDepth()`
- `toTreeString()`：生成树形可视化

### 10.3 合并策略

位置：`backend/src/agent/fork/mergeStrategies.ts`

四种内置合并策略：

| 策略 | 名称 | 行为 |
|------|------|------|
| `ReplaceStrategy` | `replace` | 完全用子会话结果替换父会话 |
| `AppendStrategy` | `append` | 追加子会话结果到父会话，检测冲突并按配置解决 |
| `MergeFindingsStrategy` | `merge_findings` | 只合并 findings，不改变 results |
| `CherryPickStrategy` | `cherry_pick` | 只合并符合过滤条件的内容 |

冲突解决策略（`ConflictResolution`）：
- `prefer_parent`：保留父会话发现
- `prefer_child`：使用子会话发现
- `prefer_higher_severity`：使用严重程度更高的发现
- `keep_both`：保留两个，通过 title 前缀标记

比较能力（`ForkManager.compare(sessionIds)`）：
- 找出共同发现、各会话独有发现、冲突发现
- 生成 `SessionSummaryComparison`：总发现数、critical 数、覆盖域、质量评分
- 推荐最佳会话

---

## 11. Hook 系统（生命周期钩子）

### 11.1 架构

位置：`backend/src/agent/hooks/`

借鉴 Claude Agent SDK 的 Hooks 设计，支持 pre/post 两阶段的事件钩子。

### 11.2 事件类型

```typescript
export type HookEventType =
  | 'tool:use'             // Tool 层：BaseSubAgent.act()
  | 'subagent:start' | 'subagent:complete' | 'subagent:error'   // SubAgent 层
  | 'session:start' | 'session:end' | 'session:checkpoint' | 'session:error'   // Session 层
  | 'iteration:start' | 'iteration:end';   // Iteration 层

export type HookPhase = 'pre' | 'post';
```

### 11.3 HookHandler

```typescript
export interface HookHandler<T extends HookEventType> {
  name: string;
  priority: number;           // 越小越先执行，默认 100
  handler: (event: HookEvent<T>, context: HookContext) => Promise<HookResult>;
  enabled?: boolean;
  filter?: (event: HookEvent<T>) => boolean;  // 可选过滤器
}
```

HookResult 控制流：
- `continue: true`：继续执行后续 hook
- `continue: false`：中断 hook 链
- `modifiedData`：修改事件数据（pre hook 用于修改输入）
- `substituteResult`：完全替代操作结果

### 11.4 HookRegistry

```typescript
export class HookRegistry {
  register<T>(eventType, phase, handler): () => void;  // 返回取消注册函数
  use(middleware: HookMiddleware): () => void;           // 批量注册中间件
  execute<T>(event, context?): Promise<HookResult>;      // 执行 hook 链
  executePre<T>(eventType, sessionId, data): Promise<HookResult>;
  executePost<T>(eventType, sessionId, data): Promise<HookResult>;
}
```

配置（`HookRegistryConfig`）：
- `enabled`: 默认 true
- `defaultTimeout`: 默认 5000ms（每个 handler 的执行超时）
- `continueOnError`: 默认 true（handler 出错不中断链）

### 11.5 HookContext

```typescript
export interface HookContext {
  sessionId: string;
  traceId: string;
  phase?: string;
  aborted: boolean;
  abortReason?: string;
  metadata: Map<string, unknown>;   // hook 间共享数据
  abort(reason?: string): void;
  set(key: string, value: unknown): void;
  get<T>(key: string): T | undefined;
}
```

支持子上下文继承：`deriveHookContext(parent, overrides?)` 创建子上下文并复制父 metadata。

### 11.6 内置中间件

| 中间件 | 优先级 | 功能 |
|--------|--------|------|
| `timingMiddleware` | 0 (最先) | pre 阶段记录开始时间，post 阶段计算耗时；超过 slowThresholdMs (默认 5000ms) 打印警告 |
| `loggingMiddleware` | 1000 (最后) | 记录所有 hook 事件到 console 和 context metadata |

`TimingMetricsAggregator` 可聚合计时统计：count、min、max、avg、p50、p95、p99。

---

## 12. 持久化（跨重启恢复）

### 12.1 SessionPersistenceService（SQLite）

位置：`backend/src/services/sessionPersistenceService.ts`

基于 better-sqlite3 的长期持久化，使用 WAL 模式：

```
data/sessions/sessions.db
  ├── sessions 表：id, trace_id, trace_name, question, created_at, updated_at, metadata (JSON)
  └── messages 表：id, session_id, role, content, timestamp, sql_result (JSON)
```

metadata JSON 字段中存储所有快照：

| 快照 | 存储方法 | 恢复方法 | 说明 |
|------|---------|---------|------|
| `sessionContextSnapshot` | `saveSessionContext()` | `loadSessionContext()` | `EnhancedSessionContext.serialize()` 产生的 JSON 字符串 |
| `entityStoreSnapshot` | `saveEntityStore()` (或 saveSessionContext 自动) | `loadEntityStore()` | EntityStore 序列化快照 |
| `focusStoreSnapshot` | `saveFocusStore()` | `loadFocusStore()` | FocusStore 序列化快照 |
| `traceAgentStateSnapshot` | `saveTraceAgentState()` | `loadTraceAgentState()` | TraceAgentState 完整对象 |

辅助查询：
- `hasEntityStore()` / `hasSessionContext()` / `hasFocusStore()` / `hasTraceAgentState()`：快速检查快照是否存在
- `getEntityStoreStats()`：无需完整反序列化即可获取 frame/session 计数
- `cleanupOldSessions(daysToKeep=30)`：清理过期会话
- `exportSessions(traceId?)`：导出为 JSON 备份

### 12.2 SessionLogger（JSONL 日志）

位置：`backend/src/services/sessionLogger.ts`

每个分析 session 一个独立 JSONL 文件：

```
logs/sessions/session_{sessionId}_{timestamp}.jsonl
```

```typescript
export interface LogEntry {
  timestamp: string;
  level: LogLevel;        // 'debug' | 'info' | 'warn' | 'error'
  sessionId: string;
  component: string;
  message: string;
  data?: any;
  duration?: number;
  error?: { name: string; message: string; stack?: string; };
}
```

特性：
- 每 session 最多 10000 条日志（防止 runaway logging）
- 7 天自动清理（`MAX_LOG_AGE_MS`）
- 支持 `timed<T>(component, operation, fn)` 方法自动记录操作耗时
- `SessionLoggerManager`：管理所有 session 的 logger 生命周期
  - `getLogger(sessionId)`：获取或创建 logger
  - `listSessions()`：列出所有 session 日志摘要
  - `readSessionLogs(sessionId, query?)`：查询日志，支持 level/component/startTime/endTime/search/limit 过滤
  - `cleanup(maxAgeMs)`：清理旧日志文件
- 提供 Express 中间件 `requestLoggingMiddleware` 记录 HTTP 请求

---

## 13. 组件关系总图

```
┌─────────────────────────────────────────────────────────────┐
│                    SessionContextManager                     │
│  key = sessionId::traceId, LRU 100, maxAge 30min            │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              EnhancedSessionContext                     │  │
│  │                                                        │  │
│  │  turns[]  findings{}  workingMemory[]  openQuestions[] │  │
│  │                                                        │  │
│  │  ┌──────────────┐  ┌──────────────────────────────┐   │  │
│  │  │  EntityStore  │  │     TraceAgentState (v1)     │   │  │
│  │  │              │  │                              │   │  │
│  │  │  7 entity    │  │  goal, preferences, coverage │   │  │
│  │  │  types +     │  │  turnLog, hypotheses,        │   │  │
│  │  │  incremental │  │  evidence, experiments,      │   │  │
│  │  │  tracking    │  │  contradictions              │   │  │
│  │  └──────────────┘  └──────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  FocusStore  │  │ContextBuilder│  │ContextCompactor  │   │
│  │  (衰减权重)   │  │ (隔离策略)    │  │ (token 溢出防护) │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ serialize / persist
                           ▼
┌──────────────────────────────────────────────────────────────┐
│           SessionPersistenceService (SQLite)                  │
│                                                               │
│  sessions.metadata JSON:                                      │
│    sessionContextSnapshot   (EnhancedSessionContext)          │
│    entityStoreSnapshot      (EntityStore)                     │
│    focusStoreSnapshot       (FocusStore)                      │
│    traceAgentStateSnapshot  (TraceAgentState)                 │
└──────────────────────────────────────────────────────────────┘

┌─────────────────────┐  ┌──────────────────────┐
│  CheckpointManager  │  │     SessionStore     │
│  (filesystem JSON)  │  │  (filesystem JSON +  │
│  ./agent-checkpoints│  │   memory Map cache)  │
│  24h retention      │  │  ./agent-sessions    │
│  10 per session     │  │  7d retention        │
└─────────────────────┘  └──────────────────────┘

┌─────────────────────┐  ┌──────────────────────┐
│    ForkManager      │  │    HookRegistry      │
│  SessionTree +      │  │  pre/post hooks +    │
│  MergeStrategies    │  │  timing/logging      │
│  4 merge strategies │  │  middleware           │
└─────────────────────┘  └──────────────────────┘

┌─────────────────────┐
│   SessionLogger     │
│  JSONL per session  │
│  ./logs/sessions/   │
│  7d cleanup         │
└─────────────────────┘
```

---

## 14. 各组件主链路接入状态

| 组件 | 主链路接入 | 说明 |
|------|-----------|------|
| EnhancedSessionContext | **已接入** | AgentDrivenOrchestrator 核心上下文 |
| TraceAgentState | **已接入** | goal/evidence/experiment/contradiction 全链路使用 |
| EntityStore | **已接入** | drill-down、extend、entity capture 使用 |
| FocusStore | **已接入** | 持久化已支持，增量分析引用 |
| WorkingMemory | **已接入** | generatePromptContext() 中注入 |
| SessionPersistenceService | **已接入** | SQLite 持久化 |
| SessionLogger | **已接入** | 全链路 JSONL 日志 |
| ContextBuilder | **已接入** | PipelineExecutor 使用隔离策略 |
| ContextCompactor | **部分接入** | 基础设施就绪，SlidingWindowStrategy 实现完整，但自动触发的调用点需确认 |
| CheckpointManager | **部分接入** | 基础设施就绪，主链路的 checkpoint 创建/恢复调用点需确认 |
| SessionStore | **部分接入** | 基础设施就绪，与路由层的内存 Map 会话管理并行存在 |
| ForkManager | **部分接入** | 基础设施完整（fork/compare/merge），主链路触发入口尚未完全集成 |
| HookRegistry | **部分接入** | 基础设施完整，内置 timing/logging middleware 就绪，实际挂载点需确认 |

---

## 15. 下一步建议（真正让 memory 成为推理资产）

1. **矛盾 -> 实验闭环**：contradictions 进入 planning，优先选择能消解冲突的数据/实验
2. **证据链可追溯**：finding 增加 evidenceIds（指向 TraceAgentState.evidence），让结论可自动生成链路摘要
3. **偏好可调**：允许用户显式设置"快/准/可解释"，并映射到 soft budget、策略选择与输出视图
4. **ContextCompactor 主链路集成**：在 HypothesisExecutor 多轮循环中自动触发 `compactIfNeeded()`
5. **Hook 系统完整挂载**：在 AgentDrivenOrchestrator 的 session/iteration/subagent 生命周期中调用 HookRegistry
6. **Checkpoint 恢复集成**：在 POST /api/agent/analyze 入口检查 `canResume()`，提供恢复选项
7. **Fork 体验完善**：暴露 fork/compare/merge API，支持用户在分析过程中创建分支探索
