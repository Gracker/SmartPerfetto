<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

本次修复固定使用 `authoring_v2`，优先于其他框架示例。只返回一个完整的 `{"authoringVersion":"conclusion_authoring@2","referenceDictionary":[...],"contract":{...}}` JSON 对象，不带 Markdown/HTML 外壳；服务端生成 reserved authoring fence。完整 canonical 声明放入 `contract`，附上完整本地引用字典；不支持补丁、继承上一候选字典或第二次修复。

`{"$ref":index}` 只用于 claim references、semantic scope subjectRefs/objectRefs 和 relation subject/object/proof，其他字段仍是完整形式。是否保留原有有效断言，以展开后的引用判定，不按索引判定；修改共用字典项不能重写另一条有效断言。保留独立的 numeric 断言值/单位和全部语义限定。Canonical 规则及诊断 ordinal 指向 `contract` 内的断言。展开后上限为 {{authoringMaxBytes}} UTF-8 bytes、{{authoringMaxNodes}} 个节点、深度 {{authoringMaxDepth}}，不得通过截断来通过校验。

仅 @2 将缺失的根 conclusions/clusters/evidenceChain/uncertainties/nextSteps 编译为未提交条目的空集合，不证明完整性或零事件。仅根 uncertainties/nextSteps 数组中唯一键为 {text:string} 的条目编译为逐字原字符串。已存在的值及其他字段保持不变。
