-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: system_windows(window_id, window_start_ts, window_end_ts).
-- The windowed `system_cpu_freq_limit_spans` requires
-- fragments/system_sched_spans.sql to be injected FIRST: policy leader CPUs
-- are classified through its system_cpu_topology, so every CPU Skill shares
-- one big/little definition. The window-independent CTEs (raw samples, data
-- status, reference) read only cpu_counter_track and counter, so a data check
-- may inject this fragment alone.
--
-- Direct cpufreq policy limit evidence from the typed tracks emitted by the
-- ftrace event power/cpu_frequency_limits. `cpu_counter_track.cpu` carries the
-- cpufreq policy leader CPU, not every CPU governed by that policy.
--
-- A track's first sample is the first CHANGE observed, so the state before it
-- is unknown; it is never proof that the policy was unlimited. The per-policy
-- reference is the maximum max-limit observed in this trace and is explicitly
-- labelled `observed_max_limit_in_trace_not_hardware_max`: it cannot establish
-- the hardware or OPP-table maximum.
--
-- `raw_end_ts` is the unclipped end of the value a sample sets: the next
-- sample of the same track, or the trace end for the last one.
--
-- Validity is decided here and nowhere else: a sample whose value is <= 0 is
-- not a limit (`limit_value_valid = 0`). It never enters the reference, and the
-- span it opens is neither capped nor binding. Consumers show it only as a
-- data-quality fact. `prev_sample_*` describe the immediately preceding sample
-- of the same track; the direction of a change is derived from them once, in
-- system_cpu_freq_limit_episodes.sql (system_cpu_freq_limit_samples).
system_cpu_freq_limit_raw AS MATERIALIZED (
  SELECT x.*, COALESCE(x.next_ts, (SELECT end_ts FROM trace_bounds)) AS raw_end_ts
  FROM (
    SELECT t.id AS track_id, t.cpu AS policy_cpu,
      CASE WHEN t.type='cpu_max_frequency_limit' THEN 'max' ELSE 'min' END AS kind,
      c.id AS counter_id, c.ts, CAST(c.value AS INTEGER) AS limit_khz,
      CASE WHEN c.value > 0 THEN 1 ELSE 0 END AS limit_value_valid,
      CAST(LAG(c.value) OVER (PARTITION BY t.id ORDER BY c.ts, c.id) AS INTEGER) AS prev_sample_limit_khz,
      LAG(CASE WHEN c.value > 0 THEN 1 ELSE 0 END) OVER (PARTITION BY t.id ORDER BY c.ts, c.id) AS prev_sample_valid,
      LEAD(c.ts) OVER (PARTITION BY t.id ORDER BY c.ts, c.id) AS next_ts
    FROM cpu_counter_track t JOIN counter c ON c.track_id = t.id
    WHERE t.type IN ('cpu_max_frequency_limit', 'cpu_min_frequency_limit')
  ) x
),
-- Whether this trace can answer a max-limit question at all. Track existence
-- is not enough: an empty max track, or one holding only invalid samples, is
-- `max_limit_samples_missing`; no max track (min-only or nothing) is
-- `max_limit_not_captured`. Every consumer gates max-limit analysis on
-- `has_max_limit_data` and reports a missing one with
-- `limit_evidence_classification` and `limit_evidence_missing_note`.
system_cpu_freq_limit_data_status AS (
  SELECT a.*,
    CASE WHEN a.valid_max_sample_count > 0 THEN 1 ELSE 0 END AS has_max_limit_data,
    CASE WHEN a.sample_count > 0 THEN 1 ELSE 0 END AS has_any_limit_sample,
    -- The session class for a trace that cannot answer at all; every other
    -- class comes from system_cpu_freq_limit_episode_verdicts.sql.
    CASE WHEN a.valid_max_sample_count > 0 THEN NULL ELSE 'LIMIT_EVIDENCE_MISSING' END
      AS limit_evidence_classification,
    CASE
      WHEN a.valid_max_sample_count > 0 THEN NULL
      WHEN a.max_limit_track_count = 0 THEN 'max_limit_not_captured'
      ELSE 'max_limit_samples_missing'
    END AS limit_evidence_missing_reason,
    CASE
      WHEN a.valid_max_sample_count > 0 THEN NULL
      WHEN a.max_limit_track_count = 0 THEN
        '没有 cpufreq policy 最大上限轨道（cpu_max_frequency_limit；只有下限轨道或完全没有限频轨道）：无法直接判断频率是否被限制。观测到的低频既可能是被限频，也可能只是负载下降或进入空闲 DVFS，没有限频事件时两者不可区分。请在采集配置的 ftrace_events 中加入 power/cpu_frequency_limits 后重新采集。'
      ELSE
        '有 cpufreq policy 最大上限轨道（cpu_max_frequency_limit），但没有有效的上限样本（轨道为空或只有 <= 0 的无效值）：无效值不是限频，无法据此判断频率是否被限制。请确认 power/cpu_frequency_limits 采集正常后重新采集。'
    END AS limit_evidence_missing_note
  FROM (
    SELECT
      (SELECT COUNT(*) FROM cpu_counter_track WHERE type = 'cpu_max_frequency_limit') AS max_limit_track_count,
      (SELECT COUNT(*) FROM cpu_counter_track WHERE type = 'cpu_min_frequency_limit') AS min_limit_track_count,
      COUNT(*) AS sample_count,
      COALESCE(SUM(CASE WHEN kind = 'max' AND limit_value_valid = 1 THEN 1 ELSE 0 END), 0) AS valid_max_sample_count,
      COALESCE(SUM(CASE WHEN kind = 'max' AND limit_value_valid = 0 THEN 1 ELSE 0 END), 0) AS invalid_max_sample_count,
      COALESCE(SUM(CASE WHEN kind = 'min' AND limit_value_valid = 0 THEN 1 ELSE 0 END), 0) AS invalid_min_sample_count
    FROM system_cpu_freq_limit_raw
  ) a
),
system_cpu_freq_limit_reference AS (
  SELECT policy_cpu,
    MAX(CASE WHEN kind='max' AND limit_value_valid = 1 THEN limit_khz END) AS reference_max_limit_khz,
    MIN(CASE WHEN kind='max' THEN ts END) AS first_max_sample_ts,
    MAX(CASE WHEN kind='max' THEN ts END) AS last_max_sample_ts,
    'observed_max_limit_in_trace_not_hardware_max' AS reference_basis
  FROM system_cpu_freq_limit_raw
  GROUP BY policy_cpu
),
system_cpu_freq_limit_spans AS (
  SELECT w.window_id, w.window_start_ts, w.window_end_ts,
    r.track_id, r.policy_cpu, r.kind, r.counter_id,
    r.limit_khz, r.limit_value_valid,
    tp.ucpu, tp.machine_id, tp.capacity,
    COALESCE(tp.core_type, 'unknown') AS core_type,
    COALESCE(tp.topology_source, 'cpu_identity_unavailable') AS topology_source,
    r.ts AS raw_start_ts, r.raw_end_ts,
    MAX(r.ts, w.window_start_ts) AS clipped_start_ts,
    MIN(r.raw_end_ts, w.window_end_ts) AS clipped_end_ts,
    MIN(r.raw_end_ts, w.window_end_ts) - MAX(r.ts, w.window_start_ts) AS dur_ns,
    r.ts < w.window_start_ts AS left_censored,
    r.next_ts IS NULL OR r.next_ts > w.window_end_ts AS right_censored,
    r.ts = ref.first_max_sample_ts AND r.kind='max' AS is_first_max_sample,
    r.ts = ref.last_max_sample_ts AND r.kind='max' AS is_last_max_sample,
    ref.reference_max_limit_khz, ref.reference_basis,
    'ftrace:power/cpu_frequency_limits' AS limit_source
  FROM system_windows w
  JOIN system_cpu_freq_limit_raw r
    ON r.ts < w.window_end_ts AND r.raw_end_ts > w.window_start_ts
  LEFT JOIN system_cpu_freq_limit_reference ref ON ref.policy_cpu = r.policy_cpu
  -- The event names the leader by its local cpu number. When several machines
  -- share that number the identity is ambiguous, so no topology is attached.
  LEFT JOIN system_cpu_topology tp ON tp.cpu = r.policy_cpu
    AND (SELECT COUNT(*) FROM cpu c2 WHERE c2.cpu = r.policy_cpu) = 1
  WHERE w.window_end_ts > w.window_start_ts
)
