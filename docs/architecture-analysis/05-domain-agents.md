# Domain Agents 深度解析（让系统"像专家"而不是"跑流程"）

> 对齐版本：2026-02-06
> 目标：解释 Domain Agents 如何围绕"目标/假设/证据/下一步"闭环工作，以及 skills 在新架构下需要怎样的工具化改造。

---

## 0. 先给结论：Domain Agents 的职责不是"生成漂亮文字"，而是"产出可验证证据"

一个真正可用的性能分析 Agent 必须能做到：
- 知道自己要验证什么（objective / hypothesis）
- 知道用哪个工具拿证据（skills / SQL）
- 发现工具失败时能修复（参数、SQL、前置模块）
- 产出可引用的证据（DataEnvelope / evidence digest）
- 在不确定时能主动向用户提问或请求干预（intervention）

Domain Agents 在 SmartPerfetto 中就是承载这些能力的"领域专家"层。

---

## 1. Domain Agents 清单与定位

位置：`backend/src/agent/agents/domain/`

默认 8 个 agents（可扩展）：

| Agent | 文件 | ID | 领域 | Skills |
|-------|------|-----|------|--------|
| FrameAgent | frameAgent.ts | `frame_agent` | frame | jank_frame_detail, scrolling_analysis, consumer_jank_detection, sf_frame_consumption, app_frame_production, present_fence_timing |
| CPUAgent | cpuAgent.ts | `cpu_agent` | cpu | cpu_analysis, scheduling_analysis, cpu_freq_timeline, cpu_load_in_range, cpu_slice_analysis, cpu_profiling, callstack_analysis |
| MemoryAgent | memoryAgent.ts | `memory_agent` | memory | memory_analysis, gc_analysis, lmk_analysis, dmabuf_analysis |
| BinderAgent | binderAgent.ts | `binder_agent` | binder | binder_analysis, binder_detail, binder_in_range, lock_contention_analysis, lock_contention_in_range |
| StartupAgent | additionalAgents.ts | `startup_agent` | startup | startup_analysis, startup_detail |
| InteractionAgent | additionalAgents.ts | `interaction_agent` | interaction | click_response_analysis, click_response_detail |
| ANRAgent | additionalAgents.ts | `anr_agent` | anr | anr_analysis, anr_detail |
| SystemAgent | additionalAgents.ts | `system_agent` | system | thermal_throttling, io_pressure, suspend_wakeup_analysis |

定位原则：
- **每个 Agent 对应一个稳定的"证据集合"**（它知道该域有哪些表/指标/常见机制）
- **skills 是它的工具箱**（YAML 定义 SQL/规则/展示）
- **LLM 是协调与补洞**（不是替代证据）

### 1.1 Agent 委托关系

每个 Agent 声明 `delegateTo` 列表，表示可以请求哪些 Agent 协助：

| Agent | 可委托给 |
|-------|---------|
| FrameAgent | cpu_agent, binder_agent, memory_agent |
| CPUAgent | frame_agent, binder_agent |
| MemoryAgent | cpu_agent, frame_agent |
| BinderAgent | cpu_agent, frame_agent |
| StartupAgent | cpu_agent, binder_agent, memory_agent |
| InteractionAgent | frame_agent, cpu_agent, binder_agent |
| ANRAgent | cpu_agent, binder_agent, memory_agent |
| SystemAgent | cpu_agent, memory_agent |

---

## 2. BaseAgent：Think-Act-Reflect 闭环（可控的自主性）

位置：`backend/src/agent/agents/base/baseAgent.ts`

### 2.1 核心架构

BaseAgent 继承自 EventEmitter，提供统一的执行模板：

