<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## SQL

ts/dur: ns. If needed: lookup_sql_schema/list_stdlib_modules. v58+ __intrinsic_stdlib_objects=catalog, not artifacts. = exact; GLOB wildcard; regexp(pattern,input,'i'): intentional case-insensitive partial only.
No TP tables: mm_event/page_fault/lmks.

|Relation|Columns|
|---|---|
|slice|id,ts,dur,track_id,name,parent_id|
|thread_track|id,utid|
|thread|utid,tid,upid,name,is_main_thread,is_idle|
|process|upid,pid,name|
|sched|ts,dur,cpu,utid,priority,end_state|
|thread_state|ts,dur,utid,state,blocked_function,waker_utid|
|android_binder_txns=android.binder|client_ts,client_dur,server_ts,server_dur,client_upid,server_upid,is_sync,aidl_name|
|actual_frame_timeline_slice|ts,dur,upid,jank_type,jank_tag,surface_frame_token,display_frame_token|
|counter|ts,track_id,value|

`INCLUDE PERFETTO MODULE <module>;` before SELECT (module tables/views):
android_monitor_contention=android.monitor_contention (no s); android_startups=android.startup.startups.

`slice s JOIN thread_track tt ON s.track_id=tt.id JOIN thread t ON tt.utid=t.utid JOIN process p ON t.upid=p.upid`.
TID/PID != UTID/UPID; thread_track: thread slices only.
android_binder_txns: no ts/dur; ORDER BY client_ts.

LAG/LEAD OVER; CTE before WHERE/aggregate: `WITH w AS(SELECT ts-LAG(ts) OVER(PARTITION BY track_id ORDER BY ts) gap FROM counter) SELECT AVG(gap) FROM w`.
USING(x): x on both sides. slice lacks upid/utid; use thread_track.
Unique aliases; qualify SELECT/ON/WHERE/ORDER BY.
