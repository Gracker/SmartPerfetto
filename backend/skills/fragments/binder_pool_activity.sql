-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- Input: system_windows(window_id, window_start_ts, window_end_ts). Requires
-- fragments/effective_target_processes.sql, fragments/system_target_threads.sql
-- (system_target_processes) and fragments/thread_role.sql (binder_named,
-- the binder thread-name rule). Read from the binder slices themselves (not only
-- android_binder_txns, which drops calls that never completed):
--   binder_pool_call_slices      `binder transaction` slices overlapping the
--                                window, with their raw end (an unfinished
--                                call ends at the trace end) and destination pid
--   binder_pool_sync_calls       those client-side synchronous calls with the
--                                server reply (by flow) when one exists and the
--                                server process from the reply thread, else
--                                from the `destination process` arg
--   binder_pool_target_processes the target process (target_process) and the
--                                servers of the sync calls of its main thread in
--                                the window (sync_binder_server)
--   binder_pool_named_threads    per target, threads the binder name rule of
--                                thread_roles matches (binder_named)
--   binder_pool_threads          those the trace shows active (a thread_state
--                                row or a slice): the observed pool. A named
--                                thread with neither is a phantom left out
--   binder_pool_busy             the depth-0 slices (any name) of each pool
--                                thread overlapping the window: a pool thread
--                                is busy while one covers it, idle ones carry
--                                none; an unfinished slice (dur = -1) is busy
--                                until the trace end
--   binder_pool_replies          the `binder reply` slices of each pool thread
--                                overlapping the window (descriptive)
binder_pool_call_slices AS MATERIALIZED (
  SELECT * FROM (
    SELECT w.window_id, w.window_start_ts, w.window_end_ts, c.id, c.ts, c.dur, c.track_id,
      CASE WHEN c.dur = -1 THEN (SELECT end_ts FROM trace_bounds) ELSE c.ts + c.dur END AS raw_end_ts,
      extract_arg(c.arg_set_id, 'destination process') AS destination_pid
    FROM system_windows w
    JOIN slice c ON c.name = 'binder transaction' AND c.dur >= -1 AND c.ts < w.window_end_ts
    WHERE w.window_end_ts > w.window_start_ts
  ) WHERE raw_end_ts > window_start_ts
),
binder_pool_call_replies AS (
  SELECT f.slice_out AS call_slice_id, MIN(f.slice_in) AS reply_slice_id
  FROM binder_pool_call_slices c
  JOIN flow f ON f.slice_out = c.id
  JOIN slice r ON r.id = f.slice_in AND r.name = 'binder reply'
  GROUP BY f.slice_out
),
binder_pool_sync_calls AS MATERIALIZED (
  SELECT c.window_id, c.id AS call_slice_id, c.ts AS call_ts, c.dur AS call_dur,
    MAX(c.ts, c.window_start_ts) AS wait_start_ts, MIN(c.raw_end_ts, c.window_end_ts) AS wait_end_ts,
    c.dur = -1 AS is_unfinished,
    ct.utid AS client_utid, ct.tid AS client_tid, ct.name AS client_thread_name, ct.upid AS client_upid,
    r.id AS reply_slice_id, r.dur AS reply_dur, rt.utid AS server_utid, rt.tid AS server_tid,
    rt.name AS server_thread_name,
    COALESCE(rt.upid, (
      SELECT dp.upid FROM process dp
      WHERE dp.pid = c.destination_pid
        AND (dp.start_ts IS NULL OR dp.start_ts <= c.ts) AND (dp.end_ts IS NULL OR dp.end_ts >= c.ts)
      ORDER BY dp.upid DESC LIMIT 1)) AS server_upid
  FROM binder_pool_call_slices c
  JOIN thread_track ctt ON ctt.id = c.track_id
  JOIN thread ct ON ct.utid = ctt.utid
  LEFT JOIN binder_pool_call_replies cr ON cr.call_slice_id = c.id
  LEFT JOIN slice r ON r.id = cr.reply_slice_id
  LEFT JOIN thread_track rtt ON rtt.id = r.track_id
  LEFT JOIN thread rt ON rt.utid = rtt.utid
),
binder_pool_target_processes AS MATERIALIZED (
  SELECT window_id, upid, MAX(target_role) AS target_role
  FROM (
    SELECT tp.window_id, tp.upid, 'target_process' AS target_role
    FROM system_target_processes tp JOIN system_windows w ON w.window_id = tp.window_id
    WHERE w.window_end_ts > w.window_start_ts
    UNION ALL
    SELECT sc.window_id, sc.server_upid, 'sync_binder_server'
    FROM binder_pool_sync_calls sc
    JOIN system_target_processes cp ON cp.window_id = sc.window_id AND cp.upid = sc.client_upid
      AND cp.pid = sc.client_tid
    WHERE sc.server_upid IS NOT NULL
  )
  GROUP BY window_id, upid
),
binder_pool_named_threads AS MATERIALIZED (
  SELECT tp.window_id, tp.upid, t.utid
  FROM binder_pool_target_processes tp
  JOIN thread t ON t.upid = tp.upid
  JOIN thread_roles tr ON tr.utid = t.utid
  WHERE tr.binder_named
),
binder_pool_active_threads AS MATERIALIZED (
  SELECT DISTINCT s.utid FROM thread_state s
  WHERE s.utid IN (SELECT utid FROM binder_pool_named_threads)
  UNION
  SELECT tt.utid FROM thread_track tt
  WHERE tt.utid IN (SELECT utid FROM binder_pool_named_threads)
    AND EXISTS (SELECT 1 FROM slice s WHERE s.track_id = tt.id)
),
-- One pass over the reply slices, kept only for named target threads.
binder_pool_reply_threads AS MATERIALIZED (
  SELECT DISTINCT tt.utid
  FROM slice r
  CROSS JOIN thread_track tt ON tt.id = r.track_id
  WHERE r.name = 'binder reply' AND tt.utid IN (SELECT utid FROM binder_pool_named_threads)
),
binder_pool_threads AS MATERIALIZED (
  SELECT nt.window_id, nt.upid, nt.utid, rt.utid IS NOT NULL AS served_reply
  FROM binder_pool_named_threads nt
  JOIN binder_pool_active_threads at ON at.utid = nt.utid
  LEFT JOIN binder_pool_reply_threads rt ON rt.utid = nt.utid
),
-- Depth-0 and `binder reply` slices of the pool threads overlapping the window.
binder_pool_thread_slices AS MATERIALIZED (
  SELECT window_id, upid, utid, slice_id, slice_name, slice_depth, slice_ts, slice_dur,
    MAX(slice_ts, window_start_ts) AS busy_start_ts, MIN(raw_end_ts, window_end_ts) AS busy_end_ts,
    slice_dur = -1 AS is_unfinished
  FROM (
    SELECT pt.window_id, pt.upid, pt.utid, w.window_start_ts, w.window_end_ts,
      s.id AS slice_id, s.name AS slice_name, s.depth AS slice_depth, s.ts AS slice_ts, s.dur AS slice_dur,
      CASE WHEN s.dur = -1 THEN (SELECT end_ts FROM trace_bounds) ELSE s.ts + s.dur END AS raw_end_ts
    FROM binder_pool_threads pt
    JOIN system_windows w ON w.window_id = pt.window_id
    JOIN thread_track tt ON tt.utid = pt.utid
    JOIN slice s ON s.track_id = tt.id AND (s.depth = 0 OR s.name = 'binder reply')
      AND s.dur >= -1 AND s.ts < w.window_end_ts
  ) WHERE raw_end_ts > window_start_ts
),
binder_pool_busy AS (
  SELECT window_id, upid, utid, slice_id, slice_name, slice_ts, slice_dur, busy_start_ts, busy_end_ts, is_unfinished
  FROM binder_pool_thread_slices WHERE slice_depth = 0
),
binder_pool_replies AS (
  SELECT window_id, upid, utid, slice_id AS reply_slice_id, slice_ts AS reply_ts, slice_dur AS reply_dur,
    busy_start_ts, busy_end_ts, is_unfinished
  FROM binder_pool_thread_slices WHERE slice_name = 'binder reply'
)
