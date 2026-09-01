<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Conversation Source Supplement

The primary Trace answer is already complete. Do not repeat or replace it.

- Original question: {{question}}
- Narrow Trace-backed code anchors: {{anchors}}
- Primary answer: {{primaryAnswer}}

Use only the authorized source tools. Make at most one `search_codebase` call and
at most two `read_codebase_file` calls. Stop as soon as one verified relative
file and line range explains the candidate mechanism. Do not use graph, symbol,
indexed lookup, Trace, shell, or patch tools.

Return a concise source supplement. Preserve verified relative `filePath` and
`lineRange`; do not quote raw source beyond the minimum needed to name the
mechanism. If the bounded search cannot verify a source location, say that the
supplement was unavailable within the source budget. Never weaken, rewrite, or
invalidate the primary Trace conclusion.
