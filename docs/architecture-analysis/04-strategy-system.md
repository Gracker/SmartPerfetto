# Strategy 系统深度解析（确定性流水线作为"可调用工具"）

> 对齐版本：2026-02-10
> 目标：把"稳定高频场景的确定性流水线"融入"目标驱动 Agent"闭环，而不是让系统退化成 pipeline + LLM 胶水。

---

## 0. 先给结论：Strategy 的正确定位

Strategy 的价值是：
- **把高频分析场景编码为可复用结构**（stages / tasks / interval extraction）
- **用 direct_skill 把高成本 LLM 环节从 hot path 移出去**
- **让输出结构稳定可预测**（有利于 UI、报告与对比）

但为了达到"目标驱动 Agent"的体验，Strategy 不应强制成为默认主链路；它更像一个**高质量的实验模板库**：

- 默认：HypothesisExecutor（假设 + 实验）驱动闭环
- Strategy：作为
  -（A）可直接执行的确定性 pipeline（在需要时/显式强制时）
  -（B）供 planner 复用的结构化 hint（在 hypothesis loop 中）

---

## 1. 核心类型与概念

位置：`backend/src/agent/strategies/types.ts`

### 1.1 FocusInterval（发现 -> 深挖 的桥梁）

FocusInterval 是 stage 之间传递的"焦点区间"：

```typescript
interface FocusInterval {
  id: number;
  processName: string;
  startTs: string;        // 纳秒，字符串保精度（避免 > 2^53）
  endTs: string;
  priority: number;       // 高优先级先分析
  label?: string;         // 人类可读标签
  metadata?: Record<string, any>;  // 关键：用于 direct_skill 参数映射、实体捕获、UI 展示
}
```

### 1.2 StageTaskTemplate（阶段任务模板）

每个 stage 定义一组任务模板：

```typescript
interface StageTaskTemplate {
  agentId: string;                          // 目标 Agent（如 frame_agent, cpu_agent）
  domain: string;                           // 领域标签
  scope: 'global' | 'per_interval';         // global=全局一次, per_interval=每区间一次
  executionMode?: 'agent' | 'direct_skill'; // 默认 agent；direct_skill 零 LLM 开销
  directSkillId?: string;                   // direct_skill 模式的目标 Skill
  paramMapping?: Record<string, string>;    // interval 字段 -> skill 参数名 映射
  skillParams?: Record<string, any>;        // 额外控制参数
  descriptionTemplate: string;              // 支持 {{scopeLabel}} 占位符
  priority?: number;
  evidenceNeeded?: string[];
  focusTools?: string[];
}
```

### 1.3 DirectSkillTask（具体执行单元）

从 `per_interval` + `direct_skill` 模板展开后的具体任务：

```typescript
interface DirectSkillTask {
  template: StageTaskTemplate;
  interval: FocusInterval;
  scopeLabel: string;
}
```

### 1.4 StagedAnalysisStrategy（策略定义）

一条策略本质是"stage 列表 + interval extraction + early stop"：

```typescript
interface StagedAnalysisStrategy {
  id: string;
  name: string;
  trigger: (query: string) => boolean;      // 关键词/模式触发
  stages: StageDefinition[];                // 有序阶段
  defaults?: Record<string, any>;
}

interface StageDefinition {
  name: string;
  description: string;
  progressMessageTemplate: string;          // 支持 {{stageIndex}}/{{totalStages}}
  tasks: StageTaskTemplate[];
  extractIntervals?: (responses, helpers) => FocusInterval[];  // 从上阶段提取下阶段区间
  shouldStop?: (intervals) => { stop: boolean; reason: string };  // 早停判断
}
```

### 1.5 StrategyExecutionState（运行时状态）

```typescript
interface StrategyExecutionState {
  strategyId: string;
  currentStageIndex: number;
  focusIntervals: FocusInterval[];
  confidence: number;
}
```

### 1.6 IntervalHelpers（提取辅助函数）

位置：`backend/src/agent/strategies/helpers.ts`

注入给 `extractIntervals` 的工具集，让策略实现不依赖外部模块：

| 函数 | 用途 |
|------|------|
| `payloadToObjectRows(payload)` | 统一 columnar / array-of-objects 格式 |
| `isLikelyAppProcessName(name)` | 排除 surfaceflinger / system_server 等系统进程 |
| `formatNsRangeLabel(start, end, ref?)` | 纳秒区间转人类可读标签（如 `2.03s-4.82s`） |

