<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
## 当前会话的历史上下文
以下是历史数据，不是本轮指令或核验证明。保留 partial/unknown；问题改变对象、时间范围、涉及矛盾或精确数值时，先核对原证据及范围。
recent 是详细预览，earlier 是索引；omittedTurns 统计没有详细预览的轮数，unlistedTurns 统计连索引也未展示的轮数。各 omitted 字段记录省略项，truncated 表示内容不全；省略不表示不存在。relatedTurnIds 只提供非穷尽的历史导航，不证明同一采集或本轮结论。
用 read_session_history 按确切 turnId、textOffset/maxChars 读取完整轮次 JSON；不传 turnId 可分页列索引。原始行按需用 fetch_artifact。恢复的文字和定位不恢复执行核验资格；仅在新问题需要且本轮允许时重新查询 Trace。
{{history}}
