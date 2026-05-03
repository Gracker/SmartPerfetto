# SmartPerfetto Skills 系统化审计报告

> **生成时间**: 2026-05-03 · **作者**: Chris + Codex Review (Round 1) · **状态**: M0 Foundation
>
> 这份文档是 backend skills 工程"细化 + 全域扩展（M0→M6）"的**单一事实源**。所有 milestone（M0-M6）的施工必须以此为基线。

## 0. 目录

1. [执行摘要](#1-执行摘要)
2. [Skills 5 维库存表](#2-skills-5-维库存表)
3. [Perfetto stdlib 覆盖缺口](#3-perfetto-stdlib-覆盖缺口)
4. [Per-Skill 目标等级三档分级（S/A/B）](#4-per-skill-目标等级三档分级sab)
5. [Vendor Override 运行时合同](#5-vendor-override-运行时合同)
6. [S/A/B 三档规范（Spec）](#6-sab-三档规范spec)
7. [validate:skills 扩展规则（5 条 lint）](#7-validateskills-扩展规则5-条-lint)
8. [对 M1-M5 的执行建议](#8-对-m1-m5-的执行建议)
9. [Per-Architecture Jank 检测覆盖矩阵](#9-per-architecture-jank-检测覆盖矩阵)
10. [Execution Backlog — M0 之后的全部 outstanding 工作](#10-execution-backlog--m0-之后的全部-outstanding-工作)

---

## 1. 执行摘要

| 指标 | 真实值（2026-05 实测） | Plan v1 假设 | 偏差 |
|------|---------------------|-------------|------|
| Skills 总数（atomic + composite + deep） | **121** | 119 | +2 |
| 引用 stdlib 模块的 skill 数 | **72**（atomic 45 + composite 25 + deep 2） | 1 | **+71（71×误差）** |
| 实际被引用的 stdlib 模块种类 | **28** | 1 | +27 |
| Android-相关未用 stdlib 模块 | **140**（android. 80 / linux. 20 / wattson. 40） | 42 | +98 |
| YAML 中带 expandableData 字段的 skill | **0** | 0 | ✓ |
| YAML 中有 for_each（运行时合成 expandableData 的来源） | **0** | n/a | n/a |
| Vendor override 文件总数 | **8**（每 OEM 1 个 startup.override.yaml） | 0 | +8 |
| Vendor override 在运行时被消费的路径 | **存在**（hint-based，仅当 additional_steps.length > 0） | 假设 0 | ✓ codex P1 #3 修正 |

**核心架构修正（来自 Codex Round 1）**:
- expandableData 是 **运行时合成**（`skillExecutor.ts:1543` "bind batch step row data as expandableData"），不是 YAML 字段
- Vendor override 是 **hint-based**（`claudeMcpServer.ts:702-717`），additional_steps SQL 当前**不自动执行**，只 ID 列表给 Claude 做提示
- stdlib 注入分两条路径：raw `execute_sql` 走 `sqlIncludeInjector.ts` 自动注入；`invoke_skill` 走 `prerequisites.modules` 显式声明（**两条路径无统一注入器**）

**目标空白**（按工程优先级）:
1. **功耗 / 电池 / 温控**（wattson 全 6 个 + android.battery + android.power_rails 未用） — M2 必须前置 capability detection
2. **运行时正确性**（android.oom_adjuster / android.freezer / lmk 部分用 / android.app_process_starts 未用） — M3
3. **Linux 内核**（linux.cpu.utilization 全套 / linux.perf 全套 / linux.memory.{high_watermark,process} 未用） — M4
4. **网络 / 媒体**（android.network_packets 已用基础；codec / radio_state 未用） — M5
5. **现代 Android 特性**（android.cujs 全套 / android.frame_blocking_calls / android.profiling_manager / android.bitmaps 未用） — M1 sweep + M3

---

## 2. Skills 5 维库存表

完整数据见 [`docs/_audit_inventory.tsv`](./_audit_inventory.tsv)（121 行 × 9 列）。

### 摘要分布

| kind | 数量 | stdlib 引用 | layered ≥2 | avg 步骤 | avg 行数 |
|------|------|-----------|-----------|---------|---------|
| atomic | 90 | 45 (50%) | 23 | 1.2 | 182 |
| composite | 29 | 25 (86%) | 29 (100%) | 12.0 | 972 |
| deep | 2 | 2 (100%) | 2 | 7.0 | 528 |

### 步骤分布（粒度判定）

| 步骤数 | skill 数 | 含义 |
|--------|---------|------|
| ≥20 | 3 | S 级 ground truth (`scene_reconstruction` 25 / `jank_frame_detail` 27 / `startup_detail` 20) |
| 10-19 | 16 | A+ 级 |
| 5-9 | 16 | A 级 |
| <5 | 86 | B 级（包括所有 atomic 单查询） |

### Top 10 行数最多的 skill（候选 S 级 flagship）

| 行数 | 步骤 | stdlib | id |
|-----:|-----:|-------:|----|
| 3288 | 18 | 4 | `scrolling_analysis` (composite) |
| 2787 | 25 | 7 | `scene_reconstruction` (composite) |
| 2050 | 27 | 5 | `jank_frame_detail` (composite) |
| 1332 | 20 | 4 | `startup_detail` (composite) |
| 1165 | 15 | 4 | `startup_analysis` (composite) |
| 1020 | 9 | 3 | `state_timeline` (composite) |
| 963 | 13 | 0 | `thermal_throttling` (composite) — **stdlib 缺！** |
| 959 | 14 | 2 | `cpu_analysis` (composite) |
| 913 | 12 | 2 | `click_response_analysis` (composite) |
| 884 | 12 | 2 | `anr_analysis` (composite) |

**异常点**: `thermal_throttling` 1000 行 0 stdlib —— 这是 M1 sweep 的优先目标（明显手写 SQL 应该迁到 stdlib）。

---

## 3. Perfetto stdlib 覆盖缺口

完整数据见 [`docs/_audit_stdlib_xref.tsv`](./_audit_stdlib_xref.tsv)。

### 已被 skill 引用的 28 个模块

```
android.anrs                   android.battery_stats         android.binder
android.binder_breakdown       android.critical_blocking_calls
android.frames                 android.frames.timeline       android.garbage_collection
android.gpu.frequency          android.gpu.memory            android.input
android.memory.dmabuf          android.memory.lmk            android.monitor_contention
android.network_packets        android.screen_state          android.slices
android.startup.startups       android.startup.startup_breakdowns
android.startup.time_to_display
android.suspend
linux.block_io                 linux.cpu.frequency           linux.cpu.irq
linux.memory.general           linux.threads
sched                          stack_profile
```

### 高优先级未用模块（按工程价值）

#### Wattson（功耗，全部 40 个未用）
```
wattson.aggregation            wattson.cpu                   wattson.cpu.arm_dsu
wattson.cpu.estimates          wattson.cpu.freq              wattson.cpu.freq_idle
wattson.cpu.hotplug            wattson.cpu.idle              wattson.cpu.pivot
wattson.curves.{cpu_1d,cpu_2d,gpu,l3,mt6897_2d,tg5_*,tpu,utils}
wattson.device_infos           wattson.estimates             wattson.gpu
wattson.gpu.estimates          wattson.gpu.freq_idle
wattson.tasks                  wattson.tasks.attribution     wattson.tasks.gpu_active_regions
wattson.tasks.gpu_tasks        wattson.tasks.idle_transitions_attribution
wattson.tasks.task_slices
wattson.tpu                    wattson.tpu.estimates         wattson.tpu.freq_idle
wattson.ui.continuous_estimates
wattson.utils                  wattson.windows
```

**P0 警告（来自 Codex）**: wattson stdlib 全部依赖特定 trace config（`android.power_rails`、battery counters、CPU freq_idle、GPU work_period）。**绝大多数 production trace 不开这些数据源** → wattson skill 上线即全空。M2 前必须部署 `traceCapabilityDetector`。

#### Linux 内核（20 个未用）
```
linux.cpu.idle                 linux.cpu.idle_stats          linux.cpu.idle_time_in_state
linux.cpu.utilization.{general,process,slice,system,thread,thread_cpu}
linux.devfreq                  linux.irqs
linux.memory.high_watermark    linux.memory.process
linux.perf                     linux.perf.counters           linux.perf.etm
linux.perf.samples             linux.perf.spe
```

#### Android 重要未用（80 个，列出 Top 30）
```
android.aflags                 android.app_process_starts    android.auto
android.battery                android.battery.charging_states android.battery.doze
android.bitmaps                android.broadcasts            android.cpu
android.cpu.cluster_type       android.cpu.cpu_per_uid
android.cujs.{base,cuj_frame_counters,sysui_cujs,threads}
android.desktop_mode           android.device                android.dumpsys
android.dvfs                   android.entity_state_residency
android.frame_blocking_calls   android.frames.jank_type      android.frames.per_frame_metrics
android.freezer
android.gpu.mali_power_state   android.gpu.work_period
android.io                     android.job_scheduler         android.kernel_wakelocks
android.memory.heap_graph.*    android.memory.heap_profile.* android.memory.memory_breakdown
android.oom_adjuster
android.power_rails            android.profiling_manager
android.statsd                 android.surfaceflinger        android.thread
android.wakeups                android.winscope.{*}
```

---

## 4. Per-Skill 目标等级三档分级（S/A/B）

完整数据见 [`docs/_skill_tier_triage.tsv`](./_skill_tier_triage.tsv)。

### 分级原则

| 等级 | 定义 | 数量 | 期望工作量 |
|------|------|------|----------|
| **S** | **分析旗舰** — composite 多阶段编排，跨多 stdlib 模块，前端 expandableData 合成关键。每个 skill 改造 2-4 小时 | **34**（28%） | 高 |
| **A** | **分析步骤** — atomic 但 SQL 实质丰富（≥3 步或 ≥200 行 + ≥1 stdlib）。每个 skill 改造 30-60 分钟 | **15**（12%） | 中 |
| **B** | **数据提供者** — atomic 单事实查询。**不强行膨胀步骤数**，但必须有 stdlib + DataEnvelope 列定义 + 单元测试。每个 skill 改造 10-20 分钟 | **72**（60%） | 低 |

### Tier S 完整清单（34 个）

> 本工程的核心改造对象。每个必须满足 S 级 spec（详见 §6）。

| id | kind | type | 步骤 | 行数 | stdlib | 备注 |
|----|------|------|-----:|-----:|-------:|------|
| `anr_analysis` | composite | composite | 12 | 884 | 2 | |
| `anr_detail` | composite | composite | 13 | 795 | 3 | |
| `anr_main_thread_blocking` | atomic | composite | 5 | 512 | 2 | atomic 目录 + composite type |
| `binder_analysis` | composite | composite | 11 | 740 | 1 | |
| `binder_detail` | composite | composite | 6 | 381 | 0 | **stdlib 缺** |
| `block_io_analysis` | composite | composite | 8 | 558 | 1 | |
| `callstack_analysis` | deep | deep | 6 | 435 | 1 | |
| `click_response_analysis` | composite | composite | 12 | 913 | 2 | |
| `click_response_detail` | composite | composite | 12 | 799 | 3 | |
| `cpu_analysis` | composite | composite | 14 | 959 | 2 | |
| `cpu_profiling` | deep | deep | 8 | 621 | 2 | |
| `dmabuf_analysis` | composite | composite | 8 | 621 | 1 | |
| `flutter_scrolling_analysis` | composite | composite | 6 | 442 | 1 | |
| `gc_analysis` | composite | composite | 8 | 743 | 2 | |
| `gpu_analysis` | composite | composite | 8 | 699 | 2 | |
| `io_pressure` | composite | composite | 8 | 653 | 2 | |
| `irq_analysis` | composite | composite | 10 | 695 | 1 | |
| `jank_frame_detail` | composite | composite | 27 | 2050 | 5 | **最复杂** |
| `lmk_analysis` | composite | composite | 8 | 625 | 2 | |
| `lock_contention_analysis` | composite | composite | 10 | 712 | 1 | |
| `memory_analysis` | composite | composite | 11 | 717 | 0 | **stdlib 缺！优先迁** |
| `navigation_analysis` | composite | composite | 13 | 900 | 1 | |
| `network_analysis` | composite | composite | 13 | 759 | 1 | |
| `rendering_pipeline_detection` | atomic | composite | 8 | 748 | 0 | **stdlib 缺** |
| `scene_reconstruction` | composite | composite | 25 | 2787 | 7 | |
| `scroll_session_analysis` | composite | composite | 6 | 495 | 0 | **stdlib 缺** |
| `scrolling_analysis` | composite | composite | 18 | 3288 | 4 | |
| `startup_analysis` | composite | composite | 15 | 1165 | 4 | |
| `startup_detail` | composite | composite | 20 | 1332 | 4 | |
| `startup_slow_reasons` | atomic | composite | 2 | 619 | 2 | **S 级模板 ground truth** |
| `state_timeline` | composite | composite | 9 | 1020 | 3 | |
| `surfaceflinger_analysis` | composite | composite | 10 | 807 | 1 | |
| `suspend_wakeup_analysis` | composite | composite | 13 | 696 | 1 | |
| `thermal_throttling` | composite | composite | 13 | 963 | 0 | **stdlib 缺！优先迁** |

**stdlib 缺口热点**: `memory_analysis` / `rendering_pipeline_detection` / `thermal_throttling` / `scroll_session_analysis` / `binder_detail` 共 5 个 S 级 skill 当前 0 stdlib —— **M1 优先迁移**。

### Tier A 完整清单（15 个）

| id | 步骤 | 行数 | stdlib | 备注 |
|----|-----:|-----:|-------:|------|
| `binder_storm_detection` | 4 | 393 | 1 | |
| `blocking_chain_analysis` | 3 | 309 | 0 | stdlib 缺 |
| `consumer_jank_detection` | 4 | 547 | 1 | |
| `device_state_timeline` | 4 | 307 | 0 | stdlib 缺 |
| `fence_wait_decomposition` | 4 | 313 | 0 | stdlib 缺 |
| `frame_production_gap` | 2 | 336 | 0 | stdlib 缺 |
| `game_fps_analysis` | 3 | 376 | 1 | |
| `gpu_metrics` | 5 | 410 | 1 | |
| `input_to_frame_latency` | 5 | 425 | 1 | |
| `lock_contention_in_range` | 3 | 243 | 1 | |
| `memory_pressure_in_range` | 4 | 381 | 0 | **stdlib 缺，优先迁** |
| `startup_critical_tasks` | 0 | 246 | 2 | for_each iterator |
| `app_frame_production` | 4 | 306 | 1 | |
| `cpu_topology_detection` | 4 | 282 | 0 | stdlib 缺 |
| `vsync_phase_alignment` | 3 | 244 | 1 | |

### Tier B 概要（72 个）

数据提供者类，按子领域统计（详见 [`docs/_skill_tier_triage.tsv`](./_skill_tier_triage.tsv)）:
- **Startup 数据提供** ~22 个: `startup_*_in_range` 系列（`startup_binder_in_range`、`startup_jit_analysis` 等）
- **CPU/GPU 计数** ~10 个: `cpu_freq_timeline` / `gpu_render_in_range` 等
- **Pipeline 数据** ~8 个: `present_fence_timing` / `frame_production_gap` 等
- **其他** ~32 个: `binder_in_range` / `gc_events_in_range` 等单事实查询

---

## 5. Vendor Override 运行时合同

### 调研问题与答案（来自 codex P1 #3 反馈推动）

| 问题 | 答案 | 文件:行 |
|------|------|---------|
| 谁加载 vendor override？ | `SkillRegistry.loadVendorOverrides()` 扫 `vendors/{oem}/*.override.yaml`，按 `extends` skill_id 索引 | `backend/src/services/skillEngine/skillLoader.ts:750-806` |
| 谁探测当前 vendor？ | `SkillAnalysisAdapter.detectVendor()` 用 `vendor_detection.signatures` patterns 匹配 trace metadata | `backend/src/services/skillEngine/skillAnalysisAdapter.ts:166-300` |
| 探测结果如何流转？ | `claudeRuntime.vendorCache: Map<traceId, vendor>` + `claudeMcpServer.ts` 在 invoke_skill 响应里挂 `vendorOverrideHint` | `claudeRuntime.ts:2116-2128`, `claudeMcpServer.ts:702-717` |
| 空 override 是否被消费？ | **不会**。`claudeMcpServer.ts:708` 显式 guard `additionalSteps.length > 0`。空 override 静默跳过 | `claudeMcpServer.ts:708` |
| `additional_steps` 是否自动执行？ | **不会**。Hint 只携带 step ID 列表（`additionalStepIds`），实际 SQL 当前**不会自动 invoke** —— 这是已存在的架构 debt | `claudeMcpServer.ts:709-715` |
| 8 个 OEM 当前实际覆盖？ | **只有 startup 一个场景**，每个 OEM 一个 `startup.override.yaml`，含 2-4 个真实 `additional_steps` 的 SQL | `backend/skills/vendors/{8 OEM}/startup.override.yaml` |

### 对 plan 的关键修正

1. **不要加空占位文件** —— `additional_steps: []` 在运行时被 line 708 守卫跳过，纯垃圾 diff
2. **新增 vendor override 必须有 ≥1 真实 `additional_step`**（含 SQL）才有运行时效果
3. **架构 debt（本工程不修复）**: `additional_steps` SQL 当前不自动执行 —— 只 ID 推给 Claude 作为 hint。本工程添加的 vendor override 默认依赖 Claude 看到 hint 后自主调用。**M5 后期可考虑独立 milestone 修复 hint→exec 的自动化**
4. **M2 vendor 扩展真实工作量**: 4 领域 × 8 OEM = 32 文件，**每文件 1-3 真实 additional_step + SQL**，总计 ~64-96 个真实 SQL —— 比"加空占位"难得多

---

## 6. S/A/B 三档规范（Spec）

### S 级规范（基于 `startup_slow_reasons.skill.yaml` 反推）

**适用**：34 个 flagship skill（见 §4）。

**强制要求**:

```yaml
# SPDX 头 + 版权（CLAUDE.md 强制）
# 文档块（多行 # 注释，说明用途、版本演进）
name: <stable_id>
version: "<MAJOR.MINOR>"
type: composite                       # 必须 composite 或 deep（atomic 升 S 也用 composite）
category: <domain>
tier: S                               # 新增字段，validate:skills 校验

meta:
  display_name: "中文显示名"
  description: "一句话说明"
  icon: "<material-icon>"
  tags: [<keyword>, ...]

prerequisites:
  modules:                            # 必须 ≥2 个 stdlib 模块
    - android.<module>
    - linux.<module>

inputs: []                            # 显式声明（即使为空）

steps:
  # ≥5 个步骤，至少覆盖 L1/L2/L3 三层
  - id: <step_id>                     # snake_case，全 skill 内唯一
    type: atomic | iterator | composite
    name: "中文步骤名"
    display:
      level: overview | summary | key | list | detail | deep | frame
      layer: number | percent | duration | bytes
      title: "中文标题"
      columns:                        # 必须有完整 column 定义
        - name: <col_name>
          label: "中文列名"
          type: number | string | duration | timestamp | percentage | bytes
          format: <format_hint>
    sql: |
      -- INCLUDE 自动注入（仅 invoke_skill path 显式声明）
      SELECT ...

# 可选: post-processing / synthesis 块（jank_frame_detail 用了大块）
synthesis:
  - id: ...
    type: aggregation | join | annotation
```

**S 级 skill 必须有的特征**（lint 强制）:
- `tier: S` 顶层字段
- `prerequisites.modules` ≥2 个
- 步骤数 ≥5
- 至少 L1（overview）+ L2（list）两层
- ≥1 个 `for_each` iterator 子步骤（产生 expandableData）— 若无 iterator 则前端展开会空
- 有相应的 vendor override 钩子（在核心 4 领域内时）

### A 级规范（atomic 但实质，15 个）

**适用**：atomic 但 ≥3 步骤或 ≥200 行的有实质 SQL 的 skill。

**强制要求**:
```yaml
name: <stable_id>
type: atomic
tier: A                               # 新增

prerequisites:
  modules:
    - <≥1 个 stdlib>

steps:
  - id: ...
    type: atomic
    display:
      level: list | detail
      columns: [...]                  # DataEnvelope 列必填
    sql: |
      SELECT ...
```

A 级强制要求：
- `tier: A`
- `prerequisites.modules` ≥1 个
- 步骤数 ≥1（A 级允许 single-step）
- 必须 `display.columns` 完整定义（防止前端裸表）
- 不强制 expandableData 也不强制 vendor 钩子

### B 级规范（数据提供者，72 个）

**适用**：atomic 单事实查询。

**强制要求**:
```yaml
name: <stable_id>
type: atomic
tier: B                               # 新增

prerequisites:
  modules:
    - <≥1 个 stdlib>                  # 即使是 B 也要有 stdlib（避免手写裸 SQL）

steps:
  - id: query
    type: atomic
    display:
      level: list | detail
      columns: [...]
    sql: |
      SELECT ...
```

B 级强制要求：
- `tier: B`
- `prerequisites.modules` ≥1 个 — **关键**：B 级不允许 0 stdlib（不允许"我就是想手写一个 SELECT" 的偷懒）
- `display.columns` 完整
- 单元测试覆盖（trace fixture-based）

---

## 7. validate:skills 扩展规则（5 条 lint）

实现于 `backend/src/cli/commands/validate.ts`。所有规则在 `npm run validate:skills` 时强制执行（fail = build break）。

### Rule 1: `skill-tier-must-match-declared`

每个 skill 必须有 `tier: S | A | B` 顶层字段。验证：
- S 级: composite 或 type=composite，prerequisites.modules ≥2，步骤数 ≥5
- A 级: atomic，prerequisites.modules ≥1，display.columns 必填
- B 级: atomic，prerequisites.modules ≥1，display.columns 必填，行数 ≤300

**Error 例**:
```
✗ skill 'memory_pressure_in_range' (tier: A)
  - failure: tier=A requires prerequisites.modules ≥1, found 0
```

### Rule 2: `skill-stdlib-detected-vs-declared`

解析 SQL，提取使用的 stdlib 函数 / 表名（如 `android_startups` → `android.startup.startups`），对比 `prerequisites.modules`。**SQL 中用到但未声明 → fail**。

**Error 例**:
```
✗ skill 'startup_jit_analysis' tier=B
  - SQL uses table 'android_startups' (from 'android.startup.startups')
  - prerequisites.modules does NOT declare it
```

### Rule 3: `skill-include-budget-soft-cap`

`prerequisites.modules.length ≤ 8`. 防止单 skill INCLUDE 过多模块拖慢启动。超出报 warning（不 fail，但 PR review 时强制审核）。

### Rule 4: `skill-step-id-uniqueness`

skill 内 `steps[*].id` 必须 unique（含 synthesis 子步骤）。已有的部分 contributor 在 fork-join 模式下重用 ID，本规则强制断绝。

### Rule 5: `skill-vendor-override-runtime-conformant`

**基于 §5 调研**:
- 任何 `vendors/{oem}/*.override.yaml` 必须有 `additional_steps.length ≥ 1`（空 override = error）
- 每个 `additional_step` 必须有 `id`、`name`、`sql` 字段
- `extends` 字段必须指向已注册的 skill_id（防 typo）
- `vendor_detection.signatures` 必须 ≥1 条（否则永远不被探测匹配）

---

## 8. 对 M1-M5 的执行建议

### M1 sweep 工作量重估

按 §4 tier triage：
- M1a 渲染管线（18 skill）→ S/A/B 各 ~6/~3/~9
- M1b CPU/调度（17 skill）→ S/A/B ~3/~3/~11
- M1c 启动（19 skill）→ S/A/B ~6/~2/~11（startup_* 多为 B 级数据提供者）
- M1d ANR/Binder/Lock（30 skill）→ S/A/B ~10/~5/~15
- M1e GPU/IO/Memory/其他（37 skill）→ S/A/B ~9/~2/~26

**总计预估改造工时**:
- S 级 34 × 3h = **102h**
- A 级 15 × 0.75h = **11h**
- B 级 72 × 0.25h = **18h**
- **总 131h** ≈ 3-4 工程师周（vs. 原 plan 估算"全 119 S 级"≈ 357h，**降 63%**）

### M2 启动顺序硬约束

1. **必须先**做 M2.0：`backend/src/services/traceCapabilityDetector.ts`（探测 power_rails / battery_counters / freq_idle / GPU work_period）
2. **必须先**做 M0.5b：前端 expandableData 排序契约修正（`sql_result_table.ts`）
3. **必须先**做 M0.7：5 条 lint rule 落地
4. 再启 M2 wattson + M3/M4/M5 新场景扩展
5. M1 sweep 可与 M2-M5 并行（按子领域 PR 拆分）

### 出错率预防

- M1 每个子 PR PR 描述里**显式列出**改造的 tier 分布（e.g. "M1a: 6 S + 3 A + 9 B"）
- Codex review 强制覆盖 M1a / M2 / M3 / M5（核心 milestone）
- 任何 conclusion 文本变化先 stop 评估（CLAUDE.md 规则 #1）
- vendor override 不允许加空文件（lint rule #5 拒绝）

---

## 9. Per-Architecture Jank 检测覆盖矩阵

> **背景**：`actual_frame_timeline_slice` 是 SurfaceFlinger 给 buffer producer 输出的帧时间线。Android 12+ 给所有 layer 的 buffer producer 都生产 timeline，但**生产端帧时长**（如 Flutter 1.ui Dart frame、TextureView 1.ui 帧、WebView V8 → drawFunctor、Game main loop）**不进 timeline**。如果只用 timeline 判断 jank，会漏掉"用户感知到卡，但 SF 端没卡"的关键场景。
>
> 用户在 2026-05-03 反馈：本工程必须显式审计每个架构的 jank 检测路径，不能默认 timeline 全覆盖。

### 9.1 现状矩阵

| 架构 | 子类型 | Timeline 是否覆盖 | Choreographer.doFrame | 当前 jank 检测 skill | 数据源 | 覆盖度评级 |
|------|-------|----|----|----|----|------|
| **STANDARD (HWUI)** | — | ✓ 全覆盖（生产端 + 消费端） | ✓ | `scrolling_analysis` / `jank_frame_detail` / `consumer_jank_detection` | `actual_frame_timeline_slice` + `expected_frame_timeline_slice` | A — 充分 |
| **FLUTTER** | SurfaceView + Skia | ✓ 消费端覆盖 | ✗（用 1.ui 自己的 frame loop） | `flutter_scrolling_analysis` | `actual_frame_timeline_slice` + 1.ui/1.raster 线程 slices | B — 良好（trace fixture 完整） |
| FLUTTER | SurfaceView + Impeller | ✓ | ✗ | 同上 | 同上（Impeller 用 1.io thread） | B |
| FLUTTER | TextureView + Skia | ✗ **生产端 1.ui 不进 timeline**（GLConsumer 走 GL texture 共享）；只有 SF composite 进 | ✗ | `flutter_scrolling_analysis` 用 1.ui 线程 slice 兜底 | 1.ui slices + RenderThread updateTexImage | B — fixture 在但根因链未验证 |
| FLUTTER | TextureView + Impeller | 同上 | ✗ | 同上 | 同上 | B |
| **WEBVIEW** | SurfaceControl | ✓ 消费端 | ✓（应用层） | 仅 `webview_v8_analysis`（V8 GC + script execution） | `actual_frame_timeline_slice`（应用 layer） | C — **JS-to-frame 因果链缺失** |
| WEBVIEW | TextureView + GL functor | ✗ 生产端 drawFunctor 不进 timeline | ✓ | 同上 | drawFunctor slice + V8 + GL command queue | **D — 显著空白** |
| WEBVIEW | SurfaceView wrapper | ✓ 消费端 | ✓ | 同上 | wrapper layer's timeline | C |
| **COMPOSE** | — | ✓（Compose 内部仍走 HWUI/RenderThread） | ✓ | `compose_recomposition_hotspot`（重组耗时） + `scrolling_analysis` | timeline + Compose slices | B — recomposition vs frame 关联不强 |
| **GAME_ENGINE** | Unity / Unreal / Cocos | ✗ 自己的 main loop / Tick 不在 Choreographer | ✗（部分用 SurfaceView 配合 swap buffer） | `game_fps_analysis`（仅 FPS 总数） | counter/buffer swap 时间间隔 | **D — main loop 帧时长无检测** |
| **REACT_NATIVE** | Old arch (Bridge) | ✓ 消费端 | ✓ | 无专属 skill；走 `scrolling_analysis` | timeline + JS thread slices | **D — Bridge 通信延迟未检测** |
| RN | New arch (Fabric/JSI) | ✓ | ✓ | 无 | timeline + JSI slices | D |
| RN | Skia (CanvasKit) | ✓ 消费端 | ✓ | 无 | timeline + skia thread | D |
| **GL_STANDALONE** | NativeActivity / GLSurfaceView | ✓ 消费端 SF 出图 | ✗（自己 swap buffer） | 无 | swap interval / GLES command | **D — 0 覆盖** |

### 9.2 关键文档/实现不一致（需要 follow-up）

**`consumer_jank_detection.skill.yaml` 名字误导**：
- 文档块写"不依赖 jank_type 标记，从 SurfaceFlinger 消费端检测"
- 但 SQL 实际引用 `expected_frame_timeline_slice` 计算 vsync 周期
- 它**仍在 Frame timeline 路径上**，不是真正的"非 timeline" jank 检测器
- **建议**：在 M1 sweep 中重命名为 `surfaceflinger_present_interval_jank` 并补充文档说明实际数据源

### 9.3 真实空白（按优先级）

| 优先级 | 缺口 | 建议新增 skill ID | trace fixture 需求 |
|-------|------|-----------------|-------------------|
| P0 | TextureView 1.ui 生产端帧时长（非 Flutter）| `textureview_producer_frame_timing` (atomic) | 通用 TextureView 应用 trace 1 |
| P0 | WebView TextureView GL functor JS→frame 因果链 | `webview_drawfunctor_jank_chain` (composite) | WebView 重 JS 应用 trace 1 |
| P1 | Game main loop / Tick 帧时长 | `game_main_loop_jank` (atomic) — 检测 Unity Update / Unreal Tick / Cocos director slice 异常 | Unity 游戏 trace 1 + Unreal trace 1 |
| P1 | RN Bridge 通信延迟 → frame 缺失 | `rn_bridge_to_frame_jank` (atomic) | RN old-arch 应用 trace 1 |
| P2 | RN Fabric/JSI sync render | `rn_fabric_render_jank` (atomic) | RN new-arch 应用 trace 1 |
| P2 | GL Standalone swap-interval miss | `gl_standalone_swap_jank` (atomic) | NativeActivity / GLSurfaceView 应用 trace 1 |
| P2 | Compose recomposition → frame 关联 | 增强 `compose_recomposition_hotspot` 加"导致 jank 的 hot recomposition"步骤 | Compose 重组密集 trace 1 |

### 9.4 整合到 milestone 节奏的建议

- **M1 sweep**：在 M1a 渲染管线子 PR 中**完成 1 件事** —— 修 `consumer_jank_detection` 命名误导（rename + 文档修正）
- **M3 (运行时正确性)**：纳入 P0/P1 的"生产端 jank"系列 skill（textureview_producer_frame_timing / webview_drawfunctor_jank_chain / game_main_loop_jank / rn_bridge_to_frame_jank）—— 这些是"应用层 jank 因果"问题，归属运行时正确性维度合理
- **M5 (网络/媒体) 之后单独 M7**：处理 P2 的稀疏架构（GL standalone / RN Fabric / Compose recomposition→frame）

### 9.5 当前 trace fixture 缺口

`test-traces/` 目前只有 6 个：3 个 Flutter（含 SurfaceView+TextureView）、2 个 standard 滑动、2 个标准启动。**完全缺**：
- 通用 TextureView（非 Flutter）应用
- WebView 重 JS（H5 列表/动画 dense）
- Unity / Unreal 游戏
- RN old-arch / new-arch
- GL Standalone (NativeActivity)
- Compose 密集重组

**M3 启动前必须先收集 trace fixture**（per CLAUDE.md `tests/skill-eval/runner.ts:describeWithTrace` 机制，缺 fixture 的 skill 会 known-skip，但**不缺意味者覆盖度上不去**）。

---

## 10. Execution Backlog — M0 之后的全部 outstanding 工作

> 这一节列出 audit doc Section 1-9 推导出的**全部待办工作**，分级、可独立施工。每条都标了"是否本会话自主完成"。
>
> 本会话尝试完成：✅ Tier-1 全部 + Tier-2 部分。
> 留给下次会话/人工决策：🔵 Tier-3 全部。

### 10.1 Tier-1 ：纯机械、零风险（本会话执行）

| ID | 任务 | 文件改动量 | 状态 |
|----|------|-----------|------|
| T1.1 | 给 121 现存 skill 添加 `tier: S \| A \| B` 字段（基于 `_skill_tier_triage.tsv`）| 121 yaml 文件，每个 +1 行 | 本会话执行 |
| T1.2 | M1a 重命名 `consumer_jank_detection` → `surfaceflinger_present_interval_jank`（修文档/实现不一致）| 1 yaml 文件 + grep replace 引用点 | 本会话执行 |
| T1.3 | 移除 `pipelines/` 32 + `deep/` 2 + `modules/` 18 这些目录 skill 的 tier triage（基于实际遍历，加到 Section 4）| audit doc + tsv | 本会话执行 |

### 10.2 Tier-2 ：用 S/A/B 模板创建新 skill（本会话尝试）

> 每个新 skill 必须：(a) 复制对应 template；(b) 通过 lint rule 1-5；(c) 触发对应 trace 时回归通过。
> 缺 trace fixture 的标 known-skip。

#### M2 wattson 系列（atomic B 级，capability-gated）

| ID | skill | stdlib 模块 | 状态 |
|----|-------|------------|------|
| T2.1 | `wattson_cpu_power_breakdown` | wattson.cpu.estimates | 本会话尝试 |
| T2.2 | `wattson_idle_state_residency` | wattson.cpu.idle | 本会话尝试 |
| T2.3 | `wattson_task_attribution` | wattson.tasks.attribution | 本会话尝试 |
| T2.4 | `battery_state_timeline` | android.battery_stats | 本会话尝试 |
| T2.5 | `doze_charging_state` | android.battery_stats | 本会话尝试 |

#### M3 运行时正确性深化（atomic）

| ID | skill | stdlib 模块 | 状态 |
|----|-------|------------|------|
| T2.6 | `lmk_kill_attribution` | android.memory.lmk | 本会话尝试 |
| T2.7 | `oom_adjuster_score` | android.oom_adjuster | 本会话尝试 |
| T2.8 | `fsync_block_breakdown` | linux.block_io | 本会话尝试 |
| T2.9 | `native_crash_signal` | （从 ftrace 解析）| 本会话尝试 |

### 10.3 Tier-3 ：留给下次会话或人工决策（不在本会话）

#### M1 sweep（119 skill，跨多子 PR）— **必须人工 review 每子 PR**

| 子 PR | 范围 | 数量 | 主要改造 |
|-------|------|------|---------|
| M1a | 渲染管线 | 18 | tier 已加（T1.1）/ stdlib 拉齐 / `frame_blocking_calls` 引用 / 命名修正 |
| M1b | CPU/调度 | 17 | tier 已加 / linux.cpu 引用 / vendor 钩子 |
| M1c | 启动 | 19 | tier 已加 / `startup_*_in_range` 数据提供者补 stdlib |
| M1d | ANR/Binder/Lock | 30 | tier 已加 / lock 系列细化 / vendor 钩子 |
| M1e | GPU/IO/Memory/其他 | 16 | tier 已加 / wattson.gpu 引用 / IO/Memory 重写 |

#### M2 复合分析（composite）+ 场景 strategy

| ID | task | 阻塞原因 |
|----|------|---------|
| 2.A | `thermal_throttling_chain` (composite) | 需要场景 strategy 编排 |
| 2.B | `battery_drain_attribution` (composite) | 同上 |
| 2.C | `power_consumption_overview` (composite) | 同上 |
| 2.D | `backend/strategies/power.strategy.md` | 需要 prompt 内容设计 + 用户 review |
| 2.E | `traceCompletenessProber` 加 `gpu_work_period` capability | 需要 stdlib 测试 |
| 2.F | wattson trace fixture 采集 | 需要真机录制 + power_rails atrace 配置 |

#### M3 运行时正确性 — 剩余 composite + strategy

| ID | task | 阻塞原因 |
|----|------|---------|
| 3.A | `anr_deep_chain` (composite) | 需 composite 编排 |
| 3.B | `memory_growth_detector` (composite) | 同上 |
| 3.C | `native_heap_breakdown` (composite) | 需 heap_graph stdlib，trace 大 |
| 3.D | `runtime-correctness.strategy.md` | 需要场景设计 |
| 3.E | M3 trace fixture（ANR/OOM/IO heavy）| 需录制 |
| 3.F | 4 个架构差异 jank skill：`textureview_producer_frame_timing` / `webview_drawfunctor_jank_chain` / `game_main_loop_jank` / `rn_bridge_to_frame_jank` | 需要 trace fixture + 架构特定 SQL 设计 |

#### M4 Linux 内核

| ID | task | 阻塞原因 |
|----|------|---------|
| 4.A | `linux_sched_latency_distribution` | 需 linux.cpu.sched_latency 验证 |
| 4.B | `linux_runqueue_depth_timeline` | 同上 |
| 4.C | `linux_pmu_cache_misses` / `_branch_mispredict` | 需 linux.perf 数据采集（trace_config 启用 PMU）|
| 4.D | `linux_page_fault_breakdown` / `_memory_reclaim_storm` | 需 linux.memory.* |
| 4.E | scrolling/startup/power.strategy.md 加 phase_hints | 需 prompt 设计 |

#### M5 网络/媒体

| ID | task | 阻塞原因 |
|----|------|---------|
| 5.A | 5 个网络 atomic skill | 需要 cellular trace |
| 5.B | 4 个媒体 atomic skill | 需要 codec trace |
| 5.C | network.strategy.md / media.strategy.md | 需要场景设计 |

#### M7（新增）稀疏架构 jank

| ID | task | 阻塞原因 |
|----|------|---------|
| 7.A | `gl_standalone_swap_jank` | 需 NativeActivity / GLSurfaceView trace |
| 7.B | `rn_fabric_render_jank` | 需 RN new-arch trace |
| 7.C | Compose recomposition→frame causality | 需 Compose 重组密集 trace |

#### 其他单点（不在 milestone 路径上）

| ID | task | 阻塞原因 |
|----|------|---------|
| Other.1 | M0.5b 前端 expandableData 排序契约 | perfetto 子模块 PR，按 rules/git.md 推 fork remote |
| Other.2 | M1 全部 119 skill 改造（除 tier 字段）| 需要逐子 PR 人工 review |
| Other.3 | M2-M5 trace fixture 采集 | 需要真机录制 + 用户决定 fixture 来源 |

### 10.4 当本会话结束时

1. **Tier-1 全做完**：121 skill 加 tier、consumer_jank_detection 重命名、tier triage 扩展
2. **Tier-2 尽量做完**：5+5 = 10 个新 atomic skill（缺 fixture 的标 known-skip）
3. **Tier-3 全部待人工**：M1 sweep / 场景 strategy / fixture 采集 / 架构 specific 全部留给下次会话

每完成一个 atomic 工作单元就 commit，commit message 引用 audit doc Section 10 的对应 ID。Quality gates 必过 = `validate:skills` 0 errors + 必要时 `scene-trace-regression` 6/6 PASS。
