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
--   - awake time: to_monotonic excludes suspend from the window and every
--     clipped Running span. If any conversion is unavailable or out of range,
--     both sides use wall-clock time, never a mixture of clock bases.
-- Running time comes from thread_state, which carries no idle-thread rows; a
-- row still running at trace end (dur = -1) runs to the trace end.
-- _cpu_topology deliberately collapses unresolved local CPU identities; those
-- rows cannot supply either the numerator or the capacity denominator.
cpu_cluster_identity AS (
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM _cpu_topology WHERE topology_source = 'multi_machine_unresolved')
      THEN 'multi_machine_unresolved'
    WHEN EXISTS (SELECT 1 FROM _cpu_topology WHERE topology_source = 'ambiguous_cpu_metadata')
      THEN 'ambiguous_cpu_metadata'
    ELSE 'available'
  END AS load_status
),
cpu_cluster_running_spans AS (
  SELECT
    cpu,
    core_type,
    MIN(end_ts, ${end_ts}) - MAX(ts, ${start_ts}) AS wall_ns,
    to_monotonic(MIN(end_ts, ${end_ts})) - to_monotonic(MAX(ts, ${start_ts})) AS monotonic_ns
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
),
cpu_cluster_clock AS (
  SELECT wall_ns, monotonic_ns,
    monotonic_ns >= 0 AND monotonic_ns <= wall_ns
      AND NOT EXISTS (
        SELECT 1 FROM cpu_cluster_running_spans
        WHERE monotonic_ns IS NULL OR monotonic_ns < 0 OR monotonic_ns > wall_ns
      ) AS use_monotonic
  FROM (
    SELECT ${end_ts} - ${start_ts} AS wall_ns,
      to_monotonic(${end_ts}) - to_monotonic(${start_ts}) AS monotonic_ns
  )
),
cpu_cluster_awake AS (
  SELECT IIF(use_monotonic, monotonic_ns, wall_ns) AS awake_ns,
    IIF(use_monotonic, 'monotonic', 'wall_clock') AS clock_basis
  FROM cpu_cluster_clock
),
cpu_cluster_core_running AS (
  SELECT cpu, core_type,
    SUM(IIF(c.use_monotonic, s.monotonic_ns, s.wall_ns)) AS running_ns
  FROM cpu_cluster_running_spans s
  CROSS JOIN cpu_cluster_clock c
  GROUP BY cpu, core_type
),
-- One row per tier present in _cpu_topology (prime/big/medium/little/unknown).
cpu_cluster_load_by_tier AS (
  SELECT
    cc.core_type,
    i.load_status,
    CASE WHEN i.load_status = 'available' THEN a.clock_basis END AS clock_basis,
    CASE WHEN i.load_status = 'available' THEN cc.core_count END AS core_count,
    CASE WHEN i.load_status = 'available' THEN COUNT(CASE WHEN r.running_ns > 0 THEN r.cpu END) END AS active_core_count,
    CASE WHEN i.load_status = 'available' THEN a.awake_ns END AS awake_ns,
    CASE WHEN i.load_status = 'available' THEN COALESCE(SUM(r.running_ns), 0) END AS running_ns,
    CASE WHEN i.load_status = 'available' THEN COALESCE(MAX(r.running_ns), 0) END AS max_core_running_ns
  FROM (
    SELECT core_type, COUNT(DISTINCT cpu_id) AS core_count
    FROM _cpu_topology
    GROUP BY core_type
  ) cc
  CROSS JOIN cpu_cluster_awake a
  CROSS JOIN cpu_cluster_identity i
  LEFT JOIN cpu_cluster_core_running r ON r.core_type = cc.core_type
  GROUP BY cc.core_type, cc.core_count, a.awake_ns, a.clock_basis, i.load_status
)
