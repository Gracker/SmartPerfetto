# 多轮对话设计深度解析（同一 trace 的连续推理）

> 对齐版本：2026-02-06
> 目标：让用户感觉在和"懂 Android + 懂当前 trace"的专家对话，而不是每轮重新跑一遍 pipeline。

---

## 0. 先给结论：多轮对话的核心不是"存聊天记录"，而是"存可用状态"

多轮对话想要不机械，必须让模型每轮都能清楚回答三件事：

1. **用户目标是什么**（Goal / Done-when）
2. **我们已经做了哪些实验、拿到了哪些证据**（Experiments / Evidence digests）
3. **下一步为什么要做这个，而不是别的**（Hypothesis space + 信息增益）

因此 SmartPerfetto 的多轮对话不是靠"拼接全部历史文本"，而是靠 trace-scoped 的结构化状态：

- `EnhancedSessionContext`：turns/findings/entity store/working memory
- `TraceAgentState`：目标/偏好/实验/证据摘要/矛盾（durable）
- `EntityStore`：可 drill-down 的实体缓存（frame/session/cpu_slice/binder/gc/memory/generic）
- `FocusStore`：用户关注点（实体/时间段/指标/问题）与增量范围

---

## 1. 不变式：必须严格 trace-scoped（"仅同一 trace"）

### 1.1 复合 key（sessionId, traceId）

- 内存态：`SessionContextManager` 使用 `sessionId::traceId` 做复合键
- 切换 trace 时自动清理同 sessionId 旧上下文（`cleanupOldTracesForSession`）
- LRU 逐出策略（默认上限 100 个上下文、30 分钟超时）
- 迁移态：`migrateTraceAgentState` 校验 sessionId/traceId，不接受跨 trace snapshot

### 1.2 为什么这很重要

跨 trace 的"知识迁移"在性能诊断里极易制造幻觉：
- 同名进程/线程不等价
- frame_id/session_id 在不同 trace 中没有语义关联
- 证据链一旦混入错 trace，会让结论"看起来很合理但完全错误"

因此：默认禁止跨 trace memory；若未来要做跨 trace，需要用户明确授权 + 隔离设计（不在当前默认架构内）。

### 1.3 路由层的 sessionId 复用

`POST /api/agent/analyze` 接受可选的 `sessionId` 参数。若提供且匹配现有会话的 `traceId`，则复用 `AgentDrivenOrchestrator` 实例和 `SessionLogger`，实现多轮对话。否则创建新会话。

```
if (requestedSessionId && existingSession.traceId === traceId) {
  // 复用 orchestrator + logger，继续多轮对话
} else {
  // 创建新 orchestrator
}
```

---

## 2. 核心数据结构（多轮对话真正依赖的"记忆"）

### 2.1 EnhancedSessionContext（会话上下文）

位置：`backend/src/agent/context/enhancedSessionContext.ts`

职责：
- **Turn 管理**：`addTurn(query, intent, result, findings)` / `completeTurn(turnId, result, findings)` / `getAllTurns()` / `getRecentTurns(n)`
- **Findings 库**：`getAllFindings()`（并维护 `findingId -> turnId` 映射）
- **Finding 引用**：`addFindingReference(from, to, refType)` 跨 turn 建立发现关联
- **上下文摘要**：`generatePromptContext(maxTokens)` 产出 prompt-friendly 上下文，包含：目标/偏好、覆盖度、最近实验、证据摘要、矛盾、语义记忆、对话历史、关键发现、讨论主题、待回答问题
- **Working memory**：`updateWorkingMemoryFromConclusion(...)` 从结论中确定性抽取（无 LLM 调用），减少"last N turns"机械遗忘。有界存储，最多 12 条。
- **可引用实体提取**：`extractReferenceableEntities()` 优先从 EntityStore 提取，回退到 findings 扫描
- **持有**：`EntityStore`、`TraceAgentState`

序列化 / 反序列化：支持完整的 `serialize()` / `deserialize()` 用于会话持久化恢复。

