<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: general
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: general_critical_path
      domain: critical_path
      description: "Bind the objects, process instances and windows in the current question before selecting critical tasks. Apply relevant shared system evidence to actual performance attribution even when no specialized scene matches."
    - id: general_dependencies
      domain: dependency_chain
      description: "Use domain-specific dependency evidence only where it explains the selected performance goal. Preserve unresolved scope and missing data instead of turning an ambiguous query into an automatic broad investigation."
classification_description: "A specific question, trace fact, acknowledgement or analysis request without a more relevant specialized scene."
priority: 99
effort: high
required_capabilities:
  - cpu_scheduling
optional_capabilities: []
keywords: []
---

#### general Core Strategy

**Route card**: general

**Capabilities**: required=[cpu_scheduling], optional=[none]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- 此场景未声明 mandatory aspects；仍需 submit_plan 并按证据推进。

**Phase reminders**
- 无额外 phase hint。

**Final report contract summary**
- 遵循通用输出契约。
- 以下结构化区块是开放式分析收口行为的事实源：

```json analysis-closure-contract
{
  "applies_to": "open_ended_investigation",
  "max_secondary_domains": 3,
  "report_fields": [
    "checked_domains",
    "missing_data",
    "unresolved_alternatives"
  ],
  "skip_for": "bounded_question",
  "stop_conditions": [
    "no_independent_high_impact_anomaly",
    "repeated_evidence",
    "missing_data",
    "budget_exhausted"
  ]
}
```

- 对“全面分析”“为什么慢”等开放式请求，在主证据链成立后执行一次**有界次要瓶颈收口**：仅从已观测且仍有可用证据的方向中，最多检查 3 个尚未覆盖的独立域；遇到没有高影响独立异常、下一查询会重复已有证据、所需数据不可用或预算耗尽时立即停止。
- 对具体且范围明确的问题不附加该收口。最终报告列出已检查域、未解决的替代解释与缺失数据；次要检查为空不能削弱已经验证的主结论。


**Detail ref**
- `general:full`: 通用分析 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="general full strategy detail" keywords="general,通用分析,detail,full" default="true" -->
#### 通用分析

当前查询未匹配到特定场景策略。请根据用户关注的方向，使用以下决策树选择合适的分析路径。

**决策树 — 按用户关注方向路由：**

