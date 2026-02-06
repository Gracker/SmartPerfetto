# SmartPerfetto Development Guide

AI-driven Perfetto analysis platform for Android performance data.

## Tech Stack

This is primarily a TypeScript codebase. Use TypeScript idioms, strict typing, and follow existing patterns in the codebase.

## Architecture Overview

```
Frontend (Perfetto UI @ :10000) ◄─SSE/HTTP─► Backend (Express @ :3000)
                │                                     │
                └───────── HTTP RPC (9100-9900) ──────┘
                                  │
                    trace_processor_shell (Shared)
```

**Core Concepts:**
- Frontend/backend share `trace_processor_shell` via HTTP RPC
- **Dual-Executor Architecture:** Strategy-Driven (deterministic) + Hypothesis-Driven (adaptive)
- Domain Agents collect evidence via SQL queries
- Analysis logic in YAML Skills (`backend/skills/`)
- Results layered: L1 (overview) → L2 (list) → L3 (diagnosis) → L4 (deep)
- SSE for real-time streaming

---

## Backend Structure

### Agent System (v6.0 - Conversation-Aware Architecture)

**Core:** `backend/src/agent/core/`
| Component | Purpose |
|-----------|---------|
| agentDrivenOrchestrator.ts | 主协调器 (策略匹配 → 执行器路由) |
| circuitBreaker.ts | 熔断器，触发用户介入 |
| modelRouter.ts | 多模型路由 (DeepSeek/OpenAI/Anthropic/GLM) |
| stateMachine.ts | 状态机 (IDLE→PLANNING→HYPOTHESIS→ROUNDS→CONCLUSION) |
| pipelineExecutor.ts | 任务执行流水线 |
| taskGraphPlanner.ts | 任务图生成 |
| taskGraphExecutor.ts | 依赖有序执行 |
| hypothesisGenerator.ts | 初始假设生成 |
| intentUnderstanding.ts | 意图理解 |
| conclusionGenerator.ts | 结论综合 |
| feedbackSynthesizer.ts | LLM 综合发现 |
| followUpHandler.ts | 后续问题处理与上下文延续 |

**Executors:** `backend/src/agent/core/executors/`
| Executor | Mode | Trigger | Description |
|----------|------|---------|-------------|
| strategyExecutor.ts | Deterministic | Strategy matched | 确定性多阶段流水线 |
| hypothesisExecutor.ts | Adaptive LLM | No strategy match | 假设驱动多轮分析 |
| directSkillExecutor.ts | Direct bypass | Stage template | 直接执行 Skill (零 LLM 开销) |
| clarifyExecutor.ts | Conversation | User clarification | 处理用户澄清请求 |
| comparisonExecutor.ts | Conversation | Compare request | 对比多次分析结果 |
| extendExecutor.ts | Conversation | Extend request | 扩展上一轮分析 |
| directDrillDownExecutor.ts | Drill-down | Time/range navigation | 直接跳转时间戳或区间 |
| analysisExecutor.ts | Interface | - | 执行器基类接口 |

**Conversation Support:** `backend/src/agent/core/`
| Component | Purpose |
|-----------|---------|
| drillDownResolver.ts | 解析 drill-down 导航 (时间戳/区间跳转) |
| entityCapture.ts | 从分析结果中提取实体 (进程/线程/帧) |

**Strategies:** `backend/src/agent/strategies/`
| Component | Purpose |
|-----------|---------|
| types.ts | StagedAnalysisStrategy, FocusInterval, StageDefinition, StageTaskTemplate |
| registry.ts | StrategyRegistry - trigger 匹配策略选择 |
| scrollingStrategy.ts | 滑动分析策略 (3 阶段流水线) |
| helpers.ts | 区间提取和格式化工具函数 |

**Decision Trees:** `backend/src/agent/decision/`
| Component | Purpose |
|-----------|---------|
| decisionTreeExecutor.ts | 决策树执行引擎 |
| decisionTreeStageExecutor.ts | 决策树与 Pipeline 集成 |
| skillExecutorAdapter.ts | Skill 调用适配器 |
| types.ts | 决策节点/分支/树类型 (CHECK/ACTION/BRANCH/CONCLUDE) |
| trees/scrollingDecisionTree.ts | 滑动场景决策树 |
| trees/launchDecisionTree.ts | 启动场景决策树 |

