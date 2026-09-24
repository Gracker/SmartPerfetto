<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: power
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: power_critical_path
      domain: critical_path
      description: "Align active work, wakeups, CPU idle and frequency residency with the measured energy window. Identify active tasks and coverage; retain integration units and denominators."
    - id: power_dependencies
      domain: dependency_chain
      description: "Separate measured rails from model estimates such as Wattson. Correlate thermal, GPU and network only with supporting evidence; frequency/occupancy alone is not measured energy or thermal throttling."
    - id: frequency_limit_attribution
      domain: cpu_frequency
      description: "Read limits from the observed limit tracks as debounced episodes against the observed maximum limit, not hardware maximum; the first sample is the first change, so a trace that starts capped has unknown onset. Attribute in ladder order: coincident cooling-device transition, then userspace thermal daemon activity before the change, then limit-only. Without cooling or thermal evidence a limit change stays non-thermal or daemon-suspected, never confirmed thermal; limits can also be raised. Separate App-generated load from system-owned limiting, and keep non-CPU heat sources and sparse temperature sampling explicit."
      condition:
        kind: semantic
        description: "Applies when the question concerns CPU frequency limits or caps, thermal throttling, or who triggered them."
      evidence_metrics:
        - system.cpu.frequency_limit.time_weighted
classification_description: "Energy use, battery drain, thermal behavior and resource activity associated with power consumption, including CPU frequency limits and thermal throttling attribution: who capped the frequency, what ran before it, and anomalous threads."
priority: 4
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - power_rails
  - battery_counters
  - cpu_freq_idle
  - gpu_work_period
  - thermal_throttling
  - cpu_freq_limits
  - device_state
keywords:
  - 功耗
  - 耗电
  - 电池
  - 掉电
  - 发热
  - wattson
  - power
  - battery
  - drain
  - energy
  - thermal
  - 限频
  - 温控
  - 降频
  - 热限频
  - 频率上限
  - throttl
  - throttling
  - frequency limit
  - freq cap
  - cooling
  - allow-while-idle
  - setExactAndAllowWhileIdle
  - exact alarm
  - wakeup alarm
  - Android vitals
  - partial wakelock

final_report_contract:
  required_sections:
    - id: job_work_fgs_governance_boundary
      label: Job/Work/FGS 治理边界
      description: '当问题涉及 JobScheduler、WorkManager、Foreground Service、UIDT 或 Android 16 quota 时，区分 trace 事件、app/API 诊断、pending reason、stop reason、版本/状态边界和缺失证据。'
      condition:
        kind: semantic
        description: '当问题涉及后台任务、前台服务或用户发起传输的执行限制、配额、等待或停止原因时适用。'
      pattern_groups:
        - ['Job/Work/FGS', 'JobScheduler', 'WorkManager', 'Foreground Service', '\bFGS\b', 'UIDT', 'user[- ]initiated', '后台执行', 'background execution']
        - ['pending reason', 'stop reason', 'getPendingJobReason', 'getPendingJobReasons', 'getPendingJobReasonStats', 'getStopReason', 'runtime quota', 'job quota', '\bquota\b', 'standby bucket', 'timeout', 'Service\.onTimeout']
        - ['trace', 'logcat', 'WorkInfo', 'JobParameters', 'dumpsys', 'app telemetry', '外部', 'missing', '缺失', '版本', 'Android\s*1[4567]', 'confidence', '置信度', '不能', '不可']
    - id: alarm_wakeup_vitals_boundary
      label: Alarm/Wakeup/Vitals 边界
      description: '当问题涉及 AlarmManager、wakeup、allow-while-idle、wakelock 或 Android/Play Vitals 时，区分本地 trace 窗口、Alarm API/权限证据、24h 聚合阈值和缺失数据。'
      condition:
        kind: semantic
        description: '当问题要求分析定时唤醒、持锁耗电、待机限制，或解释这类问题在外部质量平台上的聚合指标时适用。'
      pattern_groups:
        - ['Alarm/Wakeup/Vitals', 'AlarmManager', 'exact alarm', 'allow[- ]while[- ]idle', 'setExactAndAllowWhileIdle', 'wakeup', 'wakeups?', 'wakelock', 'wake lock', 'partial wakelock', 'vitals']
        - ['24h', '2h', '1h', 'one hour', 'two hours', 'observed window', 'trace window', '局部', '24\s*小时', '2\s*小时', '1\s*小时', '观测窗口', 'Play vitals', 'Android vitals', 'excessive', 'stuck']
        - ['trace', 'dumpsys alarm', 'android_wakeups', 'android_kernel_wakelock', 'external_aggregate', '外部聚合', 'missing', '缺失', 'permission', 'SCHEDULE_EXACT_ALARM', 'USE_EXACT_ALARM', '置信度', '不能', '不可']

