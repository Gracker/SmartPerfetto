-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Requires, injected before it: system_sched_spans.sql (system_cpu_topology),
-- system_cpu_frequency_spans.sql.
-- Input defined by the consuming step:
--   system_windows(window_id, window_start_ts, window_end_ts)
--
-- Whether a window's big-core frequency was observed well enough to time a
-- frequency ramp. A ramp is "the first moment any big-tier CPU reached a high
-- frequency", so it is evidence only when every big-tier CPU's frequency is
-- known for the whole window: an unobserved CPU or stretch could have been at
-- high frequency, and an absent observation must not read as "never reached
-- high". frequency_spans drops NULL, negative and zero-length samples, so a
-- counter track that started before the window can still leave holes; the
-- check is the union of each CPU's valid clipped spans, not a span count or a
-- duration sum (one CPU may carry overlapping tracks).
--
-- freq_ramp_evidence:
--   machine_scope_ambiguous    CPUs of more than one machine: the window has
--                              no machine identity, so no single big tier
--   big_core_topology_unknown  no CPU is classified big/medium (capacity
--                              missing or uniform)
--   big_core_freq_incomplete   some big-tier CPU is not covered for the window
--   observed                   every big-tier CPU is covered for the window
-- Consumers time a ramp only for 'observed'; otherwise the ramp is NULL.
system_cpu_big_freq_spans AS (
  SELECT f.window_id,f.ucpu,f.window_start_ts,f.window_end_ts,f.clipped_start_ts,f.clipped_end_ts,
    MAX(f.clipped_end_ts) OVER (PARTITION BY f.window_id,f.ucpu ORDER BY f.clipped_start_ts,f.clipped_end_ts
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS covered_until
  FROM system_cpu_frequency_spans f JOIN system_cpu_topology ct ON ct.ucpu=f.ucpu
  -- drops an unfinished sample that starts at or after the trace end (zero length)
  WHERE ct.core_type IN ('prime','big','medium') AND f.clipped_end_ts>f.clipped_start_ts
),
system_cpu_big_freq_cpu_coverage AS (
  SELECT window_id,ucpu
  FROM system_cpu_big_freq_spans
  GROUP BY window_id,ucpu
  HAVING MIN(clipped_start_ts)<=MIN(window_start_ts) AND MAX(clipped_end_ts)>=MAX(window_end_ts)
    AND SUM(CASE WHEN clipped_start_ts>covered_until THEN 1 ELSE 0 END)=0
),
system_cpu_big_freq_coverage AS (
  SELECT w.window_id,
    CASE
      WHEN (SELECT COUNT(DISTINCT COALESCE(machine_id,-1)) FROM system_cpu_topology)>1 THEN 'machine_scope_ambiguous'
      WHEN big.cpu_count=0 THEN 'big_core_topology_unknown'
      WHEN COALESCE(covered.cpu_count,0)<big.cpu_count THEN 'big_core_freq_incomplete'
      ELSE 'observed'
    END AS freq_ramp_evidence
  FROM system_windows w
  CROSS JOIN (SELECT COUNT(*) AS cpu_count FROM system_cpu_topology WHERE core_type IN ('prime','big','medium')) big
  LEFT JOIN (SELECT window_id,COUNT(*) AS cpu_count FROM system_cpu_big_freq_cpu_coverage GROUP BY window_id) covered
    ON covered.window_id=w.window_id
)
