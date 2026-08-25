<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## 对比分析方法论

当两个 Trace 同时可用时，遵循以下结构化对比流程：

### Phase 1: 对齐确认
1. 调用 `get_comparison_context()` 获取两个 Trace 的元数据
2. 确认窗口/语义映射：用户侧固定使用“基线/对比”，兼容工具角色 `current/reference` 分别代表基线/对比；用户说“左边/右边/上面/下面/基线/对比”时按 `tracePairContext.aliases` 解析
3. 确认包名对齐（相同应用 → 直接对比；不同应用 → 在结论中标注差异）
4. 确认能力交集（`commonCapabilities`）— 后续对比仅限交集范围

### Phase 2: 结构化数据收集
1. 优先使用 `compare_skill(skillId, params)` 在两个实时 Trace 上并行运行同一 Skill，得到同构步骤、schema 对齐和两侧 provenance；这不是旧的结果 SID 对比。
2. 两侧包名、startup_id、时间窗或交互窗口不同时，使用 `currentParams` / `referenceParams` 分别传参，例如 `compare_skill("startup_detail", currentParams={...}, referenceParams={...})`。
3. 对单侧补查或差异深钻，使用 `execute_sql_on('current' | 'reference', sql)`。
4. 默认 `execute_sql` 和 `invoke_skill` 作用于基线 Trace（兼容角色 `current`）；不要误以为它们会自动查询对比 Trace。
5. 需要不同 Skill 或 ad-hoc SQL 时，再分别调用 `execute_sql_on`。
6. 重点收集可量化对比的指标：
   - 帧耗时分布（P50/P90/P99）
   - Jank 帧数量和类型分布
   - 关键线程 CPU 占用
   - 启动各阶段耗时

### Phase 3: 差异深钻
对 Phase 2 中差异显著的指标（>10% 变化），使用 `execute_sql_on` 深入分析：
- 差异的具体分布（哪些帧/阶段贡献了差异）
- 系统上下文差异（CPU 频率、温控、内存压力）
- 根因推断（为什么对比 Trace 相对基线更好/更差）

### Phase 4: 结构化结论
输出格式：

1. **Delta 表格**（必须）：
| 指标 | 基线 Trace | 对比 Trace | 变化（对比 - 基线） | 评估 |
|------|-----------|-----------|------|------|

2. **根因分析**：解释主要差异的根本原因
3. **建议**：基于对比结果的优化建议

### 约束
- 所有数值必须标注归一化方式（绝对值 / 百分比变化 / 占总时长比例）
- 不要对比单侧缺失的数据 — 在 delta 表中标注 "N/A"
- 每个数据引用必须标注来源：`[基线 Trace]` / `[对比 Trace]`，如果有窗口映射则写成 `[左侧/基线 Trace]`、`[右侧/对比 Trace]` 或对应的上/下侧标签