phase_hints:
  - id: power_data_gate
    keywords: ['power', 'battery', 'wattson', '功耗', '耗电', '电池', '数据', '采集']
    constraints: '先检查 Trace 数据完整度中的 power_rails、battery_counters、cpu_freq_idle、gpu_work_period。缺失时必须输出数据采集建议，禁止把空表解释为“没有功耗问题”。需要总览时优先调用 power_consumption_overview；拆开看时先调用 power_rails_energy_breakdown 和 battery_drain_rate_summary。'
    critical_tools: ['power_consumption_overview', 'power_rails_energy_breakdown', 'battery_drain_rate_summary', 'lookup_knowledge']
    critical: true
  - id: wattson_attribution
    keywords: ['wattson', 'rail', 'thread', '归因', '能耗', 'energy', 'power_rails']
    constraints: 'Wattson 是估算，不是 ODPM 实测。只有 power_rails/cpu_freq_idle 数据可用时才用 Wattson 归因。先用 power_rails_energy_breakdown 看硬件 rail，再用 wattson_rails_power_breakdown / wattson_thread_power_attribution 做 CPU/线程估算；启动窗口问题再加 wattson_app_startup_power。'
    critical_tools: ['wattson_rails_power_breakdown', 'wattson_thread_power_attribution', 'wattson_app_startup_power']
    critical: false
  - id: battery_drain_chain
    keywords: ['battery drain', 'standby drain', '掉电', '待机耗电', '后台耗电', 'wakelock', 'doze', 'job', 'network']
    constraints: '用户问掉电/待机耗电时优先调用 battery_drain_attribution，把 battery drain rate、Doze、suspend/wakeup、wakelock、screen-off CPU、job、network 串起来；缺 rail 数据时只能给事件链归因。'
    critical_tools: ['battery_drain_attribution', 'wakeup_frequency_summary', 'screen_off_background_cpu_attribution', 'modem_network_correlation_summary']
    critical: false
  - id: background_execution_governance
    keywords: ['JobScheduler', 'WorkManager', 'Foreground Service', 'FGS', 'foreground worker', 'UIDT', 'pending reason', 'stop reason', 'runtime quota', 'standby bucket', 'expedited job', 'dataSync', 'mediaProcessing', 'shortService']
    constraints: '后台执行治理必须把 JobScheduler pending reason（为何未运行）与 JobParameters/WorkInfo stop reason（为何停止）分开。Perfetto 的 job event 只能证明执行窗口；Android 15/16 quota、FGS timeout、UIDT 和 standby bucket 结论必须标注版本、target/app state、app 日志/API 或 dumpsys 证据缺口。'
    critical_tools: ['battery_drain_attribution', 'android_job_scheduler_events', 'android_kernel_wakelock_summary', 'battery_doze_state_timeline', 'screen_off_background_cpu_attribution', 'suspend_wakeup_analysis', 'lookup_knowledge']
    critical: false
  - id: alarm_wakeup_boundary
    keywords: ['AlarmManager', 'exact alarm', 'allow-while-idle', 'setExactAndAllowWhileIdle', 'wakeup alarm', 'wakeups', 'wakelock', 'partial wakelock', 'Android vitals', 'Play vitals', 'excessive wakeups']
    constraints: 'Alarm/wakeup 只能从本地 trace 证明唤醒、wakelock、suspend/Doze 现象；不能仅凭 wakeup 反推 AlarmManager API、exact-alarm 权限或 Play Vitals 违规。Vitals 需要 24h/聚合窗口，短 trace 只能写局部参考。'
    critical_tools: ['wakeup_frequency_summary', 'suspend_wakeup_analysis', 'android_kernel_wakelock_summary', 'battery_drain_attribution', 'lookup_knowledge']
    critical: false
  - id: thermal_chain
    keywords: ['thermal', 'throttling', '发热', '温控', '降频', '热节流', 'gpu work period', 'mali']
    constraints: '用户问发热、降频、热导致卡顿时优先调用 thermal_throttling_chain；同时说明温度传感器/DVFS/GPU work period 哪些数据存在，哪些缺失。'
    critical_tools: ['thermal_throttling_chain']
    critical: false
  - id: fallback_state_power
    keywords: ['wakelock', 'doze', 'battery', 'dvfs', 'thermal', '唤醒', '待机', '降频']
    constraints: '如果 Wattson 前置数据缺失，退化为状态/事件链分析：battery_drain_rate_summary、battery_charge_timeline、battery_doze_state_timeline、wakeup_frequency_summary、android_kernel_wakelock_summary、screen_off_background_cpu_attribution、android_dvfs_counter_stats、suspend_wakeup_analysis。结论必须标注这是定性分析，不是 rail 级能耗归因。'
    critical_tools: ['battery_drain_rate_summary', 'battery_charge_timeline', 'battery_doze_state_timeline', 'wakeup_frequency_summary', 'android_kernel_wakelock_summary', 'screen_off_background_cpu_attribution', 'android_dvfs_counter_stats', 'suspend_wakeup_analysis']
    critical: false

