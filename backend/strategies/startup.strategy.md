<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: startup
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: startup_critical_path
      domain: critical_path
      description: "Bind the exact launch, UPID and startup interval; distinguish TTID, TTFD and framework completion. Explain material launch phases and critical tasks individually with time ranges, exclusive self time, execution/wait states, dependencies and relevant system effects. Keep pre-launch work, launch-window work and the tail to first display separate; explain residual intervals or their specific evidence gaps. Clip contributions to the declared window and preserve parent/child overlap: a parent's self time excludes its children. A phase table or dominant hotspot alone is insufficient. A container slice (bindApplication, activityStart, performCreate) names a phase, not a cause: attribute its inner work or state the instrumentation gap."
    - id: startup_dependencies
      domain: dependency_chain
      description: "Use launch phase, Binder, lock, GC, IO and render dependencies when supported. Explain each relevant phase's App work, system contribution and observed anomaly with adjacent evidence; identify the actual critical task beyond the main thread when needed. Distinguish trace facts from source mechanisms and unresolved alternatives. Preserve full root-cause details and unavailable fields; startup duration and hotspot names alone do not explain the launch."
classification_description: "Application launch behavior and performance, including launch type and time to initial or full display."
priority: 2
effort: medium
required_capabilities:
  - startup
  - cpu_scheduling
optional_capabilities:
  - binder_ipc
  - lock_contention
  - gc_memory
  - disk_io
  - memory_pressure
  - thermal_throttling
  - power_rails
  - battery_counters
  - cpu_freq_idle
  - gpu_work_period
keywords:
  - 启动
  - 冷启动
  - 热启动
  - 温启动
  - launch
  - startup
  - cold start
  - warm start
  - hot start
  - app start
  - 首帧
  - ttid
  - ttfd
  - first frame
  - ApplicationStartInfo
  - getHistoricalProcessStartReasons
  - STARTUP_STATE
  - START_TIMESTAMP
  - START_REASON
  - START_COMPONENT

final_report_contract:
  required_sections:
    - id: startup_type_and_metrics
      label: 启动类型与 TTID/TTFD
      description: '明确 cold/warm/hot 判定，并给出 TTID/TTFD 或对应不可用原因；numeric.cell 优先引用带单位的原始 Skill 字段。'
      pattern_groups:
        - ['启动类型', '冷启动', '温启动', '热启动', 'cold\s*start', 'warm\s*start', 'hot\s*start']
        - ['TTID', 'TTFD', 'Time\s+to\s+initial\s+display', 'Time\s+to\s+full\s+display']
    - id: phase_breakdown
      label: 阶段耗时分解
      description: '逐阶段说明实际窗口、wall/self 时间及运行/等待构成；self 仅排除已记录子切片，不能直接当作 CPU 时间或优化收益。'
      pattern_groups:
        - ['阶段耗时', '阶段分解', 'phase\s+breakdown', 'startup_detail', '根因分析树', 'Phase\s*\d+']
        - ['self_ms', 'dur_ms', '耗时', '\d+(?:\.\d+)?\s*ms']
    - id: root_cause_references
      label: 根因编号引用
      description: '关键根因只能引用启动知识库已有的 A1-A18、B1-B12，或工具实际返回的 SR09-SR20；禁止自创 SR01-SR08 或其他编号。'
      pattern_groups:
        - ['\bA(?:1[0-8]?|[2-9])\b', '\bB(?:1[0-2]?|[2-9])\b', 'SR(?:09|1[0-9]|20)(?!\d)']
    - id: audience_recommendations
      label: App/系统分层建议
      description: '逐维度写窗口观测/缺口；未知不得汇总成整体正常、非瓶颈或无可改进。低占比/未命中仅表示该维度未识别为本窗口主因；保留 thermal/策略/topology/blocked_function 缺口。'
      recovery_text:
        zh:
          - 'App 层：仅对已完成阶段证据直接指向的应用瓶颈实施优化。'
          - '系统/平台层：若已完成阶段没有平台归因证据，保持为未验证并继续监测。'
        en:
          - 'App layer: optimize only application bottlenecks directly supported by completed-phase evidence.'
          - 'System/Platform: when completed phases contain no platform-attribution evidence, keep that path unverified and monitor it.'
      pattern_groups:
        - ['App\s*层', '应用\s*层', 'App\s+layer']
        - ['系统\s*/\s*平台\s*层', '系统\s*层', '平台\s*层', 'ROM\s*层', 'System/Platform', 'platform\s+layer']
    - id: system_scheduling_evidence
      label: 系统调度与资源证据
      description: 'Explain startup per-CPU frequency/coverage/load, target runtime, placement/quadrants, task R/R+ handoffs, kernel priority and actual policy. For each relevant dimension give evidence, critical-path impact or a specific gap. Priority cannot prove FIFO/RR; occupancy cannot prove causality.'
      pattern_groups:
        - ['CPU', '频率', 'frequency']
        - ['四象限', 'quadrant', '摆核', 'placement']
        - ['Runnable', '抢占', 'preempt', '调度']
        - ['优先级', 'priority', '调度策略', 'scheduling\s+policy']
    - id: startup_diagnostic_api_boundary
      label: 启动诊断 API/外部指标边界
      description: '当用户主动提到 ApplicationStartInfo、App Performance Score、Vitals、APM 或 A/B 时，区分当前 trace、诊断 API 记录、外部聚合/实验数据、版本/时钟边界和缺失证据。'
      condition:
        kind: semantic
        description: '当问题要求解释启动诊断记录、外部性能指标、基准测试或实验结果，或将它们与当前 trace 对照时适用。'
      pattern_groups:
        - ['启动诊断 API/外部指标边界', 'startup diagnostic API', 'external metric boundary', 'ApplicationStartInfo', 'App Performance Score', 'Vitals', 'APM', 'A/B']
        - ['diagnostic_api', 'external_aggregate', 'experiment', 'ApplicationStartInfo', 'getHistoricalProcessStartReasons', 'STARTUP_STATE', 'START_TIMESTAMP', 'START_REASON', 'START_COMPONENT', 'App Performance Score', 'Play Vitals', 'Android Vitals']
        - ['API\s*3[56]', 'Android\s*1[56]', 'version', '版本', 'clock', 'timestamp', 'record state', 'in-progress', 'incomplete', 'device', 'sample', 'activation', 'A/A']
        - ['trace window', 'current trace', 'TTID', 'TTFD', 'align', '对齐', 'missing', '缺失', 'confidence', '置信', '不能', '不可', 'not prove']

phase_hints:
  - id: detail_breakdown
    keywords: ['detail', '详情', '分解', 'breakdown', '阶段', 'startup_detail', '耗时']
    constraints: '必须把 Phase 1 选中行的 startup_id/start_ts/end_ts/dur_ms/package/startup_type 原样传给 startup_detail；该行有 positive upid 时也必须原样传入，以便后续 target Skill 继承已验证的 exact scope。upid 为 NULL/缺失/歧义时不得从 package 或进程名推断。get_startups 为 0 行时改用 Phase 1 空结果回退，禁止伪造 startup_id/TTID。TTID/TTFD 只能作为可选 ttid_ms/ttfd_ms，不能充当时间边界。使用 self_ms（排除子切片）而非 wall-time。'
    critical_tools: ['startup_detail']
    critical: false
  - id: critical_artifacts
    keywords: ['artifact', 'critical', '关键', '任务', 'task', '热点', 'hot', '阻塞', 'block']
    constraints: '此阶段不可跳过。必须获取关键 artifact（热点函数、阻塞调用、锁竞争）作为深钻输入。'
    critical_tools: ['execute_sql', 'fetch_artifact']
    critical: true
  - id: slow_reasons_validation
    keywords: ['slow', 'reason', '原因', '交叉', 'cross', '验证', 'dex2oat', 'baseline', 'debuggable']
    constraints: '冷启动必须调用 startup_slow_reasons 检查 DEX2OAT/baseline profile/debuggable 等官方因素。Q4(Sleeping) >25% 必须用 blocking_chain_analysis 追踪阻塞源。'
    critical_tools: ['startup_slow_reasons', 'blocking_chain_analysis']
    critical: true
  - id: webview_startup
    keywords: ['webview', 'chromium', 'v8', 'crrenderermain', 'parsehtml', 'drawgl', '页面渲染', 'WebView启动']
    constraints: '仅在架构检测或 trace 证据提示 WebView 时执行。SQL 必须说明正在验证 WebView/Chromium/V8/CrRendererMain 是否参与启动；若未命中 slice，应把 WebView 启动影响标为证据不足或可排除，而不是继续归到综合结论。'
    critical_tools: ['execute_sql']
    critical: false
  - id: startup_power_overlay
    keywords: ['power', 'battery', 'wattson', '功耗', '耗电', '电池', '启动期能耗', '掉电']
    constraints: '用户关心启动功耗/耗电时，先检查 Trace 数据完整度中的 power_rails、battery_counters、cpu_freq_idle、gpu_work_period。数据可用才调用 wattson_app_startup_power；缺失时输出采集建议，禁止把空表解释为低功耗。'
    critical_tools: ['wattson_app_startup_power', 'battery_charge_timeline', 'android_dvfs_counter_stats']
    critical: false
  - id: startup_diagnostic_api_boundary
    keywords: ['ApplicationStartInfo', 'getHistoricalProcessStartReasons', 'STARTUP_STATE', 'START_TIMESTAMP', 'START_REASON', 'START_COMPONENT', 'App Performance Score', 'Android Vitals', 'Play Vitals', 'APM', 'A/B', 'experiment']
    constraints: '当计划或用户问题涉及启动诊断 API/外部指标时，必须把 Perfetto startup_analysis/TTID/TTFD、ApplicationStartInfo 记录、App Performance Score/Vitals/APM/A-B 外部数据分层；说明 API/Android 版本、时钟/时间戳对齐、record 是否 incomplete/in-progress、样本/设备/实验窗口，不能把外部分数或聚合直接当成本 trace 根因。'
    critical_tools: ['startup_analysis', 'lookup_knowledge']
    critical: false
  - id: conclusion
    keywords: ['结论', 'conclusion', '输出', 'output', '报告', 'report', '总结']
    constraints: '输出必须包含：启动类型判定(cold/warm/hot) + TTID/TTFD 数值 + 阶段耗时分解 + 根因编号引用(A1-A18/B1-B12) + 双受众格式([App層]+[系統/平台層])。'
    critical_tools: []
    critical: false

