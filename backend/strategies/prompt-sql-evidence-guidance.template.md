<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Qualify JOIN columns;thread_slice JOIN slice_self_dur USING(id);FrameTimeline: upid!=utid/process_name; JOIN process USING(upid); is_main_thread;steps/art-*!=tables:fetch_artifact, not VALUES.
Prefer Skills; SQL=gaps;columnUnits=issued; else stdlibColumnDocs unit=documented; else unknown; aliases/formats!=authority;Frames=count logical IDs/process;Negative/unfinished dur first; ts<end AND ts+dur>start;clip MIN(ts+dur,end)-MAX(ts,start);Show gaps;Thread-state sum<=window; parallel CPU!=wall;Sched has idle; busy=is_idle=0; NULL=unknown;Zero dur!=zero count;Counters=time-weighted holds+predecessor;Numerator/denominator+unrounded REAL ratio; CAST/ROUND=display.
modelEvidence=availability, not proof; empty/unknown!=zero/absence; list_skills.
