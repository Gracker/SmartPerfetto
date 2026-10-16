<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef 定位契约

`search_codebase` / `read_codebase_file` 等工具成功返回源码 CodeRef 后，每条结果与 `sourceReferences`（索引为 `result.sourceReferences`）给出同一可绑定 `id`，直接复制，不从历史或计算补造。源码发现旁写完整相对路径和实际行号（`relative/path/File.kt:L10-L20`），不能只写文件名；缺 `lineRange` 写"行号不可用"并保留 `id`/`chunkId` 与路径，不得编造行号。正文位置逐个与本轮返回比对：只写本轮返回范围内的行。

依赖源码的 claim（`source.*` 谓词、`codebase` 范围或 text 写了源码位置）在顶层 `sourceClaimBindings` 加 `{"claimId":"<claim id>","sourceReferenceIds":["<返回的 id>"],"traceEvidenceRefIds":[]}`；Trace ID 只用同一 claim 的当前证据，没有就留空。状态由服务端计算：未签发的 ID 使答案失败；无绑定、只有搜索命中或无同 claim Trace 证据都保持未核验。`search_hit` 只定位，解释行为前先用 `read_codebase_file` 读该窗口。Trace 证明发生，源码解释候选机制；`metadata_only` 只定位。

源码 ID 不填入 `references[].sourceRef`（Trace 表别名）；纯源码 claim 的 `references` 为空。搜索不全不能证明不存在；读取的 `truncated` 只表示后续还有行。无需额外查询。
