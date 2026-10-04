<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: runtime_correctness
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: runtime_correctness_critical_path
      domain: critical_path
      description: "Bind the actual app crash, ANR, LMK or memory-growth event and affected tasks/windows. Relate failure-path task states and system pressure when relevant; exception names alone do not imply a scheduling cause."
    - id: runtime_correctness_dependencies
      domain: dependency_chain
      description: "Separate crash, resource exhaustion and timeout evidence from performance symptoms. Missing failure or exit evidence limits diagnosis; this scene is not a request to repair the analyzer backend runtime."
classification_description: "Application runtime failures and correctness, including crashes, process termination and failures involving memory or blocking."
priority: 5
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - memory_pressure
  - binder_ipc
  - lock_contention
keywords:
  - runtime
  - correctness
  - anr
  - oom
  - lmk
  - leak
  - memory leak
  - native heap
  - heapprofd
  - 运行时
  - 正确性
  - 内存泄漏
  - 崩溃
  - 卡死
  - 杀进程

---

#### runtime_correctness Core Strategy

**Route card**: runtime / correctness / anr / oom / lmk / leak / memory leak / native heap / heapprofd / 运行时

**Capabilities**: required=[cpu_scheduling], optional=[memory_pressure, binder_ipc, lock_contention]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- runtime_primary_signal: 运行时正确性场景需要至少包含 ANR、内存增长、LMK/OOM 或 native heap 的一条主证据链 (requires one of: invoke_skill(anr_analysis), invoke_skill(memory_growth_detector), invoke_skill(native_heap_breakdown), invoke_skill(lmk_kill_attribution))

**Phase reminders**
- anr_chain: ANR/卡死先调用 anr_analysis；若定位到具体 ANR 事件，再用 anr_detail 深钻。 工具: anr_analysis, anr_detail
- memory_growth: 内存增长/泄漏先调用 memory_growth_detector；涉及 LMK/OOM 时补 lmk_kill_attribution 和 oom_adjuster_score_timeline。 工具: memory_growth_detector, lmk_kill_attribution, oom_adjuster_score_timeline
- native_heap: native heap 问题调用 native_heap_breakdown。无 heapprofd 数据时必须说明 trace 不支持 native heap attribution。 工具: native_heap_breakdown

**Final report contract summary**
- 遵循通用输出契约。


**Detail ref**
- `runtime_correctness:full`: 运行时正确性分析 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="runtime_correctness full strategy detail" keywords="runtime_correctness,runtime,correctness,anr,oom,lmk,leak,memory leak,native heap,heapprofd,运行时,正确性,内存泄漏,运行时正确性分析,detail,full" default="true" -->
#### 运行时正确性分析

运行时正确性关注"卡死、被杀、内存持续增长、native heap 泄漏"这类不是单纯帧时序的问题。

**Phase 1 — 选择主证据链：**

| 问题 | 调用 |
|---|---|
| ANR / 卡死 / 主线程无响应 | `invoke_skill("anr_analysis")`；有具体事件后 `invoke_skill("anr_detail", ...)` |
| 内存增长 / 疑似泄漏 | `invoke_skill("memory_growth_detector", { package: "<包名>" })` |
| LMK / OOM adj | `invoke_skill("lmk_kill_attribution")` + `invoke_skill("oom_adjuster_score_timeline", { process_name: "<包名>" })` |
| Native heap / heapprofd | `invoke_skill("native_heap_breakdown")` |

**Phase 2 — 交叉验证：**

内存增长需要和 GC、LMK、OOM adj、page fault/reclaim 区分；ANR 需要和 Binder、锁、IO、调度延迟区分。没有对应 trace 数据时必须标注不支持该维度。
<!-- /strategy-detail -->
