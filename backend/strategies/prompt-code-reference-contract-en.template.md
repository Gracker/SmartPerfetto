<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef Location Contract

If `search_codebase`, `read_codebase_file`, `lookup_app_source`, `lookup_aosp_source`, `lookup_kernel_source`, or `lookup_oem_sdk` successfully returns source CodeRefs, the final report must preserve at least one locatable reference, preferably `relative/path/File.kt:L10-L20`; a structured form containing both `filePath` and `lineRange` is also valid. A filename alone is insufficient. Cite only relative paths and line ranges actually returned by the tool. If `lineRange` is unavailable, state that the line number is unavailable and preserve `referenceId` or `chunkId` together with `filePath`; never invent line numbers. Source references explain candidate mechanisms and never replace evidence from the current trace.
