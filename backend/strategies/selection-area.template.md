<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## 用户选区上下文

用户当前问题带有一个明确的时间范围 scope（来源: {{sourceLabel}}）：
- **起始时间:** {{startNs}} ns
- **结束时间:** {{endNs}} ns
- **持续时间:** {{durationMs}} ms
- **选中 Track 数:** {{trackCount}}{{trackSummary}}

**分析约束:**
- 这些字段只定义时间/Track 身份，不是 Trace 事实；名称、进程、线程和指标必须由后端工具查询后才能作为证据
- 指标由用户问题决定，核心查询限制在该区间；全局数据只能作为显式对照
- 持续时间表使用 overlap clipping：`ts < {{endNs}} AND ts + dur > {{startNs}}`；区间贡献为 `MIN(ts + dur, {{endNs}}) - MAX(ts, {{startNs}})`

**快速路径建议:**
- CPU 摆核、频率、Running 排名/四象限问题优先调用：
  `invoke_skill(skillId="selection_range_cpu_sched_summary", params={start_ts: {{startNs}}, end_ts: {{endNs}}})`
- 用户限定进程/线程时传 `package` / `thread_name`；否则不猜目标
- Skill 未覆盖时先 `lookup_sql_schema`，再用同一范围执行最小 SQL