```typescript
abstract class BaseAgent {
  config: AgentConfig;
  modelRouter: ModelRouter;
  skillDefinitions: SkillDefinitionForAgent[];  // 声明时指定，延迟加载
  upgradeConfig: UpgradeConfig;                  // 动态 SQL 升级配置

  async executeTask(task: AgentTask): Promise<AgentResponse>;
  protected abstract buildUnderstandingPrompt(task): string;
  protected abstract buildPlanningPrompt(understanding, task): string;
  protected abstract buildReflectionPrompt(result, task): string;
  protected abstract generateHypotheses(findings, task): Promise<Hypothesis[]>;
  protected abstract getRecommendedTools(context): string[];
}
```

### 2.2 执行流程

1. **Understand**：把任务描述转成 objective + questions + constraints（LLM JSON）
2. **Plan**：选择工具与步骤（skills 为主，LLM 返回 steps[]）
3. **Execute**：按序执行工具（并记录观测），通过 `ensureToolsLoaded()` 延迟初始化 skill tools
4. **Reflect**：评估证据是否满足目标、识别缺口与矛盾（LLM JSON）
5. **Respond**：输出 findings（带 evidence/置信度）+ hypothesis update + next steps

关键点：
- **工具调用是结构化的**（不是让 LLM "随口写 SQL"）
- **失败可恢复**（见动态 SQL upgrade）
- **上下文可承接**（historyContext 注入）

### 2.3 Skill 作为 Tool（延迟加载模式）

Agent 在构造时声明 `SkillDefinitionForAgent[]`，但不立即创建 Tool 实例。在 `executeTask()` 时调用 `ensureToolsLoaded()` 确保 SkillRegistry 已初始化，再将 Skill 包装为 Tool：

```typescript
interface SkillDefinitionForAgent {
  skillId: string;       // YAML skill ID
  toolName: string;      // Agent prompt 中显示的工具名
  description: string;   // 工具描述（含使用场景和输出说明）
  category: string;      // 工具分类
}
```

每个 Agent 的 prompt 中会列出可用工具及其描述，LLM 根据描述选择工具。

### 2.4 Finding 提取

BaseAgent 提供默认的 `extractFindingsFromResult()`，从 SkillExecutionResult 的 diagnostics 中提取 Finding[]。Domain Agent 可以 override 此方法添加领域特定逻辑。

例如 FrameAgent 的 override 会：
- 合并多个 jank 数据源（消费端 > 帧列表 > App 报告）
- 生成单一的合并 Finding，避免重复/冲突的卡顿报告
- 保留所有数据源在 evidence[] 中供专家审查

### 2.5 ADB 工具集成

所有 Agent 通过 `getAdbAgentTools()` 获取 ADB 相关工具。SystemAgent 额外启用 `includeRecorder: true` 以支持 trace 录制功能。

---

## 3. "多轮不遗忘"在 Agent 侧如何实现

### 3.1 historyContext 注入

Orchestrator / Executor 会把 `sessionContext.generatePromptContext(...)` 放入每个任务的：
- `task.context.additionalData.historyContext`

BaseAgent 会将其写入 prompt（并有长度保护），确保 agent 知道：
- 用户目标与偏好（含 soft 预算）
- 最近实验与证据摘要
- 过去几轮的关键发现与可引用实体

### 3.2 为什么这能减少机械化

没有 historyContext 时，LLM 很容易：
- 复述当前 skill 表格（缺洞见）
- 重复跑已做过的实验（浪费）
- 忘记用户真正关心的对象（偏题）

historyContext 把"已做过/已得到"变成强约束输入，Agent 更像在做连续推理。

### 3.3 上下文感知的工具推荐

各 Agent 的 `getRecommendedTools()` 会根据上下文智能选择工具：

- **CPUAgent**：有 timeRange 时偏好 in-range 分析（cpu_load_in_range + scheduling + freq + slices），无 timeRange 时用全局概览
- **BinderAgent**：有 timeRange 时用 analyze_binder_range，否则用全局 overview
- **MemoryAgent**：有 timeRange 时避免全局 gc_analysis（输出过多），偏好 memory_analysis 的区间模式
- **FrameAgent**：根据查询关键词组合推荐帧分析、消费端检测、SF 分析、Fence 分析等