plan_template:
  mandatory_aspects:
    - id: startup_timing
      match_keywords: ['startup', 'ttid', 'ttfd', 'launch', '启动', 'startup_analysis']
      suggestion: '启动场景建议包含启动耗时测量阶段 (startup_analysis)'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: startup_analysis
        - tool: compare_skill
          skill_id: startup_analysis
    - id: phase_breakdown
      match_keywords: ['phase', 'breakdown', 'block', '阶段', '分解', '阻塞', 'startup_detail']
      suggestion: '启动场景建议包含启动阶段分解和阻塞因素分析'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: startup_detail
        - tool: compare_skill
          skill_id: startup_detail
    - id: startup_critical_artifacts
      match_keywords: ['artifact', 'fetch_artifact', 'critical_tasks', 'hot_slice_states', 'thread_blocking_graph', '关键数据', '关键任务', '阻塞关系']
      suggestion: '启动详情阶段必须计划获取 startup_detail 的关键 artifact（主线程状态、四象限、热点、关键任务/阻塞关系；缺失时阶段可 skipped+reason）'
      required_expected_calls:
        - tool: fetch_artifact
    - id: launch_type_verdict
      match_keywords: ['type', 'cold', 'warm', 'hot', 'bindApplication', '类型', '冷启动', '温启动', '热启动', '判定']
      suggestion: '启动场景建议验证启动类型 (cold/warm/hot)：bindApplication 存在→冷启动，仅 performCreate→温启动'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: startup_analysis
        - tool: compare_skill
          skill_id: startup_analysis
    - id: cold_start_slow_reasons
      trigger_keywords: ['cold', '冷启动', 'bindApplication', 'startup_slow_reasons', 'SR09', 'SR10', 'SR20']
      match_keywords: ['startup_slow_reasons', 'slow reason', '官方启动慢原因', 'SR09', 'SR10', 'SR20', 'dex2oat', 'baseline']
      suggestion: '冷启动或 bindApplication 证据出现时，计划必须包含 startup_slow_reasons 交叉验证；若数据不可用，执行阶段标记 skipped 并说明原因'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: startup_slow_reasons
        - tool: compare_skill
          skill_id: startup_slow_reasons
    - id: q4_blocking_chain
      trigger_keywords: ['Q4', 'Sleeping', 'sleeping', '阻塞', 'blocking_chain', 'blocked_functions', 'futex', 'binder']
      match_keywords: ['blocking_chain_analysis', '阻塞链', '唤醒者', 'waker', 'blocked_functions']
      suggestion: '当计划涉及 Q4/Sleeping/阻塞解释时，必须声明 blocking_chain_analysis；若 trace 缺少阻塞信号，执行阶段标记 skipped 并说明'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: blocking_chain_analysis
        - tool: compare_skill
          skill_id: blocking_chain_analysis
---

#### Startup Core Strategy

**Route card**: 启动 / 冷启动 / 热启动 / 温启动 / launch / startup / cold start / warm start / hot start / app start

**Capabilities**: required=[startup, cpu_scheduling], optional=[binder_ipc, lock_contention, gc_memory, disk_io, memory_pressure, thermal_throttling, power_rails, battery_counters]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- startup_timing: 启动场景建议包含启动耗时测量阶段 (startup_analysis)  (required: invoke_skill(startup_analysis) or compare_skill(startup_analysis))
- phase_breakdown: 启动场景建议包含启动阶段分解和阻塞因素分析  (required: invoke_skill(startup_detail) or compare_skill(startup_detail))
- startup_critical_artifacts: 启动详情阶段必须计划获取 startup_detail 的关键 artifact（主线程状态、四象限、热点、关键任务/阻塞关系；缺失时阶段可 skipped+reason）  (required: fetch_artifact)
- launch_type_verdict: 启动场景建议验证启动类型 (cold/warm/hot)：bindApplication 存在→冷启动，仅 performCreate→温启动  (required: invoke_skill(startup_analysis) or compare_skill(startup_analysis))
- cold_start_slow_reasons: 冷启动或 bindApplication 证据出现时，计划必须包含 startup_slow_reasons 交叉验证；若数据不可用，执行阶段标记 skipped 并说明原因  (required: invoke_skill(startup_slow_reasons) or compare_skill(startup_slow_reasons))
- q4_blocking_chain: 当计划涉及 Q4/Sleeping/阻塞解释时，必须声明 blocking_chain_analysis；若 trace 缺少阻塞信号，执行阶段标记 skipped 并说明  (required: invoke_skill(blocking_chain_analysis) or compare_skill(blocking_chain_analysis))

**Phase reminders**
- detail_breakdown: 必须把 Phase 1 的 startup_id/start_ts/end_ts/dur_ms/package/startup_type 原样传给 startup_detail；TTID/TTFD 只能作为可选 ttid_ms/ttfd_ms，不能充当时间边界。使用 self_ms（排除子切片）而非 wall-time。 工具: startup_detail
- critical_artifacts: 此阶段不可跳过。必须获取关键 artifact（热点函数、阻塞调用、锁竞争）作为深钻输入。 工具: execute_sql, fetch_artifact
- slow_reasons_validation: 冷启动必须调用 startup_slow_reasons 检查 DEX2OAT/baseline profile/debuggable 等官方因素。Q4(Sleeping) >25% 必须用 blocking_chain_analysis 追踪阻塞源。 工具: startup_slow_reasons, blocking_chain_analysis
- webview_startup: 仅在架构检测或 trace 证据提示 WebView 时执行。SQL 必须说明正在验证 WebView/Chromium/V8/CrRendererMain 是否参与启动；若未命中 slice，应把 WebView 启动影响标为证据不足或可排除，而不是继续归到综合结论。 工具: execute_sql
- startup_power_overlay: 用户关心启动功耗/耗电时，先检查 Trace 数据完整度中的 power_rails、battery_counters、cpu_freq_idle、gpu_work_period。数据可用才调用 wattson_app_startup_power；缺失时输出采集建议，禁止把空表解释为低功耗。 工具: wattson_app_startup_power, battery_charge_timeline, android_dvfs_counter_stats
- startup_diagnostic_api_boundary: 当计划或用户问题涉及启动诊断 API/外部指标时，必须把 Perfetto startup_analysis/TTID/TTFD、ApplicationStartInfo 记录、App Performance Score/Vitals/APM/A-B 外部数据分层；说明 API/Android 版本、时钟/时间戳对齐、record 是否 incomplete/in-progress、样本/设备/实验窗口，不能把外部分数或聚合直接当成本 trace 根因。 工具: startup_analysis, lookup_knowledge
- conclusion: 输出必须包含：启动类型判定(cold/warm/hot) + TTID/TTFD 数值 + 阶段耗时分解 + 根因编号引用(A1-A18/B1-B12) + 双受众格式([App層]+[系統/平台層])。

**Final report contract summary**
- 启动类型与 TTID/TTFD
- 阶段耗时分解
- 根因编号引用
- App/系统分层建议
- 启动诊断 API/外部指标边界


**Always-inject startup skeleton**
1. 调用 `startup_analysis` 获取 startup_id、TTID/TTFD、重分类后的 cold/warm/hot、主线程热点和数据质量。
2. 调用 `startup_detail` 做阶段分解、四象限、self_ms、线程状态、关键任务和阻塞关系。
3. 对 startup_detail 的关键 artifact 使用 `fetch_artifact` 读取行数据；摘要或 detail 文本不能替代 artifact 证据。
4. 冷启动/bindApplication 命中时补 `startup_slow_reasons`；Q4/Sleeping/blocked_functions 命中时补 `blocking_chain_analysis`。
5. 最终报告必须包含启动类型+TTID/TTFD、阶段耗时/self_ms、根因编号、App/系统分层建议和证据边界。
   根因编号只能来自启动知识库 A1-A18/B1-B12，或本轮工具结果明确返回的 SR09-SR20。禁止为了给自定义/合成负载分类而创建 SR01-SR08 或任何新编号；若合成负载没有精确映射，应明确写“无精确知识库编号”，并同时引用本轮实际命中的有效 SRxx 作为交叉验证而不是主根因。

**Detail refs**
- `startup:overview_timing`: startup_analysis/startup_detail 参数、启动类型、artifact 表。
- `startup:conditional_drills`: 内存压力、功耗、冷启动 slow reasons、Q4 阻塞链、Compose/Flutter/WebView 分支。
- `startup:root_cause_tree`: self_ms、四象限、blocked_functions、TTID/TTFD 边界和根因决策树。


<!-- strategy-detail id="overview_timing" title="启动概览、类型、详情和关键 artifact" keywords="overview,startup_analysis,startup_detail,ttid,ttfd,artifact,fetch_artifact" default="true" -->
#### 启动分析（用户提到 启动、冷启动、热启动、launch、startup）

**⚠️ 核心原则：**
1. **不能只报告"某 slice 耗时 XXms"——必须解释 WHY（为什么慢）**
2. **每个热点 slice 必须交叉分析**：结合四象限、线程状态（含 blocked_functions）、CPU 频率、Binder/IO/GC 数据，构建因果链
3. **四象限 + 线程状态是定位根因的核心工具**，不是独立罗列的数据
4. **区分 wall/self 与实际运行时间**：total_ms 含子切片，self_ms 仅排除已记录子切片；两者均是墙钟时间。按实际窗口裁剪，避免父子重复计数；CPU 归因另需线程状态，收益另需依赖或对照证据。

### 启动类型判定规则

启动类型（cold/warm/hot）决定了分析策略和性能基线，必须在分析初期验证。Perfetto `android_startups` 表的 `startup_type` 可能不准确（尤其是 LMK 回收后的重启），需基于以下信号重分类：

| 类型 | 判定信号 | Android 框架路径 |
|------|---------|-----------------|
| 冷启动 (cold) | `bindApplication` slice 存在 | Zygote fork → ActivityThread.main() → handleBindApplication() |
| 温启动 (warm) | `performCreate:*` 存在且**无** `bindApplication` | handleLaunchActivity() → Activity.onCreate()（跳过 App 初始化）|
| 热启动 (hot) | 两者均不存在 → 保留 Perfetto 原始分类 | Activity.onRestart() → onStart() → onResume() |

**判定逻辑（优先级从高到低）：**
1. 如果 Skill 返回的 `startup_type/type_display` 已经过重分类（`startup_events_in_range` 的 SQL 层重分类，或 `startup_quality.issue_codes` 包含 `R009_TYPE_RECLASSIFIED`），直接信任；除非同一条 SQL 明确复现了 Skill 的 overlap 口径并证明修正信号不存在，否则不得推翻。
2. 否则检查 trace 信号：`bindApplication` 存在 → cold；仅 `performCreate:*` 存在 → warm；均无 → hot
3. 热启动无正向信号（没有专属的 trace slice），仅靠排除法判定——这是合理的，因为热启动不触发 Activity 重建

**⚠️ LMK 边界场景：** 进程被 LMK 回收后重启时，ActivityManager 可能仍持有 Activity 记录，导致 Perfetto 报告 `warm`。但 `bindApplication` slice 存在说明进程经历了完整初始化（Zygote fork → handleBindApplication），实为 cold start。此时**必须以 `bindApplication` 信号为准**，覆盖 Perfetto 原始分类。

