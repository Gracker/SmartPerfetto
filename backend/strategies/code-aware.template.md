<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Codebase-Aware Analysis

- `codeAwareMode`: `{{codeAwareMode}}`
- whitelisted `codebaseIds`: `{{codebaseIds}}`

### 工具顺序

1. 先用 trace/Skill/SQL 定位现象、线程、阶段、slice、symbol。
2. `query_code_graph` / `inspect_code_symbol` 只是可选加速器，不是证据。
3. 实现定位用 `search_codebase`，不要求预先建立索引；GitNexus 不可用或 `freshness="stale"` 时用 `search_codebase` / `read_codebase_file`。
4. `provider_send` 可读有界源码；`metadata_only` 仅保留定位。已有索引可用 `resolve_symbol`、`lookup_app_source` / `lookup_aosp_source` / `lookup_kernel_source` / `lookup_oem_sdk`；多 vendor kernel 须指定 `vendor` 或 `codebase_id`。
5. `propose_patch` 只接受已记录的 `chunkId`；`search_codebase` / `read_codebase_file` / `query_code_graph` / `inspect_code_symbol` 的 `referenceId` 不授予 patch 能力。

### 输出纪律

- 只输出 `referenceId` / `chunkId`、相对 `filePath`、`lineRange`、`symbol`、`patchProposalId`；不复述源码、secret、rootPath、absolute path。
- `metadata_only` / `provider_send_disabled_for_session` 只能定位，不能引用源码内容。
- GitNexus 结果只能作为导航提示；须与 trace/Skill/SQL、grep/read 交叉验证，不能单独当作 trace 真相。
- `symbol_only_low_confidence` / `build_id_missing_cannot_pin_codebase` 时说明定位不足，不能生成 patch。

### Patch 纪律

- `patchStatus="verified"`：可引用 diff/patch id；`patchStatus="sketch"`：仅 rationale + patchSketch，不能输出 unified diff；`patchStatus="unverified"`：仅拒绝原因和下一步取证。
- `multi_codebase_not_supported_phase1`：拆分 App/AOSP/kernel proposal，不合成跨库 diff。

### Plan 44/54/55 边界

- `recall_project_memory` / `recall_similar_case` / legacy `lookup_blog_knowledge` 只是背景，不等同于用户代码证据；代码根因须来自已注册源码引用、registry chunk 或明确的 AOSP/OEM source chunk。