---

## 2. 策略匹配：keyword-first + LLM fallback

位置：`backend/src/agent/strategies/registry.ts` + `backend/src/agent/core/strategySelector.ts`

### 2.1 StrategyRegistry

```typescript
class StrategyRegistry {
  match(query: string): StagedAnalysisStrategy | null;           // 同步关键词匹配（legacy）
  matchEnhanced(query, intent?, traceContext?): Promise<StrategyMatchResult>;  // 增强匹配
  setMatchMode(mode: 'keyword_first' | 'llm_only' | 'keyword_only'): void;
  setLLMSelector(selector: LLMStrategySelector): void;
}
```

三种匹配模式：

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `keyword_only` | 仅关键词触发 | Legacy 模式 |
| `keyword_first` | 先关键词，失败后 LLM 语义 | **默认推荐** |
| `llm_only` | 跳过关键词，总是 LLM | 实验性 |

### 2.2 StrategyMatchResult

```typescript
interface StrategyMatchResult {
  strategy: StagedAnalysisStrategy | null;
  matchMethod: 'keyword' | 'llm' | 'none';
  confidence: number;           // keyword=1.0, llm=0~1
  reasoning?: string;
  shouldFallback: boolean;
  fallbackReason?: string;
}
```

### 2.3 已注册策略清单（4 条）

工厂函数 `createStrategyRegistry()` 按优先级顺序注册：

| 优先级 | 策略 ID | 名称 | 触发关键词 |
|--------|---------|------|-----------|
| 1 | `scrolling` | Scrolling/Jank Analysis | 滑动/scroll/jank/掉帧/丢帧/卡顿/stutter/fps |
| 2 | `startup` | Startup Analysis | 启动/冷启动/温启动/热启动/startup/launch/ttid/ttfd |
| 3 | `scene_reconstruction_quick` | 场景还原（仅检测） | 概览类 + 仅检测/只检测/quick |
| 4 | `scene_reconstruction` | 场景还原分析 | 发生了什么/有什么问题/概览/整体分析/overview/场景还原/分析（无特定领域） |

匹配结果会产生：
- `strategy_selected` / `strategy_fallback` SSE 事件（可观测）
- `options.suggestedStrategy`（无论是否执行 pipeline，都传入 planner 作为结构化 hint）

补充说明：
- `AgentDrivenOrchestrator` 中，`scrolling/startup/scene_reconstruction` 命中时默认优先走 `StrategyExecutor`（除非显式 force hypothesis）。
- 策略信息仍会注入 `options.suggestedStrategy`，供 hypothesis loop 复用结构化 hint。

---

## 3. 执行：StrategyExecutor（确定性流水线）

位置：`backend/src/agent/core/executors/strategyExecutor.ts`

### 3.1 两类任务：AgentTask vs DirectSkillTask

StrategyExecutor 会把 stage tasks split 为两路：
- **AgentTask**：走 message bus -> Domain Agent（可包含 LLM reasoning）
- **DirectSkillTask**：直接调用 skill engine（纯 SQL/规则 + 极少 LLM），适合 per-frame deep dive

这种 split 是"性能可控"的关键：对帧级分析，direct_skill 可以显著降低延迟与成本。

### 3.2 Pre-Stage：Trace 配置检测

StrategyExecutor 在执行任何 stage 前先检测 trace 配置（VSync 周期、刷新率、VRR）：

```
if (!ctx.sharedContext.traceConfig) {
  traceConfig = await detectTraceConfig(traceProcessorService, modelRouter, traceId);
  ctx.sharedContext.traceConfig = traceConfig;
}
```

这为后续 jank 阈值计算和矛盾消解提供准确参考。

### 3.3 Follow-up 优化：prebuilt intervals -> 跳过 discovery stages

当 follow-up/drill-down 已经给出 intervals（或 incrementalScope 提供 focusIntervals）时：
- 直接跳过 discovery stage（避免重复找 session/frame）
- 如果 prebuilt 已经是 frame-level，则跳过 session_overview
- 推断 `prebuiltEntityType`（`frame` | `session` | `unknown`）用于精确跳过

### 3.4 预算语义：仅硬安全 cap