**⚠️ 验证口径陷阱：** `bindApplication` 可能早于 `android_startups.ts` 约几十到数百毫秒开始。用 `thread_slice.ts BETWEEN start_ts AND end_ts` 的窄窗口查询返回 0 行，不能证明 `bindApplication` 不存在。若要自行验证，必须使用 `android_startup_threads` 与 `slice` 的 overlap 条件（`sl.ts + sl.dur > st.ts AND sl.ts < st.ts + st.dur`），或至少把起点扩展到 `start_ts - 500ms`。当 `startup_analysis` 已给出 `type_display=冷启动`、`type_reclassified=1`、`startup_breakdown.reason=bind_application` 或 `R009_TYPE_RECLASSIFIED` 时，结论必须按冷启动写，不得输出“R009 误判/维持温启动”。

#### 启动场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_startup_opinionated_breakdown`、`android_garbage_collection_events`、`android_oom_adj_intervals`、`android_screen_state`、`slice_self_dur`、`cpu_process_utilization_in_interval(ts, dur)`、`cpu_frequency_counters`、`android_dvfs_counter_stats`

**Phase 1 — 获取启动概览：**
```
invoke_skill("startup_analysis", { enable_startup_details: false })
```
返回：启动事件列表、延迟归因分析、主线程热点操作（含 self_dur_ms）、文件 IO、Binder 调用、**主线程状态分布（含 blocked_functions）**、GC 事件、数据质量检查、调度延迟。
从结果中提取 startup_id、start_ts、end_ts、dur_ms、package、startup_type 参数。

**⚠️ Phase 1 空结果回退（get_startups 返回 0 行或 android_startups 表不存在时）：**

进程内页面启动（Activity 在已运行进程内打开）、trace 起点晚于进程创建等场景不会产生框架启动事件。此时：

1. **不得伪造** startup_id/TTID/TTFD，也不得把 android_startups 的语义套用到自定窗口；报告写明"框架启动事件未检测到（可能为进程内页面启动或采集未覆盖进程创建）"。
2. 用 `execute_sql` 锚定启动触发点，锚点必须是实际观测到的 slice，不得从包名或猜测的时间点出发：主线程首次进入持续忙碌的转换，如 `receiveMessage(... type=MOTION/KEY)` 输入事件、`activityStart`/`performCreate:*`/`inflate` 首个 slice 簇、首个 `Choreographer#doFrame` 簇。锚点 slice 不存在时不得硬选，改报告窗口无法锚定。
3. 分析窗口写成**推断窗口 [锚点证据, 边界证据]**：边界取首个 doFrame 簇结束、主线程输入/渲染活动沉寂点或用户问题所指区间。窗口起点之前的主线程空闲 sleep 属于启动前等待，不计入启动阻塞（忙/闲分期见根因诊断决策树第 1.5 步）。
4. 后续 Phase 全部使用该推断窗口并保持"推断窗口"口径；TTID/TTFD 写"框架启动指标不可用（无框架启动事件）"。

用户问的是 App 内打开新页面（点击后跳转、Activity 切换）时，该推断窗口按 `interaction:navigation` detail 的分段方法和 `navigation_analysis` 使用边界解释。

⚠️ **数据质量门禁特别注意：**
- **R008_TTID_GT_DUR**（TTID > 启动时长）：不要只说"TTID 不可信"或"建议在 Perfetto UI 中查看"。先从同一 `startup_id` 的 `android_startups.ts` 与 `android_startup_time_to_display.time_to_initial_display` 取得原始整数纳秒，令框架完成点为 `startup.ts + startup.dur`、TTID 绝对终点为 `startup.ts + time_to_initial_display`；仅当 TTID 终点更晚时，分析半开尾窗 `[框架完成点, TTID 终点)`。不要用任意 `DrawFrame` 的开始或结束替代 TTID，也不要用显示用的浮点毫秒反算边界。
  - 对 slice 和 thread state 使用 overlap 条件，并把贡献裁剪到尾窗；`dur = -1` 只裁到 trace bound/尾窗，不得假定真实结束事件。
  - 线程状态按该 startup 的原生 `upid/utid` 分别统计并检查守恒：各互斥状态的裁剪时长之和应等于该线程已覆盖的尾窗时长；`R+` 作为被抢占后的 runnable 状态与 `R` 分开列出但不可重复相加，未覆盖区间必须显式保留。
  - 嵌套 slice 的 wall time 只说明工作在尾窗内共存，父子 slice 不得相加后声称解释了尾窗；短 `DrawFrame` 只证明该已观测 frame 的执行较短，不能排除更早的 RenderThread、GPU、BufferQueue 或 SurfaceFlinger 呈现前条件。
  - 量化结论必须同时写清尾窗长度、每个原生线程的状态覆盖率，以及 slice 是完整总体还是有明确排名与上限的样本；证据不足时保留未解释部分，不强行把全部尾窗归因给若干 slice。
- **R009_TYPE_RECLASSIFIED**（启动类型重分类）：如果温启动存在 bindApplication slice，说明进程实际被重建过，可能是冷启动被误分类。分析时应质疑启动类型并说明重分类依据。
- **温启动 + bindApplication 矛盾**：即使未触发 R009，如果主线程热点中出现 bindApplication（478ms+），也应主动质疑：温启动不应有 Application 初始化开销。可能原因：① 进程被回收后重启（实为冷启动）；② framework atrace 标记不准确。
- **禁止反向误判**：如果 `startup_analysis.get_startups` 显示 `type_display=冷启动`，且 `startup_breakdown` 包含 `bind_application` 耗时，后续任何 raw SQL 只有在使用 overlap/扩展窗口并命中同一进程主线程后，才允许挑战冷启动结论。窄窗口 0 行只能写成“该 SQL 口径未覆盖 bindApplication 起点”，不能写成“bindApplication 不存在”。

**Phase 2 — 获取启动详情（需要传参）：**
```
invoke_skill("startup_detail", {
  startup_id: <从 Phase 1 获取>,
  start_ts: "<启动开始时间戳>",
  end_ts: "<启动结束时间戳>",
  dur_ms: <启动耗时ms>,
  package: "<包名>",
  startup_type: "<cold/warm/hot>"
})
```
返回：四象限分析（Q1-Q4）、CPU 大小核占比、CPU 频率统计、可操作热点 Top5（含 self_ms）、**主线程状态分布（含 blocked_functions）**、**按窗口内裁剪时长选出的热点 Slice 样本及其逐原生 slice/thread 状态分布、覆盖率和采样规模**、**启动关键任务（全线程四象限+摆核）**、**线程等待与观测唤醒关系（并非已证实因果链）**、Binder/IO/调度延迟详情。

**Phase 2.5 — 获取详细数据（必须执行，不可跳过）：**

invoke_skill 返回 artifact 摘要（仅含列名和行数）。**必须用 fetch_artifact 获取以下关键数据的完整行**，否则无法做根因分析。

**必须获取**（startup_detail 稳定产出）：

| artifact | 匹配 stepId / title 关键词 | 用途 |
|---|---|---|
| 主线程状态分布 | `main_thread_state` / "主线程状态" | **Q4 根因定位**：blocked_functions 列 |
| 四象限分析 | `quadrant_analysis` / "四大象限" | 确定时间花在 Q1/Q2/Q3/Q4 哪里 |
| CPU 频率 | `cpu_freq_analysis` / "CPU 频率" | 判断是否升频不足 |
| 逐核系统上下文 | `per_cpu_system_context` | 逐 CPU 频率覆盖、忙碌度和目标运行时间；区分系统背景与目标归因 |
| 抢占交接 | `preemption` | R+ 原始切出及紧接着运行的 task；无交接/优先级/等待记录时保留缺口 |
| 可操作热点 | `actionable_main_thread_slices` / "可操作热点" | 确定优化目标（注意 self_ms 列） |
| 主线程同步 Binder | `main_thread_sync_binder` / "同步 Binder" | Binder 阻塞量化 |
| 主线程文件 IO | `main_thread_file_io` / "文件 IO" | 文件 IO 量化；D/DK 是否为 IO 需结合 `io_wait`/`blocked_function` |
| 调度延迟 | `sched_latency` / "调度延迟" | Q3 根因量化 |

**优先获取**（startup_detail 标记为 optional，可能缺失——缺失时标注"数据不足"，不做排除性结论）：

| artifact | 匹配 stepId / title 关键词 | 用途 |
|---|---|---|
| **热点 Slice 线程状态** | `hot_slice_states` / "热点 Slice 线程状态" | **样本内 per-slice 根因定位**：按裁剪时长排名的每个原生 `slice_id/upid/utid` 内部 Running/S/D 分布、状态覆盖率，以及 `sample_rank/sample_limit/eligible_slice_count/selected_slice_count`；不得外推到同名 slice 的完整总体 |
| **启动关键任务** | `critical_tasks` / "关键任务" | **全线程视角**：所有活跃线程的四象限+摆核+核迁移 |
| **线程阻塞关系** | `thread_blocking_graph` / "阻塞关系" | **线程间因果**：主线程被谁阻塞、唤醒者是谁 |
| Binder 线程池 | `binder_pool` / "Binder 线程池" | 线程池利用率/饱和度 |
| 摆核时序 | `cpu_placement_timeline` / "摆核时序" | 启动初期是否被困小核 |
| CPU 频率爬升 | `freq_rampup` / "频率爬升" | 初期 vs 稳态频率对比 |
| JIT 影响 | `jit_analysis` / "JIT 影响" | 仅冷启动：JIT 编译量、大核竞争 |

**来自 Phase 1（startup_analysis）的数据**（无需再次 fetch，Phase 1 返回时已包含）：

| artifact | 来源 | 用途 |
|---|---|---|
| GC 事件 | `gc_during_startup`（Phase 1 startup_analysis 产出） | GC 影响量化 |

**Phase 2.55 — Critical Task 分析（基于关键任务数据，不可跳过）：**

获取 `critical_tasks` artifact 后，按以下维度分析：

1. **并发运行情况**：`所有线程总CPU时间 / 启动墙钟时间` 表示窗口平均并行运行量。高低都不能单独证明或排除 CPU 争抢；须对齐关键线程 Runnable 区间、逐核忙碌情况及调度交接证据。
2. **JIT 竞争候选**：检查 JIT 运行是否与关键线程调度延迟重合；CPU 时间和大核占比只描述占用。证实启动期编译开销后再评估 Baseline Profile。
3. **RenderThread 诊断**：报告大小核驻留及频率，并关联首帧关键任务；低大核占比不独立证明被困小核或首帧变慢。
4. **摆核诊断**：报告跨 cluster 迁移的时间和次数；缓存失效及其成本需要 PMU 或其他直接证据，不能由迁移次数推定。
5. **GC 线程诊断**：区分后台 CPU 占用、主线程实际 GC 等待和关键路径影响，不能仅凭 CPU 时间阈值确定启动根因。

获取 `thread_blocking_graph` artifact 后，按等待事件分析：

