-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- Input: the step parameter end_ts; requires the linux.perf.counters module.
-- One row per linux.perf sample counter value: the number of counter events
-- since the previous sample on the same counter track. linux.perf hardware
-- counters (cpu-cycles, instructions, cache-*) are cumulative per
-- (perf session, CPU) track, so only this delta is a count of events; it is
-- attributed to the sampled thread, the perf report period weighting. The
-- first sample of each track has no delta and is dropped, as is a negative
-- delta (counter reset). Samples after end_ts are cut before LAG, which only
-- looks back; the lower window bound must be applied by the consumer after
-- this CTE so the first in-window sample keeps its delta. Process/thread
-- filters also belong to the consumer: a per-CPU track interleaves threads.
linux_perf_counter_deltas AS (
  SELECT ts, utid, track_id, delta
  FROM (
    SELECT
      l.ts,
      l.utid,
      l.track_id,
      l.counter_value - LAG(l.counter_value) OVER (PARTITION BY l.track_id ORDER BY l.ts) AS delta
    FROM linux_perf_sample_with_counters l
    WHERE ${end_ts} IS NULL OR l.ts < ${end_ts}
  )
  WHERE delta >= 0
)