StrategyExecutor 中的 `maxRounds` 只作为"硬 stage 上限"：
- 防止异常策略/循环阶段导致跑飞
- 不把用户偏好预算（softMaxRounds）当硬 stop

原因：deterministic pipeline 的 stage 数量本身就是"结构的一部分"，更适合由策略定义控制。

### 3.5 历史注入（避免 pipeline 阶段失忆）

StrategyExecutor 在构建 AgentTask 时也会注入：
- `additionalData.historyContext = sessionContext.generatePromptContext(...)`

保证即便走 pipeline，也不会"每个阶段像第一次见到 trace"。

### 3.6 Deferred Expandable Tables（延迟帧表绑定）

对于 scrolling strategy，L2 帧列表表格（`get_app_jank_frames`）会被延迟发射：
- 在 `session_overview` 阶段，帧表被识别并存入 `deferredExpandableTables`
- 在 `frame_analysis` 阶段完成后，将 L4 per-frame 结果作为 `expandableData` 绑定到帧表
- 然后统一发射，使 UI 首次渲染就带有可展开的详情

### 3.7 JankCauseSummarizer（帧级根因聚合）

`frame_analysis` 阶段完成后，从所有 Finding 的 `details.cause_type` 聚合帧级根因：

```
jankCauseSummary = summarizeJankCauses(allFindings);
// -> primaryCause, secondaryCauses, totalJankFrames
```

结果写入 `sharedContext.jankCauseSummary`，供 conclusionGenerator 生成结构化结论。

### 3.8 Entity Capture（实体追踪）

每个阶段的 responses 和 extracted intervals 都会被 `captureEntitiesFromResponses` / `captureEntitiesFromIntervals` 处理，产生跨阶段的实体追踪数据（帧 ID、会话 ID、进程名等），写入 EntityStore 支持多轮对话引用。

---

## 4. 典型案例：Scrolling Strategy（概览 -> 会话 -> 帧级）

位置：`backend/src/agent/strategies/scrollingStrategy.ts`

### 4.1 触发条件

```typescript
function isScrollingOrJankQuery(query: string): boolean {
  const q = query.toLowerCase();
  return q.includes('滑动') || q.includes('scroll') || q.includes('jank') ||
         q.includes('掉帧') || q.includes('丢帧') || q.includes('卡顿') ||
         q.includes('stutter') || q.includes('fps');
}
```

### 4.2 三阶段流水线

**Stage 0: overview（全局）**
- Agent: `frame_agent` (scope: global, mode: agent)
- 目的：定位 scroll sessions + jank 概览
- 输出：`scroll_sessions` + `session_jank` 数据
- `extractIntervals`：按 severity 排序（maxVsyncMissed > jankFrameCount > 时长），每个有 jank 的 session 产生一个 FocusInterval
- `shouldStop`：无 jank session 则终止

**Stage 1: session_overview（per_interval）**
- Agent: `frame_agent` (scope: per_interval, mode: agent)
- 目的：生成 per-frame 帧列表（含时间戳）
- `extractIntervals`：从 `get_app_jank_frames` 提取帧级 FocusInterval，按 sessionId 升序 + startTs 升序排列
- 每帧 FocusInterval 携带丰富 metadata：mainStartTs, mainEndTs, renderStartTs, renderEndTs, durMs, jankType, layerName, pid, tokenGap, jankResponsibility, frameIndex
- `shouldStop`：无可分析帧则终止

**Stage 2: frame_analysis（per_interval, direct_skill）**
- Agent: `frame_agent` (scope: per_interval, mode: **direct_skill**)
- directSkillId: `jank_frame_detail`
- paramMapping: 19 个参数从 interval fields + metadata 映射
- 覆盖：四象限分析、Binder、CPU 频率、主线程/RenderThread 耗时操作、锁竞争、GC、IO 阻塞、根因分析
- 性能：N 个确定性 SQL 执行 / 帧（0 LLM 调用），63 帧约 15-30 秒

### 4.3 关键机制

- 帧级 endTs 估算：当 `end_ts` 缺失时，优先用 `dur_ms` 换算，其次用 `vsyncPeriodNs * DEFAULT_VSYNC_PERIODS_FOR_FRAME_ESTIMATION` 估算
- BigInt 安全：所有时间戳用字符串传递，计算时用 BigInt，避免精度丢失

