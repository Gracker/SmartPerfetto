-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Requires, injected before it: system_sched_spans.sql,
-- system_thread_state_spans.sql, system_cpu_frequency_spans.sql,
-- system_cpu_freq_limit_spans.sql, system_cpu_freq_limit_episodes.sql,
-- thermal_cooling_spans.sql, thermal_cdev_policy_association.sql,
-- thermal_signal_signatures.sql, system_cpu_freq_limit_episode_verdicts.sql.
-- Inputs defined by the consuming step:
--   system_windows(window_id, window_start_ts, window_end_ts)   one per frame
--   system_target_threads(window_id, upid, utid, role)
--   system_work_intervals(window_id, role, utid, work_start_ts, work_end_ts)
--     the interval each role's state is attributed to, one per (window, role);
--     a non-NULL utid restricts it to the thread that did that work (the top
--     slice's thread: a process can have several main-role threads, e.g.
--     Flutter *.ui), NULL counts every target thread of the role
-- Params (integer percentages, like the verdict layer's own thresholds):
--   ${freq_limit_binding_pct|90}       frequency / limit at or above which a
--                                      capped piece counts as binding
--   ${freq_limit_min_running_pct|50}   Running share of the work interval
--                                      below which the state is not judged
--   ${freq_limit_binding_min_pct|50}   binding share of Running time for
--                                      capped_binding
--   ${freq_limit_min_binding_ms|1}     minimum binding time for capped_binding
--   ${freq_limit_state_min_pct|50}     share of Running time that the other
--                                      states need (frequency coverage,
--                                      unknown, capped, limited policy)
--
-- Whether a frequency limit actually constrained the threads that did a
-- frame's work. The unit is time, not a window maximum: a piece is the
-- intersection of a target thread's Running interval, its attributed work
-- interval, the frequency span of the CPU it ran on, and the max-limit sample
-- of the policy that governs that CPU. A piece is capped when that sample is
-- capped (system_cpu_freq_limit_samples.is_capped, the one capping rule) and
-- binding when it is capped and the CPU ran at or above
-- freq_limit_binding_pct of the limit. Other threads running at the cap, or
-- the cap applying before or after the work, never make a frame binding.
--
-- Policy membership: a max-limit track names only the policy leader CPU. The
-- CPUs sharing the leader's cpu.cluster_id belong to the policy only when the
-- machine records more than one cluster and the leader's cluster holds exactly
-- one policy leader (`cpu_cluster_id`); otherwise only the leader itself
-- (`policy_leader_only`). A leader ordinal shared by several machines has no
-- identity and so no members. Identity follows system_cpu_frequency_spans:
-- machine_id + ucpu.
--
-- Trigger: this fragment never classifies what set a limit. Each piece keeps
-- the value onset of the sample in force for it
-- (system_cpu_freq_limit_samples.value_onset_counter_id), and the frame reads
-- that onset's verdict from system_cpu_freq_limit_onset_verdicts. The frame's
-- onset is the value covering the most binding time (ties: the earlier
-- value, never the one capped longer); the value onset precedes its pieces, so an onset after the work
-- interval never applies. `freq_limit_onset_confirmed` is 1 only when that
-- onset alone meets the capped_binding thresholds and its verdict is
-- confirmed; a frame that binds only by summing several values reads
-- `freq_limit_basis = 'mixed_limit_values_in_frame'`.
--
-- freq_limit_state, first match:
--   limit_track_unavailable        no valid max-limit sample in the trace
--   insufficient_running           Running below freq_limit_min_running_pct
--                                  of the work interval, or none
--   frequency_unavailable          frequency covers less than
--                                  freq_limit_state_min_pct of Running;
--                                  missing frequency is never "not binding"
--   capped_binding                 binding time meets both binding thresholds
--   limit_state_unknown            Running on a limited policy before its first
--                                  sample or under an invalid sample
--   capped_not_binding             capped, but the CPU ran below the limit
--   threads_not_on_limited_policy  Running mostly on CPUs no max limit governs
--   at_observed_max_limit          at the policy's observed maximum limit
-- The reference is the maximum limit observed in the trace, not the hardware
-- maximum. Every state is an observation, never a cause.
_flb_leaders AS (
  SELECT l.policy_cpu, c.id AS leader_ucpu, c.machine_id, c.cluster_id
  FROM (SELECT DISTINCT policy_cpu FROM system_cpu_freq_limit_raw WHERE kind = 'max') l
  JOIN cpu c ON c.cpu = l.policy_cpu
  WHERE (SELECT COUNT(*) FROM cpu c2 WHERE c2.cpu = l.policy_cpu) = 1
),
_flb_cluster_basis AS (
  SELECT l.policy_cpu,
    l.cluster_id IS NOT NULL
      AND (SELECT COUNT(DISTINCT c.cluster_id) FROM cpu c WHERE c.machine_id IS l.machine_id) > 1
      AND (SELECT COUNT(*) FROM _flb_leaders o
        WHERE o.machine_id IS l.machine_id AND o.cluster_id = l.cluster_id) = 1 AS by_cluster
  FROM _flb_leaders l
),
_flb_members AS MATERIALIZED (
  SELECT c.machine_id, c.id AS ucpu, l.policy_cpu,
    CASE WHEN b.by_cluster THEN 'cpu_cluster_id' ELSE 'policy_leader_only' END AS membership_basis
  FROM _flb_leaders l
  JOIN _flb_cluster_basis b ON b.policy_cpu = l.policy_cpu
  JOIN cpu c ON c.machine_id IS l.machine_id
    AND (CASE WHEN b.by_cluster THEN c.cluster_id = l.cluster_id ELSE c.id = l.leader_ucpu END)
),
_flb_work AS (
  SELECT window_id, role, SUM(work_end_ts - work_start_ts) AS work_ns
  FROM system_work_intervals
  WHERE work_end_ts > work_start_ts
  GROUP BY window_id, role
),
-- Nothing below is evaluated for a trace that cannot answer at all.
_flb_run AS MATERIALIZED (
  SELECT s.window_id, s.role, s.ucpu,
    MAX(s.clipped_start_ts, wi.work_start_ts) AS lo,
    MIN(s.clipped_end_ts, wi.work_end_ts) AS hi
  FROM system_thread_state_spans s
  JOIN system_work_intervals wi ON wi.window_id = s.window_id AND wi.role = s.role
    AND (wi.utid IS NULL OR wi.utid = s.utid)
  WHERE (SELECT has_max_limit_data FROM system_cpu_freq_limit_data_status) = 1
    AND s.state = 'Running'
    AND s.clipped_start_ts < wi.work_end_ts AND s.clipped_end_ts > wi.work_start_ts
),
_flb_rf AS MATERIALIZED (
  SELECT r.window_id, r.role, r.ucpu, f.freq_khz,
    MAX(r.lo, f.clipped_start_ts) AS lo, MIN(r.hi, f.clipped_end_ts) AS hi,
    m.policy_cpu, m.membership_basis
  FROM _flb_run r
  JOIN system_cpu_frequency_spans f ON f.window_id = r.window_id AND f.ucpu = r.ucpu
    AND f.clipped_start_ts < r.hi AND f.clipped_end_ts > r.lo
  LEFT JOIN _flb_members m ON m.ucpu = r.ucpu
),
_flb_piece AS MATERIALIZED (
  SELECT p.window_id, p.role, p.policy_cpu, p.membership_basis, p.freq_khz,
    s.limit_khz, s.reference_max_limit_khz, s.is_capped, s.value_onset_counter_id, s.value_onset_ts,
    MIN(p.hi, s.raw_end_ts) - MAX(p.lo, s.ts) AS dur_ns,
    CASE WHEN s.is_capped = 1
        AND p.freq_khz * 100 >= (${freq_limit_binding_pct|90}) * s.limit_khz
      THEN 1 ELSE 0 END AS is_binding
  FROM _flb_rf p
  JOIN system_cpu_freq_limit_samples s ON s.kind = 'max' AND s.limit_value_valid = 1
    AND s.policy_cpu = p.policy_cpu AND s.ts < p.hi AND s.raw_end_ts > p.lo
),
-- One row per limit value a frame's pieces ran under.
_flb_values AS (
  SELECT v.*,
    ROW_NUMBER() OVER (PARTITION BY v.window_id, v.role
      ORDER BY v.binding_ns DESC, v.value_onset_ts, v.value_onset_counter_id) AS value_rank
  FROM (
    SELECT window_id, role, policy_cpu, membership_basis, value_onset_counter_id, value_onset_ts,
      MAX(limit_khz) AS limit_khz, MAX(reference_max_limit_khz) AS reference_max_limit_khz,
      SUM(CASE WHEN is_capped = 1 THEN dur_ns ELSE 0 END) AS capped_ns,
      SUM(CASE WHEN is_binding = 1 THEN dur_ns ELSE 0 END) AS binding_ns,
      SUM(CASE WHEN is_capped = 1 THEN freq_khz * 1.0 * dur_ns ELSE 0 END)
        / NULLIF(SUM(CASE WHEN is_capped = 1 THEN limit_khz * 1.0 * dur_ns ELSE 0 END), 0) AS binding_ratio
    FROM _flb_piece
    GROUP BY window_id, role, policy_cpu, membership_basis, value_onset_counter_id, value_onset_ts
  ) v
  WHERE v.capped_ns > 0
),
_flb_policy_rank AS (
  SELECT window_id, role, policy_cpu, membership_basis,
    ROW_NUMBER() OVER (PARTITION BY window_id, role ORDER BY SUM(hi - lo) DESC, policy_cpu) AS policy_rank
  FROM _flb_rf
  WHERE policy_cpu IS NOT NULL
  GROUP BY window_id, role, policy_cpu, membership_basis
),
_flb_totals AS (
  SELECT w.window_id, w.role, w.work_ns,
    COALESCE(r.run_ns, 0) AS run_ns,
    COALESCE(f.freq_covered_ns, 0) AS freq_covered_ns,
    COALESCE(f.limited_policy_ns, 0) AS limited_policy_ns,
    COALESCE(p.limit_known_ns, 0) AS limit_known_ns,
    COALESCE(f.limited_policy_ns, 0) - COALESCE(p.limit_known_ns, 0) AS unknown_ns,
    COALESCE(p.capped_ns, 0) AS capped_ns,
    COALESCE(p.binding_ns, 0) AS binding_ns
  FROM _flb_work w
  LEFT JOIN (SELECT window_id, role, SUM(hi - lo) AS run_ns FROM _flb_run GROUP BY window_id, role) r
    ON r.window_id = w.window_id AND r.role = w.role
  LEFT JOIN (
    SELECT window_id, role, SUM(hi - lo) AS freq_covered_ns,
      SUM(CASE WHEN policy_cpu IS NOT NULL THEN hi - lo ELSE 0 END) AS limited_policy_ns
    FROM _flb_rf GROUP BY window_id, role
  ) f ON f.window_id = w.window_id AND f.role = w.role
  LEFT JOIN (
    SELECT window_id, role, SUM(dur_ns) AS limit_known_ns,
      SUM(CASE WHEN is_capped = 1 THEN dur_ns ELSE 0 END) AS capped_ns,
      SUM(CASE WHEN is_binding = 1 THEN dur_ns ELSE 0 END) AS binding_ns
    FROM _flb_piece GROUP BY window_id, role
  ) p ON p.window_id = w.window_id AND p.role = w.role
),
-- The trigger facts describe the capped value a frame ran under, so only a
-- capped frame carries them.
system_cpu_freq_limit_frame_binding AS MATERIALIZED (
  SELECT x.window_id, x.role, x.work_ns, x.run_ns, x.freq_covered_ns, x.limited_policy_ns,
    x.limit_known_ns, x.unknown_ns, x.capped_ns, x.binding_ns, x.running_share,
    x.policy_cpu, x.membership_basis, x.limit_khz, x.reference_max_limit_khz, x.depth_pct,
    x.binding_ratio, x.onset_binding_ns, x.freq_limit_state,
    CASE WHEN x.is_capped THEN x.onset_class END AS freq_limit_onset_class,
    CASE
      WHEN x.freq_limit_state = 'capped_binding' AND NOT x.onset_alone THEN 'mixed_limit_values_in_frame'
      WHEN x.is_capped THEN x.onset_class
    END AS freq_limit_basis,
    CASE WHEN x.freq_limit_state = 'capped_binding' AND x.onset_alone
      THEN COALESCE(x.onset_is_confirmed, 0) ELSE 0 END AS freq_limit_onset_confirmed,
    CASE WHEN x.is_capped THEN x.onset_ts END AS freq_limit_onset_ts,
    CASE WHEN x.is_capped THEN x.onset_cooling_basis END AS freq_limit_cooling_basis,
    CASE WHEN x.is_capped THEN x.onset_episode_id END AS trace_episode_id,
    'observation_not_causal' AS evidence_scope
  FROM (
    SELECT y.*,
      y.freq_limit_state IN ('capped_binding', 'capped_not_binding') AS is_capped,
      y.onset_binding_ns * 100 >= (${freq_limit_binding_min_pct|50}) * y.run_ns
        AND y.onset_binding_ns >= CAST((${freq_limit_min_binding_ms|1}) * 1000000 AS INTEGER) AS onset_alone
    FROM (
      SELECT t.window_id, t.role, t.work_ns, t.run_ns, t.freq_covered_ns, t.limited_policy_ns,
        t.limit_known_ns, t.unknown_ns, t.capped_ns, t.binding_ns,
        ROUND(1.0 * t.run_ns / NULLIF(t.work_ns, 0), 3) AS running_share,
        COALESCE(v.policy_cpu, pr.policy_cpu) AS policy_cpu,
        COALESCE(v.membership_basis, pr.membership_basis) AS membership_basis,
        v.limit_khz, v.reference_max_limit_khz,
        ROUND(100.0 * (v.reference_max_limit_khz - v.limit_khz) / NULLIF(v.reference_max_limit_khz, 0), 1) AS depth_pct,
        ROUND(v.binding_ratio, 3) AS binding_ratio,
        COALESCE(v.binding_ns, 0) AS onset_binding_ns,
        CASE
          WHEN ds.has_max_limit_data = 0 THEN 'limit_track_unavailable'
          WHEN t.run_ns = 0 OR t.run_ns * 100 < (${freq_limit_min_running_pct|50}) * t.work_ns
            THEN 'insufficient_running'
          WHEN t.freq_covered_ns * 100 < (${freq_limit_state_min_pct|50}) * t.run_ns THEN 'frequency_unavailable'
          WHEN t.binding_ns * 100 >= (${freq_limit_binding_min_pct|50}) * t.run_ns
            AND t.binding_ns >= CAST((${freq_limit_min_binding_ms|1}) * 1000000 AS INTEGER)
            THEN 'capped_binding'
          WHEN t.unknown_ns * 100 >= (${freq_limit_state_min_pct|50}) * t.run_ns THEN 'limit_state_unknown'
          WHEN t.capped_ns * 100 >= (${freq_limit_state_min_pct|50}) * t.run_ns THEN 'capped_not_binding'
          WHEN t.limited_policy_ns * 100 < (${freq_limit_state_min_pct|50}) * t.run_ns
            THEN 'threads_not_on_limited_policy'
          ELSE 'at_observed_max_limit'
        END AS freq_limit_state,
        ov.trigger_class AS onset_class, ov.is_confirmed AS onset_is_confirmed,
        ov.cooling_basis AS onset_cooling_basis, v.value_onset_ts AS onset_ts, ov.trace_episode_id AS onset_episode_id
      FROM _flb_totals t
      CROSS JOIN system_cpu_freq_limit_data_status ds
      LEFT JOIN _flb_values v ON v.window_id = t.window_id AND v.role = t.role AND v.value_rank = 1
      LEFT JOIN _flb_policy_rank pr ON pr.window_id = t.window_id AND pr.role = t.role AND pr.policy_rank = 1
      LEFT JOIN system_cpu_freq_limit_onset_verdicts ov ON ov.counter_id = v.value_onset_counter_id
    ) y
  ) x
)
