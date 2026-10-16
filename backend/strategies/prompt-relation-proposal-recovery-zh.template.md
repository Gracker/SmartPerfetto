<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

按以下精确格式修复 `relationProposals`。集合必须是数组。每个条目只能包含 `schemaVersion`、`id`、`kind`、`direction`、`subject`、`object`、`proof`、`proofBindings`、`metricColumn`、`value`、`unit`、`deltaDirection`。必填字段为 `schemaVersion: "evidence_relation_candidate@1"`、匹配 `^proposal:[A-Za-z0-9][A-Za-z0-9_.:-]*$` 的 `id`、一个合法 `kind`、一个合法 `direction` 和 `subject`。kind 只能是 `overlap`、`wakeup`、`blocking_state`、`binder_peer`、`lock_owner`、`comparison_delta`、`derived`；direction 只能是 `subject_to_object`、`object_to_subject`、`symmetric`。

`subject`、可选 `object`、可选 `proof` 都只能包含 `evidenceRefId`、`sourceRef`、`sourceToolCallId`、`artifactId`、`sourceArtifactId`、`rowIndex`、`rowSelector`、`column`、`value`。每个端点至少需要一个非空标识；可选标识和 `column` 必须是非空字符串；`rowIndex` 必须是非负安全整数；`rowSelector` 必须是非空对象，键非空，值只能是字符串、有限数字或布尔值。端点的 `value` 还可显式为 null。

提案顶层可选 `value` 只能是字符串、有限数字或布尔值，不能是 null。可选 `metricColumn`、`unit` 必须是非空字符串；可选 `deltaDirection` 只能是 `current_minus_reference`。如果存在 `proofBindings`，它必须恰好同时包含 `subject` 和 `object`；两侧都必须恰好包含非空字符串 `endpointColumn` 和 `proofColumn`。

保持每个提案、有效 ID、含义和已签发引用不变，不得删除或替换提案绕过校验。该格式只声明候选关系，不授予证据、验证、关系成立或因果权威。