1. 保留等待线程 UTID/UPID、原始与裁剪区间、后继 Runnable 事件及 `wakeup_status`，不同实例不能按同名合并。
2. `waker_thread`/`waker_process` 仅表示该等待结束时观测到的唤醒者；同进程、system_server 或 HeapTaskDaemon 身份均不能证明谁发起等待、为何等待或应承担整段时长。
3. IRQ、后继缺失/歧义、窗口外唤醒及未结束等待保持各自状态，不能补造因果链。`observed_irq` 仅表示中断上下文，不能识别定时器或 nanosleep；短等待时长也不能补足该证据。TopK 等待样本不能代表全部等待或“绝大多数”，除非另有覆盖完整的聚合及明确分母。
4. `waker_current_slice` 仅是唯一活动切片的上下文；需独立 Binder transaction/reply、锁对象/持有者或其他明确依赖事件，才能连接阻塞原因与关键路径。

获取方式（并行）：
```
fetch_artifact("art-N", detail="rows", offset=0, limit=50)  // 对每个关键 artifact
```
**在所有关键 artifact 数据到手之前，不要开始写结论。**

**背景知识指引（结论生成阶段按需调用）：**

在结论生成（Phase 3）阶段，按**根因类型聚合**调用 `lookup_knowledge`，每类根因最多 1 个 📚 知识块（避免重复调用同一模板）。知识块附在对应的 CRITICAL/HIGH 发现之后：

| 根因类型 | 知识模板 | 触发条件 |
|---------|---------|---------|
| **启动根因分类体系** | `lookup_knowledge("startup-root-causes")` | 需要根因编号参考(A1-A18/B1-B12)或交叉因素分析(C1-C4) |
| Binder 阻塞 | `lookup_knowledge("binder-ipc")` | S 状态中 Binder 占比高 |
| 锁竞争 / futex | `lookup_knowledge("lock-contention")` | blocked_functions 含 futex_wait |
| D-state / io_wait / blocked_function | `lookup_knowledge("thread-state-blocked-reason")` | 出现不可中断等待、io_wait 或关键 blocked_function，需要解释 kernel wchan 证据边界 |
| GC 压力 | `lookup_knowledge("gc-dynamics")` | GC 占主线程时间 >5% |
| CPU 调度 / 大小核 / 升频 | `lookup_knowledge("cpu-scheduler")` | Q2>15% 或 CPU 争抢 >1.5x 或升频异常 |
| Thermal 限频 | `lookup_knowledge("thermal-throttling")`；要归因到触发源时 `invoke_skill("cpu_frequency_limit_attribution")` | 均频远低于峰值或检测到限频 |
| DEX/OAT 加载、ART 运行时 | Agent 自行编写背景知识（当前无专用模板） | bindApplication 阶段 IO 为主因 |

📚 知识块展示格式：
```
> 📚 **背景知识：[机制名称]**
> [2-3 句话解释底层机制]
> **当前 trace 体现**：[将机制与 trace 数据关联]
```

每类根因最多 1 个知识块。DEX/OAT 加载是冷启动常见根因但暂无专用知识模板，Agent 应基于自身知识编写 ART OAT/AppImage 加载机制的背景解释。⚠️ **防幻觉约束**：自行编写的知识块只允许解释"通用 ART 机制 + 当前 trace 中可见的 slice 现象"（如 `OpenDexFilesFromOat`、`MapImageFile`、`LZ4 decompress`），**禁止**推断 OAT 编译状态、Baseline Profile 缺失、AppImage 有效性等未被 trace 直接证实的判断——除非同时有 `startup_slow_reasons`/JIT/blocked_functions 等直接证据；数据不足时必须用"可能"/"需进一步确认"限定。
<!-- /strategy-detail -->

<!-- strategy-detail id="conditional_drills" title="启动条件深钻：内存/功耗/冷启动慢因/阻塞链/架构" keywords="memory,power,startup_slow_reasons,blocking_chain_analysis,Compose,Flutter,WebView,Q4" -->
**Phase 2.56 — 内存压力检测（D 状态异常偏高时应执行 ⚠️）：**

**触发条件**（满足任一即执行）：
- D 状态占启动时长 >10%（正常冷启动中 DEX/OAT 文件命中 Page Cache 后 D 状态应很低；>10% 是不可中断等待候选，需结合 `io_wait`、blocked_function、page fault 和内存压力判断是否为 IO/page-cache 问题）
- 存在 kswapd 线程活动（作为后台回收候选，继续检查实际回收事件）

**排除场景**（以下场景即使无内存压力也可能产生高 D 状态，Phase 2.56 仍应执行但结论中需结合 Phase 2.6 的 `startup_slow_reasons` 信号综合判断）：
- `dex2oat` 并发活跃 → OAT 文件正在重新编译（首次安装/升级/Profile 缺失）
- `missing_baseline_profiles` → 可能伴随更重的 DEX/OAT 访问、解释执行或 JIT 活动（需结合 `OpenDexFilesFromOat`/JIT/blocked_functions 再确认）
- 大量 `SyS_fsync`/`do_fsync` → fsync-heavy 初始化（SQLite、SharedPreferences）
- 首次运行的资源/代码准备路径（dynamic feature delivery、split install、资源解包、native 库提取/校验）→ 一次性启动成本
- 低端或老化存储介质、dm-verity/加密开销 → 即使 Page Cache 充足也可能有较高 IO 延迟

⚠️ **时序说明**：Phase 2.56 先于 `startup_slow_reasons`（Phase 2.6）执行，上述排除场景的信号（dex2oat/profile 等）在 Phase 2.56 执行时尚不可用。因此：先执行 `memory_pressure_in_range` 获取内存压力数据，在结论阶段（Phase 3）再与 Phase 2.6 信号联合解读。

```
invoke_skill("memory_pressure_in_range", {
  start_ts: "<启动开始时间戳>",
  end_ts: "<启动结束时间戳>",
  package: "<包名>"
})
```

**观测与归因边界**：

| 返回指标 | 可陈述的观测 | 升级为根因仍需的证据 |
|---------|-------------|------------------|
| pressure_level / pressure_score | 工具在当前窗口的启发式评分 | 评分不是目标线程的等待归因；需定位回收、缺页或 IO 与关键路径的具体交集 |
| kswapd_events / kswapd_total_ms | 后台回收相关活动 | 不能直接证明目标文件页被回收、缓存未命中或因此读盘 |
| direct_reclaim_events > 0 | 观测到直接回收事件 | 核实事件的进程/线程身份、时间区间和调用上下文，不能自动归到目标主线程或全部 D 状态 |
| lmk_events > 0 | 观测到低内存杀进程事件 | 区分受害进程、事件时间与本次启动依赖，不能仅据计数断言启动受损 |
| page_cache_add_events / page_cache_delete_events | 观测到文件页加入/移出缓存事件 | 加入不等于已发生物理读盘，移出不单独证明内存压力回收；需关联文件页、缺页/块 IO、回收原因与目标等待 |

**对根因结论的影响**：

- 高评分或多个回收信号只构成系统侧候选。结论列出真实指标及区间，再说明是否存在目标线程、文件页、缺页或块 IO 的关联证据；缺少关联时明确“已观测系统回收活动，尚不能量化其对启动的影响”。
- 只有同一区间、同一目标身份的直接回收/等待或文件 IO 因果链得到证据支持，才陈述对应片段的影响。不能套用“内存压力显著放大 IO”作为评分的固定结论，也不能把 moderate 评分当作“不是主因”的证明。
- 低评分与 direct_reclaim/LMK 并存时，保留两者，不让平均分覆盖短时事件；继续核实具体区间和目标关联。
- 空结果、低评分或没有 reclaim/LMK，只说明当前采集、窗口和查询口径下未观测到相关证据。先检查事件采集能力；不能直接写“可排除系统内存压力”或把 D 状态归给其他原因。
- 如建议在较低内存负载下复测，应说明这是验证候选的对照实验，保持启动类型、缓存状态和应用版本等条件可比，不预设一定收益。

**Phase 2.57 — 启动期功耗 Overlay（仅当用户关心启动耗电/功耗时执行）：**

先检查系统提示中的 Trace 数据完整度：
- `power_rails` + `cpu_freq_idle` 可用 → 可以做 Wattson 启动窗口能耗归因
- `battery_counters` 可用 → 可以看启动前后电池采样趋势
- 任一关键 capability 缺失 → 结论中加“数据采集建议”，不要把空表当成“启动不耗电”

```
invoke_skill("wattson_app_startup_power", { package: "<包名>" })
invoke_skill("battery_charge_timeline", {
  start_ts: "<启动开始时间戳>",
  end_ts: "<启动结束时间戳>"
})
```

交叉验证：
- 若启动窗口能耗高，再调用 `app_process_starts_summary` 判断是否有进程反复拉起
- 若 DVFS/温控相关，再调用 `thermal_throttling`；要判定“谁限的频、限频前跑了什么”用 `invoke_skill("cpu_frequency_limit_attribution")`（`android_dvfs_counter_stats` 只覆盖 Pixel/Tensor 的 counter 命名，其他平台通常为空）
- 若 GPU 首帧渲染占比高且 `gpu_work_period` 可用，再调用 `android_gpu_work_period_track`

输出必须标明可信度：Wattson 量化归因 / 电池采样趋势 / 数据不足。

**冷启动专项诊断（冷启动必须执行 ⚠️）：**

以下检查按冷启动问题范围适用；结果应区分已观测贡献、未覆盖与已证伪的候选：

1. **JIT 编译影响**：获取 `jit_analysis` artifact，分析 JIT 编译量、是否与主线程争抢大核（大核占比 > 50% 且 CPU 时间 > 20ms → 建议 Baseline Profile）、Code Cache GC 影响。数据为空时注明本次口径未观测到；仅在覆盖充分且关键路径关联被排除时才能限定范围排除 JIT
2. **类加载影响**：检查 Phase 1 返回的 `class_loading` 数据，分析类加载/类验证（`OpenDexFilesFromOat`）耗时占 bindApplication 阶段的比例。冷启动的 DEX 加载和类验证是特有开销
3. **结论中必须提及**：JIT 和类加载的影响评估结果，作为冷启动特有的排除/确认因素

**Phase 2.6 — 启动慢原因检测与交叉验证（冷启动必须执行 ⚠️）：**
```
invoke_skill("startup_slow_reasons")
```
检测 20 种已知启动慢原因（SR01-SR20），与自有分析交叉验证。

**SR 分类概览**（v3.0）：

| 分类 | SR Codes | 检测内容 |
|------|----------|---------|
| App 层基础 | SR01-SR08 | JIT/DEX2OAT/GC/锁/IO/Binder/广播/类验证 |
| App 层扩展 | SR09-SR15 | ContentProvider 过多/SP 阻塞/显式 sleep/SDK 初始化/Native 库/.so/WebView/Inflate |
| 系统层 | SR16-SR20 | 热节流/后台干扰/system_server 锁/并发启动/数据库 fsync |

