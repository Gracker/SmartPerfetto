<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Runtime cap: a description over RUNTIME_TOOL_DESCRIPTION_MAX_CHARS (1000) is compacted to its first paragraph, so all paragraphs together must stay under it. Detail belongs in knowledge-thread-state-blocked-reason.template.md. -->

What one thread waited on in one window: its state split and the wake chain through other threads.

Take the window from the scene, not the longest sleep: startup = android_startups, jank = the janky frame, ANR = input dispatch to ANR, interaction = input to present. Select by `thread_state_id` (its row is the window) or by `utid` or `process_name` + `thread_name`/`main_thread` with `start_ts`, `end_ts`.

Rank by `attributableMs` (peers running, runnable or in D); `blockingMs` also counts `eventWaitMs`, peer sleeps ending the chain. `idle_wait`: the wait sat between slices, idle not slow. `peer_event_wait`: the chain ends in a peer waiting on network, timer or device; report that wait. `java_monitor`: lock contention, see `lookup_knowledge("thread-state-blocked-reason")`.

Refusals carry `action_required` (`selector_conflict`, `no_thread_state_in_window` + candidates). `unavailableReason`: `task_state_running`, `no_waiting_time`, `no_critical_path_stack`, `wait_open_at_trace_end`.