---

## 4. Skills 作为工具：需要"证据可消费"

Domain Agents 的主要工具是 skills（YAML）。为了支持 goal-driven loop，skills 的输出必须满足：

### 4.1 证据可展示（UI）

- `display.layer` 分层（overview/list/deep）
- `display.columns` 用富列定义（name/label/type/format）而不是只给字符串
- iterator 的 L2 列表需要能绑定 L4 expandableData（可 drill-down）

### 4.2 证据可引用（Agent/结论）

建议：
- 关键步骤加 `synthesize:`（role/fields/insights）生成确定性"洞见摘要"
- diagnostic 规则带 `evidence_fields`，让 findings.details 含可引用数据

效果：
- 减少 LLM "看大表复述"的机械化
- 结论可以更像"证据链推理"

---

## 5. 动态 SQL Upgrade：当 skills 不够用时的自主补洞

### 5.1 SQL Generator

位置：`backend/src/agent/tools/sqlGenerator.ts`

关键特性：
- Schema 上下文注入：LLM 知道可用的表/列（TableSchema, ColumnInfo）
- 安全约束：read-only, table whitelist, max rows
- 解释生成：每个查询带 reasoning
- 风险评估：标记可能昂贵的查询

### 5.2 SQL Validator

位置：`backend/src/agent/tools/sqlValidator.ts`

五层验证：
1. **语法检查**：基本 SQL 结构
2. **语句类型**：仅允许 SELECT
3. **表白名单**：仅批准的表
4. **模式黑名单**：无危险模式
5. **复杂度限制**：防止跑飞查询

设计原则：fail closed（不确定时拒绝）、defense in depth、清晰错误信息。

### 5.3 Upgrade 配置

```typescript
interface UpgradeConfig {
  enabled: boolean;              // 默认 true
  minFailedSteps: number;        // 最少失败步骤数
  maxRetries: number;            // 最大重试次数（默认 2）
  requireExplicitObjective: boolean;  // 需要明确目标
}
```

### 5.4 执行流程

触发时机：
- 预置 skills 返回空/失败
- 任务 objective 明确（可以用 SQL 补证据）

流程：
1. 生成 SQL（带 objective、约束、可用表提示）
2. 静态验证（风险/表依赖/危险语句）
3. 执行 SQL
4. 若失败：有限次数修复（repair）再重试

这条路径决定了 Agent "像专家"还是"像脚本"：
- 脚本：skill 不行就报错
- 专家：知道如何换方法拿证据，并能修复错误

---

## 6. 工具系统

位置：`backend/src/agent/tools/`

| 工具 | 文件 | 用途 |
|------|------|------|
| sqlExecutor | sqlExecutor.ts | SQL 查询执行 |
| frameAnalyzer | frameAnalyzer.ts | 帧分析 |
| skillInvoker | skillInvoker.ts | Skill 调用（参数映射），暴露所有已注册 Skill 给 Agent |
| dataStats | dataStats.ts | 数据统计 |
| sqlGenerator | sqlGenerator.ts | 动态 SQL 生成（LLM 驱动） |
| sqlValidator | sqlValidator.ts | SQL 安全验证（5 层） |

### 6.1 Skill Invoker

`skillInvoker.ts` 将 Skill 系统封装为 Agent 可调用的工具：

```typescript
interface SkillInvokerParams {
  skillId: string;          // 如 startup_analysis, scrolling_analysis
  startTs?: string;         // 可选时间范围（纳秒）
  endTs?: string;
  packageName?: string;
  params?: Record<string, any>;
}
```

返回标准化的结果，包括 summary, data, diagnostics, aiSummary, executionTimeMs。

---

## 7. findings / evidence / DataEnvelope：从工具输出到"可推理结论"