plan_template:
  mandatory_aspects:
    - id: power_data_availability
      match_keywords: ['power', 'battery', 'wattson', '功耗', '耗电', '电池', '数据完整度', '采集']
      suggestion: '功耗场景必须先确认 power_rails/battery_counters/cpu_freq_idle/gpu_work_period 是否可用'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: power_rails_energy_breakdown
        - tool: invoke_skill
          skill_id: battery_charge_timeline
        - tool: invoke_skill
          skill_id: android_dvfs_counter_stats
        - tool: invoke_skill
          skill_id: android_gpu_work_period_track
    - id: power_attribution_or_fallback
      match_keywords: ['wattson', 'rail', 'thread', 'wakelock', 'doze', '归因', '唤醒', '降频']
      suggestion: '功耗场景需要包含 Wattson 归因或状态事件 fallback 分析阶段'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: wattson_thread_power_attribution
        - tool: invoke_skill
          skill_id: wattson_rails_power_breakdown
        - tool: invoke_skill
          skill_id: wakelock_tracking
        - tool: invoke_skill
          skill_id: device_state_timeline
    - id: power_composite_entrypoint
      match_keywords: ['power_consumption_overview', 'battery_drain_attribution', 'thermal_throttling_chain', '总览', '掉电', '温控链路']
      suggestion: '复杂功耗问题建议先用 power_consumption_overview / battery_drain_attribution / thermal_throttling_chain 建立统一证据链'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: power_consumption_overview
        - tool: invoke_skill
          skill_id: battery_drain_attribution
        - tool: invoke_skill
          skill_id: thermal_throttling_chain
    - id: power_vitals_threshold_context
      match_keywords: ['wakelock', 'vitals', 'excessive', 'stuck', 'P90', 'P99', '后台']
      suggestion: 'Wakelock 阈值必须说明时间基准：24h 累计 >=2h excessive，单后台 wakelock >=1h stuck，P90/P99 >60min 重点排查；短 trace 只能作为局部证据或换算参考'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: wakelock_tracking
        - tool: lookup_knowledge
---

#### power Core Strategy

**Route card**: 功耗 / 耗电 / 电池 / 掉电 / 发热 / 限频 / 降频 / 温控 / wattson / power / battery / drain / energy / throttling / frequency limit

**Capabilities**: required=[cpu_scheduling], optional=[power_rails, battery_counters, cpu_freq_idle, gpu_work_period, thermal_throttling, cpu_freq_limits, device_state]

**Execution contract**
- 问“谁把频率限住了 / 限频前跑了什么 / 有无异常线程”时，入口是 `invoke_skill("cpu_frequency_limit_attribution", { package })`，再按证据阶梯收口（detail: Phase 4）。
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- power_data_availability: 功耗场景必须先确认 power_rails/battery_counters/cpu_freq_idle/gpu_work_period 是否可用 (requires one of: invoke_skill(power_rails_energy_breakdown), invoke_skill(battery_charge_timeline), invoke_skill(android_dvfs_counter_stats), invoke_skill(android_gpu_work_period_track))
- power_attribution_or_fallback: 功耗场景需要包含 Wattson 归因或状态事件 fallback 分析阶段 (requires one of: invoke_skill(wattson_thread_power_attribution), invoke_skill(wattson_rails_power_breakdown), invoke_skill(wakelock_tracking), invoke_skill(device_state_timeline))
- power_composite_entrypoint: 复杂功耗问题建议先用 power_consumption_overview / battery_drain_attribution / thermal_throttling_chain 建立统一证据链 (requires one of: invoke_skill(power_consumption_overview), invoke_skill(battery_drain_attribution), invoke_skill(thermal_throttling_chain))
- power_vitals_threshold_context: Wakelock 阈值必须说明时间基准：24h 累计 >=2h excessive，单后台 wakelock >=1h stuck，P90/P99 >60min 重点排查；短 trace 只能作为局部证据或换算参考 (requires one of: invoke_skill(wakelock_tracking), lookup_knowledge)