**Domain Agents:** `backend/src/agent/agents/domain/`
| Agent | Purpose |
|-------|---------|
| frameAgent.ts | 帧渲染分析 (jank_frame_detail, scrolling_analysis, consumer_jank_detection) |
| cpuAgent.ts | CPU 调度与负载 |
| memoryAgent.ts | 内存分配与 GC |
| binderAgent.ts | IPC/Binder 事务 |
| additionalAgents.ts | Startup、Interaction、ANR、System |

**Planning & Evaluation:** `backend/src/agent/agents/`
- plannerAgent.ts - 意图理解、任务分解
- evaluatorAgent.ts - 结果质量评估
- iterationStrategyPlanner.ts - 迭代策略决策（置信度评估，是否继续下一轮）
- sceneReconstructionAgent.ts - 场景重建
- scrollingExpertAgent.ts - 滑动专家 (legacy)

**Agent Bases:** `backend/src/agent/agents/base/`
- baseAgent.ts - Agent 基类
- baseSubAgent.ts - SubAgent 基类

**Communication:** `backend/src/agent/communication/`
- agentMessageBus.ts - Agent 间消息总线

**Context & State:**
- `context/enhancedSessionContext.ts` - 多轮对话上下文
- `context/contextBuilder.ts` - 按角色过滤上下文
- `context/contextTypes.ts` - 上下文类型定义
- `context/entityStore.ts` - 跨轮次实体追踪 (进程/线程/帧/区间)
- `context/policies/` - Planner/Evaluator/Worker Policy
- `compaction/contextCompactor.ts` - Token 溢出防护
- `compaction/tokenEstimator.ts` - Token 用量估算
- `compaction/strategies/slidingWindowStrategy.ts` - 滑动窗口压缩
- `state/checkpointManager.ts` - 暂停/恢复
- `state/sessionStore.ts` - 会话持久化
- `fork/forkManager.ts` - 会话分叉
- `fork/mergeStrategies.ts` - 分叉合并策略
- `fork/sessionTree.ts` - 会话树结构

**Hooks (Middleware):** `backend/src/agent/hooks/`
| Component | Purpose |
|-----------|---------|
| hookTypes.ts | Hook 生命周期和注册类型 |
| hookRegistry.ts | Hook 注册管理 |
| hookContext.ts | Hook 执行上下文 |
| middleware/loggingMiddleware.ts | 日志中间件 |
| middleware/timingMiddleware.ts | 计时中间件 |

**Experts:** `backend/src/agent/experts/`
- launchExpert.ts, interactionExpert.ts, systemExpert.ts
- `base/baseExpert.ts` - Expert 基类
- `crossDomain/` - 跨域分析
  - baseCrossDomainExpert.ts - 跨域基类
  - hypothesisManager.ts - 假设生命周期管理
  - dialogueProtocol.ts - Agent 通信协议
  - moduleCatalog.ts - 模块目录 (framework/vendor capabilities)
  - moduleExpertInvoker.ts - 模块专家调用
  - experts/performanceExpert.ts - 性能综合分析

**Tools:** `backend/src/agent/tools/`
- sqlExecutor.ts - SQL 查询执行
- frameAnalyzer.ts - 帧分析
- skillInvoker.ts - Skill 调用 (参数映射)
- dataStats.ts - 数据统计

**Detectors:** `backend/src/agent/detectors/`
- architectureDetector.ts - 架构检测 (总控)
- baseDetector.ts - Detector 基类
- standardDetector.ts - 标准 Android
- composeDetector.ts - Jetpack Compose
- flutterDetector.ts - Flutter
- webviewDetector.ts - WebView