**解读指引**：
- **SR09(ContentProvider过多)**: 结合 A1 根因，检查每个 CP 的包名是否为三方 SDK。仅冷启动有意义（需有 bindApplication slice）
- **SR10(futex等待) 与 SR04(锁竞争) 的去重**：两者可能同时命中同一把锁（SR04 靠 Lock contention slice，SR10 靠 blocked_function）。**优先级规则**：若 SR04 已命中且 futex 时间落在同一窗口 → SR10 作为补充证据归入同一发现，不单列独立根因。SR10 独立报告的条件：SR04 未命中（无 Lock contention slice，如 SharedPreferences awaitLoadedLocked）
- **SR11(nanosleep 路径等待)**：不能据此区分 Java Thread.sleep、SystemClock.sleep 或 native nanosleep。先关联本次等待的具体调用，再定位代码；源码中存在 sleep 分支本身不是本次命中证明。
- **SR12(非框架初始化工作)**：非框架占比不能识别三方 SDK；需源码/符号证明身份，模拟负载保持模拟负载，不能套用 SDK 根因。
- **SR13-SR14(Native库/WebView)**: 冷启动特有，受 page cache(B3) 影响大
- **SR15(inflate 命名活动)**：按区间分解 Running 与等待；是否真实 XML inflate、反射模拟或其他行为，需要实际实现/事件证据。
- **SR16(热节流)**: 系统因素(B4)，对比设备冷却后重测
- **SR17(后台干扰)**: Runnable 表示等待 CPU；核对 R+ 切出、同 CPU 直接交接和关键路径时间后再评估后台竞争(B9)，比例本身不能证明抢占。
- **SR18(system_server锁)**: 间接影响 Binder 延迟(B6→B7)
- **SR19(并发启动)**: Boot storm 场景(B12)，放大所有系统层问题
- **SR20(fsync/数据库)**: 数据库初始化(A8)或 SP commit 在主线程

**⚠️ 冷启动时此步骤为必须，跳过将触发验证警告。** 即使是测试/基准应用，也应执行此步骤——SR 检测可发现自有分析未覆盖的系统因素。

**Phase 2.7 — 阻塞链深钻（Q4>25% 或忙期内主线程 S/D 等待 ≥10ms 未归因时必须执行 ⚠️）：**

触发条件（满足其一即为必须）：
- 四象限 Q4(Sleeping) > 25%；
- 启动忙期内（忙/闲分期见根因诊断决策树第 1.5 步）主线程任一 S/D 等待段 ≥10ms 且尚无唤醒者归因。忙期内主线程消息队列通常饱和，几十毫秒的等待也要逐段归因，不能只靠 Q4 聚合占比决定是否深钻。

不能仅依赖间接推断（如"推测为 join/await 模式"）来解释 S 状态根因；基于间接推断的发现在结论中可信度会被自动降低。

数据分工：
- startup_detail 的 `thread_blocking_graph` artifact 已含每个等待区间的 `waker_thread/waker_process/waker_current_slice` 与 `wakeup_status`，**优先直接使用**；
- `blocking_chain_analysis` 用于热点 slice 子窗口的下钻，或在 thread_blocking_graph 不可用时按窗口聚合唤醒者（`waker_chain` 从等待结束后的第一个 R/R+ 行解析唤醒者；等待行自身的 waker_utid 与 blocked_function 为空是正常采集形态，不代表没有等待或没有唤醒者）；
- 直接唤醒者往往只是接力：真正执行工作的线程在链上游。忙期等待 ≥10ms 必须看 `wakeup_chain_trace` 的**多跳唤醒链**——沿"唤醒者的上一次被唤醒"上溯（只计本等待窗口内的唤醒），报告每跳线程（hop 1=直接唤醒者）、每跳此前的等待时长、在等待窗口内的运行时长，并识别链的根部（`end_root_before_window`=等待开始前已在运行的线程；`end_no_waker`=中断/定时器等无观测唤醒者；`end_depth_cap`=跳数上限，常见于 binder 线程互相唤醒的循环）。链是观测到的接力顺序，不是已证实的因果链；窗口内运行但不在链上的线程只是共存候选。
- 覆盖边界：`wakeup_chain_trace` 默认只追踪窗口内**最长的 8 段**等待（`top_waits`），忙期等待超过 8 段时，用热点 slice 子窗口分批调用或调大 `top_waits`/`min_wait_ms` 参数后重跑；报告中必须写明已覆盖与未覆盖的等待数量，不得把"top 8 里没出现"当成"不存在"。

blocked_functions 为空时，唤醒链（waker + 唤醒时刻 slice）是等待侧的直接证据；但唤醒者身份仍只是起点——需要独立的 Binder transaction/reply、锁对象/持有者等依赖证据才能断言因果（见 Phase 2.55 的因果边界）。

链上数字的读法：当 `wait_ms` 明显大于链上各跳 `run_ms_in_wait` 之和时，剩余时间要看直接唤醒者**自身的状态分布**（如 worker 长 D 态/长 S 态后再唤醒主线程——等待发生在 worker 侧而非链的接力上），用 execute_sql 查该线程同区间状态后再下结论；不要把剩余量默认当成"无事发生"。

waker 为 `swapper`（idle task）或唤醒事件来自 `<idle>` 上下文时，表示该唤醒由 idle CPU 上的定时器/中断路径发出或无具名发出者（也见于只采 sched_switch、sched_waking 归属不完整的 trace）：链在 hop1 终止是正确行为，不得编造上游线程；此时改从等待窗口内各线程的运行分布与直接唤醒者前序状态入手归因。

对 `hot_slice_states` 中 S(Sleeping) 占比 >40% 的热点 slice，追踪阻塞链：
```
invoke_skill("blocking_chain_analysis", { start_ts: "<slice_start>", end_ts: "<slice_end>", process_name: "<包名>" })
```
- 找出谁阻塞了主线程、唤醒者是谁、唤醒者在做什么
- 如果 blocked_function 含 binder，进一步调用 `binder_root_cause` 定位服务端原因
- 用 `lookup_knowledge` 获取相关机制解释（如锁竞争、Binder IPC）

**Phase 2.75 — 首帧后可交互性检查（TTFD 存在或 dur > 2s 时执行）：**

首帧显示（TTID）后，App 可能仍在执行异步数据加载、首屏动画、权限检查等操作，导致"看到了但用不了"。

```sql
SELECT name AS slice_name, dur / 1e6 AS dur_ms, thread_name
FROM thread_slice
WHERE ('{process_name}' = '' OR process_name = '{process_name}' OR process_name GLOB '{process_name}:*')
  AND (is_main_thread = 1 OR thread_name = 'RenderThread')
  AND ts BETWEEN {end_ts} AND {end_ts} + 500000000
  AND dur > 5000000
ORDER BY dur DESC LIMIT 15
```

关注：网络请求回调、数据库查询、图片异步加载完成后的 UI 刷新、权限弹窗阻塞。

**Phase 2.8 — Compose 启动特有分析（当架构检测为 Compose 时）：**

注意：Compose 应用的启动 hotspot 分布与传统 View 应用不同：
- 传统 View: `inflate` → XML 解析 + 反射创建 View → 主要瓶颈在 LayoutInflater
- Compose: 没有 inflate，改为 `Recomposition` + `Compose:` 系列 slice → 主要瓶颈在 composition 函数执行
- Compose + View 混合: 同时存在 inflate 和 Recomposition slice

**Compose 启动 hotspot 检查：**
```
execute_sql("SELECT name AS slice_name, dur / 1e6 AS dur_ms, thread_name FROM thread_slice WHERE process_name GLOB '<package>*' AND is_main_thread = 1 AND ts >= <startup_ts> AND ts < <startup_end_ts> AND (name GLOB 'Compose:*' OR name GLOB 'Recompos*' OR name GLOB '*CompositionLocal*' OR name GLOB '*LazyList*') ORDER BY dur DESC LIMIT 20")
```

- 如果存在大量 `Recomposition` slice → 检查是否有不必要的重组（state reads 过多）
- 如果 `Compose:*` slice 总耗时 > 启动总时长的 30% → Compose composition 是瓶颈
- 如果同时存在 `inflate` 和 `Compose:*` → 混合应用，分别分析两部分的耗时占比

**Phase 2.9 — Flutter 启动特殊处理（当架构检测为 Flutter 时）：**

Flutter 冷启动包含独特的双线程初始化模型：
- **主线程 (Android)**：正常的 Application/Activity 生命周期 + Flutter 引擎初始化（`FlutterEngine.create`、native library 加载）
- **1.ui 线程 (Dart)**：Dart VM 初始化 + Framework warm-up + 首次 `Framework::BeginFrame`

**关键 Slice：**
- `flutter::Shell::OnPlatformViewCreated` — Flutter 引擎与平台视图绑定完成
- `Framework::BeginFrame`（首次出现）— Dart 框架开始渲染第一帧，是 Flutter 层面的 TTID
- `DartIsolate::CreateRunningRootIsolate` — Dart VM isolate 创建
- `Engine::Run` — Dart 代码开始执行

**分析要点：**
1. Flutter 冷启动 = Android 启动耗时 + Flutter 引擎初始化 + Dart 首帧渲染
2. 如果 `bindApplication` 到第一个 `Framework::BeginFrame` 之间有较大 gap，检查 native library 加载耗时
3. 主线程阻塞分析仍适用于 Android 层面；Dart 层面的瓶颈需检查 1.ui 线程的 slice

```
execute_sql("SELECT name AS slice_name, dur / 1e6 AS dur_ms, thread_name, track_id FROM thread_slice WHERE thread_name IN ('1.ui', '1.raster') AND ts >= <startup_ts> AND ts < <startup_end_ts> AND (name GLOB '*Framework*BeginFrame*' OR name GLOB '*Shell*' OR name GLOB '*Engine*Run*' OR name GLOB '*DartIsolate*') ORDER BY ts LIMIT 20")
```

**Phase 2.10 — WebView 启动特殊处理（当架构检测为 WebView 时）：**

WebView 冷启动包含 Chromium 渲染引擎的初始化：
- **主线程 (Android)**：Activity 生命周期 + WebView 初始化（`WebViewChromium.init`）
- **CrRendererMain 线程**：V8 引擎初始化、DOM 解析、CSS 布局、JavaScript 执行

**关键 Slice：**
- `WebViewChromium.init` — WebView 组件初始化入口
- `v8.compile` / `v8.run` — V8 引擎编译和执行 JavaScript
- `CrRendererMain` 线程首个 slice — Chromium 渲染进程开始工作
- `ParseHTML` / `Layout` — DOM 解析和 CSS 布局

