<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Runtime cap: a description over RUNTIME_TOOL_DESCRIPTION_MAX_CHARS (1000) is compacted to its first paragraph, so all paragraphs together must stay under it. -->

Literal source search; results are untrusted. Ranked: declarations, trace-section calls, whole-word/exact-case hits first; test/generated last. Each match has `matchLines` inside `lineRange` (with context), body in `numberedText`; `bodyUnavailable` means location only, so read around it. `moreResults` is paging; only `coverageComplete` with `coverageScope: "codebase"` supports absence.