---

## 5. 典型案例：Scene Reconstruction Strategy（场景还原）

位置：`backend/src/agent/strategies/sceneReconstructionStrategy.ts`

### 5.1 触发条件

两个变体：
- **sceneReconstructionQuickStrategy**：概览类查询 + "仅检测"/"只检测"/"quick"
- **sceneReconstructionStrategy**：概览类查询（发生了什么/有什么问题/概览/整体分析/场景还原/分析...）

### 5.2 Quick 变体（1 阶段）

- Stage 1: `scene_detection`（global, direct_skill, `scene_reconstruction`）
- 仅检测场景，不做深入分析

### 5.3 Full 变体（2 阶段）

**Stage 1: scene_detection（全局, direct_skill）**
- directSkillId: `scene_reconstruction`
- `extractIntervals`：从检测结果提取场景作为 FocusInterval
  - 解析 `app_launches`（冷启动/温启动/热启动）
  - 解析 `user_gestures`（scroll/tap/long_press）
  - 解析 `top_app_changes`（应用切换）
  - **Fallback**：当 `user_gestures` 无数据时，从 `jank_events` 聚合性能问题区间（相邻 500ms 内合并）
- 场景优先级：超过阈值的场景优先级 90，其余 50
- 保护：最多 5 个场景进入下一阶段

**Stage 2: problem_scene_analysis（per_interval, direct_skill）**
- 已改为 **manifest 路由驱动**（`DomainManifest.sceneReconstructionRoutes`），由策略在启动时动态构建任务模板。
- 默认路由（当前实现）：
  - Route A（`sceneTypeGroups: ['startup']`）-> `startup_detail`
  - Route B（`sceneTypeGroups: ['all']` + `excludeSceneTypes: cold/warm/hot_start`）-> `scrolling_analysis`

### 5.4 分流机制实现点

- `DomainManifest.sceneReconstructionRoutes`：场景路由规则来源。
- `matchesSceneReconstructionRoute(...)`：统一 route 命中判断（支持 `all` wildcard 与 `excludeSceneTypes`）。
- `sceneReconstructionStrategy.buildSceneAnalysisTasksFromManifest()`：从 manifest 转为 `StageTaskTemplate`。
- `StrategyExecutor.filterIntervalsForTemplate(...)`：运行时按模板过滤 focus intervals 并安全降级。

详细流程见：
- `docs/architecture-analysis/06-scrolling-startup-optimization.md`

### 5.5 性能阈值

| 场景类型 | 时长阈值 | FPS 阈值 |
|----------|----------|----------|
| cold_start | 1000ms | - |
| warm_start | 600ms | - |
| hot_start | 200ms | - |
| scroll | - | 50 FPS |
| tap | 200ms | - |
| navigation | 500ms | - |

---

## 6. DirectSkillExecutor（零 LLM 直接执行）

位置：`backend/src/agent/core/executors/directSkillExecutor.ts`

### 6.1 核心职责

- 从 interval + template 构建 skill 参数（含 paramMapping 支持）
- 直接调用 SkillExecutor.execute()（跳过 Agent LLM 循环）
- 将 SkillExecutionResult 转换为 AgentResponse（与 Agent 输出同构）
- 并发控制（默认 6 并发）

### 6.2 参数构建逻辑

1. 显式 paramMapping（如果定义）：`{ skillParamName: intervalFieldOrSpecial }`
2. 默认映射：`start_ts`, `end_ts`, `package`
3. 别名规范化：`package` -> `package_name` / `process_name`; 纳秒 -> 秒转换
4. Key 变体兼容：camelCase <-> snake_case 双向转换

`resolveParamValue` 查找顺序：
1. interval 顶级字段（startTs, endTs, processName, duration, id, label, priority）
2. `interval.metadata[source]`（原样）
3. `interval.metadata[toSnakeCase(source)]`
4. `interval.metadata[toCamelCase(source)]`
5. `interval[source]`（兜底）

### 6.3 Finding 提取与根因数据丰富

1. 从 diagnostics 提取 Finding[]（带唯一 taskId 前缀）
2. 从 rawResults.root_cause 提取根因数据（cause_type, primary_cause 等）
3. 将根因数据注入 `Finding.details`，供 JankCauseSummarizer 按 cause_type 聚合

