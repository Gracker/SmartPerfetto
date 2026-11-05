<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

本次修复固定使用 `canonical_v1`，优先于其他框架示例。返回根含 `schemaVersion:"conclusion_contract_v1"` 的完整 canonical 对象，不带 authoring envelope 或引用字典。只返回一个完整 JSON 对象，不带 Markdown/HTML 外壳；服务端生成原 full-v1 框架。
