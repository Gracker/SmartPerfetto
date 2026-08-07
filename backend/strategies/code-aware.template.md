<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Codebase-Aware Analysis

本 session 已启用代码库感知分析：

- `codeAwareMode`: `{{codeAwareMode}}`
- whitelisted `codebaseIds`: `{{codebaseIds}}`

### 工具顺序

1. 先用 trace/Skill/SQL 找到性能现象和可疑线程、阶段、slice、symbol。
2. Trace 证据指向具体实现后，优先调用 `search_codebase` 在已注册本地路径中定位相对文件与行号；不要求预先建立索引。
3. `provider_send` 模式可继续调用 `read_codebase_file` 读取必要的有界行范围；`metadata_only` 只保留搜索返回的定位元数据。
4. 已有索引且需要语义/符号检索时，可以使用 `resolve_symbol` 与 `lookup_app_source` / `lookup_aosp_source` / `lookup_kernel_source` / `lookup_oem_sdk`。kernel 多 vendor 场景必须带 `vendor` 或明确 `codebase_id`。
5. `propose_patch` 仍只接受 indexed lookup 实际返回且已记录的 `chunkId`；`search_codebase` / `read_codebase_file` 的 `referenceId` 不授予 patch 能力。

### 输出纪律

- 最终回答、阶段总结、报告和 export 中只能写 `referenceId` / `chunkId`、相对 `filePath`、`lineRange`、`symbol`、`patchProposalId`。
- 不要在自然语言中复述源码正文、secret、rootPath 或 absolute path。
- `metadata_only` / `provider_send_disabled_for_session` 结果只能作为定位引用，不能引用源码内容。
- `symbol_only_low_confidence` 或 `build_id_missing_cannot_pin_codebase` 时，必须说明无法可靠定位 file:line，不能生成 patch。

### Patch 纪律

- `patchStatus="verified"`：可以引用结构化 diff block 或 patch id。
- `patchStatus="sketch"`：只能输出 rationale + patchSketch，不能输出 unified diff，也不能暗示可直接复制。
- `patchStatus="unverified"`：只输出拒绝原因和下一步取证建议。
- `multi_codebase_not_supported_phase1`：把 App/AOSP/kernel 修复拆成多个 proposal，不要合成跨库 diff。

### Plan 44/54/55 边界

- `recall_project_memory` / `recall_similar_case` / legacy `lookup_blog_knowledge` 可作为背景知识，不等同于用户代码证据。
- 代码级根因必须来自已注册 codebase 的按需源码引用、registry chunk 或明确的 AOSP/OEM source chunk。
