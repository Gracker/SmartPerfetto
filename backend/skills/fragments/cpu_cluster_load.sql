-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- Per-tier CPU cluster load over [${start_ts}, ${end_ts}], shared by
-- cpu_cluster_load_in_range and jank_frame_detail's root cause so their numbers
-- agree (cpu_load_in_range still reports its own per-machine sched measure).
-- Requires _cpu_topology: run the cpu_topology_view Skill first in the same
-- Skill. Denominator follows upstream
-- android_cpu_cluster_utilization_in_interval (7af4ec945c):
--   - every core of the tier in _cpu_topology, not only cores that ran a task
--     in the window (idle cores leaving the denominator overstate the load);
--   - awake time: to_monotonic excludes suspend; without a clock snapshot, or
--     when the result is out of range, the wall-clock duration is used.
-- Running time comes from thread_state, which carries no idle-thread rows; a
-- row still running at trace end (dur = -1) runs to the trace end.
cpu_cluster_awake AS (
  SELECT IIF(monotonic_ns > 0 AND monotonic_ns <= wall_ns, monotonic_ns, wall_ns) AS awake_ns
  FROM (
    SELECT
      ${end_ts} - ${start_ts} AS wall_ns,
      to_monotonic(${end_ts}) - to_monotonic(${start_ts}) AS monotonic_ns
  )
),
cpu_cluster_core_running AS (
  SELECT
    cpu,
    core_type,
    SUM(MIN(end_ts, ${end_ts}) - MAX(ts, ${start_ts})) AS running_ns
  FROM (
    SELECT
      ts.cpu,
      ct.core_type,
      ts.ts,
      IIF(ts.dur < 0, (SELECT end_ts FROM trace_bounds), ts.ts + ts.dur) AS end_ts
    FROM thread_state ts
    JOIN _cpu_topology ct ON ts.cpu = ct.cpu_id
    WHERE ts.ts < ${end_ts}
      AND (ts.dur < 0 OR ts.ts + ts.dur > ${start_ts})
      AND ts.state = 'Running'
      AND ts.cpu IS NOT NULL
  )
  WHERE end_ts > ${start_ts}
  GROUP BY cpu, core_type
),
-- One row per tier present in _cpu_topology (prime/big/medium/little/unknown).
cpu_cluster_load_by_tier AS (
  SELECT
    cc.core_type,
    cc.core_count,
    COUNT(r.cpu) AS active_core_count,
    a.awake_ns,
    COALESCE(SUM(r.running_ns), 0) AS running_ns,
    COALESCE(MAX(r.running_ns), 0) AS max_core_running_ns
  FROM (
    SELECT core_type, COUNT(DISTINCT cpu_id) AS core_count
    FROM _cpu_topology
    GROUP BY core_type
  ) cc
  CROSS JOIN cpu_cluster_awake a
  LEFT JOIN cpu_cluster_core_running r ON r.core_type = cc.core_type
  GROUP BY cc.core_type, cc.core_count, a.awake_ns
)