### 7.1 skill -> DataEnvelope（给前端）

SkillExecutor 会把 DisplayResults 转为 DataEnvelope（v2 data contract）：
- UI 可通用渲染（表格/summary/层级）
- executor 可对 envelope 做去重与延迟绑定（expandableData）

### 7.2 tool output -> evidence digest（给后续轮次）

EnhancedSessionContext 会把 toolResults 压缩为 evidence digest 写入 TraceAgentState：
- 保留 provenance（agentId/skillId/scopeLabel/timeRange 等）
- 控制体积（截断、上限、去重）
- frame_analysis 阶段（>10 responses）跳过逐 response 写入，依赖 derived summaries

### 7.3 findings（给结论）

Domain Agent 需要产出：
- 明确标题（问题是什么）
- 描述（为什么是问题/影响）
- details（关键数据/证据）
- 置信度（便于收敛与对话）
- cause_type（帧级根因分类，供 JankCauseSummarizer 聚合）

结论生成器会把 findings 组织为"结论 + 证据链摘要"。

---

## 8. 规划与评估 Agents

位置：`backend/src/agent/agents/`

### 8.1 PlannerAgent

位置：`backend/src/agent/agents/plannerAgent.ts`

继承 `BaseSubAgent`，职责：
- 理解用户意图（Intent：primaryGoal, aspects, expectedOutputType, complexity）
- 分解分析任务（AnalysisPlan）
- 规划执行顺序
- 估算资源需求

使用 LLM JSON schema 验证输出格式，确保 intent 和 plan 结构正确。

### 8.2 EvaluatorAgent

位置：`backend/src/agent/agents/evaluatorAgent.ts`

继承 `BaseSubAgent`，职责：
- 评估分析结果质量（qualityScore, completenessScore）
- 检测发现之间的矛盾（Contradiction[]）
- 评估结果完整性
- 生成改进建议（EvaluationFeedback）
- 判断是否通过（passed）及是否需要改进（needsImprovement）

### 8.3 IterationStrategyPlanner

位置：`backend/src/agent/agents/iterationStrategyPlanner.ts`

迭代策略决策器：
- 评估当前置信度
- 决定是否继续下一轮
- 选择下一轮的分析方向

---

## 9. Expert 系统

位置：`backend/src/agent/experts/`

### 9.1 专项 Expert（3 个）

| Expert | 文件 | 用途 |
|--------|------|------|
| LaunchExpert | launchExpert.ts | 启动性能专家 |
| InteractionExpert | interactionExpert.ts | 交互响应专家 |
| SystemExpert | systemExpert.ts | 系统级分析专家 |

基类：`backend/src/agent/experts/base/baseExpert.ts`

### 9.2 Cross-Domain Expert 系统

位置：`backend/src/agent/experts/crossDomain/`

| 组件 | 文件 | 用途 |
|------|------|------|
| BaseCrossDomainExpert | baseCrossDomainExpert.ts | 跨域专家基类 |
| HypothesisManager | hypothesisManager.ts | 假设生命周期管理 |
| DialogueProtocol | dialogueProtocol.ts | Agent 通信协议 |
| ModuleCatalog | moduleCatalog.ts | 模块目录（framework/vendor capabilities） |
| ModuleExpertInvoker | moduleExpertInvoker.ts | 模块专家调用 |
| PerformanceExpert | experts/performanceExpert.ts | 性能综合分析 |

类型定义在 `crossDomain/types.ts`。

### 9.3 Legacy Expert

- `scrollingExpertAgent.ts` - 滑动专家（legacy，已被 Strategy + DecisionTree 替代）
- `baseExpertAgent.ts` - Expert Agent 基类

---

## 10. Architecture Detector 系统

位置：`backend/src/agent/detectors/`

### 10.1 核心架构

`ArchitectureDetector` 是总控，按优先级聚合所有特定检测器的结果：