**Phase reminders**
- power_data_gate: 先检查 Trace 数据完整度中的 power_rails、battery_counters、cpu_freq_idle、gpu_work_period。缺失时必须输出数据采集建议，禁止把空表解释为“没有功耗问题”。需要总览时优先调用 power_consumption_overview；拆开看时先调用 power_rails_energy_breakdown 和 battery_drain_rate_summary。 工具: power_consumption_overview, power_rails_energy_breakdown, battery_drain_rate_summary, lookup_knowledge
- wattson_attribution: Wattson 是估算，不是 ODPM 实测。只有 power_rails/cpu_freq_idle 数据可用时才用 Wattson 归因。先用 power_rails_energy_breakdown 看硬件 rail，再用 wattson_rails_power_breakdown / wattson_thread_power_attribution 做 CPU/线程估算；启动窗口问题再加 wattson_app_startup_power。 工具: wattson_rails_power_breakdown, wattson_thread_power_attribution, wattson_app_startup_power
- battery_drain_chain: 用户问掉电/待机耗电时优先调用 battery_drain_attribution，把 battery drain rate、Doze、suspend/wakeup、wakelock、screen-off CPU、job、network 串起来；缺 rail 数据时只能给事件链归因。 工具: battery_drain_attribution, wakeup_frequency_summary, screen_off_background_cpu_attribution, modem_network_correlation_summary
- background_execution_governance: 后台执行治理必须把 JobScheduler pending reason（为何未运行）与 JobParameters/WorkInfo stop reason（为何停止）分开。Perfetto 的 job event 只能证明执行窗口；Android 15/16 quota、FGS timeout、UIDT 和 standby bucket 结论必须标注版本、target/app state、app 日志/API 或 dumpsys 证据缺口。 工具: battery_drain_attribution, android_job_scheduler_events, android_kernel_wakelock_summary, battery_doze_state_timeline, screen_off_background_cpu_attribution, suspend_wakeup_analysis, lookup_knowledge
- alarm_wakeup_boundary: Alarm/wakeup 只能从本地 trace 证明唤醒、wakelock、suspend/Doze 现象；不能仅凭 wakeup 反推 AlarmManager API、exact-alarm 权限或 Play Vitals 违规。Vitals 需要 24h/聚合窗口，短 trace 只能写局部参考。 工具: wakeup_frequency_summary, suspend_wakeup_analysis, android_kernel_wakelock_summary, battery_drain_attribution, lookup_knowledge
- thermal_chain: 用户问发热、降频、热导致卡顿时优先调用 thermal_throttling_chain；同时说明温度传感器/DVFS/GPU work period 哪些数据存在，哪些缺失。 工具: thermal_throttling_chain
- fallback_state_power: 如果 Wattson 前置数据缺失，退化为状态/事件链分析：battery_drain_rate_summary、battery_charge_timeline、battery_doze_state_timeline、wakeup_frequency_summary、android_kernel_wakelock_summary、screen_off_background_cpu_attribution、android_dvfs_counter_stats、suspend_wakeup_analysis。结论必须标注这是定性分析，不是 rail 级能耗归因。 工具: battery_drain_rate_summary, battery_charge_timeline, battery_doze_state_timeline, wakeup_frequency_summary, android_kernel_wakelock_summary, screen_off_background_cpu_attribution, android_dvfs_counter_stats, suspend_wakeup_analysis

**Final report contract summary**
- Job/Work/FGS 治理边界
- Alarm/Wakeup/Vitals 边界


**Detail ref**
- `power:full`: 功耗 / 电池 / Wattson 分析（用户提到 功耗、耗电、电池、掉电、wattson） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="power full strategy detail" keywords="power,功耗,耗电,电池,掉电,发热,wattson,power,battery,drain,energy,thermal,allow-while-idle,功耗 / 电池 / Wattson 分析（用户提到 功耗、耗电、电池、掉电、wattson）,detail,full" default="true" -->
#### 功耗 / 电池 / Wattson 分析（用户提到 功耗、耗电、电池、掉电、wattson）

功耗分析的第一原则：**先判数据能不能支撑结论**。Wattson/rail 级归因依赖 `android.power`、power rails、CPU freq/idle、GPU work period 等采集源。缺失这些数据时，不能把空结果解释为“没有耗电”；只能输出采集建议，或退化为状态/事件链分析。

#### 功耗场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_power_rails_counters`、`android_power_rails_metadata`、`wattson_rails_aggregation!(window)`、`wattson_threads_aggregation!(window)`、`wattson_window_app_startup`、`android_battery_charge`、`android_screen_state`、`android_deep_idle_state`、`android_wakeups`、`android_kernel_wakelocks`、`android_network_packets`、`android_network_uptime_spans!`、`android_dvfs_counter_stats`、`android_gpu_work_period_track`、`cpu_idle_counters`、`cpu_frequency_counters`

#### 固定执行顺序

