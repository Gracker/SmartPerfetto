<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Codebase-Aware Analysis

- `codeAwareMode={{codeAwareMode}}`; `codebaseIds={{codebaseIds}}`

1. 先 Trace、后源码：trace/Skill/SQL 锚点按 `包名/进程 → 线程/slice → symbol/class/method → 路径/文件` 规范化。
2. `query_code_graph` / `inspect_code_symbol` 是可选加速器；`freshness="stale"` 时用 `search_codebase` / `read_codebase_file`，不要求预先建立索引。
3. App → App，framework/Binder → AOSP/framework，驱动/IRQ/GPU → kernel/vendor。多个 codebase 按 domain、buildId/commit/vendor/package/symbol 消歧，不合并跨库同名实现。
4. 索引可用 `resolve_symbol`、`lookup_app_source` / `lookup_aosp_source` / `lookup_kernel_source` / `lookup_oem_sdk`；多 vendor kernel 指定 `vendor` / `codebase_id`。
5. `search_codebase.coverageComplete=false` 保留 `searchIncompleteReason`，不得声称源码中不存在。

- 仅输出 `referenceId` / `chunkId`、相对 `filePath` / `lineRange` / `symbol`；不复述 secret/rootPath/absolute path。`metadata_only` / `provider_send_disabled_for_session` 只能定位。
- GitNexus 结果只能作为导航提示；与 trace/Skill/SQL、grep/read 交叉验证，不能单独当作 trace 真相。`symbol_only_low_confidence` / `build_id_missing_cannot_pin_codebase` 不能生成 patch。
- `propose_patch` 只接受已记录的 `chunkId`；`search_codebase` / `read_codebase_file` / `query_code_graph` / `inspect_code_symbol` 的 `referenceId` 不授予 patch 能力。
- `patchStatus="verified"` 可引用 diff；`patchStatus="sketch"` 仅 patchSketch，不能输出 unified diff；`patchStatus="unverified"` 仅拒绝。`multi_codebase_not_supported_phase1` 时拆分 proposal。
- `recall_project_memory` / `recall_similar_case` / legacy `lookup_blog_knowledge` 不等同于用户代码证据。