### 2.2 TraceAgentState（目标驱动 durable state）

位置：`backend/src/agent/state/traceAgentState.ts`

关键字段：
- `goal`：`TraceAgentGoalSpec`（userGoal / normalizedGoal / doneWhen / stopWhen）
- `preferences`：`TraceAgentPreferences`（maxExperimentsPerTurn / defaultLoopMode / qualityFirst）
- `coverage`：`TraceAgentCoverage`（已分析的 entities/timeRanges/domains/packages）
- `turnLog`：每轮审计记录（query / followUpType / conclusionSummary / confidence），有界 30 条
- `hypotheses`：`TraceAgentHypothesis[]`（proposed/investigating/confirmed/rejected）
- `evidence`：`TraceAgentEvidence[]`（kind=sql/skill/derived + digest + provenance），有界 500 条
- `experiments`：`TraceAgentExperiment[]`（run_skill/run_sql/repair_sql/ask_user/stop），有界 80 条
- `contradictions`：`TraceAgentContradiction[]`（severity + evidenceIds + hypothesisIds + resolutionExperimentIds），有界 40 条

`EnhancedSessionContext` 提供围绕 TraceAgentState 的操作方法：
- `getOrCreateTraceAgentState(userGoalSeed)`
- `updateTraceAgentGoalFromIntent(primaryGoal)`
- `recordTraceAgentTurn(...)` — 审计记录
- `ingestEvidenceFromResponses(responses, hint)` — 从工具结果批量摄入证据摘要，自动去重（SHA-1 hash），并反向绑定到 findings
- `startTraceAgentExperiment(...)` / `completeTraceAgentExperiment(...)` — 实验生命周期
- `recordTraceAgentContradiction(...)` — 记录矛盾
- `refreshTraceAgentCoverage()` — 从 EntityStore 和 evidence 确定性刷新覆盖度

### 2.3 EntityStore（实体缓存 + 可引用实体）

位置：`backend/src/agent/context/entityStore.ts`

**支持 7 种实体类型**（Phase 3 扩展）：

| 实体类型 | 接口 | ID 字段 | 典型来源 |
|---------|------|---------|---------|
| frame | `FrameEntity` | frame_id | scrolling_analysis, jank_frame_detail |
| session | `SessionEntity` | session_id | scroll_session_analysis |
| cpu_slice | `CpuSliceEntity` | slice_id | cpu_slice_analysis, scheduling |
| binder | `BinderEntity` | transaction_id | binder_transactions |
| gc | `GcEntity` | gc_id | gc_events |
| memory | `MemoryEntity` | memory_id | memory_events, lmk_events |
| generic | `GenericEntity` | entity_id | 可扩展 |

核心能力：
- **Upsert**：`upsertFrame/upsertSession/upsertCpuSlice/upsertBinder/upsertGc/upsertMemory/upsertGeneric` + 批量 `upsertFrames/upsertSessions/...`
- **Merge 语义**：newer non-null fields overwrite existing
- **增量分析**：`wasFrameAnalyzed/markFrameAnalyzed` + `setLastCandidateFrames/getUnanalyzedCandidateFrames`（extend 的基础）
- **泛化跟踪**：`markEntityAnalyzed(entityType, id)` / `wasEntityAnalyzed(entityType, id)` 支持任意实体类型
- **ID 规范化**：统一使用 string ID（避免 BigInt >2^53 精度损失）
- **序列化**：`serialize()` / `deserialize()` 产出 `EntityStoreSnapshot`（含所有 7 种实体 + 分析状态）

### 2.4 FocusStore（用户关注点）

位置：`backend/src/agent/context/focusStore.ts`

**Focus 类型**：entity / timeRange / metric / question

**FocusTarget 可跟踪**：
- 具体实体（frame/process/thread/session/cpu_slice/binder/gc/memory）
- 时间范围（start/end）
- 指标（metricName/metricThreshold）
- 概念问题（question/questionCategory）

