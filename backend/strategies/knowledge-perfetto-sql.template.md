<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## SQL

ts/dur: ns. lookup_sql_schema/list_stdlib_modules as needed. __intrinsic_stdlib_objects=catalog. = exact; GLOB wildcard; regexp(pattern,input,'i'):opt-in partial.
No TP tables: mm_event/page_fault/lmks/frames/thread_track_name/cpu_frequency_track/freq.
|Object|Cols|
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
`INCLUDE PERFETTO MODULE <module>;` before SELECT:
android_monitor_contention=android.monitor_contention (no s); android_startups=android.startup.startups.
`slice s JOIN thread_track tt ON s.track_id=tt.id JOIN thread t ON tt.utid=t.utid JOIN process p USING(upid)`.
TID/PID!=UTID/UPID.
`counter c JOIN counter_track t ON c.track_id=t.id`; CPU=cpu_counter_track.
android_binder_txns: no ts/dur; ORDER BY client_ts.
LAG/LEAD need OVER; SELECT/ORDER BY; no AVG/SUM(window). CTE then WHERE/AVG/ROUND: `WITH w AS(SELECT ts-LAG(ts) OVER(PARTITION BY track_id ORDER BY ts) gap FROM counter) SELECT AVG(gap),COUNT(gap) FROM w`.
USING:shared; slice:no upid/utid; unique aliases;qualify.
