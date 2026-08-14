<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

本次补写还必须修正以下质量门禁问题，并只使用本轮已采集的证据；不能为了通过门禁而补造 `io_wait`、`blocked_function`、文件/数据库调用或其他证据。下方包含门禁消息；如果门禁能够定位，还会在末尾给出 JSON 字符串形式的具体违规句。必须删除或改写完整报告中的该违规句及同义表述，不能在标题、表格、已排除因素或限制中原样保留：

{{quality_issue_context}}

若现有证据不足以支持原根因，请明确降级为候选、限制或已排除项，并写出下一步需要采集的证据。
