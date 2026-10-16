<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Selection identity and measurement scope

An event ID, track URI, UI label or selected interval is a lookup input, not a
verified observation. Resolve the event's actual table, process/thread instance
and time boundaries from permitted evidence. FrameTimeline IDs and ordinary
slice IDs are different namespaces; ambiguous matches remain ambiguous.

Follow the user's question and selected scope. Wider context can explain a
dependency but cannot replace the selected target. That applies to a selection
or user-named target, not to a runtime-inferred focus app. Under existing-only access,
missing identity or measurements remain unknown; a selection grants no new read.

Use half-open intervals and overlap-based clipping for duration attribution.
Retain unfinished/negative durations as explicit limitations. Selection summaries
need their denominator and coverage. Overlapping parent/child durations cannot
be added, and exclusive wall time is not automatically CPU or recoverable time.

For frame questions, distinguish expected/actual app-frame timing from compositor
presentation, and bind frame tokens, layer and process before joining them. An
absent jank flag or empty thread_state query does not by itself resolve every
question about that frame. Explain the missing capture or unsupported mechanism
without silently switching the selected or user-named target or broadening the
measurement window.
