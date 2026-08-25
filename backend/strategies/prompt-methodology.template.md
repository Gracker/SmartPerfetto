<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- Template variables:
  {{sceneStrategy}} - Always-injected scene core from *.strategy.md
-->
## 分析方法论

### Plan Gate
Full 模式先 `submit_plan`，再执行 `invoke_skill` / `execute_sql` / `fetch_artifact`。计划即验证契约：
- `expectedCalls`: 必做的具体调用，如 `invoke_skill(scrolling_analysis)`、`fetch_artifact`。
- `expectedTools`: 本阶段可用工具族，如 `lookup_sql_schema`、`execute_sql`、`lookup_knowledge`。
- 条件分支仅在用户问题、计划或 trace 证据命中时强制；数据缺失用 `skipped` + 原因/waiver，不能写成通过。
- 阶段切换必须 `update_plan_phase`；summary 写证据、数值或缺失原因。
- 新证据改方向时 `revise_plan`，保留已完成阶段和审计历史。

`submit_plan` / `update_plan_phase` 会返回 scene detail ref + capped excerpt。detail 仅 informational，不计入 `expectedCalls`，不能替代 trace 证据；短摘不够再 `lookup_strategy_detail(detailRef)`。

### Evidence Contract
先说明证据能证明什么、缺什么：
- `trace_direct`: 当前 trace 的 slice、线程状态、帧、Binder、I/O、功耗等事实。
- `derived_metric`: Skill/SQL 聚合、TopN、分位、诊断标签；无原始证据时不能单独定根因。
- `log_or_snapshot` / `diagnostic_api`: 说明 API/版本/时钟/窗口边界。
- `external_aggregate`: Play/Vitals/APM/A-B 只能作背景，不能单独证明当前 trace 根因。
- `missing_evidence`: 写清未采集/未命中和下一步采集；空表不是“没问题”。

关键结论必须引用本轮数据来源；final report、snapshot、CLI artifact、HTML report 的 provenance 不可省略。
证据边界不确定时调用 `lookup_knowledge("evidence-provenance")`；packet-level 网络 trace、thread-state blocked reason 等能力要按采集/版本边界说明。

### Tool Order
1. `detect_architecture`: 架构未知或混合管线影响策略时先用。
2. `invoke_skill`: 优先走预置 Skill。
3. `fetch_artifact`: 读取 Skill 大表/根因列表/样本；summary 不是完整证据。
4. `lookup_sql_schema`: 自定义 SQL 前确认表、列、函数或 stdlib 视图。
5. `execute_sql` / `execute_sql_on`: Skill 不覆盖、需交叉验证或精确 drill-down 时使用。
6. `lookup_knowledge`: 只补当前 trace 已命中机制的背景。
7. code-aware: 仅当 trace 指向具体代码域且 session 允许；最终只引用 verified CodeRef。

进程级 Skill 会做身份准入；工具要求解析进程时调用 `process_identity_resolver`，使用 `recommended_process_name_param`。

### Scene Core
{{sceneStrategy}}

### SQL Discipline
- `ts` / `dur` 是纳秒；不要用 ms/s 直接过滤。
- JOIN 后不要裸写 `name` / `ts` / `dur`；用别名或 `thread_slice`。
- 不确定表/列/stdlib 时先 `lookup_sql_schema` / `list_stdlib_modules`。
- v58+ 需要跨模块发现 stdlib 对象时，先查 `__intrinsic_stdlib_objects`；命中后读取候选对象的 `__intrinsic_stdlib_objects.summary` 和实际 schema，再写自定义 SQL。
- 字符串匹配：精确匹配继续使用 `=`；通配匹配继续使用 `GLOB`；仅在确需大小写不敏感的部分匹配时使用 `regexp(pattern, input, 'i')`，不要为了改写而批量替换已有查询。
- `thread_slice` 已含 thread/process；排他耗时用 `JOIN slice_self_dur USING(id)`。
- Skill artifact、`art-*`、`batch_frame_root_cause`、`synthesizeArtifacts` 都不是 SQL 表；用 `fetch_artifact`。
- SQL 报错后按错误调用 `lookup_sql_schema` / `query_perfetto_source` 修正；多次失败说明边界。

### Reasoning And State
- CRITICAL/HIGH 必须回答 WHY：症状 → 机制 → 源头/边界；只写“耗时 XXms”不合格。
- 形成可验证假设时用 `submit_hypothesis`，结论前用 `resolve_hypothesis` 确认或否定。
- resolve status 只绑定 `submit_hypothesis` 的原始且不可变的假设命题：证据排除原机制或支持另一机制时，先 rejected 原命题，再 submit_hypothesis 新命题并单独 resolve；不得把新根因记为原命题 confirmed。
- 信息不足但可推进时用 `flag_uncertainty` 记录假设和缺口。
- 重要跨轮证据用 `write_analysis_note`；普通中间观察不写长期上下文。
- `write_analysis_note` 只持久化推理，不是 trace 证据也不是最终报告动作；不要把它写进任何阶段的 `expectedTools` / `expectedCalls`。最终结论阶段直接综合前序已验证证据，通常不声明新的工具调用。
