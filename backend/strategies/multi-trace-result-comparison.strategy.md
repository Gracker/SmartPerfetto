<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: multi_trace_result_comparison
investigation_contract:
  schema_version: 1
  profiles:
    - {id: result_comparison, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: multi_trace_result_comparison_critical_path
      domain: critical_path
      description: "Retain each saved snapshot identity, original scene, scope and evidence pin. Compare stored app and system findings in their original windows; missing investigation coverage remains unknown."
    - id: multi_trace_result_comparison_dependencies
      domain: dependency_chain
      description: "Explain compatible deltas, alternatives and incomparable dimensions using saved artifacts. Do not query original traces, reinterpret missing values as zero, or generalize one side coverage to the pair."
classification_description: "Comparing previously saved analysis results or snapshots, including scope and metric differences between results."
priority: 0
effort: medium
required_capabilities: []
optional_capabilities: []
keywords:
  - 分析结果对比
  - 结果对比
  - 多 Trace 结果对比
  - 多 trace 结果对比
  - 多个 Trace 结果对比
  - 两个 Trace 结果对比
  - 另一个 Trace 的分析结果
  - 另外一个 Trace 的分析结果
  - snapshot 对比
  - SID 对比
  - analysis result comparison
  - result comparison
  - multi trace result comparison
  - compare snapshots
  - compare analysis results

---

#### multi_trace_result_comparison Core Strategy

**Route card**: 分析结果对比 / 结果对比 / 多 Trace 结果对比 / 多个 Trace 结果对比 / 两个 Trace 结果对比 / snapshot 对比 / SID 对比 / analysis result comparison / result comparison

**Capabilities**: required=[none], optional=[none]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- snapshot_scope: 分析结果对比必须先确认 snapshot 范围、baseline 和 candidates (required: get_comparison_context)
- comparison_matrix: 分析结果对比必须构造 ComparisonMatrix，并基于结构化 metric 输出 delta (required: invoke_skill(multi_trace_result_comparison))

**Phase reminders**
- result_snapshot_selection: 必须先确认要对比的是 AnalysisResultSnapshot/SID/result，而不是实时 raw trace pair 对比。候选不唯一时必须让用户选择 baseline 和 candidates。
- matrix_first: 定量结论只能来自 ComparisonMatrix 的 normalized metrics。缺失 metric 要标注 missing reason；只有允许回填时才请求 trace backfill。
- raw_trace_boundary: 如果当前会话已经有 `referenceTraceId` 或 `tracePairContext`，用户只说“对比两个 Trace/左右 Trace/上下 Trace”的启动、滑动、FPS、频率等原始数据差异时，不使用本策略；应走双 Trace raw comparison 的 `get_comparison_context`、`compare_skill`、`execute_sql_on`。

**Final report contract summary**
- 遵循通用输出契约。


**Detail ref**
- `multi_trace_result_comparison:full`: 分析结果对比（用户提到多个 Trace 的已有分析结果、snapshot、SID/result、另一个 Trace 的分析结果） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="multi_trace_result_comparison full strategy detail" keywords="multi_trace_result_comparison,分析结果对比,结果对比,多 Trace 结果对比,多 trace 结果对比,多个 Trace 结果对比,两个 Trace 结果对比,snapshot 对比,SID 对比,analysis result comparison,result comparison,multi trace result comparison,compare snapshots,分析结果对比（用户提到多个 Trace 的已有分析结果、snapshot、SID/result、另一个 Trace 的分析结果）,detail,full" default="true" -->
#### 分析结果对比（用户提到多个 Trace 的已有分析结果、snapshot、SID/result、另一个 Trace 的分析结果）

这是多窗口/多用户结果快照对比，不是当前会话里已打开两个 Trace 的实时 raw data 对比。

**核心原则：**
1. 先对比 `AnalysisResultSnapshot`，不默认唤醒原 TraceProcessor。
2. 定量结论只来自 `ComparisonMatrix` 中的 normalized metrics。
3. 不同 scene、设备、包名或采集配置不一致时，结论必须降级并明确说明。
4. 每个关键数值必须能追溯到 snapshot、metric key 和 evidence refs。
5. AI 只能解释差异，不允许从自然语言报告里重新抽取或发明指标。
6. 如果用户说的是已打开的左/右或上/下 Trace 原始数据差异，而不是已有结果/snapshot/SID，则不要使用本策略。

**Phase 1 — Snapshot 范围确认：**

- 当前窗口已有 latest snapshot 时，把它作为默认 baseline 候选。
- 通过结果目录或候选选择器确认其他可读 snapshot。
- 候选唯一时可以直接发起 comparison；候选不唯一时必须让用户确认。
- baseline 必须明确；不要把“当前 Trace”隐式当成所有场景的 baseline。

**Phase 2 — 构造 ComparisonMatrix：**

- 使用 `multi_trace_result_comparison` Skill contract 描述输入输出边界。
- 构造输入：`snapshot_ids`, `baseline_snapshot_id`, 可选 `metric_keys`, 原始 `query`。
- 默认 metric 范围：`startup.total_ms`, `scrolling.avg_fps`, `scrolling.jank_rate_pct`。
- 用户显式要求某个 metric key 时，优先加入 matrix；缺失时进入缺失矩阵。

**Phase 3 — 缺失与回填：**

- snapshot 已有 metric 时优先使用快照值。
- snapshot 缺少标准 metric，且用户或策略允许回填时，才能回查原 Trace。
- 回填失败时 comparison 仍完成，并把失败原因写入 missing matrix / uncertainty。
- 自定义 metric 没有定义 extractor 时不要硬算，返回不支持或缺失原因。

**Phase 4 — 结论输出：**

输出必须包含：

1. `ComparisonMatrix` delta 表，包含 baseline、candidate 值、delta、deltaPct 和 trend。
2. 显著变化列表，只列出有结构化证据的变化。
3. 不可比/缺失/回填失败说明。
4. AI 解释分为“已验证事实”和“推断”，推断必须基于 matrix 中的事实。

禁止：

- 使用 raw trace pair 的 `execute_sql_on("reference")` 路线替代结果快照对比。
- 对单侧缺失 metric 给出百分比变化。
- 用报告正文里的描述覆盖 normalized metric。
<!-- /strategy-detail -->
