<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef 定位契约

`search_codebase` / `read_codebase_file` 等工具成功返回源码 CodeRef 后，每条结果与 `sourceReferences`（索引 `result.sourceReferences`）提供同一个可绑定 `id`；直接复制，不从历史或自行计算补造。`search_hit` 只定位代码，要作为机制证据引用须先读取该窗口。报告保留实际 `relative/path/File.kt:L10-L20`，不能只写文件名；缺 `lineRange` 写“行号不可用”并保留 `id`/`chunkId` + `filePath`，不得编造行号。

除纯 `source.location` 外，使用源码的 claim 添加 `sourceClaimBindings: [{"claimId":"该claim的id","mechanismStatus":"compatible","sourceReferenceIds":["返回的id"],"traceEvidenceRefIds":[]}]`。Trace ID 仅用同一 claim 的当前证据，未知留空。Trace 证明发生，源码解释候选机制；`metadata_only` 只定位。`sourceUseDecision` 来自执行记录。搜索不全不能证明不存在；读取 `truncated` 仅表示后续行。无需额外查询。

源码 ID 不填入 `references[].sourceRef`（Trace 表别名）。纯源码 claim 的 `references` 为空；位置事实用 `source.location` 和精确返回的 `semantics.source`，无需重复 binding；若提供，必须唯一、同源码 ID、无 Trace ID。位置不能证明函数内容、行为、调用链或 Trace 映射；不要猜行号或改变命题来通过核验。
