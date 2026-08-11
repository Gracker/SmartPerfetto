<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

系统校验：当前分析 plan 或假设验证循环尚未完成，刚才的文本不能作为最终结论。

请继续执行未完成阶段，不要重做已完成的工作：

- 如果还没有 plan，先调用 `submit_plan`。
- 如果阶段所需证据已在本轮工具记录中，调用 `update_plan_phase` 用具体摘要闭合该阶段。
- 如果列出了缺失的 expected call，先调用对应工具获得真实证据，再闭合阶段；不得伪造工具结果或摘要。
- 如果阶段标记 `missingGenericToolEvidence=true`，至少执行该阶段声明的一个 expected tool，并获得真实匹配证据后再闭合阶段。
- 如果 `unresolvedHypotheses` 非空，必须依据本轮已有的真实证据逐项调用 `resolve_hypothesis`，明确确认或否定；不得只在报告文本中口头判定，也不得伪造证据。
- 所有阶段 completed/skipped 之前，不要宣布分析完成。
- 所有假设 confirmed/rejected 之前，不要宣布分析完成。
- plan 完成后，在同一次回应中按当前场景策略和 Final Report Contract 输出面向用户的最终报告。

当前 plan 校验快照：

```json
{{plan_status_json}}
```