1. **数据完整度**：先判断 `power_rails` / `battery_counters` / `cpu_freq_idle` / `gpu_work_period` 是否可用。
2. **全局量纲**：优先用 `power_rails_energy_breakdown` 看硬件 rail 实测 mWh，再用 `battery_drain_rate_summary` 看 trace 窗口掉电趋势。
3. **待机健康度**：screen-off / standby 问题必须看 `suspend_wakeup_analysis` 和 `wakeup_frequency_summary`，再看 `android_kernel_wakelock_summary`。
4. **后台执行治理**：JobScheduler / WorkManager / FGS / UIDT / Alarm / Wakelock 要分清 trace 事件、app/API 日志、dumpsys、Play/Vitals 聚合和 Android 版本政策；不能把本地事件直接写成平台治理结论。
5. **归因链路**：CPU 用 `screen_off_background_cpu_attribution` / `wattson_thread_power_attribution` / `cpu_freq_residency_summary`；网络只用 `modem_network_correlation_summary` 做 correlation；GPU/温控再走 GPU/thermal 链。
6. **可信度分层**：结论必须标注 `hardware_power_rails` / `wattson_estimate` / `battery_counter_trend` / `event_chain_fallback` / `external_policy_or_aggregate` / `insufficient_data`。

#### Wakelock / Vitals 阈值语义

- partial wakelock 24h 累计 >= 2h：Android vitals excessive 参考阈值。
- 单个后台 partial wakelock >= 1h：stuck wakelock 参考阈值。
- P90/P99 > 60min：重点排查。
- Android vitals 只在 app 后台或前台服务持有 partial wakelock 时计入，并存在音频、位置、JobScheduler user-initiated 等豁免；SmartPerfetto 的单条 trace 通常不是 24h 数据。除非 trace 覆盖完整统计周期或用户提供 Play/Vitals 聚合数据，否则只能输出“局部证据 / 换算参考 / 需长期采样确认”，不能直接判定 Play vitals 违规。

**Phase 0 — 数据完整度门禁：**

先读取系统提示中的 Trace 数据完整度结果：

| capability | 缺失时含义 | 处理 |
|---|---|---|
| `power_rails` | 无 rail 级能耗估算 | 不调用 Wattson rail/thread 能耗结论；输出 `collect_power_rails` 采集建议 |
| `battery_counters` | 无电量/电流采样 | 不计算掉电速率；输出 `battery_poll_ms` 采集建议 |
| `cpu_freq_idle` | 无 CPU idle/freq 完整状态 | 不做 Wattson CPU 能耗归因；可退化为 CPU 频率/DVFS 定性分析 |
| `gpu_work_period` | 无 GPU active region | 不做 GPU work period/能耗归因；可退化为 GPU 频率或 Mali power state 分析 |
| `cpu_freq_limits` | 无 `cpu_max/min_frequency_limit` 轨道 | 不能给限频归因结论；只能用实际 `cpufreq` 做观测，并按 Phase 4(e) 给 `power/cpu_frequency_limits` 采集建议 |
| `thermal_throttling` | 无热区温度 / cooling device 轨道 | 不能确认热触发；限频结论最多停在 `NON_THERMAL` 或守护进程候选 |

如果用户明确问“怎么采集”，优先调用：
```
lookup_knowledge("data-sources")
```

**Phase 1 — Wattson rail/thread 归因（数据可用时）：**

复杂功耗问题优先使用总览入口：
```
invoke_skill("power_consumption_overview", { package: "<包名>" })
```

需要拆开看时再调用：
```
invoke_skill("power_rails_energy_breakdown")
invoke_skill("wattson_rails_power_breakdown")
invoke_skill("wattson_thread_power_attribution", { process_name: "<包名>" })
```

分析顺序：
1. 看 rail 总能耗排序：CPU/GPU/DDR/Modem 哪个是主耗能源
2. 看线程级归因：是否是目标 App 线程、system_server、RenderThread、Binder 线程池或后台进程消耗
3. 如果能耗集中在某一时间窗口，结合 `cpu_thread_utilization_period` / `cpu_process_utilization_period` 做 CPU 利用率交叉验证

**Phase 2 — 启动期功耗（用户提到启动耗电时）：**

```
invoke_skill("wattson_app_startup_power", { package: "<包名>" })
invoke_skill("app_process_starts_summary")
```

把启动窗口能耗与启动类型、进程创建、CPU/DVFS 状态关联。不能只给总能耗，必须说明能耗集中在哪个阶段或线程。

**Phase 3 — 电池/Doze/Wakelock fallback（Wattson 数据缺失或用户问待机耗电时）：**

掉电/待机耗电优先使用组合入口：
```
invoke_skill("battery_drain_attribution", { package: "<包名>" })
```

需要拆开看时再调用：
```
invoke_skill("battery_drain_rate_summary")
invoke_skill("battery_charge_timeline")
invoke_skill("battery_doze_state_timeline")
invoke_skill("wakeup_frequency_summary")
invoke_skill("android_kernel_wakelock_summary")
invoke_skill("suspend_wakeup_analysis")
invoke_skill("screen_off_background_cpu_attribution", { package: "<包名>" })
invoke_skill("modem_network_correlation_summary")
invoke_skill("android_app_background_power_state", { package: "<包名>" })
```