```typescript
class ArchitectureDetector {
  private detectors: BaseDetector[] = [
    new FlutterDetector(),     // 优先级 1：独特线程模型
    new WebViewDetector(),     // 优先级 2：Chromium 特征
    new ComposeDetector(),     // 优先级 3：特殊 Slice
    new StandardDetector(),    // 优先级 4：默认兜底
  ];

  config: {
    minConfidenceThreshold: 0.3,
    parallelDetection: true,
    timeoutMs: 10000,
  }
}
```

### 10.2 检测器清单（4 个）

| 检测器 | 文件 | 目标架构 | 检测特征 |
|--------|------|----------|----------|
| FlutterDetector | flutterDetector.ts | Flutter | 独特线程模型（ui/raster/io worker） |
| WebViewDetector | webviewDetector.ts | WebView | Chromium 特征（CrRendererMain 等） |
| ComposeDetector | composeDetector.ts | Jetpack Compose | Compose 特有 Slice（Composition 等） |
| StandardDetector | standardDetector.ts | Standard Android | 默认 View 体系（RenderThread + main） |

基类：`baseDetector.ts` -- 统一的检测接口和结果格式。
类型：`types.ts` -- `ArchitectureInfo`, `DetectorContext`, `DetectorResult`, `RenderingArchitectureType`。

### 10.3 检测优先级

FlutterDetector > WebViewDetector > ComposeDetector > StandardDetector

高优先级检测器命中后，后续检测器不再执行（或结果被覆盖）。检测结果低于 `minConfidenceThreshold`（0.3）时返回 UNKNOWN。

---

## 11. 什么时候该问用户（Intervention / Clarify）

当出现以下情况时，Agent/Executor 应更像专家一样"停下来问"：
- 证据不足以区分 2 个机制（歧义）
- 继续实验成本高但收益不确定（需要用户偏好）
- 用户没有提供关键对象（frame_id/session_id/时间范围/进程）

对应机制：
- executor 提交 `interventionRequest`
- 或 follow-up `clarify` 走 ClarifyExecutor（只读解释，不跑 SQL）

---

## 12. 各 Domain Agent 详细分析

### 12.1 FrameAgent

**定位**：帧渲染与滑动性能分析核心。

**Skills（6 个）**：

| toolName | skillId | 用途 |
|----------|---------|------|
| get_frame_detail | jank_frame_detail | 深度单帧诊断（四象限/Binder/CPU/GC/IO/根因） |
| analyze_scrolling | scrolling_analysis | 滑动概览（会话列表+FPS+帧列表） |
| detect_consumer_jank | consumer_jank_detection | 消费端卡顿（SF/GPU 延迟） |
| analyze_sf_frames | sf_frame_consumption | SF 帧消费时序 |
| analyze_app_frames | app_frame_production | App 帧生产节奏 |
| analyze_present_fence | present_fence_timing | 显示 Fence 等待时序 |

**Finding 提取特殊逻辑**：
- 合并多数据源 jank 统计：消费端 > 帧列表 > App 报告
- 使用可配置阈值（`DEFAULT_JANK_THRESHOLDS`）进行 severity 分级
- 所有源均保留在 `evidence[]` 中

**推荐工具逻辑**：
- 默认推荐 analyze_scrolling
- 根据关键词追加：卡顿/jank -> detect_consumer_jank；帧/frame -> analyze_app_frames + analyze_sf_frames；vsync/fence -> analyze_present_fence

### 12.2 CPUAgent

**定位**：CPU 调度、频率、负载分析。

**Skills（7 个）**：

| toolName | skillId | 用途 |
|----------|---------|------|
| analyze_cpu_overview | cpu_analysis | 全局 CPU 使用概况 |
| analyze_scheduling | scheduling_analysis | 调度延迟/Runnable 等待 |
| get_cpu_freq_timeline | cpu_freq_timeline | 频率变化历史 |
| analyze_cpu_load | cpu_load_in_range | 区间 CPU 负载 |
| analyze_cpu_slices | cpu_slice_analysis | CPU 时间片分布 |
| profile_cpu_hotspots | cpu_profiling | 热点函数（需 perf 数据） |
| analyze_callstacks | callstack_analysis | 调用栈聚合（需 callstack 数据） |