**分析要点：**
1. WebView 冷启动 = Android Activity 启动 + WebView/Chromium 初始化 + 页面加载渲染
2. `WebViewChromium.init` 在 Android 主线程执行，可能占据数百毫秒（首次加载 Chromium 库）
3. 页面渲染瓶颈在 CrRendererMain 线程：V8 GC、大量 DOM 节点、CSS Layout Thrashing
4. 网络请求耗时通常不在 trace 中体现，需结合 TTFD 分析

```
execute_sql("SELECT name AS slice_name, dur / 1e6 AS dur_ms, thread_name FROM thread_slice WHERE process_name GLOB '<package>*' AND ts >= <startup_ts> AND ts < <startup_end_ts> AND (name GLOB '*WebViewChromium*' OR name GLOB '*v8.*' OR thread_name = 'CrRendererMain' OR name GLOB '*ParseHTML*' OR name GLOB '*Layout*' OR name GLOB '*DrawGL*' OR name GLOB '*WebView*') ORDER BY dur DESC LIMIT 20")
```

**Phase 3 — 综合结论（基于根因诊断决策树）：**

结论应完整回答当前问题：呈现相关指标、根因推理、系统证据和建议，或逐项解释证据缺口。完整场景调查覆盖所有适用维度；局部追问不扩展成全场景报告。下文组织形式是示例，不能因省略固定标题或表格而判断回答不完整，也不能以简洁为由删掉关键推理。
<!-- /strategy-detail -->

<!-- strategy-detail id="root_cause_tree" title="启动根因诊断决策树与最终报告结构" keywords="root cause,根因,self_ms,blocked_functions,phase breakdown,结论" -->
### 预检查：识别测试/基准应用

在开始根因分析前，检查热点 slice 名称是否包含测试/基准特征模式：
- 常见关键词：`Benchmark`、`StressTest`、`TestRunner`、`Mock`、`Synthetic`、`Dummy`
- 特征：slice 名称中含有 `Simulator`、`Fake`、`Test` 前缀/后缀，或非标准 AOSP 框架 slice 占据大量启动时间

如果检测到这些特征：
- 名称只能提示测试负载候选；只有读到相应实现或明确的配置/采集来源后，才在概览标注测试/基准应用。不得从“模拟”名称推断模拟了什么操作
- 不要给出通用的"检查 synchronized 块"/"使用 AsyncLayoutInflater"等优化建议（对测试 App 无意义）
- 改为描述模拟负载的性能特征，帮助用户理解测试 App 的行为
- 如果用户的目标是验证测试框架本身，可以分析模拟负载是否符合预期

### Slice 嵌套感知（⚠️ 关键）

主线程热点 slice 数据包含两组指标：
- **total_ms / percent_of_startup**（wall time）：包含所有子 slice 的时间，**父子会重叠**
- **self_ms / self_percent**（exclusive time）：仅自身独占时间，**不含子 slice，不会重叠**

**必须遵循的规则：**
1. **self_ms 仅是去除子 slice 的 exclusive wall time**，仍可能包含 Running、等待和未埋点操作。它用于避免重复计数，不自动证明 CPU 成本、根因或可消除耗时。容器 self 很少也不能排除其内部调用顺序、依赖或同步方式的问题。
2. **根因分析树中，嵌套 slice 必须体现父子关系**：
   - ✅ 正确：`activityStart (832ms wall) → performCreate (827ms) → inflate (710ms)`
   - ❌ 错误：将 activityStart (62%)、performCreate (61%)、inflate (53%) 作为独立根因并列
3. **优化收益须有依赖关系、可消除工作或对照实验支持**。不能直接把 self_ms 或互不重叠 self 总量称为“可回收时间”“收益上限”；未知时只报告观测成本和待验证方向，也不能把父子 wall time 相加。
4. **检查切片嵌套及埋点覆盖**：self_ms ≈ total_ms 只能说明记录到的子切片占时很少，不代表内部没有其他工作；逐事件状态和实现证据决定如何归因。`bindApplication`、`activityStart`、`performCreate:*`、`activityResume`（及 trace 中存在的 `clientTransactionExecuted` 等事务包裹）是框架容器：其名称只说明所处阶段，不能作为最终根因或"直接原因"。沿子 slice 下钻到 App 可归属的具体工作（某个 ContentProvider、SDK 初始化、inflate、数据加载）；子 slice 缺失时，归因写成"该容器内 App 初始化（埋点未细分）"，给出该区间的运行/等待分解并说明埋点缺口，不根据名称虚构内部工作。

### 启动阶段划分（必须覆盖）

Android 启动有两个串行大阶段，**分析结论必须覆盖两个阶段**，不能遗漏：

1. **bindApplication 阶段**（Application.onCreate / ContentProvider.onCreate）
   - 典型 slice：`bindApplication`、`app.onCreate`、`contentProviderCreate`、`OpenDexFilesFromOat`
   - 冷启动特有；温启动出现 bindApplication 说明启动类型可能被误判

2. **activityStart 阶段**（Activity.onCreate / onStart / onResume → 首帧）
   - 典型 slice：`activityStart`、`performCreate:*`、`inflate`、`Choreographer#doFrame`

阶段嵌套 self time 只排除子切片，不等于 CPU 执行时间。其总和与启动时长接近或相差较大，均不能证明串行执行或非主线程原因；必须按真实事件顺序、状态及依赖解释剩余区间。

### 根因诊断决策树

**第一步：看四象限分布，确定主线程时间花在哪里**

| 四象限 | 占比 | 含义 | 下一步 |
|--------|------|------|--------|
| Q1 大核运行 高 | >50% | 观测到较多大核执行时间 | → 对齐热点任务、频率和关键路径，判断执行成本 |
| Q2 小核运行 高 | >15% | 观测到较多小核执行时间，尚不能判断供给不足 | → 检查拓扑来源、频率、优先级和关键任务的实际时限 |
| Q3 Runnable 高 | >5% | 可运行但尚未获得 CPU；原因未定 | → 区分 R/R+，看局部调度延迟、直接交接及逐核负载 |
| Q4 Sleeping 高 | >25% | 观测到较多睡眠/等待时间；具体原因未定 | → 结合 blocked_functions、Binder/锁/唤醒链及任务范围定位 |

这些比例是排查提示，不是异常或因果判据。Q4a 的 D/DK 与 Q4b 的 S/I 应分别解释；无独立证据时保留等待原因未知。

**第 1.5 步：忙/闲分期——同一段 S 的含义取决于所处分期，先分期再归因，禁止跨期混算占比**

- **忙期**：启动锚点（框架启动事件或推断窗口锚点）到框架完成/首帧的关键路径区间，以及其后主线程仍在连续处理 doFrame/输入消息的子区间。忙期内主线程消息队列通常饱和，任一 S/D 段 ≥10ms 都必须给出**唤醒链**归因，不止于直接唤醒者：直接唤醒者可能只是接力，需沿链上溯到根部线程（如"worker 线程跑完后经 2-3 个中间线程把主线程唤醒"，或"多个线程在等待窗口内各跑一段"），报告链上每跳线程的等待与运行贡献（`thread_blocking_graph` 的直接唤醒者 + `blocking_chain_analysis` 的 `wakeup_chain_trace` 多跳链）。等待数量多时按时长排序覆盖，无法覆盖的写明数量。没有唤醒链数据时如实写"唤醒者未观测"，不得默认无害。
- **闲期**：忙期之外、主线程等待下一个输入/消息的区间。被 `InputDispatcher` 唤醒且唤醒时刻 slice 为 `sendMessage(... type=MOTION/KEY)` 的长 S，归类为**等待输入的空闲**，不计入启动阻塞总量；该分类必须引用唤醒证据，不能凭时长或位置断言，也不得据此声称"启动已完成/消息队列为空"。被定时器或采样器（如 `traced_perf`）戳醒后随即回睡、无其他唤醒者的长 S，同样按闲期证据处理，只描述观测到的唤醒来源。
- 报告必须写明忙期边界与各期内 S/D 总量；跨忙闲边界的长 sleep 按重叠区间拆分说明，不得整段计入某一期。

**第二步：当 Q4 占比高时，用线程状态 + blocked_functions 定位阻塞根因**

主线程状态分布数据包含 state（Running/S/D/R）和 **blocked_functions** 列。下面是排查候选，blocked_function 是内核等待位置，不是完整调用栈；需要结合任务范围和实际事件验证具体机制：

| 线程状态 | blocked_functions 特征 | 根因类型 | 典型场景 |
|---------|----------------------|---------|---------|
| S (Sleeping) | `futex_wait_queue` / `futex_wait` | **futex 等待候选** | 结合锁竞争或唤醒事件确认对象、持有者和实际等待关系 |
| S (Sleeping) | `binder_ioctl` / `binder_ioctl_write_read` | **Binder 路径等待候选** | 同步客户端等待需具体 transaction/reply、对端身份及区间证据 |
| S (Sleeping) | `binder_wait_for_work` | **Binder 线程池空闲等待** | 正常行为。注意：如果在主线程看到此函数，说明主线程异常充当了 Binder 服务端 |
| S (Sleeping) | `do_epoll_wait` / `ep_poll` | **等待事件** | 不能据此认定消息队列为空、启动已结束或等待没有影响 |
| S (Sleeping) | `pipe_wait` / `pipe_read` | **管道等待** | 等待子线程/进程通信 |
| S (Sleeping) | `SyS_nanosleep` / `hrtimer_nanosleep` | **nanosleep 路径等待** | 尚不能定位到 Java/框架/native API；需调用栈或对应事件 |
| S (Sleeping) | `do_wait` / `wait_consider_task` | **等待子进程** | fork 后等待 |
| D (Uninterruptible sleep) + `io_wait=1` | `io_schedule` / `blkdev_issue_flush` | **IO wait 直接证据** | 文件读写、数据库操作、存储队列等待 |
| D (Uninterruptible sleep) | `SyS_fsync` / `do_fsync` | **fsync 候选** | SQLite WAL checkpoint、SharedPreferences commit；需结合 DB/SP/file slice |
| D (Uninterruptible sleep) | `filemap_read` / `filemap_fault` / `do_page_fault` | **页缓存/页缺失候选** | 内存映射文件首次访问、dex/so/resource 加载；需结合 page fault / block I/O / 内存压力 |

⚠️ **D 状态高占比时应排查系统内存压力** → 满足触发条件时执行 **Phase 2.56（内存压力检测）**，触发条件和排除场景详见 Phase 2.56 定义。

**第 2.5 步：当主线程状态分布的 blocked_functions 为空或 "-" 时**

某些 trace 的 `blocked_functions` 列为空（未采 `sched/sched_blocked_reason`、设备 tracepoint 不可用、符号化缺失，或内核配置不支持）。此时：

1. **优先使用 hot_slice_states 数据**（已包含在 startup_detail 的返回结果中，Phase 2.5 fetch_artifact 时获取）。
   即使全局 blocked_functions 为空，per-slice 的线程状态分布（Running/S/D 各自占比）仍然有效，可以区分该 slice 的运行与等待构成，但不能仅靠状态确定计算类型或阻塞原因。