`android_app_background_power_state`（也是 `battery_drain_attribution` 的 `app_background_power` 步骤）是应用级的三层可选证据，先读 `power_state_capability` 再解读：
- App wakelock（`app_wakelock_summary`，或旧 trace processor 上的 `app_wakelock_summary_battery_stats`）是 PowerManager 持锁，按 uid + tag；它和 `android_kernel_wakelock_summary` 的 kernel wakeup source 是两层，一个应用 wakelock 可以不对应任何可见的 kernel wakelock，不要相加或互相替代。
- Standby bucket（`standby_bucket_residency`）说明配额环境：长时间 RARE/RESTRICTED 能解释 job/alarm/网络被推迟或合并，ACTIVE/WORKING_SET 下仍频繁唤醒则更可能是应用自身行为。
- Freezer（`freezer_summary` 或 `freezer_summary_slices`，按有数据的来源二选一）：冻结期间进程不执行代码，频繁解冻（binder、广播、服务绑定等原因）会把后台 CPU 和唤醒带回来；statsd 与 slice 两种来源的解冻原因写法不同（`UFR_BINDER_TXNS` 与 `binder_txns`），引用时保留原文。
- 需要确认应用当时是否真在后台时，用 `invoke_skill("android_process_state_residency", { process_name: "<包名>" })` 看 framework 进程状态驻留（TOP、FOREGROUND_SERVICE、CACHED_* 等）：前台服务期间的持锁和唤醒与 cached 状态下的持锁是两类问题。
- `runtime_lacks_*` 表示 trace 有数据但 trace processor 早于对应模块，只能写数据存在和版本缺口；`no_*_data` 表示没采集（statsd atom `app_standby_bucket_changed` / `app_freeze_changed`、atrace `power`/`am`），写成采集建议。

输出要明确标注：这是状态/事件链证据，能说明“是否频繁唤醒、是否无法进入 Doze、是否有 wakelock”，但不是 rail 级功耗量化。

**Phase 3.5 — 后台执行治理证据（按需）：**

当用户提到 JobScheduler、WorkManager、Foreground Service/FGS、UIDT、quota、pending reason、stop reason、AlarmManager、allow-while-idle、wakeup 或 Android vitals 时，在功耗归因前先做治理边界拆分：

```
invoke_skill("android_job_scheduler_events", { package: "<包名>" })
invoke_skill("android_kernel_wakelock_summary")
invoke_skill("wakeup_frequency_summary")
invoke_skill("suspend_wakeup_analysis")
invoke_skill("battery_doze_state_timeline")
```

报告必须分清这些证据面：

| 证据面 | 能证明什么 | 不能直接证明什么 |
|---|---|---|
| `android_job_scheduler_events` | JobScheduler 执行窗口、服务名、包名、UID | pending reason、stop reason、quota 触发原因、WorkManager worker 业务语义 |
| `JobScheduler#getPendingJobReason(s)` / dumpsys / app 日志 | Job 为什么未运行：constraint、quota、standby bucket、background restriction 等候选原因 | 已运行任务为何停止 |
| `JobParameters.getStopReason()` / `WorkInfo.getStopReason()` / app telemetry | 正在运行的 Job/Worker 为什么停止：timeout、quota、constraint、device state、background restriction 等 | 未运行任务的完整等待历史；未来 Android 版本可能新增 reason |
| FGS logcat / service telemetry | `dataSync`、`mediaProcessing`、`shortService` timeout 或 `Service.onTimeout()` 路径 | 没有服务日志时，不能只凭 CPU/Job trace 认定 FGS timeout |
| `android_wakeups` / wakelock / suspend / Doze | 本地 trace 窗口内是否唤醒频繁、阻止 suspend、Doze 状态异常 | 具体 AlarmManager API、exact alarm 权限、Play Vitals 24h 聚合违规 |

版本/政策边界：

- Android 15：`dataSync` / `mediaProcessing` FGS 在后台 24h 内共享各自 6h budget，超限后系统调用 `Service.onTimeout(int, int)`；`shortService` 是更短的约 3 分钟路径。没有 Android 版本、targetSdk、service type 或 logcat/API 证据时，只能写“版本敏感候选”。
- Android 16：JobScheduler regular/expedited runtime quota 会受 standby bucket、top/visible 起始状态、FGS 并发影响；WorkManager、JobScheduler、DownloadManager 都会受影响。FGS 并发不再是 Job quota 豁免证据。
- UIDT：Android 14+ 的 user-initiated data transfer 是长耗时用户触发传输的边界；trace 只能看到 Job/网络/CPU 现象，是否 UIDT 需要 JobInfo/API 或 app 日志。
- Alarm / allow-while-idle：wakeup trace 只能证明设备被唤醒；exact alarm、`setExactAndAllowWhileIdle`、`SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` 权限和 Android 17 listener API 需要 app/API/dumpsys 证据。