**推荐工具逻辑**：
- 有 timeRange 且非全局查询 -> 优先 in-range 分析（cpu_load + scheduling + freq + slices）
- 无 timeRange -> 全局 overview
- 关键词驱动追加：调度 -> scheduling；频率/降频 -> freq_timeline；热点 -> profiling + callstacks

### 12.3 MemoryAgent

**定位**：内存、GC、LMK 分析。

**Skills（4 个）**：

| toolName | skillId | 用途 |
|----------|---------|------|
| analyze_memory_overview | memory_analysis | 进程内存分布 |
| analyze_gc | gc_analysis | GC 活动分析 |
| analyze_lmk | lmk_analysis | Low Memory Killer 事件 |
| analyze_dmabuf | dmabuf_analysis | DMA-BUF 图形内存 |

**推荐工具逻辑**：
- 默认推荐 analyze_memory_overview
- 有 timeRange 时**不推荐**全局 gc_analysis（输出过多）
- 关键词驱动：gc -> analyze_gc；lmk/oom/kill -> analyze_lmk；dmabuf/gpu内存 -> analyze_dmabuf

### 12.4 BinderAgent

**定位**：Binder IPC 与锁竞争分析。

**Skills（5 个）**：

| toolName | skillId | 用途 |
|----------|---------|------|
| analyze_binder_overview | binder_analysis | 全局 Binder 通信概况 |
| get_binder_detail | binder_detail | 单个事务详情 |
| analyze_binder_range | binder_in_range | 区间 Binder 分析 |
| analyze_lock_contention | lock_contention_analysis | 锁竞争热点 |
| analyze_lock_range | lock_contention_in_range | 区间锁竞争 |

**推荐工具逻辑**：
- 有 timeRange -> analyze_binder_range；否则 -> analyze_binder_overview
- 锁相关关键词 / evidenceNeeded 包含 lock -> 追加锁竞争分析（in-range 或全局）

### 12.5 StartupAgent

**Skills（2 个）**：startup_analysis, startup_detail

### 12.6 InteractionAgent

**Skills（2 个）**：click_response_analysis, click_response_detail

### 12.7 ANRAgent

**Skills（2 个）**：anr_analysis, anr_detail

### 12.8 SystemAgent

**Skills（3 个）**：thermal_throttling, io_pressure, suspend_wakeup_analysis

额外能力：ADB 工具包含 trace recorder（`getAdbAgentTools({ includeRecorder: true })`）。

---

## 13. Agent 配置模式

所有 Domain Agent 共享统一的配置结构：

```typescript
interface AgentConfig {
  id: string;                   // 唯一标识
  name: string;                 // 显示名称
  domain: string;               // 领域标签
  description: string;          // 描述
  tools: AgentTool[];           // 内置工具（ADB 等）
  maxIterations: 3;             // Think-Act-Reflect 最大迭代
  confidenceThreshold: 0.7;     // 置信度阈值
  canDelegate: true;            // 是否可委托
  delegateTo: string[];         // 可委托的 Agent ID 列表
}
```

---

## 14. Skills 是否需要改造？（结论）

需要，但改造方向不是"加更多 LLM"，而是"更工具化、更证据优先"：

1. **输出列定义与摘要**：`display.columns` 富定义 + `synthesize` 洞见摘要
2. **诊断携带证据**：diagnostic 的 evidence_fields / inputs 设计
3. **失败可解释**：明确 prerequisites、on_empty、optional；让 Agent 能基于错误选择下一步（修复/换证据）

这会直接提升"洞见感"和"多轮承接感"。