**Other:**
- `types/agentProtocol.ts` - Agent 通信协议类型
- `llmAdapter.ts` - LLM 适配器
- `toolRegistry.ts` - 工具注册表
- `traceRecorder.ts` - Trace 录制
- `evalSystem.ts` - 评估系统

### Key Services

| Service | Location | Purpose |
|---------|----------|---------|
| TraceProcessorService | services/traceProcessorService.ts | HTTP RPC 查询 (端口池 9100-9900) |
| SkillExecutor | services/skillEngine/skillExecutor.ts | YAML Skill 引擎 |
| SkillLoader | services/skillEngine/skillLoader.ts | Skill 加载器 |
| PipelineSkillLoader | services/pipelineSkillLoader.ts | Pipeline Skill 加载器 (含 Teaching) |
| SkillAnalysisAdapter | services/skillEngine/skillAnalysisAdapter.ts | Skill 分析适配 |
| AnswerGenerator | services/skillEngine/answerGenerator.ts | 答案生成器 |
| SmartSummaryGenerator | services/skillEngine/smartSummaryGenerator.ts | 智能摘要 |
| EventCollector | services/skillEngine/eventCollector.ts | 事件收集 |
| HTMLReportGenerator | services/htmlReportGenerator.ts | HTML 报告生成 |
| SessionLogger | services/sessionLogger.ts | JSONL 会话日志 |
| AutoAnalysisService | services/autoAnalysisService.ts | 自动分析服务 |
| SessionPersistenceService | services/sessionPersistenceService.ts | 会话持久化 |
| ResultExportService | services/resultExportService.ts | 结果导出 |

---

## Data Flow

```
User Query → POST /api/agent/analyze → AgentDrivenOrchestrator
    │
    ├─ Phase 1: Intent Understanding + Hypothesis Generation
    │   └─ intentUnderstanding → generateInitialHypotheses (LLM)
    │
    ├─ Phase 2: Strategy Matching
    │   └─ StrategyRegistry.match(query) → scrollingStrategy / null
    │
    ├─ [Strategy Match] StrategyExecutor (Deterministic Pipeline):
    │   ├─ Stage 0 (overview): scroll_session_analysis → 识别卡顿会话
    │   ├─ extractIntervals() → FocusInterval[] (卡顿区间)
    │   ├─ Stage 1 (session_overview): 每会话 FPS/掉帧统计
    │   ├─ Stage 2 (per_interval): jank_frame_detail → 逐帧分析
    │   └─ generateConclusion → analysis_completed
    │
    ├─ [No Strategy] HypothesisExecutor (Adaptive LLM Loop):
    │   ├─ Round 1:
    │   │   ├─ 分派任务 → Domain Agents (Frame/CPU/Memory/Binder)
    │   │   ├─ Agents 执行 SQL → 收集 Evidence
    │   │   ├─ 综合 Findings (severity: critical/warning/info)
    │   │   └─ IterationStrategyPlanner → 评估置信度
    │   │
    │   ├─ Round N (if confidence < threshold):
    │   │   └─ 深入分析，补充证据
    │   │
    │   └─ generateConclusion → analysis_completed
    │
    └─ Circuit Breaker: 置信度过低时触发用户介入
```

### Multi-Round Conversation Flow

```
Round N+1 (Follow-up Query) → Intent Classification:
    │
    ├─ [Clarify] "刚才说的第3帧是什么情况?"
    │   └─ ClarifyExecutor → entityStore.resolve("第3帧") → 定向分析
    │
    ├─ [Extend] "继续分析 CPU 调度"
    │   └─ ExtendExecutor → 复用上轮 FocusInterval → 扩展 skill
    │
    ├─ [Compare] "对比这两次滑动"
    │   └─ ComparisonExecutor → 多区间并行分析 → 差异报告
    │
    └─ [DrillDown] 点击表格中的时间戳
        └─ DrillDownResolver → navigate_timeline / navigate_range
```

**Entity Tracking:** `entityStore` 跨轮次追踪实体引用
- 进程: "com.example.app" → processName
- 线程: "RenderThread" → threadName
- 帧: "第3帧" → frameId + timestamp
- 区间: "卡顿会话" → FocusInterval