**Phase 4 — 限频归因 / 温控 / 频率交叉验证（按需）：**

用户问“谁把频率限住了”“限频之前跑了什么”“有没有异常线程”时，入口是：
```
invoke_skill("cpu_frequency_limit_attribution", { package: "<包名>", lookback_ms: 10000, who_window_ms: 2000, max_episodes: 3 })
```
一次返回：data_check、限频总览、cooling device 总览、按受限程度排序的 capped episodes，每个 episode 的 who_cooling / who_daemon / temperature_context / before_workload / before_anomalies / non_cpu_heat_context / who_verdict，以及 vendor_signal_discovery（候选 counter track、slice、进程及其计数与时间范围）。

**(a) 先读共性证据（各平台通用）**

| counter_track.type | 轨道名示例 | 单位 | 来源与含义 |
|---|---|---|---|
| `cpu_max_frequency_limit` / `cpu_min_frequency_limit` | `Cpu N Max Freq Limit` / `Cpu N Min Freq Limit` | kHz | ftrace `power/cpu_frequency_limits`；N 是 policy leader CPU，这条上限管整个 policy，不只那一个核 |
| `thermal_temperature` | `<zone> Temperature` | mC | ftrace `thermal/thermal_temperature`，热区温度采样 |
| `cooling_device_counter` | `<cdev> Cooling Device` | state | ftrace `thermal/cdev_update`，冷却设备档位，0 = 未限制 |

实际频率是 `cpu_counter_track` 上的 `cpufreq`，和上限是两件事：频率低也可能只是没负载。

读数纪律（必须写进结论）：
- 参照系是 **trace 内观测到的最大上限**，不是硬件最大频率；不要按 spec 频率算“降了百分之多少”。
- limit 轨道的**第一个样本是第一次变化**，不是限频起点；trace 一开始就是低上限时 onset 未知，只能说“数据起点即受限”。
- capped 状态按**去抖后的 episode** 读：Pixel 的 PID governor 会 ~60ms 反复切换上限，那是一个 episode，不是几十次限频。
- 上限也会被**抬高**（boost）；`cpu_min_frequency_limit` 的变化同样是策略动作。

**(b) 读 who_verdict，按证据阶梯收口**

| who_verdict | 证据强度 | 结论写法 |
|---|---|---|
| `thermal_cooling_device_confirmed` | 强：cdev 档位跳变与 limit 变化同刻 | 可写“热管理触发的限频”，给出 cdev 名与温度上下文 |
| `userspace_thermal_daemon_active_before_limit` | 中：limit 变化前窗口内有 thermal 守护进程活动 | 只能写**候选触发源**；说明该平台把限频写进 sysfs，trace 里没有 cdev 事件 |
| `limit_changed_no_thermal_evidence` | 弱：限频确实发生，但无 cooling/温度证据 | 写 `NON_THERMAL`：PowerHAL/perf service、游戏/省电模式、厂商策略都可能限频，需要补证 |
| `onset_unknown_capped_at_data_start` | 起点缺失 | 只报受限时长与影响，不报触发者 |

对应诊断分级：`THERMAL_LIMIT_CONFIRMED` / `THERMAL_DAEMON_SUSPECTED` / `NON_THERMAL_LIMIT` / `LIMIT_EVIDENCE_MISSING`。

平台差异决定你最多能拿到哪一级证据，不是结论本身：内核热管理平台（Pixel，GKI 上的 MTK 多半也是）会发 cooling device 跳变，可直接对上 limit 变化；高通把限频写在用户态（`thermal-engine` / `android.hardware.thermal-service.qti` 直写 sysfs），**limit 变了却没有任何 cdev 事件**，温度采样也稀疏（每分钟几个点），此时最强结论只能到“守护进程在限频前活跃”。

**(c) 厂商信号靠探索，不靠清单**

vendor_signal_discovery 给的是**候选**。用 `execute_sql` 逐个验证：名字是数据不是定义，要看值域、看跳变时刻是否与 limit 变化对齐，才决定它能否当证据。真实 trace 里见过的例子（示例，不是目录；MTK 尚未实测，必须现场探索）：
- Pixel thermal HAL atrace counter `VIRTUAL-SKIN-CPU-GPU-thermal-cpufreq-2-pid_request` / `...-cdev_ceiling`、`H:THERMAL_VIRTUAL-SKIN-HINT_*`；slice `ThermalHelper::readThermalSensor - <zone>`；内核线程 `thermal_BIG`。
- 高通/OEM 进程 `thermal-engine-v2`、`android.hardware.thermal-service.qti`、`vendor.bytedance.thermalextservice.service`、`perfservice`；system_server slice `ThermalAtomicEventMonitor$ThermalHandler`。

**(d) “限频之前跑了什么”与 App / 系统责任边界**

