<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef Location Contract

When `search_codebase` / `read_codebase_file` and similar tools return source CodeRefs, each item and the tool's `sourceReferences` (indexed: `result.sourceReferences`) carry the same `id`; copy it verbatim when citing it, never from history or calculation. Beside each source finding write the full relative path and actual lines (`relative/path/File.kt:L10-L20`), never a file name alone; without `lineRange`, keep the `id`/`chunkId` and path and say line numbers are unavailable, never invent them. Written locations are matched against this run's returns: write only lines inside a returned range.

A `search_hit` only locates; read the window with `read_codebase_file` before explaining behavior. Trace evidence proves occurrence; source explains candidate mechanisms. `metadata_only` is locate-only. An incomplete search cannot prove absence; a read's `truncated` means later lines exist. No extra lookup is required.