---

## Dual-Executor Pattern

**Purpose:** 根据场景选择最优执行路径，平衡确定性与灵活性。

### StrategyExecutor (Deterministic)

```
Query → Strategy.trigger() match → Multi-stage pipeline → Fixed output
```

**特点:**
- 预定义分析流水线
- 确定性阶段转换
- 保证输出格式
- 支持 `direct_skill` 模式 (零 LLM 开销)
- 适用: 滑动、启动、导航等常见场景

### HypothesisExecutor (Adaptive)

```
Query → LLM 假设生成 → Multi-round refinement → Variable output
```

**特点:**
- LLM 驱动假设生成
- 多轮迭代优化
- 输出随发现变化
- Circuit Breaker 用户介入
- 适用: 通用分析、边缘场景

### Execution Modes

| Mode | LLM Overhead | Use Case |
|------|--------------|----------|
| `agent` | Full reasoning | 需要 LLM 决策的任务 |
| `direct_skill` | Zero | 确定性 SQL 查询 (`*_in_range` skills) |

---

## Strategy System

**Purpose:** 将常见分析场景编码为确定性多阶段流水线，避免 LLM 不确定性。

### Scrolling Strategy (3 Stages)

```
Stage 0 (overview):
  - Skill: scroll_session_analysis
  - Scope: global
  - Output: scroll_sessions, session_jank data
  - extractIntervals() → FocusInterval[] (janky sessions)

Stage 1 (session_overview):
  - Skill: scrolling_analysis
  - Scope: global (with session context)
  - Output: FPS, frame drop stats per session

Stage 2 (per_interval):
  - Skill: jank_frame_detail
  - Scope: per_interval
  - For each FocusInterval:
    - Run with start_ts/end_ts parameters
    - Collect CPU/Binder/Rendering metrics per frame
```

**Key Concepts:**
- `StagedAnalysisStrategy` — 策略定义 (trigger + stages)
- `StageDefinition` — 阶段定义 (tasks + extractIntervals + shouldStop)
- `StageTaskTemplate` — 任务模板 (agentId + scope + executionMode + skillParams)
- `FocusInterval` — 焦点区间 (startTs/endTs/processName/priority)
- `skillParams` — 泛型参数传递，Strategy → Agent → Skill

---

## Skill System

**Types:** atomic, composite, iterator, parallel, conditional

**Layered Results:**
- **L1 (overview):** 聚合指标 - `display.level: overview/summary`
- **L2 (list):** 数据列表 - `display.level: list/detail` + expandableData
- **L3 (diagnosis):** 逐帧诊断 - iterator over jank frames
- **L4 (deep):** 详细分析 - `display.level: deep/frame`

**Parameter Substitution:**
```yaml
# Skill 通过 ${param|default} 接收参数
inputs:
  - name: max_frames_per_session
    type: number
    required: false
steps:
  - id: diagnose
    type: iterator
    max_items: "${max_frames_per_session|8}"  # Strategy 传参覆盖默认值
```

**Skill Example:**
```yaml
name: scrolling_analysis
type: composite
steps:
  - id: summary
    sql: "SELECT COUNT(*) as total..."
    display: { level: overview, title: "概览" }
  - id: jank_frames
    sql: "SELECT frame_id, ts, dur..."
    display:
      level: list
      columns:
        - { name: ts, type: timestamp, clickAction: navigate_timeline }
        - { name: dur, type: duration, format: duration_ms }
```

**Location:** `backend/skills/`
- `atomic/` - 单步检测 (32 skills)
- `composite/` - 组合分析 (27 skills)
- `deep/` - 深度分析 (2 skills)
- `modules/` - 模块配置 (app/framework/hardware/kernel)
- `vendors/` - 厂商适配 (pixel/samsung/xiaomi/honor/oppo/vivo/qualcomm/mtk)

### Atomic Skills (32)

**Frame Analysis:**
- app_frame_production, consumer_jank_detection, render_thread_slices
- rendering_arch_detection, present_fence_timing, vrr_detection, vsync_config

