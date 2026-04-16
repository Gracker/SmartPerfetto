# SmartPerfetto 技术架构文档

> AI-driven Perfetto Trace 分析平台 — 面向技术人员的深度介绍

---

## 目录

1. [为什么需要 SmartPerfetto？LLM 不能直接分析 Trace 吗？](#1-为什么需要-smartperfetto)
2. [整体架构概览](#2-整体架构概览)
3. [Agent 系统 (agentv3)](#3-agent-系统-agentv3)
4. [MCP 工具体系](#4-mcp-工具体系)
5. [Skill 技能系统](#5-skill-技能系统)
6. [Context Engineering — 上下文工程](#6-context-engineering--上下文工程)
7. [验证与纠错系统](#7-验证与纠错系统)
8. [数据流与流式输出](#8-数据流与流式输出)
9. [总结：各层职责一览](#9-总结各层职责一览)

---

## 1. 为什么需要 SmartPerfetto？

### 1.1 LLM 能直接分析 Perfetto Trace 吗？

**简短回答：不能。** 至少不能可靠地分析。

Perfetto trace 是一种二进制的 protobuf 格式 (`.pftrace`)，记录了 Android 系统在一段时间内的调度、渲染、Binder IPC、CPU 频率、内存分配等数百种事件。一个典型的 trace 文件包含**数百万行数据**、几十个 track、上千个进程/线程。

如果你把 trace 直接丢给 LLM，会遇到以下根本性问题：

#### 问题 1：数据规模远超 Context Window

| 维度 | 典型值 |
|------|--------|
| Trace 文件大小 | 50MB - 500MB |
| 事件数 | 百万 ~ 千万级 |
| 序列化为文本后 | 数 GB |
| Claude 最大 context | ~200K tokens (约 150K 字) |

即使是最先进的 LLM，context window 也只能容纳 trace 数据的极小部分。**你无法把 trace "喂给" LLM。**

#### 问题 2：LLM 不是数据库，无法做精确计算

性能分析需要大量**精确的数值计算**：

- 帧耗时的 P50 / P90 / P99 统计
- VSync 周期检测（需要中位数 + IQR 过滤）
- CPU 频率在某个时间段的利用率百分比
- Binder 调用延迟的分布统计

LLM 做这些事情会**幻觉**——它会编造看起来合理但完全错误的数字。这在性能分析中是致命的，因为一个错误的 P90 帧耗时会导致完全相反的结论。

#### 问题 3：缺乏领域知识的结构化运用

Android 渲染管线极其复杂。以滚动卡顿分析为例：

1. 首先需要判断渲染架构（Standard View / Flutter / Compose / WebView），不同架构的线程模型完全不同
2. 需要理解 SurfaceFlinger 的 buffer 消费模型（present_ts 间隔 vs token gap）
3. 卡顿帧的"责任归属"需要追溯 2-3 帧的延迟（guilty frame tracing）
4. 根因可能跨线程、跨进程（如 Binder 阻塞、GC、CPU 调度）

LLM 虽然"知道"这些概念，但缺乏将知识**结构化、分阶段**运用到具体 trace 数据上的能力。

#### 问题 4：可靠性不足

直接让 LLM 分析性能数据，你会遇到：

- **幻觉**：编造不存在的 slice 名、错误的时间戳
- **遗漏**：只看到部分数据就下结论，忽略关键信息
- **浅层归因**：停留在"MainThread 耗时过长"而不深入到具体原因
- **不一致**：同样的 trace 可能得到不同的结论

### 1.2 SmartPerfetto 的解决思路

**核心理念：让 LLM 做它擅长的事（推理、归因、表达），让工具做它擅长的事（查询、计算、检索）。**

```
┌─────────────────────────────────────────────────────────┐
│                    SmartPerfetto                         │
│                                                         │
│  LLM (Claude) 负责:          工具系统负责:               │
│  ├─ 理解用户问题              ├─ SQL 精确查询             │
│  ├─ 制定分析计划              ├─ 数值计算与统计            │
│  ├─ 推理因果关系              ├─ 渲染架构检测              │
│  ├─ 跨领域关联分析            ├─ 分层数据提取 (L1-L4)     │
│  ├─ 生成结构化报告            ├─ Perfetto stdlib 查询      │
│  └─ 自然语言交互              └─ 数据摘要与压缩            │
│                                                         │
│  连接层: MCP (Model Context Protocol) — 20 个工具        │
│  质量层: 4 层验证 + 反思纠错                              │
└─────────────────────────────────────────────────────────┘
```

简单来说：

- **trace_processor** (Perfetto 官方的 SQL 引擎) 负责数据查询
- **Skill 系统** 封装领域分析逻辑为可复用的 YAML pipeline
- **MCP 工具** 是 LLM 与数据之间的桥梁
- **Agent 系统** 编排整个分析流程，包括规划、假设、验证
- **Context Engineering** 确保 LLM 获得最相关的上下文

---

## 2. 整体架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend                                  │
│  Perfetto UI (fork) + AI Assistant Plugin                       │
│  (ai_panel.ts / sql_result_table.ts / chart_visualizer.ts)     │
│                        :10000                                    │
└─────────────────┬───────────────────────────────────────────────┘
                  │ SSE / HTTP
┌─────────────────▼───────────────────────────────────────────────┐
│                        Backend                                   │
│                     Express @ :3000                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                 agentv3 Runtime                            │   │
│  │                                                           │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐   │   │
│  │  │ ClaudeRuntime│  │SystemPrompt  │  │ SseBridge     │   │   │
│  │  │ (orchestrator)│  │Builder       │  │ (SDK→SSE)     │   │   │
│  │  └──────┬───────┘  └──────┬───────┘  └───────────────┘   │   │
│  │         │                 │                                │   │
│  │  ┌──────▼─────────────────▼──────────────────────────┐   │   │
│  │  │          Claude Agent SDK (Anthropic)               │   │   │
│  │  │     Claude Sonnet/Opus + MCP Protocol               │   │   │
│  │  └──────┬──────────────────────────────────────────────┘   │   │
│  │         │ MCP Tool Calls                                   │   │
│  │  ┌──────▼──────────────────────────────────────────────┐   │   │
│  │  │          MCP Server (20 Tools)                       │   │   │
│  │  │  execute_sql | invoke_skill | detect_architecture    │   │   │
│  │  │  lookup_sql_schema | list_stdlib_modules | ...       │   │   │
│  │  └──────┬──────────────────────────────────────────────┘   │   │
│  │         │                                                  │   │
│  │  ┌──────▼──────────┐  ┌────────────────┐                 │   │
│  │  │ Skill Executor  │  │ SQL Summarizer  │                 │   │
│  │  │ (164 skills)    │  │ (~85% 压缩)     │                 │   │
│  │  └──────┬──────────┘  └────────────────┘                 │   │
│  │         │                                                  │   │
│  │  ┌──────▼──────────┐  ┌────────────────┐                 │   │
│  │  │ Verifier        │  │ Artifact Store  │                 │   │
│  │  │ (4 层验证)      │  │ (结果缓存)      │                 │   │
│  │  └─────────────────┘  └────────────────┘                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              trace_processor_shell                         │   │
│  │         Perfetto SQL Engine (WASM / HTTP RPC)             │   │
│  │              Port Range: 9100 - 9900                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 核心数据流

```
用户问题 "这个 trace 为什么卡？"
    │
    ▼
Scene Classifier ──→ "scrolling" (关键词匹配, <1ms)
    │
    ▼
System Prompt Builder ──→ 组装: 角色 + 方法论 + 滚动策略 + 架构指南 + 输出格式
    │
    ▼
Claude Agent SDK ──→ Claude 理解问题，制定分析计划
    │
    ▼  (Claude 自主调用 MCP 工具)
    ├─ invoke_skill("scrolling_analysis") ──→ 帧级统计、卡顿检测、根因分类
    ├─ invoke_skill("jank_frame_detail")  ──→ 逐帧深入分析
    ├─ execute_sql("SELECT ...")           ──→ 补充查询特定数据
    ├─ lookup_knowledge("cpu-scheduler")   ──→ 加载 CPU 调度背景知识
    │
    ▼
Verifier ──→ 检查: 证据充分？根因够深？假设都验证了？
    │
    ▼ (如不通过, 反思纠错, 最多 2 轮)
    │
    ▼
结构化报告 ──→ 发现列表 + 因果链 (Mermaid) + 优化建议
    │
    ▼ (SSE 实时流式输出)
Frontend ──→ 用户看到分析结果 + 可交互的数据表格 + 时间线导航
```

---

## 3. Agent 系统 (agentv3)

### 3.1 为什么用 Agent 而不是简单的 LLM 调用？

性能分析不是一个"给输入、得输出"的任务。它是一个**多步骤、需要动态决策**的探索过程：

1. 先做总览，确定问题方向
2. 根据总览结果，决定深入哪个方向
3. 可能需要回退，换个方向
4. 最后综合所有发现，形成结论

这恰好是 Agent 架构的核心优势——LLM 自主规划、工具调用、迭代推理。

### 3.2 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **ClaudeRuntime** | `claudeRuntime.ts` | 主编排器。管理分析生命周期、会话状态、超时控制 |
| **MCP Server** | `claudeMcpServer.ts` | 20 个工具的注册与执行。Claude 通过 MCP 协议调用 |
| **System Prompt** | `claudeSystemPrompt.ts` | 动态构建 system prompt，注入场景策略和上下文 |
| **SSE Bridge** | `claudeSseBridge.ts` | SDK 流式消息 → SSE 事件转换 |
| **Verifier** | `claudeVerifier.ts` | 4 层验证 + 反思纠错 |
| **Scene Classifier** | `sceneClassifier.ts` | 关键词场景分类 (<1ms) |
| **Strategy Loader** | `strategyLoader.ts` | 加载 `.strategy.md` 和 `.template.md`；解析 `phase_hints` 供 restatement 注入 |
| **Complexity Classifier** | `queryComplexityClassifier.ts` | 查询复杂度路由 — 7 deterministic scenes + Haiku fallback |
| **Artifact Store** | `artifactStore.ts` | Skill 结果缓存 + 分级获取 |
| **SQL Summarizer** | `sqlSummarizer.ts` | SQL 结果摘要 (~85% token 节省) |

### 3.3 分析流程

```
analyze(query, sessionId, traceId)
    │
    ├─ 1. 并发守卫：同一 session 不允许并行分析
    │
    ├─ 2. prepareAnalysisContext()
    │     ├─ detectArchitecture() → Standard/Flutter/Compose/WebView
    │     ├─ classifyScene(query) → scrolling/startup/anr/general/...
    │     └─ buildSystemPrompt() → 动态组装 prompt (4500 token 预算)
    │
    ├─ 3. sdkQuery() → Claude Agent SDK
    │     └─ Claude 自主调用 MCP 工具（最多 30 轮）
    │
    ├─ 4. 验证循环
    │     ├─ Heuristic checks (无 LLM, <1ms)
    │     ├─ Plan adherence check
    │     ├─ Hypothesis resolution check
    │     ├─ Scene completeness check
    │     └─ LLM verification (可选)
    │
    ├─ 5. 如果验证不通过 → 反思纠错 (最多 2 轮)
    │
    └─ 6. 返回 AnalysisResult
          ├─ conclusion (结论文本)
          ├─ findings[] (发现列表)
          ├─ dataEnvelopes[] (结构化数据)
          └─ confidence (置信度)
```

### 3.4 安全与治理机制

Agent 自主运行意味着需要**严格的安全边界**：

| 机制 | 说明 |
|------|------|
| **并发守卫** | `activeAnalyses` Set 防止同一 session 并行分析 |
| **超时控制** | 40s/轮 × 最多 30 轮 = 20 分钟上限 |
| **Watchdog** | 检测连续 3 次同工具失败 → 触发策略切换 |
| **Circuit Breaker** | >60% 工具调用失败 → 简化分析范围 |
| **Safety Timer** | Promise.race() 级别的强制超时 |
| **Stream 取消** | 超时时主动终止 SDK 流，停止 API 消费 |

### 3.5 多轮对话

SmartPerfetto 支持多轮追问：

- 用户可以基于上一轮结果继续提问
- SDK session ID 持久化到 `logs/claude_session_map.json`
- 通过 `resume: sdkSessionId` 恢复 SDK 上下文
- 分析笔记 (`analysis_notes`) 在 context compression 后仍然保留
- 实体追踪 (`entity_context`) 记录已发现的关键实体

---

## 4. MCP 工具体系

### 4.1 什么是 MCP？

MCP (Model Context Protocol) 是 Anthropic 推出的标准化协议，让 LLM 可以调用外部工具。SmartPerfetto 注册了 **20 个 MCP 工具**（9 个 always-on + 8 个全分析模式 + 3 个对比模式），这是 Claude 与 trace 数据之间的唯一桥梁。

Claude **不直接**访问 trace 数据。它通过调用 MCP 工具，获取结构化的查询结果。

### 4.2 工具清单

#### 核心数据访问 (9 个，always-on)

| 工具 | 用途 | 说明 |
|------|------|------|
| `execute_sql` | 执行 Perfetto SQL | 支持 `summary=true` 返回摘要而非全量数据 |
| `invoke_skill` | 执行 Skill pipeline | 参数: skillId + 业务参数 (package, time range 等) |
| `list_skills` | 列出可用 Skills | 按 category 过滤 (scrolling/startup/cpu/memory/...) |
| `detect_architecture` | 检测渲染架构 | 返回类型 + 置信度 + 证据 |
| `lookup_sql_schema` | 查询 SQL 模式 | 搜索 761 个 Perfetto stdlib 表/视图/函数 |
| `query_perfetto_source` | 查询 stdlib 源码 | 查找用法模式和示例 |
| `list_stdlib_modules` | 列出 stdlib 模块 | 发现可用的 Perfetto stdlib 模块 |
| `lookup_knowledge` | 加载背景知识 | 6 个领域: 渲染管线/Binder/GC/CPU调度/温控/锁竞争 |
| `recall_patterns` | 跨会话分析模式记忆 | 正面/负面经验 (加权 Jaccard 匹配) |

#### 规划与假设 (8 个，conditional)

| 工具 | 用途 |
|------|------|
| `submit_plan` | 提交分析计划 (hard-gate: 首次缺少必查项 → 拒绝) |
| `update_plan_phase` | 更新阶段状态 + restatement 注入 (注入下一阶段策略约束) |
| `revise_plan` | 中途修订计划 (新信息出现时) |
| `submit_hypothesis` | 提交可验证的假设 |
| `resolve_hypothesis` | 确认/否定假设 (附证据) |
| `write_analysis_note` | 写入分析笔记 (抗 context compression) |
| `fetch_artifact` | 分级获取 Skill 结果 (summary/rows/full) |
| `flag_uncertainty` | 标记不确定性 (非阻塞) |

#### 对比模式 (3 个，comparison mode)

双 trace 对比时启用（请求中提供 `referenceTraceId`）：

| 工具 | 用途 |
|------|------|
| `execute_sql_on` | 对指定 trace (current/reference) 执行 SQL |
| `compare_skill` | 同一 Skill 对两个 trace 并行执行，返回并排结果 |
| `get_comparison_context` | 获取两个 trace 的元数据差异 |

#### 查询复杂度路由 (Query Complexity Router)

`queryComplexityClassifier.ts` 在分析开始前判断查询复杂度，将简单查询路由到 **Lightweight Mode**（5 轮、low effort、仅 3 个工具），避免全分析模式的开销��7 个确定性场景 (scrolling/startup/anr/interaction/scroll_response/teaching/pipeline) 直接走 full 路径，仅 general/memory/game/overview/touch-tracking 使用 Haiku 分类。

#### 自学习系统 (内置于验证器)

- 自动从验证结果中提取误诊模式 (90 天 TTL, 30 条上限)
- ≥2 次出现的模式加入启发式检查规则

### 4.3 为什么需要这么多工具？

**对比：没有工具体系 vs SmartPerfetto**

```
❌ 没有工具体系:
   用户: "分析这个 trace 的卡顿"
   LLM:  "好的...（但我看不到任何数据）...根据一般经验，
          卡顿可能是由于主线程阻塞..."

✅ SmartPerfetto:
   用户: "分析这个 trace 的卡顿"
   Claude:
     1. detect_architecture → "Standard View, 置信度 95%"
     2. invoke_skill("scrolling_analysis") → "发现 47 帧卡顿,
        P90=23.5ms, 根因分布: GPU 35%, SF 25%, APP 40%"
     3. invoke_skill("jank_frame_detail", frame_id=...) →
        "Frame #1234: RenderThread blocked 15ms by dequeueBuffer,
         因为 GPU 上一帧还没画完"
     4. lookup_knowledge("rendering-pipeline") → 加载渲染管线知识
     5. 综合推理 → "根因: GPU 负载过高 (着色器复杂度),
        导致 buffer 不足, 触发 RenderThread 阻塞"
```

### 4.4 Artifact Store — 节省 Token 的关键

`invoke_skill` 可能返回几百行数据。如果全部放进 Claude 的 context，会快速耗尽 token 预算。

**Artifact Store 的解决方案**：

```
invoke_skill() 返回:
    ├─ Claude 看到: artifactId + 摘要 (行数、列名、首行) ← ~440 tokens
    └─ 完整数据存入 Artifact Store

Claude 需要详情时:
    fetch_artifact(id, detail="rows", offset=0, limit=50) ← 按需分页
```

- 每个 Skill 结果节省 ~3000 tokens
- LRU 策略，最多 50 个 artifacts / session
- 前端始终获得完整 DataEnvelope（artifact 只压缩 Claude 的上下文）

---

## 5. Skill 技能系统

### 5.1 为什么需要 Skill？

如果让 LLM 每次从头写 SQL 分析卡顿，会有几个问题：

1. **SQL 不稳定**：LLM 可能写出语法错误或逻辑错误的 SQL
2. **分析不全面**：可能遗漏关键指标（如 VSync 周期检测）
3. **不可复现**：同样的问题，每次分析路径不同
4. **Token 浪费**：复杂的多步 SQL 每次都要重新生成

**Skill 的核心思想：把领域专家的分析知识封装为可复用的 YAML pipeline。**

LLM 只需要决定"用哪个 Skill"，Skill 负责"怎么分析"。

### 5.2 Skill 全景

| 类型 | 数量 | 位置 | 说明 |
|------|------|------|------|
| **Atomic** | 87 | `skills/atomic/` | 单一检测能力 (如 VSync 检测、CPU 频率分析) |
| **Composite** | 29 | `skills/composite/` | 组合分析 (如 scrolling_analysis = 多个 atomic 的编排) |
| **Deep** | 2 | `skills/deep/` | 深度分析 (cpu_profiling, callstack_analysis) |
| **Pipeline** | 28 | `skills/pipelines/` | 渲染管线检测 + 教学 (28 种管线类型) |
| **Module** | 18 | `skills/modules/` | 模块分析 (app/framework/hardware/kernel) |
| **总计** | **164** | | |

### 5.3 Skill YAML 结构

以 `consumer_jank_detection` 为例：

```yaml
name: consumer_jank_detection
version: "2.0"
type: composite
description: "基于 present_ts 间隔的真实卡顿检测"
category: scrolling

triggers:
  keywords: [卡顿, jank, 掉帧, fps]

prerequisites:
  stdlib_modules:
    - android.frames.timeline

inputs:
  - name: process_name
    type: string
    required: true
  - name: start_ts
    type: number
  - name: end_ts
    type: number

steps:
  - id: vsync_config
    type: atomic
    sql: |
      -- 检测 VSync 周期 (中位数 + IQR 过滤)
      SELECT ... FROM ...
    display:
      level: summary

  - id: consumer_jank_frames
    type: atomic
    sql: |
      -- 基于 present_ts 间隔检测真实卡顿
      WITH frames AS (...)
      SELECT frame_id, duration_ms, jank_type, severity
      FROM ...
    display:
      level: list
      columns:
        - { name: duration_ms, type: duration, click: navigate_timeline }

  - id: jank_severity_distribution
    type: atomic
    sql: |
      -- 卡顿严重度分布
      SELECT severity, count, percentage FROM ...
    display:
      level: overview

outputs:
  - stepId: consumer_jank_frames
    layer: L2
  - stepId: jank_severity_distribution
    layer: L1
```

### 5.4 分层结果 (L1-L4)

Skill 输出分为 4 层，对应分析的不同深度：

```
L1 (Overview)  ─── "47 帧卡顿, P90=23.5ms, SEVERE 占 12%"
    │                    ↑ 聚合指标，快速了解全貌
    ▼
L2 (List)      ─── 每一帧的详情列表 (frame_id, duration, jank_type)
    │                    ↑ 可展开的数据表格
    ▼
L3 (Diagnosis) ─── 逐帧诊断 (通过 iterator 遍历每个卡顿帧)
    │                    ↑ 每帧的线程状态、阻塞原因
    ▼
L4 (Deep)      ─── 深度分析 (阻塞链、Binder 根因、调用栈)
                         ↑ 跨线程/跨进程的因果追踪
```

### 5.5 Step 类型

| Step 类型 | 说明 | 典型用途 |
|-----------|------|----------|
| `atomic` | 单条 SQL 查询 | 大多数检测 |
| `skill_ref` | 引用另一个 Skill | 组合分析 |
| `iterator` | 遍历数据行 (循环) | 逐帧诊断 |
| `parallel` | 并行执行多个 step | 独立指标同时获取 |
| `conditional` | 条件分支 | 根据架构类型走不同路径 |
| `diagnostic` | 诊断逻辑 | 状态判断 + 阈值告警 |
| `pipeline` | 渲染管线检测 | 28 种管线的匹配 |

### 5.6 SQL Fragment 复用

`skills/fragments/` 目录下的 `.sql` 文件是可复用的 SQL 片段，在执行时作为 CTE 注入：

```sql
-- fragments/vsync_config.sql
vsync_config AS (
  SELECT median_period_ns, iqr_filtered_mean
  FROM ...
)

-- fragments/thread_states_quadrant.sql
thread_states_quadrant AS (
  SELECT thread_name, state, duration,
         CASE WHEN ... THEN 'Q1' ... END AS quadrant
  FROM ...
)
```

Skill 可以通过 `fragments: [vsync_config, thread_states_quadrant]` 引用，避免重复编写。

### 5.7 Pipeline Skills — 渲染管线教学

SmartPerfetto 支持 **28 种** Android 渲染管线的自动识别和教学：

```
Standard View (Blast/Legacy) | Flutter (TextureView/SurfaceView)
Compose | WebView (多种变体) | OpenGL ES | Vulkan | ANGLE
SurfaceControl | Video Overlay | Camera Pipeline | Game Engine
...
```

每个 Pipeline Skill 包含：
- **detection**: 如何在 trace 中识别该管线 (signal matching)
- **teaching**: Mermaid 序列图 + 线程角色说明
- **auto_pin**: 推荐 pin 到时间线的 track
- **analysis**: 常见问题 + 推荐 Skills

---

## 6. Context Engineering — 上下文工程

### 6.1 为什么上下文工程很重要？

LLM 的效果**高度依赖**你给它的 system prompt。SmartPerfetto 的 system prompt 不是静态的——它根据用户的问题、trace 的特征、历史上下文**动态组装**。

### 6.2 System Prompt 组装

```
System Prompt (4500 token 预算)
    │
    ├─ [角色定义]     ← prompt-role.template.md
    │   "你是 Android 性能分析专家, 证据驱动, 中文输出"
    │
    ├─ [架构检测结果]  ← arch-{type}.template.md
    │   "当前 trace: Flutter TextureView, 置信度 92%"
    │
    ├─ [焦点应用]     ← 自动检测
    │   "前台应用: com.example.app (活跃 12.3s, 1847 帧)"
    │
    ├─ [选区上下文]   ← selection-area/slice.template.md (如果用户选了时间范围)
    │   "用户选中了 1.2s ~ 3.5s 的区域"
    │
    ├─ [分析方法论]   ← prompt-methodology.template.md
    │   ├─ 通用方法论 (规划、工具优先级、SQL 规范)
    │   └─ {{sceneStrategy}} ← scrolling.strategy.md (场景策略注入)
    │       "Phase 1: 总览分析 → Phase 1.5: 架构分支 → Phase 1.9: 根因深钻 → Phase 2: 逐帧 → Phase 3: 综合"
    │
    ├─ [输出格式]     ← prompt-output-format.template.md
    │   "发现格式: [SEVERITY] 标题 + 根因链 + Mermaid 因果图"
    │
    ├─ [会话上下文]   ← 多轮对话积累
    │   ├─ 分析笔记 (top 10)
    │   ├─ 已有发现
    │   └─ 实体追踪
    │
    └─ [可选，按优先级裁剪]
        ├─ SQL 知识库 (匹配到的 stdlib 表)
        ├─ 模式记忆 (历史分析经验)
        ├─ 负面记忆 (历史踩坑)
        └─ SQL 错误-修复对 (自我学习)
```

### 6.3 Token 预算管理

System prompt 有 **4500 token** 的硬预算。当内容超标时，按优先级从低到高裁剪：

1. SQL 知识库引用 (最先丢弃)
2. 模式记忆
3. 负面模式记忆
4. SQL 错误-修复对
5. Sub-agent 指导
6. 计划历史
7. **选区上下文永不丢弃**（这是用户的明确意图）

### 6.4 场景分类器

```typescript
// 关键词匹配, <1ms, 零 LLM 调用
classifyScene("这个 trace 滑动有点卡") → "scrolling"
classifyScene("冷启动太慢了")         → "startup"
classifyScene("ANR 了")              → "anr"
classifyScene("帮我看看这个 trace")    → "general"
```

12 个场景类型，每个场景有对应的 `.strategy.md` 文件：

| 场景 | 关键词示例 | 策略文件 |
|------|-----------|---------|
| scrolling | 滑动、卡顿、掉帧、jank、fps | `scrolling.strategy.md` |
| startup | 启动、冷启动、TTID、TTFD | `startup.strategy.md` |
| anr | ANR、无响应、deadlock | `anr.strategy.md` |
| pipeline | 渲染管线、rendering | `pipeline.strategy.md` |
| memory | 内存、LMK、OOM | `memory.strategy.md` |
| game | 游戏、帧率 | `game.strategy.md` |
| interaction | 点击响应、touch | `interaction.strategy.md` |
| overview | 总览、概览 | `overview.strategy.md` |
| teaching | 教学、怎么看 | `teaching.strategy.md` |
| scroll-response | 滑动响应延迟 | `scroll-response.strategy.md` |
| touch-tracking | 触摸追踪 | `touch-tracking.strategy.md` |
| general | (兜底) | `general.strategy.md` |

### 6.5 Trace 数据完整度诊断

`traceCompletenessProber.ts` 在会话初始化时探测 trace 数据的可用性：

- **能力注册表**：18 个分析域（如 frame_timeline, binder_ipc, cpu_scheduling）映射到所需的 Perfetto 数据源
- **两层探测**：先检查 schema（表/视图是否存在），再检查数据（表中是否有行）
- **4 状态模型**：`available` / `missing_config_suspected` / `not_applicable` / `insufficient_or_scene_absent`
- **系统提示注入**：诊断结果注入到 system prompt，引导 Agent 跳过不可用的分析域并建议用户改善 trace 采集配置
- **参考模板**：`knowledge-data-sources.template.md` 提供 Perfetto 数据源与采集配置的详细对照

### 6.6 SQL 结果摘要

当 Claude 请求 `execute_sql(sql, summary=true)` 时，返回的不是全量数据，而是统计摘要：

```
原始: 200 行 × 15 列 = ~8000 tokens
摘要: 列统计 (min/max/avg/P50/P90) + 10 个代表性样本 = ~1200 tokens
节省: ~85%
```

摘要包含：
- 数值列: min, max, avg, P50, P90, P95, P99, nullCount
- 字符串列: top 5 值 + 出现次数
- 代表性采样: 按"有趣度"排序 (优先取 duration 最大、jank 最多的行)

---

## 7. 验证与纠错系统

### 7.1 为什么需要验证？

LLM 的分析可能有以下问题：

- **幻觉**：声称发现了 CRITICAL 问题但没有数据支撑
- **浅层归因**：只说"主线程卡了"但不解释为什么
- **过度标记**：把所有问题都标为 CRITICAL
- **遗漏**：分析滚动但没有检查 VSync 配置
- **假设未验证**：提出了假设但忘记确认/否定

### 7.2 四层验证

```
分析结果
    │
    ▼
Layer 1: 启发式检查 (无 LLM, <1ms)
    ├─ CRITICAL 发现没有证据? → ERROR
    ├─ >5 个 CRITICAL? → WARNING (过度标记嫌疑)
    ├─ 匹配已知误诊模式? → WARNING
    ├─ 结论过短 (<50字)? → ERROR
    ├─ 高严重度发现缺因果推理? → WARNING
    └─ 浅层根因 (无多级因果链)? → WARNING
    │
    ▼
Layer 2: 计划遵守检查
    ├─ 未提交计划? → ERROR
    ├─ 有未完成的阶段? → WARNING/ERROR
    └─ 完成的阶段没有匹配的工具调用? → WARNING
    │
    ▼
Layer 2.5: 假设解决检查
    └─ 有未确认/否定的假设? → ERROR
    │
    ▼
Layer 2.7: 场景完整性检查
    ├─ scrolling: 缺少帧/卡顿/VSync 内容? → WARNING
    ├─ startup: 缺少 TTID/TTFD 数据? → WARNING
    └─ anr: 缺少阻塞/死锁内容? → WARNING
    │
    ▼
Layer 3: LLM 验证 (可选, Haiku 模型)
    ├─ CRITICAL/HIGH 发现的证据是否充分?
    ├─ 严重度标记是否一致?
    └─ 是否遗漏必查项?
```

### 7.3 反思纠错

如果验证发现 ERROR 级别的问题：

```
验证不通过
    │
    ▼
生成纠错 prompt (包含具体问题 + 修正建议)
    │
    ▼
Claude 重新分析 (利用已有数据，补充不足)
    │
    ▼
再次验证 (最多 2 轮)
    │
    ▼
如果同样的错误重复出现 → 跳过 (避免死循环)
```

### 7.4 自学习系统

验证器会自动从结果中**学习误诊模式**：

- 从验证 issue 中提取关键词
- 记录出现次数 + TTL (90 天)
- ≥2 次出现的模式加入启发式检查
- 自动修剪到 30 个活跃模式

---

## 8. 数据流与流式输出

### 8.1 SSE 事件流

分析过程中，前端通过 SSE (Server-Sent Events) 实时接收更新：

| 事件 | 说明 | 时机 |
|------|------|------|
| `progress` | 阶段变化 | starting → analyzing → concluding |
| `thought` | 中间推理 | Claude 在思考/规划时 |
| `agent_response` | 工具执行结果 | Skill / SQL 返回数据 |
| `answer_token` | 最终文本流 | 结论生成阶段 |
| `conclusion` | 近终结 | SDK 结果到达，结论文本就绪 |
| `analysis_completed` | 终结 | HTML 报告生成完成，携带 reportUrl |
| `error` | 异常 | 任何错误 |

Note: agentv3 先发 `conclusion`（用户即刻看到结论），后发 `analysis_completed`（携带 reportUrl）。

### 8.2 文本分类的挑战

SDK 返回的 text_delta 可能是**中间推理**或**最终回答**。区分方式：

```
Text 到达
    │
    ▼
200ms 缓冲窗口
    │
    ├─ 窗口内出现 tool_use → 这是推理 (thought)
    └─ 窗口超时无 tool_use → 切换为 answer_token 模式
```

### 8.3 DataEnvelope — 前端渲染协议

所有结构化数据通过 **DataEnvelope v2.0** 传递到前端：

```typescript
interface DataEnvelope<T> {
  meta: { type, version, source, skillId?, stepId? };
  data: T;  // { columns, rows, expandableData? }
  display: {
    layer: 'L1' | 'L2' | 'L3' | 'L4';
    format: 'table' | 'chart' | 'timeline';
    title: string;
    columns?: ColumnDefinition[];  // 类型、点击动作
  };
}
```

前端根据 `display` 配置**自动渲染**——不需要为每个 Skill 写专门的 UI。这就是为什么可以有 164 个 Skills 而前端代码量仍然可控。

---

## 9. 总结：各层职责一览

```
┌─────────────────────────────────────────────────────────────┐
│ 层级              │ 组件                │ 解决的问题         │
├─────────────────────────────────────────────────────────────┤
│ 用户交互层         │ Perfetto UI Plugin  │ 可视化 + 交互     │
│                   │ SSE 实时流           │ 流式输出体验       │
│                   │ DataEnvelope         │ 统一渲染协议       │
├─────────────────────────────────────────────────────────────┤
│ Agent 编排层       │ ClaudeRuntime       │ 多步推理 + 规划    │
│                   │ Scene Classifier     │ 场景路由           │
│                   │ System Prompt        │ 动态上下文注入     │
│                   │ Verifier             │ 质量保证           │
├─────────────────────────────────────────────────────────────┤
│ 工具桥接层         │ MCP Server (20工具)  │ LLM ↔ 数据桥梁    │
│                   │ Artifact Store       │ Token 节省         │
│                   │ SQL Summarizer       │ 数据压缩           │
├─────────────────────────────────────────────────────────────┤
│ 领域知识层         │ 164 Skills (YAML)    │ 分析逻辑复用       │
│                   │ 28 Pipeline 模板     │ 渲染管线识别       │
│                   │ 12 场景策略          │ 分析方法论         │
│                   │ 8 知识模板           │ 背景知识注入       │
├─────────────────────────────────────────────────────────────┤
│ 数据引擎层         │ trace_processor      │ SQL 精确查询       │
│                   │ Perfetto stdlib      │ 761 个预定义模式   │
│                   │ SQL Fragments        │ 查询复用           │
└─────────────────────────────────────────────────────────────┘
```

### 一句话总结

> **SmartPerfetto 不是让 LLM 读 trace，而是给 LLM 配备了一整套精确的"仪器"和"方法论"，让它像一个有经验的性能工程师一样工作——先看全貌、再定方向、逐步深入、验证假设、最后给出有证据支撑的结论。**

---

## 10. 开发者指南：修改与扩展

### 10.1 参数替换机制

Skill YAML 的 SQL 中使用 `${variable}` 语法，在执行时替换为运行时参数：

```
规则:
├─ ${process_name}     → context.params.process_name（直接引用）
├─ ${start_ts|0}       → context.params.start_ts，缺失时用默认值 0
├─ ${item.frame_id}    → iterator 当前行的 frame_id 字段
├─ SQL 字符串内的 ${x}  → 自动转义单引号（防 SQL 注入）
└─ 未解析的变量        → 字符串上下文返回空串，其他返回 NULL
```

### 10.2 新增场景策略

1. 创建 `backend/strategies/<scene>.strategy.md`
2. 填写 YAML frontmatter：`scene`, `priority`, `keywords`, `compound_patterns`
3. 编写 Markdown body（分析策略指导）
4. **无需修改任何 TypeScript 代码** — `sceneClassifier.ts` 自动发现

### 10.3 新增架构指导

1. 创建 `backend/strategies/arch-<type>.template.md`
2. 编写纯 Markdown（无需变量）
3. 确保 `detectArchitecture()` 能返回该 type

### 10.4 新增 Skill

1. 在对应目录创建 `<name>.skill.yaml`
2. 定义 meta、inputs、steps、display
3. **无需修改任何 TypeScript 代码** — `skillRegistry` 启动时自动加载
4. Claude 通过 `list_skills` 自动发现新 Skill

### 10.5 修改后生效方式

| 文件类型 | 修改后生效方式 | 需要重启？ |
|---------|-------------|----------|
| `*.strategy.md` | 刷新浏览器（DEV 模式自动刷新缓存） | 否 |
| `*.template.md` | 刷新浏览器 | 否 |
| `*.skill.yaml` | 刷新浏览器 | 否 |
| `*.ts` (TypeScript) | tsx watch 自动重编译，刷新浏览器 | 否 |
| `.env` | 需要 `./scripts/restart-backend.sh` | 是 |

---

*文档更新日期: 2026-03-23*
*基于 SmartPerfetto v3 代码库当前状态*
