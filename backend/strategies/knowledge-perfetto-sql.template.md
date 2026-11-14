<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Perfetto SQL

ts/dur filters: ns. If needed, inspect summary/schema first: lookup_sql_schema/list_stdlib_modules. v58+ __intrinsic_stdlib_objects: schema catalog, not Skill artifact tables. = exact; GLOB wildcard; regexp(pattern,input,'i') only intentional case-insensitive partial matching.

More: lookup_sql_schema.

| Relation | Columns |
| --- | --- |
| slice | id,ts,dur,track_id,name,parent_id |
| thread_track | id,utid |
| thread | utid,tid,upid,name,is_main_thread,is_idle |
| process | upid,pid,name |
| sched | ts,dur,cpu,utid,priority,end_state |
| thread_state | ts,dur,utid,state,blocked_function,waker_utid |
| android_binder_txns | client_ts,server_ts,client_dur,server_dur,client_upid,server_upid,is_sync |
| actual_frame_timeline_slice | ts,dur,upid,jank_type,jank_tag,surface_frame_token,display_frame_token |
| counter | ts,track_id,value |

Thread slices: `slice s JOIN thread_track tt ON s.track_id=tt.id JOIN thread t ON tt.utid=t.utid JOIN process p ON t.upid=p.upid`.
TID/PID != UTID/UPID; thread tracks: thread slices only.

LAG/LEAD need OVER; CTE before WHERE/aggregates: `WITH w AS(SELECT c.ts-LAG(c.ts) OVER(PARTITION BY c.track_id ORDER BY c.ts) gap FROM counter c) SELECT AVG(w.gap) FROM w`.
USING(x): x on both sides. slice lacks upid/utid; use thread_track.
Joins: unique aliases; use alias.column in SELECT/ON/WHERE/ORDER BY.
