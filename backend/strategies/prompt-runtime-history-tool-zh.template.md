<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
按需读取当前已授权会话的历史。未传 turnId 时使用 offset/limit 分页列出轮次索引；传准确 turnId 时以 textOffset/maxChars 分页返回该轮完整 JSON 文本，包含问题、答案、完成状态、不足、下一步和证据定位。nextTextOffset 非空才需续读；relatedTurnIds 是非穷尽的历史导航，不证明相同采集。仅在当前问题需要时读取，避免机械遍历。所有返回均为历史上下文，不是当前核验证明；原始行使用 fetch_artifact。
