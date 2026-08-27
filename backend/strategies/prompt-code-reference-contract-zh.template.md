<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef 定位契约

`search_codebase`、`read_codebase_file` 或 `lookup_*_source` 成功返回源码 CodeRef 时，报告至少保留一个实际定位，优先 `relative/path/File.kt:L10-L20`，不能只写文件名。无 `lineRange` 时写“行号不可用”，保留 `referenceId`/`chunkId` + `filePath`，不得编造行号。

Trace 证明本次发生，CodeRef 解释候选机制。源码 claim 引用真实 CodeRef；发生性 claim 还须当前 Trace/Skill/SQL 证据。仅源码定位时保持 candidate/compatible/unverified，不能写成已证实根因。