**交互事件**（`FocusInteraction`）：click / query / drill_down / compare / extend / explicit，来源为 ui/query/agent/system

**权重模型**：
- Decay-based weighting（配置 `decayRatePerMinute`）
- Boost multiplier for new interactions
- 低于 `minWeight` 自动移除
- `getTopFocuses(n)` 供 `ExtendExecutor` 做 focus-aware 优先级排序

---

## 3. Follow-up 类型：分类的目的不是"做 NLP"，而是"选正确的执行器"

### 3.1 Intent Understanding（意图理解）

位置：`backend/src/agent/core/intentUnderstanding.ts`

`understandIntent(query, sessionContext, modelRouter, emitter)` 通过 LLM 解析用户查询为结构化 `Intent`：

- `primaryGoal`：用户主要目标
- `aspects`：需要分析的方面
- `expectedOutputType`：diagnosis / comparison / timeline / summary
- `complexity`：simple / moderate / complex
- `followUpType`：**initial / drill_down / clarify / extend / compare**
- `referencedEntities`：用户引用的实体列表（frame/session/process/time_range/timestamp）
- `extractedParams`：可传递给 Skill 的参数

**多轮增强**：
- 注入 `sessionContext.generatePromptContext(800)` 作为历史上下文
- 注入 `sessionContext.extractReferenceableEntities()` 让 LLM 知道可引用的实体
- 带完整的实体提取规则（支持中英文、多种格式的帧/会话/进程/时间范围引用）

**Fallback**：LLM 解析失败时，使用正则匹配的规则降级：
- `DRILL_DOWN_PATTERNS`（16+ 正则：详细分析/frame N/帧 N/时间范围/为什么...）
- 自动提取 frame_id / session_id

### 3.2 Follow-up 类型 → 执行器映射

| Follow-up 类型 | 执行器 | 是否跑 SQL | 关键目标 |
|---|---|---|---|
| `drill_down` | DirectDrillDownExecutor | 是（聚焦区间） | 深挖某个 frame/session/时间段 |
| `clarify` | ClarifyExecutor | 否（只读 LLM 推理） | 解释上一轮发现/概念 |
| `extend` | ExtendExecutor | 是（批量） | 在同类候选中继续补覆盖 |
| `compare` | ComparisonExecutor | 优先缓存（SQL 兜底） | 多实体对比（差异 + 证据） |
| `initial` | HypothesisExecutor 或 StrategyExecutor | 是 | 目标驱动探索/验证 |

---

## 4. 引用解析：如何把"你刚才说的那一帧"变成可执行的参数

### 4.1 FollowUpHandler（第一层解析）

位置：`backend/src/agent/core/followUpHandler.ts`

`resolveFollowUp(intent, sessionContext)` 返回 `FollowUpResolution`：

```typescript
interface FollowUpResolution {
  isFollowUp: boolean;
  resolvedParams: Record<string, any>;   // frame_id, start_ts, end_ts, process_name 等
  focusIntervals?: FocusInterval[];      // 可直接用于 drill-down 的区间
  suggestedStrategy?: string;            // frame_drill_down / session_drill_down / comparison
  confidence: number;                    // 0.5 ~ 1.0
  resolutionDetails?: string;            // 调试日志
}
```

**实体解析流程**：
1. 遍历 `intent.referencedEntities`
2. 对每个实体，在 `sessionContext.getAllFindings()` 中匹配（支持 snake_case/camelCase 双模式 + 类型归一化）
3. 找到匹配 finding → 构建完整参数（buildFrameParams/buildSessionParams/buildProcessParams）
4. 对 drill_down 类型 → 构建 `FocusInterval`（优先从 finding、回退到 params、最后构建 minimal interval 标记 `needsEnrichment`）
5. 计算 confidence（有 timestamps + 有 intervals → 高置信度）

### 4.2 DrillDownResolver（第二层解析 - cache-first）

位置：`backend/src/agent/core/drillDownResolver.ts`

