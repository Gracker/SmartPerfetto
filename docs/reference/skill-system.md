# SmartPerfetto Skill System Guide

[English](skill-system.en.md) | [中文](skill-system.md)

<!-- i18n-headings: paired -->

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
  display_name_i18n:                   # 另一种语言的显示名称 (可选)，未写时由标识符生成
    en: "Consumer jank detection"
  description: "基于 present_ts 间隔的真实卡顿检测"  # 描述 (必填)
  description_i18n:                    # 另一种语言的描述 (可选)
    en: "Detects real jank from present_ts intervals"
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

每种步骤都是确定性的：没有调用模型的步骤类型。需要叙述时由分析 runtime 基于 Skill 的
证据撰写，Skill 结果的摘要只按规则生成。

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
| `condition` | string | 条件表达式，为 true 才执行此步骤。按 JavaScript 求值（`?.`、`??`、`&&`、`\|\|`）；写 SQL 的 `AND` / `OR` 不能编译，步骤会被静默跳过，`validate:skills` 报 `condition_uses_sql_boolean_words` |
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

带 `save_as` 的引用步骤只绑定被引用 Skill 的一个步骤结果：有 `root` 步骤时取它，否则取第一个有数据的
展示步骤，再否则取第一个有数据的步骤，都没有数据时取最后一个返回了结果的步骤（开头返回 `[]` 的建表/准备步骤因此不会被选中）。按步骤 id 读取引用步骤
——表达式里的 `${step_id.data...}`、诊断步骤的 `inputs`、iterator/pipeline 的 `source`——读到的也是这个
默认选中的步骤及其范围来源。父 Skill 要读具体字段时，用 `save_from` 指明步骤（它只改变 `save_as` 的绑定，
按步骤 id 读取仍是默认选择）：

```yaml
- id: cpu_throttling
  skill: cpu_throttling_in_range
  save_as: freq_limit_evidence
  save_from: limit_evidence   # 被引用 Skill 的顶层步骤 id
```

该步骤未观测到结果（失败、条件跳过、可选查询出错或不存在）时，`save_as` 绑定为 `null`，查找不会退回其他
步骤，也不会退回同名输入或继承值；真正的空结果绑定 `[]`。引用步骤本身失败（子 Skill 失败、required 条件不满足）
时同样绑定 `null`，即使目标步骤已有数据；按步骤 id 也读不到它的任何子步骤数据，包括失败前已经返回的部分结果。
`save_from` 只在父 Skill 的顶层步骤生效，`validate:skills` 会拒绝不存在的目标步骤。

分层输出（Skill HTTP API 与 HTML 报告背后的 composite 路径）展示引用步骤的方式与此一致：展示默认选中子步骤的
数据和该步骤自己的范围来源（该步骤没有声明范围时就没有，绝不用全部子步骤合并后的范围）。失败的引用显示为失败、
不带任何子步骤行；步骤为 `optional` 时，这个失败显示为可选步骤出错（`executionStatus: optional_error`，与
可选查询出错相同），不会使整个 Skill 失败。

默认选中的子步骤本身又是 Skill 引用时，绑定的是孙 Skill 的结果对象：表达式经 `.data` 访问时按同一规则再
选一层，诊断步骤的 `inputs` 拿到的是这个结果对象，iterator 不能遍历它。`save_from` 只能选直接子 Skill
的顶层步骤、不能穿透到孙 Skill：需要具体字段时，用它绑定子 Skill 中真正的读取步骤，而不是那个引用步骤。

### 4.3 iterator — 遍历数据行

对上一步结果的每一行执行子 Skill。`item_params` 的值是当前行的列名：执行器读 `item[列名]`，该列不存在时把值原样作为常量传入，所以这里写 `${item.x}` 只会传出字面字符串。省略 `item_params` 时整行作为参数。

