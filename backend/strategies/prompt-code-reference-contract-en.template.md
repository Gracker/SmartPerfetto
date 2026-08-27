<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef Location Contract

When `search_codebase`, `read_codebase_file`, or `lookup_*_source` successfully returns source CodeRefs, preserve at least one actual location, preferably `relative/path/File.kt:L10-L20`; a filename alone is insufficient. Without `lineRange`, state that line numbers are unavailable and keep `referenceId`/`chunkId` plus `filePath`; never invent lines.

Trace evidence proves occurrence; source evidence explains implementation mechanism. Source claims cite returned CodeRefs; occurrence claims also cite current Trace/Skill/SQL evidence. Source location alone remains candidate/compatible/unverified, not a confirmed root cause.