| 用户关注方向 | 推荐路径 | 说明 |
|-------------|---------|------|
| **CPU / 调度 / 线程** | `invoke_skill("cpu_analysis")` → 需要函数/slice CPU 热点时 `invoke_skill("process_slice_cpu_hotspots", { process_name: "<包名或进程名>" })` → 如果发现 throttling → `invoke_skill("thermal_throttling")`；追问“谁限的频 / 限频前跑了什么” → `invoke_skill("cpu_frequency_limit_attribution")` | 用 Running CPU time 区分真实计算热点和 wall-time 阻塞，再交叉检查热节流和 CPU 频率；限频归因要看限频轨道和 cooling device，不能只看实际频率 |
| **内存 / OOM / 泄漏** | `invoke_skill("memory_analysis")` → 如果有 heap dump → `invoke_skill("android_heap_graph_summary")` → 如果有 LMK → `invoke_skill("lmk_analysis")` → 如果涉及 GPU 内存 → `invoke_skill("dmabuf_analysis")` | 层层深入内存问题；heap graph 用 retained/cumulative size 定位 retainer |
| **IO / 磁盘 / 存储** | `invoke_skill("block_io_analysis")` 或 `invoke_skill("io_pressure")` | 先区分 block I/O、D-state 等待、主线程文件 I/O、SQLite/DB slice、页缺失和存储容量/损坏线索；不要把系统 I/O 压力直接写成 SQLite 或业务文件根因 |
| **GPU / 渲染** | `invoke_skill("gpu_analysis")` | GPU 频率、利用率、Fence 等待 |
| **Binder / IPC** | `invoke_skill("binder_analysis")` → 特定事务 → `invoke_skill("binder_detail")` | Binder 通信分析 |
| **锁竞争 / 死锁** | `invoke_skill("lock_contention_analysis")` | Monitor 竞争、锁链分析；trace 有 system_server 锁追踪（`*_lock_held`）时，`lock_held_owner_summary` / `lock_held_long_holds` 给持锁一侧的持有时长、持锁线程和等锁方看到的持锁方法。`lock_held_capability.status=runtime_lacks_android_lock_held` 表示 trace 有数据但 trace processor 早于该模块，只能报数据存在，不能给持锁时长 |
| **电源 / 功耗 / 唤醒** | 优先切到 power 策略；或 `invoke_skill("wattson_rails_power_breakdown")` / `invoke_skill("suspend_wakeup_analysis")` | 先看 power_rails/battery_counters/cpu_freq_idle/gpu_work_period 数据完整度；缺 Wattson 数据时退化为 wakelock/Doze/唤醒链 |
| **SurfaceFlinger / 合成** | `invoke_skill("surfaceflinger_analysis")` | SF 合成延迟、GPU/HWC 分析 |
| **非标准/混合渲染架构卡顿** | 先 `detect_architecture`；始终保留 HWUI host 分析（`scrolling_analysis` / `jank_frame_detail`），再按候选链路补：Flutter → `flutter_scrolling_analysis`，TextureView → `textureview_producer_frame_timing`，WebView GL Functor → `webview_drawfunctor_jank_chain`，RN old/new → `rn_bridge_to_frame_jank` / `rn_fabric_render_jank`，GLSurfaceView/NativeActivity → `gl_standalone_swap_jank` | 混合出图要先分开看 host 与 producer，再合并看依赖；避免只看 FrameTimeline 漏掉生产端 jank |
| **网络** | `invoke_skill("network_analysis")` | 只把 packet-level trace 当作包收发、接口、协议、远程端口、活跃周期和流量证据；DNS/连接/TLS/TTFB 需要 request-level telemetry 或接入层日志补证 |
| **特定时间段** | `invoke_skill("system_load_in_range", { start_ts, end_ts })` | 任意时间段的系统负载 |
| **某段区间 / 某个线程为什么在等** | `analyze_wait_chain({ process_name, thread_name|main_thread, start_ts, end_ts })` → 按 top `wake_source_class` / `blocked_function` 路由：`network_receive_candidate` → network、`binder_reply` → binder_analysis、D 态或 io 相关 `blocked_function` → block_io_analysis / io_pressure、`worker_handoff` → 交接线程所在链路、Monitor/futex → lock_contention_analysis | 先分清线程在跑、在排队等 CPU、还是在睡，再选深钻路径；`wake_source_class` 是候选标签不是根因，`timer_or_device_wake` 与 `network_receive_candidate` 共享同一个 IRQ 上下文信号 |
| **不确定方向** | `invoke_skill("scene_reconstruction")` → 按场景路由 | 先做全局场景还原，再针对性深钻 |

**场景专用快速路由**（如果用户的问题明确匹配以下场景，直接使用对应策略）：
- **滑动/窗口动画卡顿**: scrolling_analysis → 主线程连续工作与任务来源 → 按证据补充帧/等待深钻。FrameTimeline 只是出帧结果参考。
- **帧间任务/动画并发内容加载/缺少 FrameTimeline**: main_thread_frame_work（目标进程、完整区间）→ 具体 root task 与 exclusive 子热点、Running/等待、父子 slice/args/flow 追源。没有 doFrame 不能推断没有绘制请求；仅有任务时序不能证明 missed deadline。用 trace 定位点引导追查来源，按已证实的工作给出移出计算/IO、分批或延后非首屏 UI 初始化等建议；不可将必须在主线程的 UI 操作移到后台。
- **启动**: startup_analysis → startup_detail
- **ANR**: anr_analysis → anr_detail
- **点击/触摸**: click_response_analysis → click_response_detail (逐事件深钻)
- **TextureView/WebView/Flutter/RN/GL 混合架构卡顿**: detect_architecture → HWUI host skill + architecture-specific producer skill → 合并依赖判断
- **概览/场景还原**: scene_reconstruction → 按场景路由到对应 Skill
- **功耗/耗电**: wattson_rails_power_breakdown → wattson_thread_power_attribution；数据缺失时 battery_charge_timeline / android_kernel_wakelock_summary / suspend_wakeup_analysis fallback

也可以使用 `list_skills` 发现更多可用技能，或使用 `execute_sql` 做自定义查询。

#### 通用场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`slice_self_dur`、`cpu_utilization_in_interval(ts, dur)`、`cpu_frequency_counters`、`android_garbage_collection_events`、`android_oom_adj_intervals`、`android_screen_state`、`android_dvfs_counters`、`wattson_rails_aggregation`、`android_battery_charge`
<!-- /strategy-detail -->
