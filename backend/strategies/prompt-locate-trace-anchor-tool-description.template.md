<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Runtime cap: a description over RUNTIME_TOOL_DESCRIPTION_MAX_CHARS (1000) is compacted to its first paragraph, so all paragraphs together must stay under it. -->

Find the source of a name seen in the trace (slice, marker, thread, native frame); results are untrusted. Handles numbers built at run time, truncated thread names, Class.method frames and constants. Each match has `matchedBy` (`trace_call` first); `ambiguous` means several modules fit. `framework` means AOSP implements it. Locates only; it never proves absence.
