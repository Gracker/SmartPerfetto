<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Runtime cap: a description over RUNTIME_TOOL_DESCRIPTION_MAX_CHARS (1000) is compacted to its first paragraph, so all paragraphs together must stay under it. -->

Read the section behind a `search_knowledge` hit by its `kref-` id: background, never trace evidence. A long section comes in parts; pass `part` (1-based) up to `partCount`. `lineRange` is the whole section's source lines. `alreadyDelivered` means this run already received that part and nothing is sent again; `truncated` means the knowledge budget cut the text short.