`resolveDrillDown(intent, followUp, sessionContext, traceProcessorService, traceId)` 返回 `DrillDownResolved`：

```typescript
interface DrillDownResolved {
  intervals: FocusInterval[];
  traces: DrillDownResolutionTrace[];  // 可观测性：每个实体的解析路径
}
```

解析优先级（由强到弱）：
1. **FollowUpHandler 已解析**：followUp.focusIntervals 有效且 timestamps 非占位符 → 直接使用（source: explicit）
2. **EntityStore 缓存命中**：`entityStore.getFrame(id)` 有 start_ts/end_ts → 0 SQL（source: cache）
3. **Findings 参数**：followUp.resolvedParams 有 start_ts/end_ts（source: finding）
4. **SQL 轻量 enrichment**：查询 `actual_frame_timeline_slice`（frame）或聚合 `scroll_id`（session），并**回写 EntityStore**（source: enrichment）
5. **失败**：返回 null → Orchestrator 选择降级路径

**可观测性**：每个实体的解析路径记录在 `DrillDownResolutionTrace` 中（used sources / enriched / reason / enrichmentQuery）。

### 4.3 为什么要 cache-first

用户的 follow-up 期望是"立即承接"，不是"再跑一遍全局发现"：
- cache hit：通常 < 0.5s（直接进入 deep skill）
- cache miss → enrichment：1 条轻量 SQL（仍比全局 pipeline 更快）
- enrichment 结果回写 EntityStore，后续同实体查询变 cache hit

---

## 5. 对话执行器详解

### 5.1 ClarifyExecutor（澄清执行器）

位置：`backend/src/agent/core/executors/clarifyExecutor.ts`

**特点**：纯读、零 SQL、零 trace 查询。

**流程**：
1. 从 EntityStore 和 findings 收集被引用实体数据（FrameEntity / SessionEntity）
2. 获取最近 3 轮 turn 摘要 + 上下文摘要（300 tokens）
3. 构建 prompt → LLM 生成解释（含常见卡顿类型知识库：App Deadline Missed / Buffer Stuffing / SurfaceFlinger Deadline Missed / Dropped Frame / Display HAL / GPU Composition / Present Late）
4. LLM 失败 → fallback：基于缓存数据的确定性解释

**输出**：单个 `explanation` 类型 finding，severity=info，confidence=0.9。

### 5.2 ComparisonExecutor（对比执行器）

位置：`backend/src/agent/core/executors/comparisonExecutor.ts`

**前置条件**：至少 2 个同类型实体（frame 或 session）。

**流程**：
1. 通过 `resolveDrillDown()` 解析所有实体（cache-first + SQL enrichment 兜底）
2. 从 EntityStore 构建对比数据（FrameComparisonRow / SessionComparisonRow）
3. LLM 生成叙事性差异分析（分析关键差异 + 量化 + 优化建议）
4. LLM 失败 → fallback：确定性对比（卡顿类型分布 / 最差表现 / 卡顿率差异）

**输出**：2 个 findings — comparison_table（对比表）+ comparison_narrative（叙事分析），severity 根据数据自动判定（jank_rate > 10% → critical, > 5% → warning）。

### 5.3 ExtendExecutor（扩展执行器）

位置：`backend/src/agent/core/executors/extendExecutor.ts`

**流程**：
1. 从 EntityStore 获取未分析候选：`getUnanalyzedCandidateFrames()` / `getUnanalyzedCandidateSessions()`
2. **Focus-aware 优先级排序**（v2.0）：通过 FocusStore 对未分析实体打分（直接匹配 ×10、时间重叠 ×5、同 session ×3），高分优先
3. 取一批（默认 5 个）→ 从 EntityStore 构建 FocusInterval
4. 通过 `DirectSkillExecutor` 批量执行 `jank_frame_detail`（frame）或 `scroll_session_analysis`（session）
5. 摄入证据（`ingestEvidenceFromResponses`）+ 记录实验
6. 从 responses 捕获新实体（`captureEntitiesFromResponses`）