2. **提出候选并查证依赖**（blocked_functions 为空时）：
   - 同期存在 Binder/GC/IO 或源码 sleep 分支，只能作为候选；缺少同一线程、同一等待区间的关联时，等待来源保持未知。
   - Binder 总量、GC 总量、源码循环次数/随机概率算出的理论睡眠时长，即使与 S 时长接近，也不能证明本次等待来自该机制。
   - 需要具体 transaction/reply、GC pause/锁依赖、带时间戳的调用栈/marker、nanosleep 等事件，把候选与该等待区间连接。单个样本不能外推全部 S。
   - 原因必须明确写成“待验证/无法确认”，不能先断言根因，再用“间接推断”尾注掩盖确定性表达。

3. **在优化建议中**：建议用户后续抓 trace 时包含 `ftrace_events: "sched/sched_blocked_reason"`；如设备不产出 blocked_function，再检查 tracepoint 可用性、符号化和内核能力。需要完整 off-CPU 栈时使用 `linux.perf` 对 `sched_switch`/`sched_waking` 做目标线程过滤采样。

**第三步：用热点 Slice 线程状态（hot_slice_states）做 per-slice 根因定位**

`hot_slice_states` 返回每个热点 slice 内部的线程状态分解（Running/S/D/R 各自的耗时和 blocked_functions）。
**这是区分该 slice 执行与等待构成的直接观察**，仍不独立证明具体等待原因。

使用方式：
- 如果 `app.onCreate` 的 hot_slice_states 显示 S=400ms + blocked_functions=`futex_wait_queue`
  → **观测**：该 slice 内有 S 状态且出现 futex 路径；不能把整个 400ms 都归给锁竞争，需区分条件变量/join 等并关联锁对象/持有者
- 如果 `inflate` 的 hot_slice_states 显示 Running=300ms + S=150ms + blocked_functions 为空
  → 结论：部分 CPU-bound + 部分阻塞，blocked_functions 为空则需结合上下文推断阻塞原因
- 如果 `contentProviderCreate` 的 hot_slice_states 显示 D=30ms + blocked_functions=`io_schedule`
  → **候选**：ContentProvider 初始化中存在 IO/page-cache 等待；是否为 SQLite/SharedPreferences/Provider 业务根因还要补 DB/SP/Provider slice 或 stack 证据

⚠️ **重要：slice 的 wall time ≠ 线程状态时间的直接对比**
slice 的 wall time（如 inflate 479ms）包含 Running + S + D + R 所有状态。
不能直接用 slice wall time 与全区间的 S 状态总量做数值对比来推断因果关系。
必须用 `hot_slice_states` 的 per-slice 线程状态数据来确认具体比例。

如果 hot_slice_states 为空或不可用，保留候选与待查证关系（见第 2.5 步），不能将未知原因改写为确定根因。

**第四步：评估频率观察与关键任务的关系**
- 分 CPU/ucpu、同窗口比较实际频率与覆盖率；初期/后段必须裁剪跨界样本，缺数据和不存在的后段窗口不能填 0 或称“正常”。
- 观测频率排名不能证明大小核；只有可信容量/拓扑证据才能分类，缺失或跨设备身份不明确时保持 unknown。
- 初期频率比后段低、均频比观测峰值低都只是差异；调频请求、硬件/策略限制、频率响应以及任务时间关联才可能支持升频延迟/限频的解释。
- 高 Running、运行在已知大核或观测高频均不能证明“纯计算量问题”，也不能排除其他时段的等待和系统影响。Running 中也可能有访存停顿，不能仅凭调度状态细分执行成本。

**第五步：逐项核对其他因素的贡献与覆盖**
- **Binder**：量化同一主线程、同区间同步事务及与关键路径重叠的等待。小总量或空结果只说明本口径内的观测，不证明全启动可排除。
- **Binder 线程池**：线程数量/利用率不是请求排队或容量不足证明，需排队、等待与服务线程执行证据。
- **GC**：区分后台运行、主线程暂停和锁依赖。后台 CPU 时间既不自动证明竞争，也不证明不影响主线程；GC cause 需要暂停/依赖关联。
- **类加载/Inflation**：名称识别的是操作候选，CPU/等待构成必须按具体区间测量；模拟标记不能代替源码实现。
- **调度**：报告 R/R+ 时长、分布、边界与覆盖；严重延迟不独立证明负载原因。只有相应机制被充分覆盖并证伪，才能在明确范围内排除。

**第六步：TTID / TTFD 分析与分析边界确认**

TTID 和 TTFD 是两个不同的指标，必须区分：
- **TTID（Time To Initial Display）**：使用 Perfetto 启动显示指标及其生产者定义；不能把任意首次 DrawFrame 结束直接当作物理显示完成。对应 `android_startup_time_to_display` 的 `time_to_initial_display` 字段。**不依赖** `reportFullyDrawn()`
- **TTFD（Time To Full Display）**：完全显示时间，**需要**应用主动调用 `reportFullyDrawn()` 才有数据。对应 `time_to_full_display` 字段
- **业务可用/可交互时间**：如果 App 有自定义业务 ready、首个可交互、首页数据加载完成或线上 APM TTFD 口径，必须标成外部/业务上下文。除非 trace 中有同名 marker 或可对齐的日志/快照，否则不能把它当作 `android_startup_time_to_display` 的直接证据。
- **外部评分/Vitals 边界**：App Performance Score、Macrobenchmark、Android Vitals 或线上 APM 可以作为启动质量背景和下一步验证方向；当前 Perfetto trace 只能证明本次采集窗口内的启动链路，不能直接证明 28 天 Vitals 状态或评分项合规。
- **ApplicationStartInfo / 外部观测边界**：当用户提供或询问 `ApplicationStartInfo`、App Performance Score、Vitals、APM 或 A/B 时，必须说明这是 `diagnostic_api`、`external_aggregate` 或 `experiment_or_ab` 证据。ApplicationStartInfo 记录需要核对 API/Android 版本、startup state、start type/reason/component、timestamp clock 和当前 Perfetto 窗口是否对齐；App Performance Score/Vitals/APM/A-B 需要核对设备、样本窗口、版本/渠道、activation 和 A/A sanity。需要机制背景时调用：
  ```
  lookup_knowledge("observability-diagnostics")
  ```

**分析边界（analysis window）说明**：
- `android_startups` 表的 `dur`（= `end_ts - start_ts`）是框架层启动时长，通常表示框架认定的 startup completion，可近似首帧显示边界
- 注意：`dur` 与 TTID 在部分 trace 上并不严格等价（文档前面的 `R008_TTID_GT_DUR` 数据质量检查即为此设计）。当数据质量检查触发 R008 时，需单独核验 `dur` 与 TTID 的偏差原因
- 即使 `ttid_ms` 字段为 NULL，`dur_ms` 仍然定义了有效的分析窗口，分析的全部内容（Phase 1 到 Phase 3）都基于 `start_ts` 到 `end_ts` 范围
- **Launch trampoline（SDK 33+）**：`trampoline_ms > 0` 表示同一启动区间先启动了另一个 Activity/包（trampoline），再跳转到目标包；`dur_ms` 包含这段跳转，`dur_without_trampoline_ms` 才是目标包自身 `launching:` 区间的时长。trampoline 段属于发起跳转的入口，不得计入目标 App 的阶段分解、根因或优化收益；报告须同时列出两个时长，并注明 `rating` 仍按含 trampoline 的 `dur_ms` 评定。

**诊断逻辑**：
- `ttid_ms` 存在 → 报告中显示 TTID 值
- `ttid_ms` 为 NULL → 报告中说明："TTID 数据点不可用（可能原因：DrawFrame slice 未被独立捕获、trace 配置缺失、Perfetto 版本差异等），分析窗口基于 android_startups.dur = XXms"。**不要**说"TTID 不可用因为未调用 reportFullyDrawn"——这是错误的，TTID 与 reportFullyDrawn 无关
- `ttfd_ms` 存在且 > `ttid_ms`（或 > `dur_ms`）→ 上报的完全显示点晚于初始显示点；具体工作/上报策略仍需证据，不能直接归为异步加载。前面所有 Phase 的查询边界固定在 `start_ts ~ end_ts`，不覆盖首帧之后的时间段。分析 TTID→TTFD 时，从同一 `startup_id` 的原始整数纳秒构造 TTID 与 TTFD 绝对终点，只分析半开区间 `[TTID 终点, TTFD 终点)`；若 TTID 不可用而改看框架完成点→TTFD，必须把它明确命名为另一口径，不能混称 TTID→TTFD。追加查询必须绑定该 startup 的原生 `upid/utid`，对 slice/state 使用 overlap 后裁剪到窗口，处理 `dur = -1` 并报告覆盖率；完整 raw duration、包名 glob 或线程名不能替代这些身份与边界。网络、数据库、图片加载或 WebView 活动只能先作为窗口内共存候选，仍需依赖证据才能归因。如果无法追加查询，结论中应降级为"确认存在显示点之后的延迟，但该时段未完成有身份约束的裁剪分析"。
- `ttfd_ms` 为 NULL → 报告中说明："本次未观测到 TTFD；调用是否发生尚未确认，可能与采集范围、解析支持或调用缺失有关"（分析范围已在 TTID 分支中说明，此处无需重复）

**TTID 差值区间的归因边界**：队列任务、主线程忙碌或合成事件出现在 dur→TTID 窗口，只证明时间上的共存。需要关联真实启动帧、预期/实际呈现点及依赖或阻塞事件，才能说某项工作推迟首帧。不能把该区间的任务 wall time 相加称为“解释了首帧延迟”，也不能据此排除渲染/合成因素。所有阶段展示区分完整 slice 与当前窗口交集；跨界完整 slice 不参与窗口内分解求和。

**第七步：特定阶段补充检查**
- **ContentProvider**：冷启动时 `contentProviderCreate` slice 可能占显著时间（尤其多 ContentProvider 应用）。检查 `startup_main_thread_slices_in_range` 中是否有此 slice
- **厂商特定 Slice**：部分 OEM 有专有 trace 标记（如 OPPO `HyperBoost*`、vivo `TurboX*`、Xiaomi `MiBoost*`），可作为辅助分析信号
- **Zygote fork 阶段**：冷启动的 pre-`bindApplication` 阶段（进程 fork ~50ms）通常不是瓶颈，但极端情况下（系统负载高）可能贡献显著延迟

**输出内容与组织示例：**

以下结构用于组织完整的根因解释，标题、顺序和段落数量可调整。按当前问题范围覆盖启动关键路径及系统证据；简短概览不能替代相关详情。未完成的调查、缺少的字段和无法确认的因果关系应逐项说明，不能为了凑齐报告而补造事实。预算耗尽时保留实际完成状态和未完成项。