`before_workload`（`cpu_workload_attribution_in_range`）按 `actor_class` 把 target_app / other_app / system_service / kernel 分开；其 freq-weighted work = Σ dur×频率，单位 MHz·ms，**不是能量**。`before_anomalies`（`cpu_anomalous_threads_in_range`）标出 sustained_runner / spin_like / kernel_daemon_heavy / waker_storm。

结论必须把两侧分开写：
- App 侧可动作：本 App 线程在限频前持续满载、自旋、唤醒风暴、后台线程抢大核。
- 系统/厂商侧：其他 App、系统服务、内核线程的热贡献，以及限频策略本身。
- **skin / battery 热区不是 CPU 结温**：充电、Modem、屏幕、GPU、相机都会把 skin 推高，`non_cpu_heat_context` 就是为此而设。只做 CPU 归因会把充电导致的限频写成 App 的锅。
- 温度采样稀疏时（高通常见），温度曲线只能作背景，不能当因果证据。

**(e) `LIMIT_EVIDENCE_MISSING` 时给采集建议**

这说明这条 trace 没采到限频事件，不是“没有限频”。建议补采 ftrace：`power/cpu_frequency_limits`、`thermal/thermal_temperature`、`thermal/cdev_update`，以及 `power/cpu_frequency`；厂商 thermal HAL 的 atrace tag 按设备补。CLI 可建议 `smp capture android --preset power --app <pkg> --duration <sec>`。

**(f) 其余频率/GPU 交叉验证**

| 信号 | 调用 |
|---|---|
| 温度/频率观测（只看现象，不做触发源归因） | `invoke_skill("thermal_throttling")` |
| 温控链路总览（温度 → 频率 → 帧影响） | `invoke_skill("thermal_throttling_chain", { package: "<包名>" })` |
| 指定窗口内的受限情况 | `invoke_skill("cpu_throttling_in_range", { start_ts, end_ts })` |
| GPU work period 可用 | `invoke_skill("android_gpu_work_period_track")` |
| Mali power state 可用 | `invoke_skill("mali_gpu_power_state")` |
| CPU 高频驻留 / idle residency | `invoke_skill("cpu_freq_residency_summary")` / `invoke_skill("cpu_idle_state_residency")` |
| 机制背景 | `lookup_knowledge("thermal-throttling")`、`lookup_knowledge("data-sources")` |

`android_dvfs_counter_stats` 不是通用 DVFS 入口：它走 `android.dvfs` stdlib，而该模块按固定 counter 名白名单匹配（`domain@N Frequency`、`17000010.devfreq_mif Frequency`、`cpuNdsu Frequency` 等 Pixel/Tensor 命名），在高通/MTK 设备上通常为空。空结果只说明该设备不发这些 counter，不能写成“没有 DVFS 问题”；通用路径用上面的 limit 轨道和 `cpu_counter_track` 的 `cpufreq`。

**限频子场景输出结构（问“谁限的频”时用这个）：**

1. **限频是否发生**：观测到的最大上限、受限 episode 数、受限时长占比、是否 trace 起点即受限（onset 未知）
2. **谁触发**：who_verdict + 诊断分级，给出 cdev / 守护进程 / 无证据的具体依据；候选就写候选
3. **限频前发生了什么**：freq-weighted work 的 actor_class 分布 + 异常线程及其标志
4. **非 CPU 热源**：充电、Modem、屏幕、GPU、相机等 skin 贡献；说明温度采样密度
5. **责任边界**：App 可动作项 vs 系统/厂商侧项分开写，不混成一句“系统降频”
6. **证据边界与采集建议**：缺 cdev / 温度 / limit 事件时明确说缺什么、补什么

**输出结构（功耗主线）：**

1. **数据完整度判定**：power_rails / battery_counters / cpu_freq_idle / gpu_work_period 哪些可用，哪些缺失
2. **全局能量/掉电趋势**：硬件 rail mWh、Wattson 估算 mWh、battery drain rate 分开列
3. **待机健康度**：suspend 占比、wakeup/min、wakelock Top、screen-off CPU 是否异常
4. **时间窗口关联**：耗电/唤醒/降频发生在什么阶段，是否与启动、滑动、后台任务、网络活动重叠
5. **后台执行治理边界**（仅相关时）：Job pending reason vs stop reason、WorkManager/JobScheduler/FGS/UIDT、Alarm/wakeup/Vitals 的证据来源、版本边界和缺失数据
6. **结论可信度**：hardware_power_rails / wattson_estimate / battery_counter_trend / event_chain_fallback / external_policy_or_aggregate / insufficient_data
7. **采集建议**：缺哪些数据就给具体 Perfetto 配置方向，不泛泛而谈；CLI 可建议 `smp capture android --preset power --app <pkg> --duration <sec>`
<!-- /strategy-detail -->
