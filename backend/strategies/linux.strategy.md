<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: linux
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: linux_critical_path
      domain: critical_path
      description: "Bind the requested workload, process instance and critical threads/windows using available Linux trace identities. Analyze relevant state, runqueue signals, frequency/load and observed priority without Android startup or MainThread assumptions."
    - id: linux_dependencies
      domain: dependency_chain
      description: "Preserve homogeneous topology and missing perf/PSI/policy capabilities as explicit boundaries. Distinguish user/kernel work, blocking, IRQ and peer activity using observed evidence."
classification_description: "Linux system behavior, scheduling and workload performance in traces outside an Android-specific workflow."
priority: 7
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - cpu_freq_idle
  - perf_samples
keywords:
  - linux
  - kernel
  - sched
  - runqueue
  - runnable
  - pmu
  - perf
  - cache miss
  - branch miss
  - rss
  - swap
  - 内核
  - 调度
  - 调度延迟
  - 缓存未命中
  - 分支预测

---

#### linux Core Strategy

**Route card**: linux / kernel / sched / runqueue / runnable / pmu / perf / cache miss / branch miss / rss

**Capabilities**: required=[cpu_scheduling], optional=[cpu_freq_idle, perf_samples]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- sched_or_linux_signal: Linux 调度问题需要包含 sched latency 或 runqueue 深度分析 (requires one of: invoke_skill(linux_sched_latency_distribution), invoke_skill(linux_runqueue_depth_timeline))

**Phase reminders**
- sched_latency: 调度问题优先调用 linux_sched_latency_distribution 和 linux_runqueue_depth_timeline；如果用户给定时间窗必须传 start_ts/end_ts。 工具: linux_sched_latency_distribution, linux_runqueue_depth_timeline
- pmu_perf: PMU 问题调用 linux_perf_counter_hotspots。无 perf sample/counter 数据时必须说明 trace 未启用 PMU，不能给 cache/branch 结论。 工具: linux_perf_counter_hotspots
- linux_memory: Linux 进程内存问题调用 linux_process_rss_swap_timeline；page fault/reclaim 仍用 page_fault_in_range 做窗口级阻塞证据。 工具: linux_process_rss_swap_timeline, page_fault_in_range

**Final report contract summary**
- 遵循通用输出契约。


**Detail ref**
- `linux:full`: Linux 内核 / 调度 / PMU 分析 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="linux full strategy detail" keywords="linux,linux,kernel,sched,runqueue,runnable,pmu,perf,cache miss,branch miss,rss,swap,内核,Linux 内核 / 调度 / PMU 分析,detail,full" default="true" -->
#### Linux 内核 / 调度 / PMU 分析

Linux 场景必须先判断 trace 是否包含对应数据源：sched 基础数据通常存在，PMU/perf counter 需要额外 trace_config，RSS/swap 需要内存 counters。

**Phase 1 — 调度延迟与 runqueue：**

```
invoke_skill("linux_sched_latency_distribution", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
invoke_skill("linux_runqueue_depth_timeline", { start_ts: "<start>", end_ts: "<end>" })
```

用于判断 Runnable→Running 等待是否构成瓶颈，以及系统级 runnable thread count 是否持续高压。

**Phase 2 — PMU / perf counter（仅数据可用时）：**

```
invoke_skill("linux_perf_counter_hotspots", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
```

无 perf samples/counters 时，结论必须是"当前 trace 不支持 PMU 判断"。

**Phase 3 — 进程内存 / page fault：**

```
invoke_skill("linux_process_rss_swap_timeline", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
invoke_skill("page_fault_in_range", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
```

RSS/swap 是容量证据，page fault/reclaim 是阻塞证据，不能互相替代。
<!-- /strategy-detail -->
