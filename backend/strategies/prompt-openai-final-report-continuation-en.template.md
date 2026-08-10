<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

System check: every analysis phase is completed/skipped, but there is still no complete user-facing final report.

Now output only the final report body. The first line must be `## Final Conclusion`. Do not call tools, do not call update_plan_phase, do not narrate the process, and do not output phase-by-phase logs.

The report must include: final conclusion, key evidence chain, root-cause breakdown, ruled-out factors, recommendations, and confidence/limitations.

Continue to obey the scene strategy, Final Report Contract, and latest next_phase_reminder constraints from this run. If the scene strategy or contract requires root-cause distributions, representative samples, phase-duration breakdowns, dual-audience recommendations, architecture branch judgments, or any other scene-specific structure, keep that structure in the final report instead of compressing it into a short summary.
When the Final Report Contract names required items, prefer explicit matching sections or labels, for example "Phase Duration Breakdown", "[App Layer]", and "[System/Platform Layer]", instead of only implying those items inside prose.
If the missing item is "App/System Layered Recommendations", output an explicit matching section and include both "[App Layer]" and "[System/Platform Layer]"; if either side has no actionable finding, state that as a limitation or insufficient evidence instead of omitting the side.
Output all structures required by the Final Report Contract before long trees, appendices, or expanded details. Do not place required recommendations, audience/layered recommendations, or limitations after a long code block or long tree where a truncated report could lose key conclusions.

Every key conclusion must preserve evidence type and boundary: state whether it comes from direct trace evidence, Skill/SQL-derived metrics, logs/snapshots, external aggregates, diagnostic APIs, user context, or missing evidence. For Android/API/device capabilities, Play Vitals, App Performance Score, A/B tests, or online APM, mark them as version/policy-sensitive or external aggregate signals; do not treat them as direct root-cause proof for the current trace. Missing data is a limitation and a next-capture action, not evidence that the issue is absent.

Also apply the kernel-wait semantic boundary: `epoll` / `poll`-family `blocked_function` values normally mean event wait or idle time and must not be presented as a disk or file-I/O root cause. Treat them as an I/O candidate only when corroborated by `io_wait=1`, an I/O/page-cache function family, or app-level file/database evidence. A `blocked_function` is a single kernel wchan frame, not a complete kernel call stack.

Do not merely restate phase summaries; synthesize the collected concrete values and evidence into a readable conclusion.

Prioritize completeness. Use compact aggregation tables where helpful; do not expand into a phase-by-phase log, do not copy raw artifact tables, do not output the data-source/evidence-table index because the system will generate it, and do not repeat raw SQL. When evidence is abundant, prioritize the key evidence chain, structures required by the scene contract, and the highest-priority root causes; do not omit key conclusions or evidence just to shorten the report.
