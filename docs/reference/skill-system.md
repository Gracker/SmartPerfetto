# SmartPerfetto Skill System Guide

[English](skill-system.en.md) | [中文](skill-system.md)

> YAML Skill DSL 完整开发指南。面向需要创建或修改 Skill 的开发者。

---

## 目录

1. [Skill 是什么？](#1-skill-是什么)
2. [Skill 全景](#2-skill-全景)
3. [YAML 格式详解](#3-yaml-格式详解)
4. [Step 类型](#4-step-类型)
5. [参数替换机制](#5-参数替换机制)
6. [显示配置 (Display)](#6-显示配置-display)
7. [SQL Fragment 复用](#7-sql-fragment-复用)
8. [Prerequisites 与模块系统](#8-prerequisites-与模块系统)
9. [分层结果 (L1-L4)](#9-分层结果-l1-l4)
10. [Synthesize 数据摘要](#10-synthesize-数据摘要)
11. [Pipeline Skills](#11-pipeline-skills)
12. [开发工作流](#12-开发工作流)
13. [与标准 Agent Skill 的关系](#13-与标准-agent-skill-的关系)
14. [Skill tier 与校验规则](#14-skill-tier-与校验规则)
15. [本地 Skill Pack](#15-本地-skill-pack)

---

## 1. Skill 是什么？

SmartPerfetto Skill 是一种**领域专用 DSL (Domain-Specific Language)**，用 YAML 定义 trace 分析流水线。

**核心价值：** 把性能分析专家的知识封装为可复用、可组合、确定性执行的分析管线。当前 agent runtime 只需要决定"用哪个 Skill"，Skill 引擎负责"怎么查数据、怎么展示结果"。

```
Agent 调用: invoke_skill("scrolling_analysis", { package: "com.app" })
    │
    ▼
Skill Engine 自动执行:
    ├─ 检测 VSync 周期 (IQR 过滤中位数)
    ├─ 基于 present_ts 间隔检测真实卡顿
    ├─ 统计卡顿严重度分布
    ├─ 对每个卡顿帧执行根因分析 (iterator)
    ├─ 并行收集 CPU/GPU/Binder/GC 指标
    └─ 组装 L1-L4 分层结果 → DataEnvelope → SSE → 前端
```

一次 MCP 调用可以由引擎编排多步 SQL、子 Skill 和条件分支，减少 agent 往返与
上下文开销；实际步骤由当前 YAML 定义决定。

---

## 2. Skill 全景

### 按类型分布

Skill inventory 以 `backend/skills/**/*.skill.yaml` 文件树为准，不要在代码或长期文档中写死总数。需要当前统计时运行：

```bash
rg --files backend/skills | rg '\.skill\.yaml$' | wc -l
```

目录语义：

| 类型 | 位置 | 说明 |
|------|------|------|
| **Atomic** | `backend/skills/atomic/` | 单步 SQL 查询或小型查询组 |
| **Composite** | `backend/skills/composite/` | 多步编排 (iterator/parallel/conditional) |
| **Comparison** | `backend/skills/comparison/` | 多 trace / 多结果对比相关 Skill |
| **Deep** | `backend/skills/deep/` | 深度分析 (CPU profiling, callstack) |
| **Pipeline** | `backend/skills/pipelines/` | 渲染管线检测子路径、特征证据与教学来源引用 |
| **Module** | `backend/skills/modules/` | 模块化分析 (app/framework/hardware/kernel) |
| **Template** | `backend/skills/_template/` | Skill 作者模板，不一定代表运行时分析能力 |

### 按场景发现

场景、标签和运行候选由当前 Skill frontmatter 与 registry 决定，不在文档里维护静态
列表。开发者可用仓库脚本查看实时分类：

```bash
cd backend
npm run skill:list
```

---

## 3. YAML 格式详解

### 完整 Skill 结构

```yaml
# === 元信息 ===
name: consumer_jank_detection       # 唯一标识符 (必填)
version: "2.0"                       # 版本号 (必填)
type: atomic                         # 类型 (必填)，以 SkillType 与校验器为准
category: rendering                  # 分类 (可选)

meta:
  display_name: "Consumer Jank 检测"  # 显示名称 (必填)
  description: "基于 present_ts 间隔的真实卡顿检测"  # 描述 (必填)
  tags: [jank, consumer, surfaceflinger]  # 标签 (可选)

# === 触发规则 (可选) ===
triggers:
  keywords:
    zh: [卡顿, 掉帧, 帧率]
    en: [jank, frame drop, fps]
  patterns:
    - ".*卡顿.*分析.*"

# === 前置条件 (可选) ===
prerequisites:
  required_tables:
    - actual_frame_timeline_slice
  modules:
    - android.frames.timeline

# === 输入参数 (可选) ===
inputs:
  - name: package
    type: string
    required: false
    description: "应用包名"
  - name: start_ts
    type: timestamp
    required: false
  - name: end_ts
    type: timestamp
    required: false
  - name: max_frames_per_session
    type: number
    required: false

# === 执行步骤 (必填) ===
steps:
  - id: vsync_config
    type: atomic
    sql: |
      SELECT vsync_period_ns FROM ...
    save_as: vsync_data
    display:
      level: summary
      title: "VSync 配置"

  - id: jank_frames
    type: atomic
    sql: |
      SELECT frame_id, duration_ms, jank_type
      FROM ... WHERE ...
    display:
      layer: list
      title: "卡顿帧列表"
      columns:
        - { name: frame_id, type: number }
        - { name: duration_ms, type: duration, clickAction: navigate_timeline }
        - { name: jank_type, type: string }

# === 输出声明 (可选) ===
outputs:
  - stepId: jank_frames
    layer: list
  - stepId: jank_summary
    layer: overview
```

### 输入参数类型

| 类型 | 说明 | SQL 中的默认值 |
|------|------|---------------|
| `string` | 字符串 | 空字符串 `''` |
| `number` | 浮点数 | `NULL` |
| `integer` | 整数 | `NULL` |
| `boolean` | 布尔 | `NULL` |
| `timestamp` | 纳秒时间戳 | `NULL` |
| `duration` | 纳秒时长 | `NULL` |

---

## 4. Step 类型

### 4.1 atomic — 单步 SQL

最基本的步骤类型，执行一条 SQL 查询。

```yaml
- id: frame_stats
  type: atomic
  sql: |
    SELECT COUNT(*) as total_frames,
           SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) as jank_frames
    FROM actual_frame_timeline_slice
    WHERE process_name GLOB '${package}*'
  save_as: stats        # 保存结果供后续步骤引用
  display:
    level: summary
    title: "帧率统计"
```

**可选字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `condition` | string | 条件表达式，为 true 才执行此步骤。支持 JS 语法（`?.`、`??`、`\|\|`） |
| `on_empty` | string | 查询结果为空时的提示消息，用于告知用户所需数据缺失 |

```yaml
# 条件执行示例 — 仅在 frame_timeline 数据可用时执行
- id: vsync_config
  type: atomic
  condition: "frame_timeline.data[0]?.has_frame_timeline === 1"
  sql: SELECT vsync_period_ns FROM ...

# 空数据提示示例
- id: callstack
  type: atomic
  sql: SELECT * FROM cpu_profile_stack_sample ...
  on_empty: "未找到 CPU 采样数据，请确保 trace 包含 simpleperf/perf 数据"
```

### 4.2 skill_ref — 引用另一个 Skill

```yaml
- id: detailed_startup
  type: skill              # 或省略 type，使用 skill 字段
  skill: startup_detail    # 引用的 Skill ID
  params:
    package: "${package}"
    startup_id: "${startup_data.data[0].startup_id}"
```

### 4.3 iterator — 遍历数据行

对上一步结果的每一行执行子 Skill。

```yaml
- id: per_frame_analysis
  type: iterator
  source: jank_frames           # 引用 save_as 的数据
  item_skill: jank_frame_detail # 对每一行调用的 Skill
  item_params:
    frame_id: "${item.frame_id}"
    package: "${package}"
  max_items: "${max_frames_per_session|8}"   # 最多处理 N 项
  display:
    layer: deep
```

### 4.4 parallel — 并行执行

独立步骤并发运行，提高效率。

```yaml
- id: multi_metric
  type: parallel
  steps:
    - id: cpu_load
      type: atomic
      sql: SELECT avg_cpu_pct FROM ...

    - id: gpu_load
      type: atomic
      sql: SELECT avg_gpu_freq FROM ...

    - id: thermal_state
      type: atomic
      sql: SELECT max_temperature FROM ...
```

### 4.5 conditional — 条件分支

根据运行时数据决定执行路径。

```yaml
- id: arch_branch
  type: conditional
  conditions:
    - when: "${architecture_type} == 'FLUTTER'"
      then:
        - id: flutter_analysis
          skill: flutter_scrolling_analysis

    - when: "${architecture_type} == 'COMPOSE'"
      then:
        - id: compose_analysis
          skill: compose_recomposition_hotspot
  else:
    - id: standard_analysis
      skill: scrolling_analysis
```

### 4.6 diagnostic — 规则诊断

```yaml
- id: diagnose
  type: diagnostic
  rules:
    - id: slow_startup
      condition: "startups.data[0].dur_ms > 2000"
      severity: critical
      message: "启动时间超过 2 秒"
      suggestions:
        - "检查 Application.onCreate 耗时"
        - "优化 ContentProvider 初始化"
```

### 4.7 pipeline — 渲染管线检测

专用于匹配 trace 中的渲染管线类型。详见 [Pipeline Skills](#11-pipeline-skills)。

### 4.8 ai_decision / ai_summary — AI 协作步骤

`ai_decision` 让当前会话选中的 AI runtime 基于指定输入产出结构化判断；
`ai_summary` 汇总指定步骤的有界数据。两者都属于可选协作层：AI 被禁用或不可用时，
引擎返回明确的跳过状态，不把缺失的 AI 输出伪装成确定性 SQL 结论。

```yaml
- id: summarize_findings
  type: ai_summary
  inputs: [frame_stats, diagnose]
  prompt: "Summarize the selected evidence without inventing missing data."
  save_as: ai_summary
```

---

## 5. 参数替换机制

### 基本语法

```
${变量名}           → 直接引用
${变量名|默认值}     → 缺失时用默认值
${item.字段}        → iterator 当前行的字段
${step_id.data[0].字段}  → 引用某步骤结果
```

### 解析优先级

1. **步骤结果**: `${step_id}` → `results[step_id].data`
2. **保存的变量**: `${save_as_name}` → `variables[save_as_name]`
3. **输入参数**: `${package}` → `params.package`
4. **继承的上下文**: `${parent_var}` → `inherited[parent_var]`
5. **当前迭代项**: `${item.field}` → `currentItem.field`

### 智能默认值

```yaml
# 字符串上下文 (在单引号内): 默认空字符串
WHERE package = '${package}'
# → package 缺失时: WHERE package = ''

# 数值上下文 (不在引号内): 默认 NULL
WHERE ts >= ${start_ts}
# → start_ts 缺失时: WHERE ts >= NULL (条件不生效)

# 显式默认值: 优先级最高
WHERE ts >= ${start_ts|0}
# → start_ts 缺失时: WHERE ts >= 0
```

### SQL 注入防护

字符串参数自动转义单引号：`O'Brien` → `O''Brien`

---

## 6. 显示配置 (Display)

### 核心字段

```yaml
display:
  layer: overview              # overview | list | session | deep | diagnosis
  level: summary               # none | debug | detail | summary | key | hidden
  title: "帧率概览"             # 显示标题
  format: table                # table | chart | text | timeline | summary | metric
  columns:                     # 列定义
    - name: ts
      label: "时间戳"
      type: timestamp           # timestamp | duration | number | string | percentage | bytes
      clickAction: navigate_timeline  # navigate_timeline | navigate_range | copy | expand | filter | link
    - name: dur_ms
      label: "耗时"
      type: duration
      unit: ms                  # ns | us | ms | s
    - name: jank_rate
      label: "掉帧率"
      type: percentage
  # 可选高级字段
  severity: warning            # critical | warning | info | normal — 前端按严重度排序
  collapsible: true            # 是否可折叠
  defaultCollapsed: false      # 默认是否折叠
  maxVisibleRows: 20           # 限制显示行数
  priority: 1                  # 渲染优先级 (数值越小越靠前)
  group: "frame_analysis"      # 分组标识，相关 DataEnvelope 归为一组
```

**特殊 level 值：**
- `hidden` — 步骤正常执行，但不向前端发送 DataEnvelope。适用于中间数据收集步骤（如 composite 中的 setup 步骤），10+ 个 composite skill 使用此特性。

**特殊 layer 值：**
- `diagnosis` — 诊断层，用于 diagnostic step 输出的结构化诊断结果。

### 可展开数据

```yaml
display:
  layer: list
  expandable: true
  expandableBindSource: frame_details  # 关联的详情数据源
```

### 高亮规则

```yaml
display:
  highlight:
    - condition: "jank_rate > 10"
      color: "red"
    - condition: "jank_rate > 5"
      color: "orange"
```

---

## 7. SQL Fragment 复用

### Fragment 格式

Fragment 是裸 CTE 定义（不含 `WITH` 关键字），存放在 `backend/skills/fragments/` 下：

```sql
-- fragments/vsync_config.sql
-- 估算 VSync 周期，使用 VSYNC-sf 计数器的中位数间隔
-- 自动吸附到标准刷新率 (30/60/90/120/144/165 Hz)
-- 参数: ${start_ts}, ${end_ts}
vsync_ticks AS (
  SELECT c.ts, c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND c.ts >= ${start_ts} - 100000000
    AND c.ts < ${end_ts} + 100000000
),
vsync_config AS (
  SELECT CASE
    WHEN raw_ns BETWEEN 5500000 AND 6500000 THEN 6060606      -- 165 Hz
    WHEN raw_ns BETWEEN 6500001 AND 7500000 THEN 6944444      -- 144 Hz
    WHEN raw_ns BETWEEN 7500001 AND 9500000 THEN 8333333      -- 120 Hz
    WHEN raw_ns BETWEEN 9500001 AND 12500000 THEN 11111111    -- 90 Hz
    WHEN raw_ns BETWEEN 12500001 AND 20000000 THEN 16666667   -- 60 Hz
    WHEN raw_ns BETWEEN 20000001 AND 35000000 THEN 33333333   -- 30 Hz
    ELSE raw_ns
  END AS vsync_period_ns
  FROM (
    SELECT CAST(COALESCE(
      (SELECT PERCENTILE(interval_ns, 0.5)
       FROM vsync_ticks
       WHERE interval_ns > 5500000 AND interval_ns < 50000000),
      16666667
    ) AS INTEGER) AS raw_ns
  )
)
```

### 在 Skill 中引用

```yaml
steps:
  - id: jank_detection
    type: atomic
    sql_fragments:
      - fragments/vsync_config.sql
      - fragments/thread_states_quadrant.sql
    sql: |
      SELECT frame_id, duration_ms
      FROM frames
      CROSS JOIN vsync_config v
      WHERE duration_ms > v.vsync_period_ns / 1e6 * 1.5
```

**注入规则：**
- SQL 以 `WITH` 开头 → fragment 插入到 `WITH` 之后，现有 CTE 之前
- SQL 不以 `WITH` 开头 → 整体包装为 `WITH <fragments>\n<sql>`
- Fragment 内的 `${变量}` 同样会被参数替换

---

## 8. Prerequisites 与模块系统

### 声明依赖

```yaml
prerequisites:
  required_tables:              # 必须存在的表 (缺失则跳过 Skill)
    - actual_frame_timeline_slice
    - slice
  optional_tables:              # 可选表 (缺失不影响执行)
    - gpu_counter_track
  modules:                      # Perfetto stdlib 模块 (自动 INCLUDE)
    - android.frames.timeline
    - android.binder
    - sched.states
```

### 模块别名展开

| 别名 | 展开为 |
|------|--------|
| `sched` | `sched.states`, `sched.runnable` |
| `android.frames` | `android.frames.timeline`, `android.frames.jank_type` |
| `stack_profile` | `callstacks.stack_profile` |

### 运行时行为

```sql
-- 引擎自动在 SQL 前插入:
INCLUDE PERFETTO MODULE android.frames.timeline;
INCLUDE PERFETTO MODULE android.binder;
INCLUDE PERFETTO MODULE sched.states;

-- 然后执行用户 SQL
SELECT ...
```

---

## 9. 分层结果 (L1-L4)

Skill 输出组织为语义层，前端自动渲染：

```
L1 (Overview)  ─── 聚合指标
    │  例: "47 帧卡顿, P90=23.5ms, SEVERE 12%"
    │  display: { layer: overview, level: summary }
    ▼
L2 (List)      ─── 数据列表
    │  例: 每一帧的 frame_id, duration, jank_type
    │  display: { layer: list, expandable: true }
    ▼
L3 (Diagnosis) ─── 逐项诊断
    │  例: iterator 遍历每个卡顿帧的线程状态、阻塞原因
    │  display: { layer: session }
    ▼
L4 (Deep)      ─── 深度分析
       例: 阻塞链、Binder 根因、调用栈
       display: { layer: deep }
```

**前端渲染协议 (DataEnvelope v2.0)：**

```typescript
interface DataEnvelope<T> {
  meta: {
    type: 'skill_result' | 'sql_result' | 'ai_response' | 'diagnostic' | 'chart';
    version: string;
    source: string;
    timestamp: number;
    skillId?: string;
    stepId?: string;
  };
  data: T;  // { columns, rows, expandableData? }
  display: {
    layer: 'overview' | 'list' | 'session' | 'deep' | 'diagnosis';
    format: 'table' | 'chart' | 'text' | 'timeline' | 'summary' | 'metric';
    level?: 'none' | 'debug' | 'detail' | 'summary' | 'key' | 'hidden';
    title: string;
    columns?: ColumnDefinition[];
    metadataFields?: string[];
    highlights?: HighlightRule[];
    defaultExpanded?: boolean;
    severity?: 'critical' | 'warning' | 'info' | 'normal';
    collapsible?: boolean;
    defaultCollapsed?: boolean;
    maxVisibleRows?: number;
    priority?: number;
    group?: string;
  };
}
```

前端根据 `display.columns` 的类型和 `clickAction` **自动渲染**表格、跳转链接、格式化数值——不需要为每个 Skill 写专门的 UI 代码。`severity` 和 `priority` 字段控制结果排序和视觉权重。

---

## 10. Synthesize 数据摘要

标记步骤为 `synthesize: true` 可生成数据驱动的摘要：

```yaml
# 简单模式
- id: metrics
  type: atomic
  sql: SELECT fps, jank_rate FROM ...
  synthesize: true

# 结构化模式
- id: metrics
  type: atomic
  sql: SELECT fps, jank_rate, jank_count FROM ...
  synthesize:
    role: overview        # overview | list | clusters | conclusion
    fields:
      - key: fps
        label: "平均 FPS"
        format: "{{fps}}.0 fps"
      - key: jank_rate
        label: "掉帧率"
        format: "{{jank_rate}}.1%"
    insights:             # 条件触发的洞察
      - condition: "jank_rate > 10"
        template: "掉帧率偏高：{{jank_rate}}%（>10%）"
      - condition: "jank_rate >= 5 && jank_rate <= 10"
        template: "掉帧率略高：{{jank_rate}}%"
```

Synthesize 数据随 Artifact 一起存储，agent 可通过 `fetch_artifact` 获取。

---

## 11. Pipeline Skills

Pipeline Skills 用于 Android 渲染管线识别和教学，但“类型”和“检测条目”不是同一层：

- `docs/rendering_pipelines/*.md` 是固定上游 commit 的 Android 17 教学真相；
- `backend/skills/pipelines/index.yaml` 是具体 rendering type 与检测条目的实时清单；
- `variant` 可以成为主类型，`feature` 只提供附加证据；
- 单个 Pipeline Skill 保存信号、auto-pin、分析建议，并通过 `teaching.source` 引用权威文档。

目录与单条定义的关系如下：

```yaml
# backend/skills/pipelines/index.yaml
pipelines:
  FLUTTER_TEXTUREVIEW:
    classification_role: variant
    rendering_type_id: S10_FLUTTER
    primary_eligible: true
  ANGLE_GLES_VULKAN:
    classification_role: feature
    related_rendering_type_ids: [S08_NATIVE_GRAPHICS]
    primary_eligible: false

# backend/skills/pipelines/flutter_textureview.skill.yaml
name: FLUTTER_TEXTUREVIEW
type: pipeline_definition
detection:
  signals:
    - { name: "SurfaceTexture", source: "slice" }
teaching:
  source: "rendering_pipelines/S10_flutter_type.md"
```

检测结果分别输出主 `rendering type`、具体 pipeline 子路径和 feature 候选，避免把
ANGLE、PIP、HWC overlay 等特征误报为应用的主出图类型。构建时同步目录会复制到
`backend/dist/rendering_pipelines/`，所以 Docker、portable 与 npm CLI 使用同一份内容。

更新上游内容时运行同步脚本，禁止手工修改同步后的 Markdown：

```bash
npm run sync:rendering-pipelines -- --source /path/to/rendering_pipelines --apply
npm run check:rendering-pipelines
```

---

## 12. 开发工作流

### 创建新 Skill

1. 在对应目录创建 `<name>.skill.yaml`
2. 定义 meta, inputs, steps, display
3. **无需修改任何 TypeScript 代码** — `skillRegistry` 启动时自动加载
4. Agent 通过 `list_skills` 自动发现新 Skill

### 修改后生效

| 文件类型 | 生效方式 | 需要重启？ |
|---------|---------|----------|
| `*.skill.yaml` | 刷新浏览器 | 否 |
| `fragments/*.sql` | 刷新浏览器 | 否 |
| TypeScript (Skill Engine) | tsx watch 自动编译 | 否 |

### 验证

```bash
# 验证所有 Skill YAML 语法和约束
cd backend && npm run validate:skills

# 跑全量 trace 回归测试
cd backend && npm run test:scene-trace-regression
```

### 调试

1. 检查 `backend/logs/sessions/*.jsonl` 中的 skill 执行日志
2. 使用 `execute_sql` 单独测试 SQL 片段
3. 检查 SSE 事件中的 DataEnvelope 是否正确

## 13. 与标准 Agent Skill 的关系

SmartPerfetto YAML Skills **不是**标准 Agent Skill 的等价物，两者解决不同的问题：

| 维度 | 标准 Agent Skill | SmartPerfetto YAML Skills |
|------|---|---|
| **本质** | Markdown 提示词模板 | 领域 DSL (SQL 编排引擎) |
| **执行者** | 兼容 Agent 按说明和脚本行动 | SkillExecutor 引擎确定性执行 |
| **文件格式** | `SKILL.md` (YAML frontmatter + Markdown) | `.skill.yaml` (SQL + 显示配置) |
| **能力** | 注入上下文、指导行为 | 多步 SQL 编排 + 分层结果 + Artifact 缓存 |
| **调用方式** | Agent 自动路由或显式点名 | 当前 agent runtime 通过注册表和工具间接调用 |
| **可复现性** | 取决于 Agent 推理与本地脚本 | 确定性（同输入 = 同输出） |
| **产品能力** | 本地文件、终端和 `trace_processor_shell` | DataEnvelope、Artifact、报告、会话和 UI 投影 |

**架构关系：**

```
Perfetto-Skills (标准 SKILL.md)
    └─ 公开的可移植方法论、SQL、管线知识和本地查询脚本
        └─ 由兼容 Agent 执行，不依赖 SmartPerfetto 服务

SmartPerfetto Skills (backend/skills/)
    └─ 产品内确定性 DSL 与运行时真相
        └─ 驱动 DataEnvelope、Artifact、报告和前端投影

backend/strategies + docs/rendering_pipelines
    └─ 公开投影的方法论与渲染管线来源
```

公开仓库 [Gracker/Perfetto-Skills](https://github.com/Gracker/Perfetto-Skills)
是生成加人工策划的标准 Agent Skill 投影，不替代本仓库运行时。当前
`backend/skills/public-export.yaml` 必须逐项声明每个运行候选的 workflow、
disposition 和目标路径；公开目录记录源 commit 与逐文件 SHA-256，并导出
SQL、策略/知识材料和渲染管线文档。Provider、会话、Artifact、DataEnvelope、
SSE 与前端行为仍只属于 SmartPerfetto。

### 批量分析的可移植边界

运行候选可以声明 `batch_analysis`，把某个确定性 Skill step 的受限结果标记为
批量后处理输入。YAML 内的 SQL、字段契约、单 trace 缺失数据语义和行数上限属于
可移植分析能力，可以通过公开投影复用；它们本身不会执行跨 trace 聚合。

`BatchTraceRunner` 只保留声明的 source step，并把校验后的有界行交给注册过的
TypeScript post-processor。跨 trace 的 `BatchTraceDomainAnalysisV1` 结果、证据
artifact、聚类限制和报告投影是 SmartPerfetto 产品运行时能力，不属于公开 Agent
Skill 的本地执行契约。聚合结果由 batch run/report 持有，不能复制到每个单 trace
snapshot；单 trace snapshot 只保留自身的提取指标和证据引用。

修改 `backend/skills/`、`backend/strategies/`、`docs/rendering_pipelines/` 或
公开策略后，在已检出 Perfetto-Skills 的环境运行：

```bash
npm run verify:public-skills
```

默认查找同级 `../Perfetto-Skills`；也可用 `PERFETTO_SKILLS_DIR` 指向其他
checkout。门禁会拒绝未分类来源、源 hash/commit 漂移和生成文件漂移。

---

## 14. Skill tier 与校验规则

Skill 可以声明顶层 `tier: S | A | B`，用于表达目标复杂度和 review 预期：

| Tier | 适用 Skill | 结构预期 |
|---|---|---|
| `S` | 旗舰级跨域分析，如 startup、scrolling、CPU、scene reconstruction | `type: composite` 或 `deep`，通常包含多个 Perfetto stdlib module 和 5 个以上步骤 |
| `A` | 单域实质分析，能产出诊断结论或关键列表 | 至少声明相关 `prerequisites.modules`，并提供可复用的显示层 |
| `B` | 单事实或辅助数据提供者 | 查询边界清晰，字段和缺失数据语义明确 |

`cd backend && npm run validate:skills` 会执行这些稳定规则：

| Rule | 行为 |
|---|---|
| `skill-tier-must-match-declared` | 校验 `tier` 是否为 `S/A/B`，并把结构不足报告为迁移 warning |
| `skill-stdlib-detected-vs-declared` | 扫描 SQL 中使用的 Perfetto stdlib symbol，要求被 `prerequisites.modules` 覆盖 |
| `skill-include-budget-soft-cap` | 当 `prerequisites.modules` 超过 8 个时发出成本 warning |
| `skill-step-id-uniqueness` | 每个 Skill 内 step id 必须唯一 |
| `skill-vendor-override-runtime-conformant` | Vendor override 必须有真实 `additional_steps`、vendor signatures，并指向已注册 base Skill |

`backend/skills/_template/` 是作者模板，不进入运行时 registry。复制模板后必须删除占位符，放入正式 Skill 目录，再运行 `validate:skills` 和匹配的 trace regression。

## 15. 本地 Skill Pack

本地 Skill Pack 用于把已经 review 过的团队/OEM Skill 以 workspace 范围安装，
不需要直接修改 `backend/skills/`。第一版是本机目录导入，不是远程 marketplace：
不支持 HTTPS URL、自动同步、`.well-known` 发现或 archive 解包。

目录必须包含 `smartperfetto-skill-pack.json`：

```json
{
  "schemaVersion": 1,
  "packId": "vendor-scroll-pack",
  "name": "Vendor Scroll Pack",
  "version": "1.0.0",
  "publisher": "vendor-team",
  "description": "Reviewed scrolling diagnostics",
  "license": "AGPL-3.0-or-later",
  "compatibility": {
    "smartPerfettoMinVersion": "0.1.0"
  },
  "assets": [
    {
      "kind": "skill",
      "path": "atomic/vendor_scroll.skill.yaml",
      "sha256": "<64 hex chars>",
      "sizeBytes": 1234
    }
  ]
}
```

允许的 asset 根目录：`atomic/`、`composite/`、`deep/`、`system/`、
`comparison/`、`modules/`、`pipelines/`、`fragments/`、`docs/`。
禁止 `strategies/`、`vendors/`、`custom/`、隐藏文件、symlink、可执行扩展和
未在 manifest 声明的文件。每个 asset 的 `sha256` 和 `sizeBytes` 必须和实际文件一致。

Workspace 管理接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/workspaces/:workspaceId/skill-packs/preview` | 只读预检 |
| `POST` | `/api/workspaces/:workspaceId/skill-packs/install` | 重新预检后安装 |
| `GET` | `/api/workspaces/:workspaceId/skill-packs` | 列出已安装 pack |
| `PATCH` | `/api/workspaces/:workspaceId/skill-packs/:packId` | 启用或禁用 |
| `DELETE` | `/api/workspaces/:workspaceId/skill-packs/:packId` | 禁用并删除受管副本 |

安装会复制声明资产到受管目录，并在 `skill_registry_entries.metadata_json`
记录 manifest hash、content hash、审批人、Skill ID、fragment key 和 docs 路径。
同一个 `packId + version` 已安装时，如果 content hash 不一致会被拒绝。
外部 Skill ID 不能覆盖内置 Skill；SQL fragment key 不能覆盖不同内容的内置 fragment。

带有 workspace 上下文的 agent 会在运行时加载内置 Skill 加该 workspace 已启用的
Skill Pack。`list_skills` 会返回外部 pack 的 `origin` metadata，
`invoke_skill` 会在 registry fingerprint 变化时刷新 executor 和 SQL fragment cache，
因此启用、禁用或删除 pack 后不会继续执行旧内容。旧版全局 `/api/admin/skills`
和当前 `smp skill` CLI 路径仍只使用内置 Skill；CLI 执行 workspace pack 需要未来显式
tenant/workspace 上下文支持。
