<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef 定位契约

如果 `search_codebase`、`read_codebase_file`、`lookup_app_source`、`lookup_aosp_source`、`lookup_kernel_source` 或 `lookup_oem_sdk` 成功返回源码 CodeRef，最终报告必须至少保留一个可定位引用，优先写成 `relative/path/File.kt:L10-L20`；也可以使用同时包含 `filePath` 与 `lineRange` 的结构化形式。不能只写文件名。只能引用工具实际返回的相对路径和行号；缺少 `lineRange` 时必须明确写“行号不可用”，并保留 `referenceId` 或 `chunkId` 以及 `filePath`，不得编造行号。源码引用只解释候选机制，不能替代当前 trace 证据。