### 6.4 性能对比

| 项目 | Agent 模式 | Direct Skill 模式 |
|------|-----------|-------------------|
| LLM 调用 / 帧 | ~12（Understanding/Planning/SQL/Reflection x 3 agents） | 0-1（仅 ai_assist 诊断） |
| 适用场景 | 需要 LLM 决策的任务 | 确定性 SQL 查询（*_in_range skills） |
| 延迟 / 帧 | ~5-10s | ~0.3-0.5s |

---

## 7. Decision Tree 系统

位置：`backend/src/agent/decision/`

### 7.1 核心类型

位置：`backend/src/agent/decision/types.ts`

```typescript
type DecisionNodeType = 'CHECK' | 'ACTION' | 'BRANCH' | 'CONCLUDE';
type ProblemCategory = 'APP' | 'SYSTEM' | 'MIXED' | 'UNKNOWN';
type ProblemComponent =
  | 'RENDER_THREAD' | 'MAIN_THREAD' | 'CHOREOGRAPHER' | 'SURFACE_FLINGER'
  | 'BINDER' | 'VSYNC' | 'INPUT' | 'CPU_SCHEDULING' | 'GPU' | 'MEMORY'
  | 'IO' | 'THERMAL' | 'UNKNOWN';
```

决策树结构：

```typescript
interface DecisionTree {
  id: string;
  name: string;
  analysisType: 'scrolling' | 'launch' | 'memory' | 'anr' | 'general';
  entryNode: string;
  nodes: DecisionNode[];
}
```

节点类型：

| 类型 | 行为 | 输出 |
|------|------|------|
| CHECK | 执行 Skill 或引用缓存结果，评估条件 | true/false -> 不同下一节点 |
| ACTION | 执行 Skill 并存储结果 | 结果存入 collectedData |
| BRANCH | 多条件分支（按序评估） | 命中的分支 -> 对应下一节点 |
| CONCLUDE | 输出结论 | category + component + summaryTemplate + confidence |

### 7.2 DecisionTreeExecutor

位置：`backend/src/agent/decision/decisionTreeExecutor.ts`

- 循环执行节点直到 CONCLUDE 或超限（默认 maxNodes=50）
- 每节点超时 30s
- 通过 `SkillExecutorInterface` 解耦实际 Skill 调用
- 发射 `node:start` / `node:complete` 事件

### 7.3 SkillExecutorAdapter

位置：`backend/src/agent/decision/skillExecutorAdapter.ts`

- 桥接 `SkillExecutorInterface` 和 `SkillAnalysisAdapter`
- 带结果缓存（相同 traceId + skillId + params 不重复执行）
- 包含 Skill 特定的结果转换：scrolling_analysis, startup_analysis, jank_frame_detail, cpu_analysis, binder_analysis

### 7.4 DecisionTreeStageExecutor（Pipeline 集成）

位置：`backend/src/agent/decision/decisionTreeStageExecutor.ts`

- 包装决策树为 `StageExecutor`，可嵌入 Pipeline 架构
- 支持按 stage metadata、stage ID、用户查询自动检测 analysisType
- 将 `DecisionTreeExecutionResult` 转换为 `SubAgentResult`（含 findings、结论）

### 7.5 已注册决策树（2 棵）

位置：`backend/src/agent/decision/trees/`

#### 滑动分析决策树 (`scrolling_analysis_v1`)

```
get_fps_overview (ACTION)
  -> check_has_problem (CHECK: FPS>=55 且 jankRate<5%)
    -> true: conclude_no_problem
    -> false: check_fps_pattern (CHECK: 持续偏低 vs 突刺)
      -> 持续偏低: analyze_continuous_low -> check_sf_normal
        -> SF 异常: conclude_sf_issue
        -> SF 正常: analyze_app_render -> check_render_thread
          -> RT > 16ms: conclude_render_thread_issue
          -> RT 正常: check_main_thread
            -> doFrame > 12ms: conclude_main_thread_issue
            -> 正常: analyze_scheduling -> check_scheduling
              -> Runnable > 5ms: conclude_scheduling_issue
              -> 正常: conclude_unknown
      -> 突刺掉帧: analyze_spike_jank -> classify_jank_frames (BRANCH)
        -> App Deadline Missed > 60%: conclude_app_deadline_missed
        -> SF Stuffing > 60%: conclude_sf_stuffing
        -> Binder 阻塞: conclude_binder_issue
        -> default: conclude_mixed_jank
```

