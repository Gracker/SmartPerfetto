-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- Continuous main-thread evidence. FrameTimeline is deliberately not an input.
-- Only scoped root annotations, doFrames and scheduler states enter the sweep;
-- nested slices never multiply wall/CPU totals. All intervals are half-open.
-- Explicitly materialize reusable scoped relations: the Perfetto virtual-table
-- planner otherwise re-expands these joins in recursive and integral consumers.
mtw_config AS MATERIALIZED (
  SELECT COALESCE(${start_ts}, start_ts) AS start_ts,
    COALESCE(${end_ts}, end_ts) AS end_ts,
    MIN(100, MAX(1, CAST(COALESCE(${main_thread_top_k|20}, 20) AS INTEGER))) AS top_k
  FROM trace_bounds
),
mtw_threads AS MATERIALIZED (
  SELECT p.upid, p.pid, p.name AS process_name, t.utid, t.tid,
    MAX(c.start_ts, COALESCE(p.start_ts, c.start_ts), COALESCE(t.start_ts, c.start_ts)) AS window_start_ts,
    MIN(c.end_ts, COALESCE(p.end_ts, c.end_ts), COALESCE(t.end_ts, c.end_ts)) AS window_end_ts
  FROM effective_target_processes p
  JOIN thread t ON t.upid = p.upid AND t.tid = p.pid
  CROSS JOIN mtw_config c
  WHERE (${__process_scope.upid} IS NOT NULL OR '${package}' = ''
    OR p.name = '${package}' OR p.name GLOB '${package}:*')
    AND window_start_ts < window_end_ts
),
mtw_slices AS MATERIALIZED (
  SELECT s.id AS slice_id, s.name AS task_name, s.parent_id, s.arg_set_id,
    s.track_id, t.upid, t.utid, s.ts AS raw_ts, s.dur AS raw_dur,
    MAX(s.ts, t.window_start_ts) AS start_ts,
    MIN(CASE WHEN s.dur = -1 THEN t.window_end_ts ELSE s.ts + s.dur END,
      t.window_end_ts) AS end_ts,
    CASE WHEN s.dur = -1 THEN 1 ELSE 0 END AS is_incomplete,
    CASE WHEN (s.name GLOB 'Choreographer#doFrame*' OR s.name = 'doFrame')
      AND LOWER(s.name) NOT GLOB '*resynced*' THEN 1 ELSE 0 END AS is_doframe
  FROM mtw_threads t
  JOIN thread_track tt ON tt.utid = t.utid
  JOIN slice s ON s.track_id = tt.id
  WHERE s.ts < t.window_end_ts AND (s.dur > 0 OR s.dur = -1)
    AND (s.dur = -1 OR s.ts + s.dur > t.window_start_ts)
),
mtw_roots AS MATERIALIZED (
  -- An observed root is an annotation, not proof of one Looper message.
  SELECT s.* FROM mtw_slices s
  LEFT JOIN mtw_slices parent ON parent.slice_id = s.parent_id
    AND parent.track_id = s.track_id AND parent.utid = s.utid
  WHERE parent.slice_id IS NULL
),
mtw_frame_ancestors AS (
  SELECT slice_id AS frame_slice_id, parent_id, track_id FROM mtw_slices WHERE is_doframe = 1
  UNION ALL
  SELECT a.frame_slice_id, p.parent_id, a.track_id
  FROM mtw_frame_ancestors a JOIN mtw_slices p ON p.slice_id = a.parent_id AND p.track_id = a.track_id
),
mtw_frames AS MATERIALIZED (
  SELECT f.* FROM mtw_slices f WHERE f.is_doframe = 1
    AND NOT EXISTS (SELECT 1 FROM mtw_frame_ancestors a
      JOIN mtw_slices p ON p.slice_id = a.parent_id AND p.track_id = a.track_id
      WHERE a.frame_slice_id = f.slice_id AND p.is_doframe = 1)
),
mtw_states AS MATERIALIZED (
  SELECT s.id AS state_id, t.utid, s.state, s.blocked_function,
    s.io_wait AS raw_io_wait, s.ts AS raw_ts, s.dur AS raw_dur,
    MAX(s.ts, t.window_start_ts) AS start_ts,
    MIN(CASE WHEN s.dur = -1 THEN t.window_end_ts ELSE s.ts + s.dur END,
      t.window_end_ts) AS end_ts,
    CASE s.state WHEN 'Running' THEN 'running' WHEN 'R' THEN 'runnable'
      WHEN 'R+' THEN 'runnable_preempted' WHEN 'S' THEN 'sleep'
      WHEN 'I' THEN 'idle_state' WHEN 'D' THEN 'uninterruptible'
      WHEN 'DK' THEN 'uninterruptible_wakekill' ELSE 'other_state' END AS kind,
    CASE WHEN s.state IN ('D', 'DK') THEN s.io_wait END AS io_wait
  FROM mtw_threads t JOIN thread_state s ON s.utid = t.utid
  WHERE s.ts < t.window_end_ts AND (s.dur > 0 OR s.dur = -1)
    AND (s.dur = -1 OR s.ts + s.dur > t.window_start_ts)
),
mtw_intervals AS (
  SELECT utid, start_ts, end_ts, 'annotation' AS kind FROM mtw_roots
  UNION ALL SELECT utid, start_ts, end_ts, 'doframe' FROM mtw_frames
  UNION ALL SELECT utid, start_ts, end_ts, kind FROM mtw_states
  UNION ALL SELECT utid, start_ts, end_ts, 'io_wait' FROM mtw_states WHERE io_wait = 1
  UNION ALL SELECT utid, start_ts, end_ts, 'unknown_io_wait' FROM mtw_states
    WHERE kind IN ('uninterruptible', 'uninterruptible_wakekill') AND io_wait IS NULL
),
mtw_events AS (
  SELECT utid, start_ts AS ts, kind, 1 AS delta FROM mtw_intervals
  UNION ALL SELECT utid, end_ts, kind, -1 FROM mtw_intervals
  UNION ALL SELECT utid, window_start_ts, 'boundary', 0 FROM mtw_threads
  UNION ALL SELECT utid, window_end_ts, 'boundary', 0 FROM mtw_threads
),
mtw_event_deltas AS (
  SELECT utid, ts,
    SUM(CASE WHEN kind = 'annotation' THEN delta ELSE 0 END) AS annotation,
    SUM(CASE WHEN kind = 'doframe' THEN delta ELSE 0 END) AS doframe,
    SUM(CASE WHEN kind = 'running' THEN delta ELSE 0 END) AS running,
    SUM(CASE WHEN kind = 'runnable' THEN delta ELSE 0 END) AS runnable,
    SUM(CASE WHEN kind = 'runnable_preempted' THEN delta ELSE 0 END) AS runnable_preempted,
    SUM(CASE WHEN kind = 'sleep' THEN delta ELSE 0 END) AS sleep,
    SUM(CASE WHEN kind = 'idle_state' THEN delta ELSE 0 END) AS idle_state,
    SUM(CASE WHEN kind = 'uninterruptible' THEN delta ELSE 0 END) AS uninterruptible,
    SUM(CASE WHEN kind = 'uninterruptible_wakekill' THEN delta ELSE 0 END) AS uninterruptible_wakekill,
    SUM(CASE WHEN kind = 'other_state' THEN delta ELSE 0 END) AS other_state,
    SUM(CASE WHEN kind = 'io_wait' THEN delta ELSE 0 END) AS io_wait,
    SUM(CASE WHEN kind = 'unknown_io_wait' THEN delta ELSE 0 END) AS unknown_io_wait
  FROM mtw_events GROUP BY utid, ts
),
mtw_sweep AS (
  SELECT utid, ts AS start_ts, LEAD(ts) OVER w AS end_ts,
    SUM(annotation) OVER w AS annotation, SUM(doframe) OVER w AS doframe,
    SUM(running) OVER w AS running, SUM(runnable) OVER w AS runnable,
    SUM(runnable_preempted) OVER w AS runnable_preempted,
    SUM(sleep) OVER w AS sleep, SUM(idle_state) OVER w AS idle_state,
    SUM(uninterruptible) OVER w AS uninterruptible,
    SUM(uninterruptible_wakekill) OVER w AS uninterruptible_wakekill,
    SUM(other_state) OVER w AS other_state, SUM(io_wait) OVER w AS io_wait,
    SUM(unknown_io_wait) OVER w AS unknown_io_wait
  FROM mtw_event_deltas
  WINDOW w AS (PARTITION BY utid ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
mtw_frame_bounds AS (
  SELECT utid, MIN(start_ts) AS first_frame_start, MAX(end_ts) AS last_frame_end,
    COUNT(*) AS observed_doframe_count FROM mtw_frames GROUP BY utid
),
mtw_segments AS MATERIALIZED (
  SELECT s.*,
    CASE WHEN f.utid IS NULL THEN 'no_doFrame' WHEN s.doframe > 0 THEN 'inside_doFrame'
      WHEN s.start_ts < f.first_frame_start THEN 'before_first_doFrame'
      WHEN s.start_ts >= f.last_frame_end THEN 'after_last_doFrame'
      ELSE 'between_doFrames' END AS phase,
    (s.running > 0) + (s.runnable > 0) + (s.runnable_preempted > 0) + (s.sleep > 0)
      + (s.idle_state > 0) + (s.uninterruptible > 0)
      + (s.uninterruptible_wakekill > 0) + (s.other_state > 0) AS state_kind_count
  FROM mtw_sweep s LEFT JOIN mtw_frame_bounds f USING (utid)
  WHERE s.end_ts > s.start_ts
),
-- Task ranking needs outside-doFrame time at slice endpoints. Keep this
-- one-dimensional union integral separate from the thread-state sweep.
mtw_frame_events AS (
  SELECT utid, start_ts AS ts, 1 AS delta FROM mtw_frames
  UNION ALL SELECT utid, end_ts, -1 FROM mtw_frames
  UNION ALL SELECT utid, start_ts, 0 FROM mtw_slices
  UNION ALL SELECT utid, end_ts, 0 FROM mtw_slices
  UNION ALL SELECT utid, window_start_ts, 0 FROM mtw_threads
  UNION ALL SELECT utid, window_end_ts, 0 FROM mtw_threads
),
mtw_frame_endpoints AS (
  SELECT utid, ts, SUM(SUM(delta)) OVER w AS depth, LEAD(ts) OVER w AS next_ts
  FROM mtw_frame_events GROUP BY utid, ts
  WINDOW w AS (PARTITION BY utid ORDER BY ts ROWS UNBOUNDED PRECEDING)
),
mtw_outside_integrals AS MATERIALIZED (
  SELECT utid, ts, COALESCE(SUM(CASE WHEN depth = 0 THEN next_ts - ts ELSE 0 END)
    OVER (PARTITION BY utid ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS outside_ns
  FROM mtw_frame_endpoints
),
mtw_summary_segments AS (
  SELECT *, phase AS summary_phase FROM mtw_segments
  UNION ALL SELECT *, 'window' FROM mtw_segments
),
mtw_coverage AS (
  SELECT t.utid, COUNT(s.slice_id) AS observed_slice_count,
    COUNT(DISTINCT s.track_id) AS annotation_track_count,
    COALESCE(SUM(s.is_incomplete), 0) AS incomplete_slice_count,
    (SELECT COUNT(*) FROM mtw_roots r WHERE r.utid = t.utid) AS eligible_task_count
  FROM mtw_threads t LEFT JOIN mtw_slices s USING (utid) GROUP BY t.utid
),
main_thread_work_summary AS (
  SELECT t.upid, t.pid, t.process_name, t.utid, t.tid,
    printf('%d', t.window_start_ts) AS window_start_ts,
    printf('%d', t.window_end_ts) AS window_end_ts, s.summary_phase AS phase,
    SUM(s.end_ts - s.start_ts) / 1e6 AS wall_ms,
    SUM(CASE WHEN annotation > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 AS annotated_wall_ms,
    SUM(CASE WHEN annotation = 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 AS unannotated_wall_ms,
    SUM(CASE WHEN annotation > 1 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 AS ambiguous_annotation_wall_ms,
    SUM(CASE WHEN state_kind_count = 1 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 AS known_state_ms,
    SUM(CASE WHEN state_kind_count != 1 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 AS unknown_state_ms,
    SUM(CASE WHEN state_kind_count > 1 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 AS conflicting_state_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND running > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS running_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND runnable > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS runnable_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND runnable_preempted > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS runnable_preempted_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND sleep > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS sleep_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND idle_state > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS idle_state_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND uninterruptible > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS uninterruptible_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND uninterruptible_wakekill > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS uninterruptible_wakekill_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND other_state > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS other_state_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND io_wait > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS io_wait_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN
      SUM(CASE WHEN state_kind_count = 1 AND unknown_io_wait > 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS unknown_io_wait_ms,
    CASE WHEN SUM(state_kind_count = 1) > 0 THEN SUM(CASE WHEN state_kind_count = 1
      AND running > 0 AND annotation = 0 THEN s.end_ts - s.start_ts ELSE 0 END) / 1e6 END AS unannotated_running_ms,
    c.observed_slice_count, c.eligible_task_count, c.annotation_track_count,
    c.incomplete_slice_count, COALESCE(f.observed_doframe_count, 0) AS observed_doframe_count,
    'observed intervals; annotations are not necessarily Looper messages; no deadline or request inferred' AS evidence_scope
  FROM mtw_summary_segments s JOIN mtw_threads t USING (utid)
  JOIN mtw_coverage c USING (utid) LEFT JOIN mtw_frame_bounds f USING (utid)
  GROUP BY t.utid, s.summary_phase
)