**输出**：批量 findings + extend_summary，明确告知已分析/剩余数量，提示用户可继续 "继续分析"。返回 `capturedEntities` 和 `analyzedEntityIds` 供 orchestrator 回写。

### 5.4 DirectDrillDownExecutor（直接下钻执行器）

位置：`backend/src/agent/core/executors/directDrillDownExecutor.ts`

**特点**：零 LLM 开销（direct_skill 模式），跳过策略流水线。

**Skill 映射**：
| 实体类型 | Skill | 参数映射 |
|---------|-------|---------|
| frame | `jank_frame_detail` | start_ts, end_ts, package, frame_id, jank_type, dur_ms, main_start_ts/end_ts, render_start_ts/end_ts, pid, session_id, layer_name, token_gap, vsync_missed, jank_responsibility, frame_index |
| session | `scrolling_analysis` | start_ts, end_ts, package, session_id |

**流程**：
1. `determineTargetSkill()` — 从 resolvedParams / intervals metadata 推断实体类型
2. `enrichIntervalsIfNeeded()` — 对标记 `needsEnrichment` 的 interval 执行轻量 SQL 补齐 timestamps
3. 构建 `DirectSkillTask[]` → `DirectSkillExecutor.executeTasks()`
4. `emitDataEnvelopes()` 流式推送（含去重）
5. 摄入证据 + 记录实验
6. `synthesizeFeedback()` 综合 findings

**输出**：直接从 Skill 执行结果产出 findings + dataEnvelopes。

---

## 6. Entity Capture：从分析结果中自动提取实体

位置：`backend/src/agent/core/entityCapture.ts`

### 6.1 数据来源

| Step ID 模式 | 提取类型 |
|---|---|
| `get_app_jank_frames`, `jank_frames`, `frame_list`, `frames` | FrameEntity |
| `scroll_sessions`, `sessions`, `session_list` | SessionEntity |
| `cpu_slices`, `sched_slices`, `thread_slices`, `scheduling`, `cpu_timeline` | CpuSliceEntity |
| `binder_transactions`, `binder_calls`, `ipc_transactions`, `binder_blocking` | BinderEntity |
| `gc_events`, `garbage_collection`, `gc_analysis`, `gc_pauses` | GcEntity |
| `memory_events`, `allocations`, `oom_events`, `lmk_events`, `memory_stats` | MemoryEntity |

### 6.2 数据格式兼容

支持两种 payload 格式：
- **Array of objects**：`[{ frame_id: 1, ... }, ...]`
- **Columnar format**：`{ columns: [...], rows: [[...], ...] }`

统一通过 `normalizeToRows()` 转换后解析。同时兼容 snake_case / camelCase 字段名。

### 6.3 核心函数

```
captureEntitiesFromResponses(responses)  → CapturedEntities
captureEntitiesFromIntervals(intervals)  → CapturedEntities
applyCapturedEntities(store, captured)   → void (写入 EntityStore)
mergeCapturedEntities(...captures)       → CapturedEntities (去重合并)
```

`CapturedEntities` 包含：frames / sessions / cpuSlices / binders / gcs / memories / generics / candidateFrameIds / candidateSessionIds，全部自动按 ID 去重。

---

## 7. "每一轮都要给模型什么"：上下文注入点（非常关键）

多轮对话的失败往往来自"只把当前问题给 LLM"。SmartPerfetto 的做法是把 `generatePromptContext()` 产物注入到 3 个关键位置：

### 7.1 任务规划（Hypothesis loop）

- `planTaskGraph(..., hints.historyContext)`
- 目标：避免重复实验、沿着未覆盖的证据缺口规划

### 7.2 Agent 执行（Domain Agents）

- 每个 AgentTask 的 `additionalData.historyContext`
- BaseAgent 会把它写入 prompt：目标/偏好/近期实验/证据摘要/最近 turns
- 目标：让 agent "知道之前已经查过什么"