**CPU Analysis:**
- cpu_freq_timeline, cpu_load_in_range, cpu_slice_analysis
- cpu_topology_detection, scheduling_analysis, lock_contention_in_range

**Range-Based Skills (12 - direct_skill 模式):**
- binder_blocking_in_range, cpu_cluster_load_in_range, cpu_throttling_in_range
- gpu_freq_in_range, gpu_render_in_range, page_fault_in_range
- render_pipeline_latency, sched_latency_in_range, sf_composition_in_range
- system_load_in_range, task_migration_in_range, vsync_alignment_in_range

**Other:**
- binder_in_range, gpu_metrics, game_fps_analysis, sf_frame_consumption

### Composite Skills (27)

**Scrolling/Jank:**
- scroll_session_analysis, scrolling_analysis, jank_frame_detail

**Startup:**
- startup_analysis, startup_detail

**ANR:**
- anr_analysis, anr_detail

**Interaction:**
- click_response_analysis, click_response_detail, navigation_analysis

**System Analysis:**
- cpu_analysis, memory_analysis, gc_analysis, lmk_analysis
- binder_analysis, binder_detail, gpu_analysis, surfaceflinger_analysis

**Issues:**
- lock_contention_analysis, render_pipeline_latency
- block_io_analysis, io_pressure, dmabuf_analysis
- suspend_wakeup_analysis, thermal_throttling, irq_analysis, network_analysis

**Meta:**
- scene_reconstruction

### Pipeline Skills (25)

**Location:** `backend/skills/pipelines/`

渲染管线检测和教学内容，每个 Pipeline Skill 包含:
- `detection` - SQL 检测逻辑
- `teaching` - 教学内容 (线程角色、关键 Slice、Mermaid 时序图)

**Android View 系列:**
- android_view_standard_blast, android_view_standard_legacy
- android_view_software, android_view_mixed, android_view_multi_window
- android_pip_freeform

**Surface/Texture 系列:**
- surfaceview_blast, textureview_standard, surface_control_api

**Flutter 系列:**
- flutter_surfaceview_skia, flutter_surfaceview_impeller, flutter_textureview

**WebView 系列:**
- webview_gl_functor, webview_surface_control
- webview_surfaceview_wrapper, webview_textureview_custom

**Graphics API 系列:**
- opengl_es, vulkan_native, angle_gles_vulkan

**特殊场景:**
- game_engine, video_overlay_hwc, camera_pipeline
- hardware_buffer_renderer, variable_refresh_rate

---

## Teaching Content System

**Purpose:** 为每种渲染管线提供结构化教学内容，帮助用户理解帧渲染流程。

### 数据结构

```typescript
interface TeachingContent {
  threadRoles: ThreadRole[];     // 关键线程角色
  keySlices: KeySlice[];         // 关键 Trace Slice
  mermaidBlocks: string[];       // Mermaid 时序图源码
}

interface ThreadRole {
  thread: string;                // 线程名 (main/RenderThread/SurfaceFlinger)
  responsibility: string;        // 职责描述
  traceLabels: string[];         // 对应的 Trace 标签
}

interface KeySlice {
  name: string;                  // Slice 名称
  description?: string;          // 说明
}
```

### 前端渲染

**Mermaid 图表渲染流程:**
```
Teaching Content → Base64 编码 → data-mermaid-b64 属性
                                       ↓
页面加载 → loadMermaidScript() → 从 assets/mermaid.min.js 加载
                                       ↓
renderMermaidInElement() → 解码 Base64 → mermaid.render() → SVG
```

**CSP 兼容:** Mermaid.js 从同源 `assets/mermaid.min.js` 加载，符合 CSP `script-src 'self'`

---

## DataEnvelope (v2.0)

统一数据契约 - 数据自描述，前端按配置渲染。

