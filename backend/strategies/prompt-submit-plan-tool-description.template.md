<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Optionally submit a structured analysis plan. Define phases with goals and expected tools. The system tracks plan adherence and warns on deviation. Use when: an explicit multi-phase plan helps organize the analysis.
Don't use when: plan already submitted (use revise_plan to modify, update_plan_phase to track progress).
expectedCalls skillId is only valid for invoke_skill/compare_skill; scope every other tool as {tool:"fetch_artifact"} or {tool:"execute_sql"} with no skillId.

Examples:
1. Scrolling plan: phases=[{id:"p1", name:"概览采集", goal:"获取帧统计和卡顿分布", expectedTools:["invoke_skill"], expectedCalls:[{tool:"invoke_skill", skillId:"scrolling_analysis"}]}, {id:"p2", name:"根因分析", goal:"逐帧诊断卡顿原因", expectedTools:["invoke_skill","execute_sql"], expectedCalls:[{tool:"invoke_skill", skillId:"jank_frame_detail"}]}, {id:"p3", name:"深入验证", goal:"验证根因假设", expectedTools:["execute_sql","fetch_artifact"]}], successCriteria="识别卡顿根因并提供量化证据"
