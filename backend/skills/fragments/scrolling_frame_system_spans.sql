-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Batched implementation of the clipped state/frequency relations used by
-- scrolling frame attribution. The pinned interval tree returns half-open
-- intersections even when windows or CPU frequency tracks overlap.
-- Inputs: system_windows(window_id, window_start_ts, window_end_ts),
-- system_target_threads(window_id, upid, utid, role).
batch_windows AS MATERIALIZED (
  SELECT CAST(ROW_NUMBER() OVER () AS INTEGER) AS id, window_id,
    window_start_ts AS ts, window_end_ts - window_start_ts AS dur
  FROM system_windows
  WHERE window_end_ts > window_start_ts
),
batch_thread_windows AS MATERIALIZED (
  SELECT CAST(ROW_NUMBER() OVER () AS INTEGER) AS id, w.ts, w.dur, w.window_id, t.upid, t.utid, t.role
  FROM batch_windows w JOIN system_target_threads t USING (window_id)
),
batch_thread_states AS MATERIALIZED (
  SELECT s.id, s.ts, s.utid, s.ucpu, s.state,
    CASE WHEN s.dur = -1 THEN COALESCE(
      (SELECT MIN(n.ts) FROM thread_state n WHERE n.utid = s.utid AND n.ts > s.ts),
      (SELECT end_ts FROM trace_bounds)) - s.ts ELSE s.dur END AS bounded_dur
  FROM (SELECT DISTINCT utid FROM batch_thread_windows) t
  CROSS JOIN thread_state s ON s.utid = t.utid
  WHERE s.dur > 0 OR s.dur = -1
),
batch_state_intervals AS (
  SELECT id, ts, bounded_dur AS dur, utid FROM batch_thread_states WHERE bounded_dur > 0
),
-- Materialize integer lookup keys before joining payloads. Otherwise the
-- virtual table planner can scan all windows in the same partition per hit.
batch_state_matches AS MATERIALIZED (
  SELECT CAST(id_0 AS INTEGER) AS window_idx, CAST(id_1 AS INTEGER) AS source_id, ts, dur
  FROM _interval_intersect!((batch_thread_windows, batch_state_intervals), (utid))
),
system_thread_state_spans AS MATERIALIZED (
  SELECT w.window_id, w.ts AS window_start_ts, w.ts + w.dur AS window_end_ts,
    w.upid, s.utid, w.role, s.ucpu, s.state,
    i.ts AS clipped_start_ts, i.ts + i.dur AS clipped_end_ts, i.dur AS dur_ns
  FROM batch_state_matches i
  CROSS JOIN batch_thread_windows w ON w.id = i.window_idx
  CROSS JOIN batch_thread_states s ON s.id = i.source_id
),
batch_frequency_samples AS MATERIALIZED (
  SELECT CAST(ROW_NUMBER() OVER () AS INTEGER) AS id, f.id AS counter_id, f.ts, f.cpu, f.ucpu, f.track_id, f.freq,
    CASE WHEN f.dur = -1 THEN COALESCE(
      (SELECT MIN(n.ts) FROM cpu_frequency_counters n
       WHERE n.track_id = f.track_id AND n.ucpu = f.ucpu AND n.ts > f.ts),
      (SELECT end_ts FROM trace_bounds)) - f.ts ELSE f.dur END AS bounded_dur
  FROM cpu_frequency_counters f JOIN cpu c ON c.id = f.ucpu AND c.cpu = f.cpu
  WHERE f.freq >= 0 AND (f.dur > 0 OR f.dur = -1)
),
batch_frequency_intervals AS (
  SELECT id, ts, bounded_dur AS dur FROM batch_frequency_samples WHERE bounded_dur > 0
),
batch_frequency_matches AS MATERIALIZED (
  SELECT CAST(id_0 AS INTEGER) AS window_idx, CAST(id_1 AS INTEGER) AS source_id, ts, dur
  FROM _interval_intersect!((batch_windows, batch_frequency_intervals), ())
),
system_cpu_frequency_spans AS MATERIALIZED (
  SELECT w.window_id, w.ts AS window_start_ts, w.ts + w.dur AS window_end_ts,
    f.track_id, f.counter_id, f.ts AS raw_start_ts, f.cpu, f.ucpu, f.freq AS freq_khz,
    i.ts AS clipped_start_ts, i.ts + i.dur AS clipped_end_ts, i.dur AS dur_ns
  FROM batch_frequency_matches i
  CROSS JOIN batch_windows w ON w.id = i.window_idx
  CROSS JOIN batch_frequency_samples f ON f.id = i.source_id
)
