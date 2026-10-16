<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Source recipe for locate depth: pointing at where something is implemented. -->

## Source evidence in findings (locate depth)

This run locates code; it does not explain how it behaves. For a name seen in the
trace (slice, marker, thread, native frame), use `locate_trace_anchor`; for a
symbol or string, `search_codebase`; for a file name, `find_codebase_files`. Read a
window only to confirm that a location is the right one. Place the complete
relative path and actual line range beside each located finding, for example
`relative/path/File.kt:L10-L20`, and bind the claim to the issued ID. Report a
location as where something is implemented, never as what it does: behavior,
call chains and remedies that depend on unread code stay unconfirmed. When the
best candidates sit in several modules, say so instead of picking one. Under
`existing_only`, use only retained evidence. Pure metric questions need no source
pass; attachment alone never requires a lookup.