```yaml
- id: per_frame_analysis
  type: iterator
  source: jank_frames           # 引用 save_as 的数据
  item_skill: jank_frame_detail # 对每一行调用的 Skill
  item_params:                  # 子 Skill 参数 ← 当前行的列名
    frame_id: frame_id
  max_items: 8                  # 最多处理 N 项（数字，不做 ${...} 替换；缺省 100）
  display:
    layer: deep
```

每一项的结果会作为可展开数据挂回 iterator 读到行的那个步骤：iterator 运行前绑定 `source` 这个名字的步骤
（按步骤 id 读取时就是该步骤）。多个步骤声明同一个 `save_as` 时也按这一规则确定。

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
  inputs: [startups]
  rules:
    - condition: "startups.data[0]?.dur_ms > 2000"
      severity: critical
      confidence: high
      diagnosis: "启动耗时 ${startups.data[0].dur_ms}ms，超过 2 秒"
      suggestions:
        - "检查 Application.onCreate 耗时"
        - "优化 ContentProvider 初始化"
      evidence_fields:
        - startups.data[0]?.dur_ms
        - startups.data.length
```

`inputs` 列出规则读到的每个步骤（step id 或 `save_as`），它们就是步骤上报的
`data.inputs`，也是 `evidence_fields` 唯一能引用的名字。阈值等 Skill 参数按参数名直接读，例如 `(threshold_ms ?? 50)`：作用域里没有 `inputs` 对象，`inputs?.threshold_ms` 永远是 `undefined`，规则只会用默认值。
evidence field 是只读路径，不是 JavaScript 表达式，也不是 `${...}` 模板：以某个 input 的
`name.data`（或 `name?.data`）开头，后接任意个 `.column`、`[n]`、`.length`、
`.find(r => r.column OP literal)` / `.filter(...)`（OP 为比较运算，literal 为数字、带引号字符串、
布尔或 `null`），每段都可写成 `?.`。它读的就是 condition 里 `name.data` 的同一个值，只读对象自有的数据属性，不调用函数、
不写数据；谓词只比较标量，缺失或非标量的值一律不匹配。值上报前有界：行集变成 `{_rowCount, _firstRow}`，行只保留标量字段，长字符串截断。
规则触发时还会附带它的 condition 读到的每个 input 的样本（同样有界），无论写成 `name.data`、`name?.data` 还是 `name?.["data"]`；只在字符串或注释里出现的名字不算读到。
`validate:skills` 拒绝：不符合该语法或根不在 `inputs` 的 evidence field、读了不在 `inputs`
里的步骤、condition 不经 `.data` 读步骤数据（按路径解析的占位符 `${name[0].x|默认值}` 或嵌在文本中的 `${name[0].x}` 里仍合法；占位符里的 JS 表达式和不带默认值的整串 `${...}` 按 condition 绑定，同样要经 `.data`），没有
`inputs` 的 diagnostic 步骤，以及读了任何作用域都不绑定的名字（如 `inputs`）的规则。按根名的这几项检查只在能确定读到哪些根时生效：condition 里含函数体、方法、块语句等可能声明局部名的写法时不报。

### 4.7 pipeline — 渲染管线检测

专用于匹配 trace 中的渲染管线类型。详见 [Pipeline Skills](#11-pipeline-skills)。

### 4.8 精确进程范围与调查证据

原子步骤（以及原子 Skill 的根）可以声明三项可选字段，校验与执行器准入使用同一套判定。

`process_scope` 说明这段 SQL 的证据与目标进程的关系：

| 字段 | 说明 |
|---|---|
| `role` | `target`（目标进程自身的证据）、`global_context`、`peer_context` 或 `identity_metadata`（上下文证据，不能声明 `binding`） |
| `binding` | target SQL 绑定可信 UPID 的方式：`native_upid`（SQL 直接使用 `${__process_scope.upid}`），或 `effective_target_processes`（引入 `fragments/effective_target_processes.sql` 并 `FROM` / `JOIN effective_target_processes`） |
| `context_fields` | 上下文证据按角色列出的字段 |
| `exact_unavailable` | 这段 SQL 做不到精确进程范围的原因（必须写明） |
| `limitations` | 精确运行下仍存在的限制 |

`exact_sql` 是同一步骤在精确进程范围下运行的 SQL，只能包含 `sql`、`sql_fragments` 和它自己的
`process_scope`。身份门禁为调用确定唯一目标 UPID 时，执行器运行 `exact_sql`，否则运行原 `sql`；
`exact_sql` 无效时步骤失败，不会退回原 SQL。

```yaml
- id: frame_coverage
  type: atomic
  sql: |
    SELECT ... FROM actual_frame_timeline_slice a
    JOIN process p USING (upid) WHERE p.name GLOB '${package}*'
  exact_sql:
    process_scope:
      role: target
      binding: effective_target_processes
    sql_fragments:
      - fragments/effective_target_processes.sql
    sql: |
      SELECT ... FROM actual_frame_timeline_slice a
      JOIN effective_target_processes p ON a.upid = p.upid
