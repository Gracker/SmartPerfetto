<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: overview
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 2}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: overview_critical_path
      domain: critical_path
      description: "Identify material performance symptoms/windows and select supported local paths for investigation. Separate overall supply/pressure context from target task evidence and clearly distinguish investigated and uninvestigated segments."
    - id: overview_dependencies
      domain: dependency_chain
      description: "Use representative local paths to explain material symptoms; do not claim a whole-trace cause from one fragment or require every detector for every segment."
classification_description: "Surveying broad performance symptoms in a trace and investigating the material issues, with system context and supported local paths."
priority: 5
effort: high
required_capabilities:
  - cpu_scheduling
  - device_state
optional_capabilities:
  - frame_rendering
  - startup
  - binder_ipc
  - gc_memory
  - thermal_throttling
  - power_rails
  - battery_counters
keywords:
  - 有什么问题
  - 概览
  - 整体分析
  - 性能概览
  - overview
  - analyze the trace
  - performance overview
  - 全局分析
---

#### overview Core Strategy

调查 trace 中的重要性能问题：先确认范围和可用证据，盘点实际症状，再沿有依据的局部路径查清影响与原因。系统负载和压力是上下文，不能仅靠全局统计归因。

可以使用注册的 `scene_reconstruction` Skill 盘点候选事件和区间，再按实际症状选择相应调查。读取相关原始 artifact、时间范围、对象及覆盖信息；候选标签不是已核验的用户行为。工具零行、缺失状态或被截断的结果都不能证明空闲、流畅或全 trace 无问题。

根据性能影响和证据强度选择调查顺序，保留所有已发现的重要症状和明确的未调查区间。不要用固定数量的问题替代请求范围，也不要要求所有 detector 覆盖所有区间。用户要求逐段还原操作与设备状态时，应由专用 `scene_reconstruction` 策略承担该目标。

**Detail ref**: `overview:full` — 性能症状盘点、局部调查和证据边界。

<!-- strategy-detail id="full" title="Performance overview investigation" keywords="overview,有什么问题,概览,整体分析,性能概览,performance overview,全局分析,detail,full" default="true" -->
#### 性能概览调查

**确认范围与能力。** 检查 trace 时间、关注应用、运行环境和相关数据来源。使用当前 registry 发现适用的概览和专项 Skill，读取其真实参数与返回字段。对旧版本 Android、不同渲染管线、缺少输入或 FrameTimeline 的记录，保留相应能力限制。

**盘点症状。** `scene_reconstruction` 可提供输入、启动、窗口和系统变化的候选盘点，作为选择调查区间的线索。读取所需 artifact 的原始行和完整可用分页；结果 preview 和 SQL 截断是不同边界。候选事件的数量、名字或原先的置信值不能替代证据核验。不要把未记录的操作改写为空闲，或把 FPS 缺失改写为流畅。

**按问题调查。** 根据用户目标、实际延迟/卡顿/资源异常及覆盖情况安排调查。对启动问题区分 TTID、TTFD 和生命周期完成；对滚动或动画问题先识别实际渲染路径和帧口径；对输入问题分开 dispatch、处理、ACK 和可用的呈现证据；对耗电/待机问题检查采集到的状态、唤醒和供电证据。由 registry 选择相应策略与 Skill，继续读取完整返回证据，并沿能够解释局部路径的调度、Binder、锁、IO、GC 或图形依赖补查。

需要进程身份时，使用实际 UPID/UTID、窗口和时间范围。身份准入返回 ambiguous/blocked 时先消除歧义；不要把同名进程、输入目标和出帧应用直接合并。全局 CPU 占用、同时发生的后台工作或单个热点不能单独证明局部原因。

**综合结果。** 说明观察到的症状、精确区间、对象、测量口径及影响，并把事实、机制解释、未排除的替代原因分开。对已深入调查的问题给出证据支持的改善方向；对未调查的区间说明范围和原因。仅当实际证据和覆盖允许时，才在对应范围内写“未观察到该问题”，不能扩大为整台设备或整段 trace 的保证。

性能概览可以按时间组织结果，但不发布模型自行命名的 canonical scene timeline。完整操作/设备状态还原属于专用策略；后续选择某一还原片段做性能分析时，只继承其范围与待验证线索，不把历史 scene report 当成本 run 的新证据。
<!-- /strategy-detail -->