1. **概览**：应用名、启动类型、总耗时、**TTID**、**TTFD**（如有）、**分析边界**、评级、数据质量提示
   - **分析边界**必须明确写出，格式示例：
     - TTID 有值且与 dur 一致时："分析范围：启动开始 → 首帧显示（TTID = XXms）"
     - TTID 无值但 dur 有值时："分析范围：启动开始 → 框架启动完成（dur = XXms，基于 android_startups），近似首帧显示"
     - 框架启动事件未检测到时："分析范围：推断窗口 锚点证据 → 边界证据（框架启动事件未检测到，可能为进程内页面启动）；TTID/TTFD 框架指标不可用"
     - R008_TTID_GT_DUR 触发时（TTID > dur）："分析范围：启动开始 → 框架启动完成（dur = XXms）。注意 TTID = YYms > dur，差值 ZZms 需单独分析（见数据质量提示）"
     - TTFD 有值时追加："TTFD = XXms（应用调用了 reportFullyDrawn）"
     - TTFD 无值时追加："TTFD 未观测到，不能仅凭 NULL 判断是否调用 reportFullyDrawn()"
   - 模拟器/测试应用特征按实际证据标注为已确认或候选，名称不能替代实现
   - 如果启动类型与 bindApplication 存在矛盾，必须在此说明

2. **关键发现**（每个发现必须包含**根因推理链**和**根因编号**，不能只报数字）：
   ```
   **[待验证] 等待片段 ← 候选 A9，具体依赖尚未确认**
   - 描述：XX slice 自身耗时 YY ms（self_percent ZZ%）[wall time AA ms]
   - 根因推理链：
     ① 四象限显示 Q4=NN%（主线程存在较多睡眠/等待时间）
     ② 线程状态：S = XX ms、D/DK = YY ms，按任务区间分别定位，尚未确认具体原因
     ③ blocked_functions 含 futex_wait_queue → futex 等待候选，需锁/唤醒证据
     ④ 结合该热点 slice 内的状态及锁/Binder/IO事件建立关系；缺失的因果环节保持未知
   - SR 交叉验证：SR10 检测到 futex 等待 XX ms，与此发现一致
   - 结论：[该区间已证实的观测]；[候选机制及其仍缺少的身份/时序/依赖证据]。仅在因果链已证实的范围内命名根因。
   - 建议：[可操作的优化建议]
   ```
   ⚠️ **根因编号标注规则**（A1-A18 / B1-B12，参见 `knowledge-startup-root-causes` 模板）：
   - **CRITICAL/HIGH 发现**：必须标注根因编号 + SR 交叉验证
   - **WARNING/INFO 发现**：可写"疑似 A9 / 待确认"
   - **数据不足时**：标注"数据不足，无法归类"而非强行贴标签
   - **未发现显著直接耗时的维度**：报告观测区间、覆盖和口径，例如“该窗口已观测同步 Binder 等待 Xms”；小总量或空结果不能写成“Binder 已排除”“不在关键路径”或“系统没有问题”。

3. **根因分析树**：层级式展示启动耗时分解，**体现嵌套关系、解释 wall/self 口径，并区分已证实原因与候选编号**。树可以保持紧凑；不要让长树状图挤掉后面的 App/系统分层建议。
   ```
   启动总耗时 XXms
   ├── [Phase 1] bindApplication = XXms wall
   │     └── app.onCreate = XXms wall (self=YYms)
   │           ├── contentProviderCreate = XXms (self=YYms) ← A1: ContentProvider 初始化
   │           └── OpenDexFilesFromOat = XXms (self=YYms) ← A5: DEX 加载
   ├── [Phase 2] activityStart = XXms wall
   │     └── performCreate = XXms wall (self=YYms)
   │           ├── inflate = XXms (self=YYms) ← inflate 操作及其运行/等待分解
   │           └── Choreographer#doFrame = XXms (self=YYms) ← 首帧渲染
   ├── [交叉因素]（当多个根因同时出现时，说明放大关系）
   │     └── 回收活动与文件等待是否相关：列出已连接的具体事件，缺连接则保持候选
   └── [其他因素的观测与证据缺口]
         ├── Binder 同步事务观测 Xms；标明范围、覆盖和实际等待关联
         ├── GC 在哪些线程及区间运行；是否关联主线程暂停仍需证据
         ├── 频率观察与硬件/热限制证据分别报告，不能按频率排除温控
         └── R/R+ 区间观测 Xms；限定任务和覆盖范围
   ```
   ⚠️ 树中分别标明 wall/self、选中窗口交集与完整事件范围；只有同一分母且互不重叠的区间可求和，父子或窗口外部分不能塞入启动总量

4. **App/系统分层建议**（双视角，按预期收益排列）：

   完整场景报告应区分应用与系统的证据和建议；具体标题、标签和顺序可自行组织。某侧没有可操作项时，说明已检查的证据和边界；缺数据时逐项说明，不能用一句“系统正常”或“数据不足”代替相关维度。局部追问仅覆盖与问题有关的部分。

   **[App 层]**（应用开发者可直接实施）：
   - self_ms 是 exclusive wall time；收益估算另需可消除工作、依赖或对照证据，不能由 self 时间直接得出
   - 嵌套 slice 的收益不能简单相加

   **[系统/平台层]**（系统工程师 / ROM 开发者参考）：

   **核心优先检查**（Phase 1/2 通常已包含数据，优先输出结论；若对应 artifact 缺失则标注"数据不足"）：

   | 维度 | 检查项 | 数据来源 |
   |------|--------|---------|
   | CPU 调度 | 主线程大小核摆放（Q2 占比）、核迁移频率 | 四象限分析、摆核时序（如 critical_tasks 缺失则标注） |
   | CPU 频率与负载 | 各 CPU 的频率覆盖、窗口频率/忙碌度、目标运行时间；区分全窗口与目标执行加权口径 | per_cpu_system_context、cpu_freq_analysis、freq_rampup；缺 counter 不写成 0MHz |
   | Binder 阻塞 | 主线程同步 Binder 中 system_server 响应延迟 | 主线程同步 Binder、Binder 阻塞分析 |
   | 调度延迟 | >8ms 严重延迟次数、整体调度质量 | sched_latency |
   | 抢占交接 | R+ 切出时间、CPU、被抢占线程和紧接着运行的 task、原始 sched ID；解释关键路径影响所需的额外证据 | preemption、critical_tasks；无匹配交接时保留未知 |
   | 优先级与策略 | 观测到的 kernel priority 范围及变化；实际调度策略、RT、nice、affinity/cgroup/uclamp 分开记录 | critical_tasks；没有直接策略记录时明确未知，禁止仅由 priority 推定 FIFO/RR |

   **条件触发**（仅当有对应数据或满足触发条件时分析，数据不足时输出"当前数据不足以判断"）：

   | 维度 | 触发条件 | 数据来源 |
   |------|---------|---------|
   | 内存压力 | Phase 2.56 被执行（D 状态 >10% 或 kswapd 活跃）| memory_pressure_in_range |
   | Binder 线程池 | binder_pool artifact 存在 | Binder 线程池利用率（optional artifact） |
   | Thermal | 均频远低于峰值（>10% 差距）| thermal_zone counters（需 execute_sql 查询） |
   | IO 子系统 | D 状态 >30% 且有 `io_wait=1` 或 IO/page-cache blocked_function，memory_pressure 已解释或排除 | 文件 IO 类型、blocked_functions、block I/O |
   | 进程管理 | LMK 事件 > 0 或 Binder 中有 freezer 相关调用 | oom_adj_intervals（需 execute_sql 查询） |
   | OEM 差异 | 检测到厂商特定 Slice（HyperBoost/TurboX/MiBoost 等）| slice 名称匹配 |

   格式示例：
   ```
   **[系统/平台层] P1 — CPU 调度优化**
   - 发现：主线程启动前 200ms 被调度到小核（Q2=15%），核迁移 12 次
   - 判断：摆核与迁移是观测，尚未证明其造成启动延迟
   - 建议：关联关键任务的频率、Runnable 及抢占交接，取得 affinity/cgroup/uclamp 证据后再评估策略调整；不从占比直接指定 uclamp 或 RT 参数

   **[系统/平台层] P2 — 系统内存治理**
   - 发现：内存压力 moderate，2 次 LMK，同时观测到回收与 D 状态；两者关联尚待同区间 fault/block-IO 证据
   - 建议：检查后台进程 oom_adj 策略；只有确认回收进入关键路径后才评估内存治理，不能直接建议改变系统优先级

   **[系统/平台层] 观测边界**
   - 频率：已观测窗口内 prime 核均频 2499MHz；设备上限和温控状态未记录，不能据此排除限频
   - 摆核：已覆盖主线程运行区间均在已识别的大核；仍需独立检查等待 CPU 的时间
   - 调度延迟：已覆盖区间 max 0.67ms，0 次超过 8ms；是否影响首帧需与关键路径对齐
   ```

⚠️ **禁止的做法：**
- 只说"XX 耗时 YYms"但不解释为什么慢
- 把四象限、线程状态、Binder、GC 当独立章节罗列，而不进行交叉引用
- 忽略 blocked_functions 数据（这是定位 Q4 根因的关键）
- 在证据中只复制 slice 列表，不做根因推理链
- 把 S/I 直接当作锁/Binder阻塞或队列空闲，或在没有 io_wait/blocked_function/IO 证据时把 D/DK 当成 IO 根因
- 把启动锚点之前或闲期的主线程长 sleep 计入启动阻塞总量；或在缺少唤醒证据（waker + 唤醒时刻 slice）时把闲期 sleep 写成"等待输入/空闲"
- 在忙/闲分期未建立的情况下，仅凭 Q4 聚合占比下"主线程睡眠严重/不严重"的结论
- 不区分 GC 在主线程还是后台线程
- 把延迟归因（opinionated_breakdown）的 category 字段（IO/Layout/Other 等）当作真实的阻塞原因。这些 category 是 Perfetto 基于 slice 名称的**启发式分类**，不代表实际线程状态。例如 bind_application 被标记为 IO 类别，但实际阻塞原因可能是锁等待。**必须用线程状态数据（特别是 hot_slice_states）来验证真实根因**
- 用 slice wall time 与全区间线程状态总量做直接数值对比来推断因果（如"inflate 479ms ≈ S状态 468ms 所以它是 S 状态的根因"）。wall time 包含所有线程状态，正确做法是使用 hot_slice_states 的 per-slice 状态分解
- **将嵌套 slice 的 wall time 作为独立根因并列报告**，导致百分比总和超过 100%。必须用 self_ms 归因
- **只分析 activityStart 阶段而遗漏 bindApplication 阶段**（反之亦然）。两个阶段都必须覆盖
- **给出过于精确的 CPU 频率收益估算**（如"升频可降低 28%"），除非有多频率对比的实测数据
<!-- /strategy-detail -->