### 7.3 结论生成（Conclusion）

- `generateConclusion(..., options.historyContext)`
- 目标：输出"结论 + 证据链摘要"，并显式呈现不确定性与下一步

### 7.4 上下文注入内容结构

`generatePromptContext()` 产出的内容包含以下区段：

```
## 目标与偏好
## 覆盖度（已分析范围）
## 最近实验（执行记录）
## 证据摘要（可引用）
## 已检测到的矛盾（待解释/待消解）
## 语义记忆（跨轮次摘要）
## 对话历史 (N 轮)
  ### Turn N: "..."
  可引用实体: frame_id=...; session_id=...
## 关键发现
## 讨论主题
## 待回答问题
```

自动按 `maxTokens` 截断（4 chars ~= 1 token for Chinese）。

---

## 8. Context 隔离与策略

### 8.1 ContextBuilder

位置：`backend/src/agent/context/contextBuilder.ts`

按角色为不同 Agent 构建隔离上下文，减少 token 浪费：

| 策略 | 适用角色 | Intent | Plan | previousResults |
|-----|---------|--------|------|-----------------|
| plannerPolicy | Planner | summary | full | summary |
| evaluatorPolicy | Evaluator | full | full | full |
| workerPolicy | Worker | summary | none | filtered |

### 8.2 可见性级别

- `full`：完整访问
- `summary`：只看摘要（通过 `transformIntent` / `transformPlan` 转换）
- `none`：不可见

### 8.3 Context Types

位置：`backend/src/agent/context/contextTypes.ts`

定义了 `IsolatedContext`（带 `isIsolated: true` + `appliedPolicy` 标记）、`IntentSummary`、`PlanSummary`、`StageResultSummary` 等轻量摘要类型。

---

## 9. 会话管理与持久化

### 9.1 SessionStore（会话存储）

位置：`backend/src/agent/state/sessionStore.ts`

- 磁盘持久化（JSON 文件在 `agent-sessions/` 目录）
- 支持 phase 生命周期：idle → planning → executing → evaluating → refining → awaiting_user → completed / failed
- 保留期默认 7 天，最大活动会话 100 个
- 查询接口：按 traceId / phase / 可恢复状态查找

### 9.2 CheckpointManager（检查点管理器）

位置：`backend/src/agent/state/checkpointManager.ts`

- 按 sessionId 分目录存储检查点
- 每个检查点包含：stageResults / findings / agentState（query/traceId/intent/plan/expertResults/iterationCount/metadata）
- 每会话最多 10 个检查点（自动清理旧的）
- 保留期默认 24 小时
- 支持 `canResume()` 查询和 `getLatestCheckpoint()` 恢复

### 9.3 SessionContextManager（内存上下文管理）

位置：`backend/src/agent/context/enhancedSessionContext.ts`（底部）

- 复合键 `sessionId::traceId`
- LRU 逐出 + 30 分钟超时清理
- `getOrCreate(sessionId, traceId)` — 切换 trace 时自动清理旧上下文
- `set(sessionId, traceId, ctx)` — 持久化恢复注入
- 全局 singleton `sessionContextManager`

---

## 10. 会话分叉与合并

### 10.1 SessionTree（会话树）

位置：`backend/src/agent/fork/sessionTree.ts`

树形结构追踪会话父子关系：

- **节点**：`SessionNode`（sessionId / parentSessionId / childSessionIds / branchName / depth / status / hypothesis / summary）
- **状态**：active / completed / merged / abandoned / expired
- **查询**：getAncestors / getDescendants / getSiblings / getLeaves / findLowestCommonAncestor / getPathBetween
- **序列化**：`serialize()` / `deserialize()` 支持持久化
- **可视化**：`toTreeString()` 产出 ASCII 树形图

### 10.2 ForkManager（分叉管理器）

位置：`backend/src/agent/fork/forkManager.ts`

