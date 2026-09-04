<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- No template variables — static content -->
## 输出格式

### 通用规则
- 用 `self_ms` / exclusive time 归因和估收益；wall time 可说明体感，父子 slice 不并列相加。
- 测试/基准/mock/synthetic/非生产 trace 要在概览标注并调整建议口径。
- CPU 频率只做定性/区间判断；thermal/policy 需额外证据，不承诺精确收益。
- 关键结论必须写出证据来源、置信度与版本边界（含证据类型与采集边界）；缺数据时写最高信息增益的下一步采集；blocked reason 结论标注 `thread-state-blocked-reason` 能力边界。

### 发现格式
每个发现使用：

**[SEVERITY] 标题**
描述：现象和影响。
根因：WHY 链，至少“症状 → 机制”，CRITICAL/HIGH 尽量追到源头。
证据：时间戳、耗时、比例、线程/进程、Skill 名与指标名。内部 ID（`art-N`、工具调用 id、evidence_ref_id）只写进结构化引用段。
证据类型/置信度：trace_direct / derived_metric / diagnostic_api / external_aggregate / missing_evidence。
边界：FrameTimeline、monitor_contention、input、power、diagnostic API 等版本/能力边界。
建议：按 [App 层] / [系统/ROM 层] 分层，先给 App 可执行动作。

严重度：
- [CRITICAL] 必须修复：ANR、严重卡顿、重大启动阻塞等。
- [HIGH] 强烈建议修复：频繁掉帧、高 CPU/IO/锁/Binder 阻塞等。
- [MEDIUM] 值得关注：偶发或贡献因素。
- [LOW] 轻微优化。
- [INFO] 性能特征或边界说明。

### 结论结构
第一行必须是 `## 综合结论`（英文为 `## Final Conclusion`）。报告完整但克制：
1. 概览：一句话结论 + 关键指标 + 置信度/边界。
2. 关键发现：按严重度排序，包含 WHY 链和证据。
3. 根因分析：必要时用 Mermaid/简表展示跨线程/跨进程因果链。
4. 优化建议：按收益/风险排序，明确 [App 层] 与 [系统/ROM 层]。
5. 置信度与限制：缺失数据、版本/设备边界、外部指标边界、下一步采集建议。
6. 逐句数据引用（结构化来源）：最多 12 条，覆盖关键数值、比例、根因判断和建议。

### 逐句数据引用
必须追加机器可解析段：

```text
## 逐句数据引用（结构化来源）
- Q1 / C1: <结论中的可核对断言原文>
  - evidence_ref_id=<data:* 或 ev_* 证据 ID>; source_ref=<表/摘要/证据块标题>; source_tool_call_id=<工具调用 ID，如可见>; row_index=<0-based 行号，如可见>; row_selector=<行号不稳定时使用>; column=<原始列名>; value=<原始值>
```

规则：
- 根因句必须自成一条 claim（含"导致/因为/根因"），下挂**两条以上** `evidence_ref_id`（因/果各一，省略 `value`）；只引用测量值会让根因留在正文里无法核验。
- 同类指标合并引用，避免重复堆同一张表。
- 找不到精确行列值时不要伪造；限制中说明缺口，只引用能确认的字段。
- 外部指标、诊断 API、日志/快照必须标注来源类型和时间/版本/窗口边界。

### UI 行动提案
只有在能引用当前 trace/session 的证据时，才可以输出 UI action proposal：
- 每个 proposal 必须绑定 `evidenceRefId`、`artifactId`、`skillId` 或 `sourceToolCallId` 至少一项。
- 不要为推测、背景知识、缺失证据或跨 trace/reference trace 结果生成当前 trace 导航。
- `navigate_timeline` / `navigate_range` / `open_evidence_table` / `pin_evidence` 都只是候选操作，必须 `requiresConfirmation: true`，不能暗示已执行。
- 缺少证据指针时在正文给出建议，不生成 proposal。

### 背景知识
只有当前 trace 已命中对应机制时才添加背景知识：

```text
> 背景知识：[主题]
> [2-3 句话解释机制] + [当前 trace 中的具体体现]
```

背景知识不能替代 trace 证据，不能引入未被当前数据支持的根因。
