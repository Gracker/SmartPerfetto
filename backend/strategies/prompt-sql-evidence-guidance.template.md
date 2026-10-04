<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Qualify JOIN columns. thread_slice self: JOIN slice_self_dur USING(id). FrameTimeline: upid, not utid/process_name; JOIN process USING(upid). is_main_thread. Skill steps and art-* ids are not tables: fetch_artifact, not VALUES.

Prefer Skills; SQL for gaps; aliases/formats grant no unit/investigation authority. Frames=count logical IDs/process. Handle negative/unfinished dur first; require ts<end AND ts+dur>start; clip MIN(ts+dur,end)-MAX(ts,start). Show gaps; Per-thread state sum<=window; parallel CPU!=wall. Sched has idle; busy=is_idle=0, NULL=unknown. Zero dur!=zero count. Counters=time-weighted holds+predecessor. Return numerator/denominator+unrounded REAL ratio; CAST/ROUND only display extras.