#### 启动分析决策树 (`launch_analysis_v1`)

```
get_launch_overview (ACTION)
  -> check_launch_type (BRANCH: cold/warm/hot)
    -> cold: analyze_cold_launch (CHECK: TTID < 1000ms)
      -> 正常: conclude_launch_ok
      -> 慢: find_slowest_phase (BRANCH)
        -> process_start: analyze_process_start -> zygote fork > 100ms?
        -> application_init: conclude_app_init_slow
        -> activity_create: analyze_activity_create -> inflate > 200ms?
        -> first_frame: conclude_first_frame_slow
        -> default: conclude_launch_slow_mixed
    -> warm: analyze_warm_launch (CHECK: < 500ms)
    -> hot: analyze_hot_launch (CHECK: < 200ms)
```

---

## 8. Skill 系统概览

### 8.1 Skill 类型与数量

| 类别 | 数量 | 位置 | 用途 |
|------|------|------|------|
| Atomic | 32 | `backend/skills/atomic/` | 单步检测/查询 |
| Composite | 27 | `backend/skills/composite/` | 多步组合分析 |
| Pipeline | 25 (+1 base) | `backend/skills/pipelines/` | 渲染管线检测+教学 |
| Deep | 2 | `backend/skills/deep/` | 深度分析（callstack, cpu_profiling） |
| Module | 18 | `backend/skills/modules/` | 模块配置 |
| Vendor | 8 | `backend/skills/vendors/` | 厂商适配 |

**总计：86 个 Skill 定义 + 18 个模块配置 + 8 个厂商覆盖**

### 8.2 Atomic Skills 分类

**帧分析（7）：**
app_frame_production, consumer_jank_detection, render_thread_slices, rendering_arch_detection, present_fence_timing, vrr_detection, vsync_config

**CPU 分析（6）：**
cpu_freq_timeline, cpu_load_in_range, cpu_slice_analysis, cpu_topology_detection, scheduling_analysis, lock_contention_in_range

**Range-Based Skills（13 - 适合 direct_skill 模式）：**
binder_blocking_in_range, binder_in_range, cpu_cluster_load_in_range, cpu_throttling_in_range, gpu_freq_in_range, gpu_render_in_range, memory_pressure_in_range, page_fault_in_range, render_pipeline_latency, sched_latency_in_range, sf_composition_in_range, system_load_in_range, task_migration_in_range, vsync_alignment_in_range

**其他（6）：**
gpu_metrics, game_fps_analysis, sf_frame_consumption, vsync_period_detection, rendering_pipeline_detection, cpu_load_in_range

### 8.3 Composite Skills 分类

**滑动/Jank（3）：** scroll_session_analysis, scrolling_analysis, jank_frame_detail

**启动（2）：** startup_analysis, startup_detail

**ANR（2）：** anr_analysis, anr_detail

**交互（3）：** click_response_analysis, click_response_detail, navigation_analysis

**系统分析（8）：** cpu_analysis, memory_analysis, gc_analysis, lmk_analysis, binder_analysis, binder_detail, gpu_analysis, surfaceflinger_analysis

**Issue 检测（9）：** lock_contention_analysis, render_pipeline_latency, block_io_analysis, io_pressure, dmabuf_analysis, suspend_wakeup_analysis, thermal_throttling, irq_analysis, network_analysis

**元分析（1）：** scene_reconstruction

### 8.4 Pipeline Skills

25 个渲染管线 Skill + 1 个 `_base.skill.yaml` 基础模板：

| 系列 | Skills |
|------|--------|
| Android View | android_view_standard_blast, android_view_standard_legacy, android_view_software, android_view_mixed, android_view_multi_window, android_pip_freeform |
| Surface/Texture | surfaceview_blast, textureview_standard, surface_control_api |
| Flutter | flutter_surfaceview_skia, flutter_surfaceview_impeller, flutter_textureview |
| WebView | webview_gl_functor, webview_surface_control, webview_surfaceview_wrapper, webview_textureview_custom |
| Graphics API | opengl_es, vulkan_native, angle_gles_vulkan |
| 特殊场景 | game_engine, video_overlay_hwc, camera_pipeline, hardware_buffer_renderer, variable_refresh_rate |