```

`investigation_evidence` 把步骤结果登记到调查证据账本，供场景 Strategy `investigation_contract` 的
`evidence` 条件与 `evidence_metrics` 读取（见文末“系统调查证据合同”）：

| 字段 | 说明 |
|---|---|
| `window: {start, end}` | 结果中给出证据时间窗的列 |
| `identity` | 可选：`upid`、`utid`、`cpu`、`ucpu`、`machine_id` 对应的列 |
| `metrics[]` | 每项 `domain`、生产者声明的 `metric_id`、值所在列 `value`、状态列 `status`（只有 `observed` 参与比较），可选 `unit`、`coverage`、`denominator`、`aggregation` |
| `scan` | 可选：本步骤非分页扫描的完整性列（总行数、输出截断、游标关闭、解析失败） |

无效的 `exact_sql` 或 `investigation_evidence` 在任何地方都是错误；无效的 `process_scope` 只会让精确范围
不可用，报 `process_scope_invalid`。语料中每个 `exact_sql` 单元都必须被某个 Trace case 的
`exact_scope` 绑定实际执行并通过，否则 `npm run trace:sql-regression` 失败。

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

占位符、`condition`、iterator `filter`、诊断步骤的 `inputs` 以及证据范围都按同一顺序解析根名字，先找到的作用域生效：

1. **当前迭代项**（仅 iterator `filter`）: `item` 和它自己的字段 → `currentItem`
2. **保存的变量**: `${save_as_name}` → `variables[save_as_name]`；值为 `null` 也算已绑定
3. **步骤结果**: `${step_id}` → `results[step_id].data`；成功的步骤、条件跳过的步骤、exact scope 不可用的步骤以及失败的查询或 Skill 引用都会记录结果（两条执行路径相同）。Skill 引用步骤是它默认 `save_as` 会绑定的子步骤数据（见 4.2），引用失败时没有数据
4. **输入参数**: `${package}` → `params.package`（含声明的 `default`）
5. **继承的上下文**: `${parent_var}` → `inherited[parent_var]`，即调用方 Skill 的继承值和它的 `save_as`

SQL 里按路径读取前面步骤的结果（`${step_id.data[0].字段}`）时，必须二选一写明意图：带 `|默认值`（结果没有行时照常执行，引号内常用 `|`、其它位置常用 `|NULL`），或者让本步骤的 `condition` 以顶层合取项 `step_id.data?.length > 0` 要求该结果有行（结果没有行时不执行；只是提到该结果、在无行时仍可能为真的条件不算）。本运行时缺值会按下面的智能默认值照常执行，公开的 Perfetto-Skills 运行时则把没有默认值的路径当成依赖、结果无行时跳过整步；`validate:skills` 对没写明的读取报错 `result_path_read_undecided`。

所以本 Skill 自己的绑定总会遮住调用方的同名值；`save_as` 先于同名步骤结果，读到的是它声明的绑定（包括 `save_from` 选中的子步骤）。一个步骤的 `save_as` 不能使用另一个步骤的 id（`validate:skills` 报 `save_as_step_id_collision`），以自身 id 命名则是常规写法。根名字一旦在某层找到就不再向更低的层回退（例如 `null` 变量不会让位给同名输入参数）；完整路径最终解析为 `null`/`undefined` 时（未绑定、绑定为 `null`、空数组取 `[0]`、字段不存在），再使用 `|默认值` 和下面的智能默认值。

表达式（`condition`、iterator `filter`、`${...}` 里的 JS 表达式、诊断文案）里有一组名字始终是语言自带的标准全局，不从上面五层解析：`Infinity`、`NaN`、`undefined`、`isFinite`、`isNaN`、`parseFloat`、`parseInt`、`decodeURI`、`decodeURIComponent`、`encodeURI`、`encodeURIComponent`、`Array`、`BigInt`、`Boolean`、`Date`、`Error`、`Intl`、`JSON`、`Map`、`Math`、`Number`、`Object`、`RegExp`、`Set`、`String`、`Symbol`（清单在 `expressionUtils.ts` 的 `EXPRESSION_GLOBALS`）。所以输入、`save_as` 或数据列取了其中某个名字时，表达式读不到它。其余名字（包括 `window`、`process`、`console` 这类宿主全局名）都按五层解析，五层都没有就是 `undefined`；保留字（如 `enum`、`default`）不会被当成名字，写在字符串里也不影响求值。`validate:skills` 对步骤 `condition` 用同一套名字检查未声明的引用：占位符 `${path|默认值}` 读的是 `path` 的根名字（引号里也算），箭头函数参数和对象字面量的静态键不算引用。只检查 ASCII 名字；上下文关键字（`async`、`await`、`let`、`of`、`static`、`yield`）和 `window`、`console`、`globalThis` 不要求声明。字符串、模板、正则和注释的边界以 JS 引擎的编译结果为准；条件编译不过或无法确认时退回粗扫描（成对引号之外、不在 `.` 之后的标识符），正则、模板和注释里的词可能被当成引用。

声明了 `save_as` 的步骤执行后总会绑定这个名字：成功时绑定选中的数据（可选步骤被条件跳过或查询出错时为 `[]`）；步骤没有成功（非可选步骤被条件跳过、exact scope 不可用、任何类型的步骤失败，包括失败的可选 Skill 引用）时绑定 `null`，带上该步骤自身结果的 scope（`save_from` 带上目标子步骤的 scope，目标不存在时不带 scope）。被条件跳过的步骤没有执行，不会覆盖本 Skill 前面步骤已经做出的绑定，所以互斥条件下的多个备选步骤可以声明同一个名字。

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

`expandableBindSource` 写 `save_as` 名：用该绑定的行展开本步骤的行，展开数据带的范围来源也是这个绑定自己的。

### 高亮规则

```yaml
display:
  highlight:
    - condition: "jank_rate > 10"
      color: "red"
    - condition: "jank_rate > 5"
      color: "orange"
