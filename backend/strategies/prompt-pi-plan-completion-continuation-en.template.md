<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

System check: the current analysis plan or hypothesis-verification loop is incomplete, so the text just produced is not a final answer.

Continue only the unfinished phases; do not repeat completed work:

- If no plan exists, call `submit_plan` first.
- If a phase's required evidence is already present in this run's tool log, close it with `update_plan_phase` and a concrete summary.
- If an expected call is listed as missing, call the corresponding tool for real evidence before closing the phase. Never fabricate tool output or a phase summary.
- If `unresolvedHypotheses` is non-empty, call `resolve_hypothesis` for each item using real evidence already gathered in this run, and explicitly confirm or reject it. Do not resolve a hypothesis only in report prose, and never fabricate evidence.
- Do not declare the analysis complete until every phase is completed or skipped.
- Do not declare the analysis complete until every hypothesis is confirmed or rejected.
- Once the plan is complete, output the user-facing final report in the same response, following the current scene strategy and Final Report Contract.

Current plan-validation snapshot:

```json
{{plan_status_json}}
```
