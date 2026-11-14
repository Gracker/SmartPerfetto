<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Perfetto SQL discovery and units

Trace ts/dur filters use nanoseconds. When schema/module discovery is needed,
use lookup_sql_schema/list_stdlib_modules and inspect actual columns; v58+
__intrinsic_stdlib_objects is a discovery catalog, not a Skill artifact table.
Read candidate summary/schema before querying. Exact matching uses =, wildcard
matching uses GLOB; regexp(pattern, input, 'i') is for intentional case-insensitive
partial matching, not a blanket replacement.

Core schema (other fields: lookup_sql_schema):

| Relation | Columns |
| --- | --- |
| slice | id, ts, dur, track_id, name, parent_id |
| thread_track | id, utid |
| thread | utid, tid, upid, name, is_main_thread, is_idle |
| process | upid, pid, name |
| sched | ts, dur, cpu, utid, priority, end_state |
| thread_state | ts, dur, utid, state, blocked_function, waker_utid |
| android_binder_txns | client_ts, server_ts, client_dur, server_dur, client_upid, server_upid, is_sync |
| actual_frame_timeline_slice | ts, dur, upid, jank_type, jank_tag, surface_frame_token, display_frame_token |
| counter | ts, track_id, value |

Thread slices: `slice s JOIN thread_track tt ON s.track_id=tt.id JOIN thread t ON tt.utid=t.utid JOIN process p ON t.upid=p.upid`.
OS TID/PID != trace UTID/UPID. Thread tracks cover thread slices only.