```

### 双语标签与原因措辞

Skill 展示的每段文字都按中英文两种语言检查：显示名、描述、列标签、步骤标题、诊断结论与建议、输入描述、
由标识符派生的目录标签，以及 SQL 和所引 fragment 中可能被显示的字符串字面量（CASE 结果、VALUES 表里的标签）。
作为比较操作数、`IN (…)` 成员、GLOB/LIKE 操作数或简单 CASE 的 WHEN 值的字面量不显示，不算。标识符、路径
和写成数据的模式（如 `*thermal-engine*`）是名字；只用来指称组件的英文子句（thermal HAL 服务进程）也是名字。

- 温控词（温控、过热、thermal）需要温度、cooling device 或 cpufreq 上限证据；
- 限频词（throttle、限频、降频、热节流，以及被当作原因的“频率上限”）需要 cooling device 或 cpufreq 上限
  证据——温度只能说明发热，不能说明被限频；
- 只观察到频率下降时写“频率下调”。

标识符读起来像结论时，不要改列名，给标签写 `label_i18n`（display 列、synthesize 字段）或 `title_i18n`
（步骤标题），`meta` 用 `display_name_i18n` / `description_i18n`。缺少证据支撑的措辞报
`cause_wording_without_evidence`。精确运行显示 `exact_sql` 的文字，需要该运行实际读取的证据。

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
      (SELECT PERCENTILE(interval_ns, 50)
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

### 等待归因相关的两个 fragment

- `fragments/thread_role.sql`：给 trace 里每个 utid 一个角色（main/render/gc/jit/
  binder/network/image/worker/flutter_ui/flutter_raster/webview/system/other）。
  唤醒者通常不在被分析进程里，所以它不按包名裁剪；角色来自线程名，是用途提示而非行为证据。
- `fragments/sleep_wake_source.sql`：输入 `wake_source_scope(utid)` 与
  `thread_roles`，把每个 S/I/D/DK 等待行回连到其结束时刻的 R/R+ 行，取出
  `waker_utid` / `irq_context`，输出 `wake_source` 与候选 `wait_class`。
  Android 内核只对 TASK_UNINTERRUPTIBLE 发 `sched_blocked_reason`，S 态没有
  `blocked_function`，这是 S 态等待唯一的内核侧归因信号。

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

`cd backend && npm run validate:skills` 依次运行：

1. `tsx src/cli/index.ts validate --contracts --all`：逐文件的结构 lint，加上与 Self-Evolution 门禁共用的
   in-process validator（`selfEvolution/inProcessValidator.ts`）；
2. `check:skill-localizations`：`backend/skills/localization.catalog.json` 与当前 Skill 一致
   （`npm --prefix backend run generate:skill-localizations` 重新生成）；
3. `check:skill-identity-policies`：`backend/skills/identity-policy.catalog.json`（每个内置 Skill 的生效身份策略，
   Perfetto-Skills 导出器直接读取）一致（`npm --prefix backend run generate:skill-identity-policies`）；
4. `check:skill-sql-inventory`：`Trace/skill-sql.inventory.json`（Trace SQL 回归读取的 Skill SQL 清单）一致
   （`npm --prefix backend run generate:skill-sql-inventory`）；`npm run trace:validate` 另外检查每个 Skill 文件的文本 hash 与清单一致。

结构 lint 以文本消息报告（没有 issue code）：

| 规则 | 行为 |
|---|---|
| tier 与声明一致 | 校验 `tier` 是否为 `S/A/B`，并把结构不足报告为迁移 warning |
| stdlib 声明覆盖 | 扫描 SQL 中使用的 Perfetto stdlib symbol，要求被 `prerequisites.modules` 覆盖 |
| include 预算 | `prerequisites.modules` 超过 8 个时发出成本 warning |
| step id 唯一 | 每个 Skill 内 step id 必须唯一 |
| vendor override 有效 | Vendor override 必须有真实 `additional_steps`、vendor signatures，并指向已注册 base Skill |

共享 validator 的问题带 issue code（提案门禁与 `validate:skills` 报同样的 code）：

| Code | 行为 |
|---|---|
| `skill_top_level_key_unknown` | 顶层字段必须是加载器会读的字段，否则报错：Skill 是 `SkillDefinition` 的字段加上加载器归一化的旧写法（`display`、`description`、`tags`、`icon`、`display_name`、`displayName`）；pipeline 只能用 `PipelineDefinition` 的字段；vendor override 只能用 `extends`、`version`、`meta`、`vendor_detection`、`additional_steps`。外部 Skill Pack 带未知顶层字段时整包拒绝加载 |
| `result_path_read_undecided` | 按路径读取前面顶层步骤结果的 SQL 占位符（`sql` 与 `exact_sql.sql`）必须带 `\|默认值`，或所在步骤的 `condition` 含顶层合取项 `<结果>.data?.length > 0` |
| `cause_wording_without_evidence` | 温控/限频措辞缺少对应证据，见 [双语标签与原因措辞](#双语标签与原因措辞) |
| `process_scope_invalid` | `process_scope` 声明无效，精确范围不可用，见 [4.8](#48-精确进程范围与调查证据) |
| `sql_not_executed` | 执行器永远不会运行的 SQL：非 atomic Skill 的根 SQL、atomic 根旁边的 steps、metadata-only Skill 的 steps |
| `condition_uses_sql_boolean_words` | 步骤 `condition`、conditional 分支 `when` 或诊断规则 `condition` 的代码里写了 SQL `AND` / `OR`（字符串字面量和属性名里的不算）。这些表达式按 JavaScript 求值，`AND` / `OR` 不能编译，结果为 false，步骤被静默跳过（分支不走、规则不触发）。iterator `filter` 例外，其中的 `AND` / `OR` 会被改写 |
| 其他结构错误 | 如 `step_id_duplicate`、`save_as_step_id_collision`、`save_from_target_missing`、`fragment_reference_missing`、`skill_reference_missing`、`display_contract`，在任何地方都是错误 |

其中 `result_path_read_undecided`、`cause_wording_without_evidence`、`process_scope_invalid`、
`sql_not_executed` 和 `condition_uses_sql_boolean_words` 属于 `PREDATING_RULE_CODES`：它们在
`validate:skills` 和提案定义或修改的 Skill（含该 Skill 已有覆盖层的步骤；`skill_sql` 候选放进它替换的步骤后检查）
上是错误，对其他已发布的覆盖层和 Skill Pack 只报警告，避免一个早于规则的覆盖层让同一 scope 的全部覆盖层下线。
内置 registry 在这些规则下没有错误。

所有读取 Skill SQL 的检查都从同一次遍历（`executableSqlUnits`）取单元：atomic Skill 的根 SQL，否则是任意深度的
每个 atomic 步骤（嵌套步骤、内联 conditional 分支）及其 `exact_sql`；读取步骤的检查同样只用 `stepNodesOf`。

没人读的顶层字段不是无害注释：它看起来像会生效的配置（顶层 `diagnostics`、`thresholds`、`synthesis`、厂商
`thresholds_override` 都曾这样静默无效，公开投影还把它们当作活配置渲染）。诊断规则写在 `type: diagnostic`
步骤里，综合结论写在步骤级 `synthesize`；vendor override 运行时只把厂商名、显示名和 `additional_steps` 的 id
作为提示挂在基础 Skill 结果上。

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

## 系统调查证据合同

场景 Strategy 的 `investigation_contract` 引用 `backend/strategies/investigation-profiles.yaml` 中的版本化 profile；`evidence_metrics` 使用生产者声明的 metric ID，不从显示列名推断语义。普通回答的调查义务与 `final_report_contract` 分开。

需求的 `condition` 决定义务何时适用。`kind: semantic` 由最终语义复核判断；`kind: evidence` 带 `metric_id`、`operator`（`gt`/`gte`/`lt`/`lte`）和数值 `value`，只读生产者绑定的证据账本判定，不依赖模型，因此语义复核不可用时仍会产出 `ledgerAcquisition` 行。只有 `observed` 记录参与比较，账本里缺失的指标保持未知，不视为条件不成立。

系统 SQL 必须对请求窗口、调度片段和频率样本做区间交集，保留原始时间及裁剪时间、UTID/UPID、CPU/ucpu 和拓扑来源。线程状态区分 Running、R/R+、S/I、D/DK 与未知覆盖。CPU 驻留保留 medium 和 unknown；精确同 ucpu 的 next-task handoff 仅证明切换观测，不证明抢占动机或全部等待归因。priority 观测不等于 FIFO/RR/OTHER 等策略。

`display.columns` 的投影不得丢弃后续证据读取需要的身份、范围及来源字段。复合 Skill、artifact 保存恢复和 fetch 必须保留这些事实；格式化缺失值不能替代原始 typed null。