```typescript
interface DataEnvelope<T> {
  meta: { type, version, source, skillId?, stepId? };
  data: T;  // { columns, rows, expandableData }
  display: { layer, format, title, columns?: ColumnDefinition[] };
}

interface ColumnDefinition {
  name: string;
  type: 'timestamp' | 'duration' | 'number' | 'string' | 'percentage' | 'bytes';
  format?: 'duration_ms' | 'timestamp_relative' | 'compact';
  clickAction?: 'navigate_timeline' | 'navigate_range' | 'copy';
}
```

**Type Generation:** `npm run generate:frontend-types` (auto-run by start-dev.sh)

---

## Frontend

**Plugin:** `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`
- ai_panel.ts - 主 UI + Mermaid 渲染
- sql_result_table.ts - 数据表格 (schema-driven)
- ai_service.ts - 后端通信
- chart_visualizer.ts - 图表可视化
- navigation_bookmark_bar.ts - 导航书签

**Mermaid 图表支持:**
- 懒加载 `assets/mermaid.min.js` (CSP 兼容)
- Base64 编码存储图表源码
- 错误处理 + 源码折叠展示

---

## API Endpoints

**Agent (唯一主链路):**
- `POST /api/agent/analyze` - 启动分析 (Strategy 匹配 → Executor 路由)
- `GET /api/agent/:sessionId/stream` - SSE 实时流
- `GET /api/agent/:sessionId/status` - 轮询状态
- `POST /api/agent/:sessionId/respond` - 响应断路器
- `POST /api/agent/scene-reconstruct` - 场景重建（独立功能）

**Logs:**
- `GET /api/agent/logs/:sessionId` - 会话日志
- `GET /api/agent/logs/:sessionId/errors` - 仅错误

**Trace:**
- `POST /api/traces/register-rpc` - 注册 RPC

**Skills:**
- `GET /api/skills/*` - Skill 管理

**Export:**
- `POST /api/export/*` - 结果导出

**Sessions:**
- `GET /api/sessions/*` - 会话管理

---

## SSE Events (Agent-Driven)

| Event | Phase Mapping | Description |
|-------|---------------|-------------|
| progress | starting, understanding, concluding | 阶段进度 |
| hypothesis_generated | hypotheses_generated | 假设生成 |
| round_start | round_start | 新一轮开始 |
| stage_start | stage_start | 策略阶段开始 |
| agent_task_dispatched | tasks_dispatched | 任务批量分派 |
| agent_dialogue | task_dispatched | 单任务分派 |
| agent_response | task_completed | Agent 完成任务 |
| synthesis_complete | synthesis_complete | 综合结果 |
| strategy_decision | strategy_decision | 迭代策略决定 |
| analysis_completed | - | 分析完成 |
| error | - | 错误 |

---

## Session Management

- 路由层内存 `Map<sessionId, AnalysisSession>` 管理会话
- 每 30 分钟清理过期会话
- 支持多轮对话（复用 sessionId）
- AnalysisSession 包含: orchestrator, sseClients, result, hypotheses, agentDialogue

---

## Quick Start

```bash
./scripts/start-dev.sh  # Auto-builds trace_processor_shell
# Backend @ :3000, Frontend @ :10000
```

---

## Common Issues

| Issue | Solution |
|-------|----------|
| "AI backend not connected" | `./scripts/start-dev.sh` |
| Empty data | 检查 stepId 匹配 YAML `id:` |
| Port conflict | `pkill -f trace_processor_shell` |
| Debug | 查看 `backend/logs/sessions/*.jsonl` |
| Build/compilation error in unfamiliar file | Check if the file is auto-generated before editing. Look for headers like `// Generated`, `/* Auto-generated */`, or check if the path contains `generated`, `build`, or `dist`. Fix the generator/template instead. |

---

## Code Generation

When fixing localization (L10n) or code generation issues, always identify and modify the generator script/template rather than editing generated output files directly.

---

## Environment

```bash
# backend/.env
PORT=3000
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=sk-xxx
```

---

## File Count Summary

| Category | Count |
|----------|-------|
| Agent System | ~129 source files |
| Services | ~31 service files |
| Skills | 86 definitions (32 atomic + 27 composite + 25 pipelines + 2 deep) |
| Routes | 16 API handlers |