**分叉操作**：
- `fork(parentSessionId, options)` — 从检查点创建分叉，复制检查点 + 上下文
- 约束：maxForkDepth / maxForksPerSession / allowNestedForks
- 状态持久化到 `agent-state/forks/` 目录

**比较操作**：
- `compare(sessionIds[])` → `ComparisonResult`：共同发现 / 独有发现 / 冲突发现 / 摘要比较 / 推荐最佳会话

**合并操作**：
- `merge(options)` — 将子会话结果合并回父会话
- 支持 4 种合并策略，配置冲突解决方式
- 可选自动清理已合并会话

### 10.3 MergeStrategies（合并策略）

位置：`backend/src/agent/fork/mergeStrategies.ts`

| 策略 | 行为 |
|-----|------|
| `replace` | 完全用子会话结果替换父会话 |
| `append` | 将子会话结果追加到父会话（检测冲突 + 解决） |
| `merge_findings` | 只合并 findings，不改变 results |
| `cherry_pick` | 只合并符合 filter 条件的内容 |

**冲突解决**（`ConflictResolution`）：
- `prefer_parent`：保留父会话发现
- `prefer_child`：使用子会话发现替换
- `prefer_higher_severity`：保留严重程度更高的
- `keep_both`：两个都保留（标记 `[Alt: ...]`）

---

## 11. 常见多轮问题与修复策略

### 11.1 机械化复述（LLM 只会总结表格）

修复要点：
- skills 用 `synthesize:` 产出确定性"洞见摘要"，减少 LLM 看大表
- evidence digests 让 LLM 有可引用的、短而稳定的证据片段
- KPI snippet 自动从 dataEnvelopes 中提取关键指标

### 11.2 重复实验（每轮都跑 scrolling overview）

修复要点：
- EntityStore + FocusStore → extend 只处理 unanalyzed candidates
- follow-up drill_down 直接绕过 discovery stage
- TraceAgentState.coverage + experiments 进入 prompt，LLM 可见已覆盖范围
- `refreshTraceAgentCoverage()` 每轮确定性刷新

### 11.3 "忘记用户目标"（多轮后偏题）

修复要点：
- `TraceAgentState.goal` 持久化并进入 prompt（`## 目标与偏好`）
- working memory 从结论中确定性抽取"稳定目标/已确认结论/下一步"（有界 12 条）
- `updateTraceAgentGoalFromIntent()` 逐步归一化目标

### 11.4 实体解析失败

修复要点：
- FollowUpHandler 支持 `entity.value` 优先（结构化值 > 简单 ID）
- ID 归一化（`normalizeId` 处理 string/number/BigInt）
- snake_case / camelCase 双模式字段匹配（`getField` 工具函数）
- 多级 fallback interval 构建（finding → params → minimal + needsEnrichment）
- DrillDownResolver SQL enrichment 兜底 + 回写 EntityStore

---

## 12. 建议的后续增强（让对话更像专家）

1. **把矛盾变成一等公民**：`TraceAgentState.contradictions` 已有数据结构（含 severity / evidenceIds / hypothesisIds / resolutionExperimentIds），下一步是让 planning 优先做"能消解冲突"的实验
2. **可解释的覆盖度**：`TraceAgentState.coverage` 已跟踪 entities/timeRanges/domains/packages，下一步是在 UI 中呈现"哪些域/哪些实体/哪些时间段已覆盖"
3. **偏好闭环**：`TraceAgentState.preferences` 已定义 maxExperimentsPerTurn/qualityFirst，下一步允许用户明确设置"更快/更准/更可解释"，并映射到预算、策略与输出视图
4. **泛化 extend**：EntityStore Phase 3 已支持 cpu_slice/binder/gc/memory/generic，ExtendExecutor 可扩展为支持非 frame/session 实体的增量分析
5. **FocusStore 深度集成**：当前 FocusStore 仅在 ExtendExecutor 中使用，可进一步集成到 HypothesisExecutor 的 hypothesis 优先级排序和 planning 的增量范围决策