每个 Pipeline Skill 包含 `detection`（SQL 检测逻辑）和 `teaching`（教学内容：线程角色、关键 Slice、Mermaid 时序图）。

### 8.5 Module 配置（18 个）

| 层级 | 模块 |
|------|------|
| App | launcher_module, systemui_module, third_party_module |
| Framework | ams_module, art_module, choreographer_module, input_module, surfaceflinger_module, wms_module |
| Hardware | cpu_module, gpu_module, memory_module, power_module, thermal_module |
| Kernel | binder_module, filesystem_module, lock_contention_module, scheduler_module |

### 8.6 Vendor 覆盖（8 家）

pixel, samsung, xiaomi, honor, oppo, vivo, qualcomm, mtk -- 各有 `startup.override.yaml`。

### 8.7 Skill YAML 格式示例

```yaml
name: cpu_load_in_range
version: "1.0"
type: atomic
category: hardware

meta:
  display_name: "CPU 负载区间分析"
  description: "分析指定时间范围内各 CPU 核心的负载情况"
  tags: [cpu, load, usage, atomic]

prerequisites:
  required_tables:
    - sched_slice

inputs:
  - name: start_ts
    type: timestamp
    required: true
  - name: end_ts
    type: timestamp
    required: true

steps:
  - id: cpu_utilization
    type: atomic
    name: "CPU 利用率"
    display:
      level: detail
      title: "CPU 利用率"
    sql: |
      SELECT cpu, ... FROM sched_slice WHERE ts >= ${start_ts} AND ts <= ${end_ts} ...
```

### 8.8 参数替换机制

```yaml
# Skill 通过 ${param|default} 接收参数
steps:
  - id: diagnose
    type: iterator
    max_items: "${max_frames_per_session|8}"  # Strategy 传参覆盖默认值
```

### 8.9 Layered Results（L1-L4）

| 层级 | 用途 | display.level |
|------|------|--------------|
| L1 (overview) | 聚合指标 | overview / summary |
| L2 (list) | 数据列表 | list / detail + expandableData |
| L3 (diagnosis) | 逐帧诊断 | iterator over jank frames |
| L4 (deep) | 详细分析 | deep / frame |

---

## 9. 在目标驱动 Agent 下：Strategy 如何"变聪明"而不是"变僵硬"

当默认走 HypothesisExecutor 时，Strategy 不执行，但其结构仍然有价值：

### 9.1 作为 suggestedStrategy（结构化 hint）

planner 可以复用 strategy 的 stages 作为"实验候选空间"，例如：
- 当前目标在"帧级根因" -> 直接选 frame_analysis 的 direct_skill
- 当前目标在"启动事件根因" -> 直接选 startup 的 launch_event_detail

### 9.2 作为"实验模板库"

建议未来增强：
- 为每个 stage/task 增加 capability 标签（产出哪些证据）
- planner 在"假设空间"里做信息增益最大化，而不是纯 LLM 自由发挥

---

## 10. Skills 在新架构下需要怎样的改造（工具化）

Strategy 的稳定性最终依赖 skills 的"证据可消费性"：

### 10.1 display.columns：建议使用富列定义

使用 `name/label/type/format` 的列定义能带来：
- UI 通用渲染更准确
- Evidence digest 能稳定抽取 KPI
- iterator 表格能从 nested results 中提取字段

### 10.2 synthesize：让 skill 产出确定性洞见摘要

推荐在关键步骤加：
- `synthesize: { role, fields, insights, ... }`

让"洞见"从 YAML 数据驱动产生，减少 LLM "复述表格"的机械化。

### 10.3 diagnostic：证据字段要可引用

diagnostic 规则尽量补 `evidence_fields`，否则只能 best-effort 从 condition 解析来源。

---

## 11. 下一步建议（Strategy x Agent 的真正融合）

1. **stage-cost 模型**：把 stage 的时延/数据量/LLM 次数纳入规划（质量优先但可控）
2. **矛盾消解 stage**：当出现冲突（例如 app jank vs consumer jank）时自动选择"能区分责任"的实验
3. **strategy-to-experiment 编译**：把 stages 编译为 hypothesis loop 的实验候选，统一闭环语义
