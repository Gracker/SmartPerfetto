-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Requires, injected in this order: system_sched_spans.sql,
-- system_cpu_freq_limit_spans.sql,
-- system_cpu_freq_limit_episodes.sql, thermal_cooling_spans.sql,
-- thermal_cdev_policy_association.sql, thermal_signal_signatures.sql.
-- Inputs: ${who_window_ms|2000}, ${cooling_coincidence_ms|50}, plus the
-- association inputs.
--
-- This is the ONLY place that decides what triggered a frequency limit. No
-- consumer keeps its own ladder, rank mapping, default class or class prose:
-- windowed Skills read the window-scoped rows (per-episode verdicts and the
-- window summary with its per-class episode counts, `is_confirmed` and
-- `class_note`), session facts read the trace-wide summary, and a per-frame
-- consumer reads the verdict of the value onset that wrote the limit in force
-- for it.
--
-- The unit of classification is the VALUE ONSET (system_cpu_freq_limit_samples):
-- every change of a policy's max-limit value inside a capped trace episode. An
-- episode, a window and the trace are summarised from their onsets: the best
-- (lowest) rank wins and `onset_trigger_mix` keeps the per-class counts, so a
-- mixed episode reads "confirmed for N of M limit changes", never "confirmed".
--
-- Onset ladder, first match wins:
--   direction unknown   first observed sample / first valid value after an
--                       invalid sample: the write time was not observed. Rank
--                       5, evaluated before any activity tier so co-occurring
--                       activity can never upgrade an unobservable onset.
--   relaxed             the limit rose (still capped). Neutral, never causal.
--   paired tightening   the limit dropped 0..cdev_policy_pair_ms AFTER a
--                       tightening transition of a cooling device tied to this
--                       policy (first-match forward pair). The only rank 1.
--   daemon              a thermal daemon ran in the who_window_ms before the
--                       write. A candidate, never a confirmation.
--   tied background     a tied cooling device was active while the value was
--                       in force, or changed state near the write without
--                       being its forward pair.
--   untied activity     only cooling devices not tied to this policy showed
--                       activity.
--   no evidence         cooling transitions were captured in this trace but
--                       none relates to the write (observed absence), or no
--                       cooling transition exists at all (not captured). Neither
--                       is a claim that the trigger was non-thermal.
system_cpu_freq_limit_trigger_classes AS (
  SELECT 1 AS trigger_class_rank, 'THERMAL_LIMIT_CONFIRMED' AS trigger_class, 'onset' AS class_scope, 1 AS is_confirmed,
    '限频值的写入紧跟在与该 policy 时序关联的内核散热设备升档之后（前向配对、同向）：这次收紧由内核热控施加。' AS class_note
  UNION ALL SELECT 2, 'THERMAL_DAEMON_SUSPECTED', 'onset', 0,
    '限频收紧前的归因窗口内有名字匹配温控签名的守护进程在运行：用户态温控是候选触发方，尚未证明因果；这类守护进程在未限频时也会运行。'
  UNION ALL SELECT 3, 'THERMAL_COOLING_BACKGROUND', 'onset', 0,
    '与该 policy 时序关联的散热设备在限频值生效期间处于非零档位或在写入附近换档，但没有与这次写入前向配对的升档：只是并存的背景热控候选，不能确认是施加者。'
  UNION ALL SELECT 4, 'THERMAL_COOLING_UNASSOCIATED', 'onset', 0,
    '限频值生效期间只有未与该 policy 关联的散热设备有活动：时序证据没有把它们与这个 policy 绑定，不能算作这次限频的施加者。'
  UNION ALL SELECT 5, 'LIMIT_ONSET_UNKNOWN', 'onset', 0,
    '限频值的写入时刻不可观测（轨道首样本，或紧跟在无效样本之后）：只报告受限时长与影响，不判断触发方，也不能写成非热限频。'
  UNION ALL SELECT 6, 'NO_THERMAL_EVIDENCE_OBSERVED', 'onset', 0,
    '本 trace 采集到了散热设备档位变化，但这次收紧既没有关联散热设备的配对或活动，也没有温控守护进程活动：未观测到热证据，但这不证明触发方是非热的。'
  UNION ALL SELECT 7, 'THERMAL_EVIDENCE_NOT_CAPTURED', 'onset', 0,
    '本 trace 没有任何散热设备档位变化，无法把这次限频写入归因到内核热控；温度或守护进程名只能算线索。触发方无法判定，需要补采 thermal/cdev_update。'
  UNION ALL SELECT 8, 'LIMIT_RELAXED', 'onset', 0,
    '上限被放宽（仍低于参考上限）：放宽不是限频的原因，不参与热证据判定；之前的收紧才是受限的来源。'
  UNION ALL SELECT NULL, 'NO_LIMIT_EPISODE', 'session', 0,
    '有有效的最大上限样本，但范围内没有超过阈值的限频区段。'
  UNION ALL SELECT NULL, 'LIMIT_EVIDENCE_MISSING', 'session', 0,
    '没有有效的最大上限样本（未采集 power/cpu_frequency_limits，或上限轨道为空/只有无效样本）：无法判断是否发生限频。'
),
system_cpu_freq_limit_onset_verdict_classes AS (
  SELECT 'thermal_cooling_device_confirmed' AS onset_verdict, 1 AS trigger_class_rank
  UNION ALL SELECT 'userspace_thermal_daemon_active_before_limit', 2
  UNION ALL SELECT 'policy_cooling_active_background', 3
  UNION ALL SELECT 'cooling_activity_policy_unassociated', 4
  UNION ALL SELECT 'onset_unknown_capped_at_data_start', 5
  UNION ALL SELECT 'onset_after_invalid_sample', 5
  UNION ALL SELECT 'limit_changed_no_thermal_evidence', 6
  UNION ALL SELECT 'thermal_evidence_not_captured', 7
  UNION ALL SELECT 'limit_relaxed', 8
),
_flv_onsets AS MATERIALIZED (
  SELECT e.trace_episode_id, e.policy_cpu, e.counter_id, e.ts, e.value_end_ts,
    e.limit_khz, e.prev_valid_limit_khz, e.direction, e.direction_basis,
    e.reference_max_limit_khz
  FROM system_cpu_freq_limit_max_events e
  WHERE e.is_value_onset = 1 AND e.in_episode = 1
),
_flv_tied AS MATERIALIZED (
  SELECT cdev_track_id, cdev_name, associated_policy_cpu AS policy_cpu
  FROM thermal_cdev_policy_association
  WHERE association_status = 'paired_with_policy_limit_changes'
),
_flv_active_cooling AS MATERIALIZED (
  SELECT r.cdev_track_id, r.ts, r.raw_end_ts AS end_ts
  FROM thermal_cooling_raw r
  WHERE r.state > 0
),
_flv_pairing AS (
  SELECT o.counter_id,
    MAX(CASE WHEN p.cooling_direction = 'tightened' THEN 1 ELSE 0 END) AS paired_tightening,
    MAX(CASE WHEN p.cooling_direction = 'relaxed' THEN 1 ELSE 0 END) AS paired_relaxing,
    MIN(CASE WHEN p.cooling_direction = 'tightened' THEN td.cdev_name END) AS paired_cdev_name,
    MIN(CASE WHEN p.cooling_direction = 'tightened' THEN p.lead_ns END) AS pair_lead_ns
  FROM _flv_onsets o
  JOIN thermal_cdev_limit_forward_pairs p ON p.limit_counter_id = o.counter_id
  JOIN _flv_tied td ON td.cdev_track_id = p.cdev_track_id AND td.policy_cpu = o.policy_cpu
  WHERE o.direction = 'tightened'
  GROUP BY o.counter_id
),
-- Activity tiers are evaluated only for tightening onsets that no tied
-- cooling transition applied; everything else is already decided.
_flv_open_onsets AS MATERIALIZED (
  SELECT o.* FROM _flv_onsets o
  LEFT JOIN _flv_pairing pa ON pa.counter_id = o.counter_id
  WHERE o.direction = 'tightened' AND COALESCE(pa.paired_tightening, 0) = 0
),
_flv_tied_nearby AS (
  SELECT o.counter_id,
    MAX(CASE WHEN t.ts > o.ts THEN 1 ELSE 0 END) AS tied_transition_after,
    MAX(CASE WHEN t.ts <= o.ts THEN 1 ELSE 0 END) AS tied_transition_before
  FROM _flv_open_onsets o
  JOIN _flv_tied td ON td.policy_cpu = o.policy_cpu
  JOIN thermal_cooling_transitions t ON t.cdev_track_id = td.cdev_track_id
    AND t.ts >= o.ts - CAST(${cooling_coincidence_ms|50} * 1000000 AS INTEGER)
    AND t.ts <= o.ts + CAST(${cooling_coincidence_ms|50} * 1000000 AS INTEGER)
  GROUP BY o.counter_id
),
_flv_cooling_activity AS (
  SELECT o.counter_id,
    MAX(CASE WHEN td.cdev_track_id IS NOT NULL THEN 1 ELSE 0 END) AS tied_active,
    MAX(CASE WHEN td.cdev_track_id IS NULL THEN 1 ELSE 0 END) AS untied_active
  FROM _flv_open_onsets o
  JOIN _flv_active_cooling a ON a.ts < o.value_end_ts AND a.end_ts > o.ts
  LEFT JOIN _flv_tied td ON td.cdev_track_id = a.cdev_track_id AND td.policy_cpu = o.policy_cpu
  GROUP BY o.counter_id
),
_flv_untied_transitions AS (
  SELECT o.counter_id, 1 AS untied_transition
  FROM _flv_open_onsets o
  JOIN thermal_cooling_transitions t
    ON t.ts >= o.ts - CAST(${cooling_coincidence_ms|50} * 1000000 AS INTEGER)
    AND t.ts < o.value_end_ts
  LEFT JOIN _flv_tied td ON td.cdev_track_id = t.cdev_track_id AND td.policy_cpu = o.policy_cpu
  WHERE td.cdev_track_id IS NULL
  GROUP BY o.counter_id
),
_flv_daemon_slices AS MATERIALIZED (
  SELECT s.ts, s.ts + s.dur AS end_ts
  FROM sched_slice s
  WHERE s.dur > 0 AND s.utid IN (SELECT utid FROM thermal_daemon_threads)
),
_flv_daemon AS (
  SELECT o.counter_id, COUNT(*) AS daemon_slices
  FROM _flv_open_onsets o
  JOIN _flv_daemon_slices d
    ON d.ts < o.ts AND d.end_ts > o.ts - CAST(${who_window_ms|2000} * 1000000 AS INTEGER)
  GROUP BY o.counter_id
),
system_cpu_freq_limit_onset_verdicts AS MATERIALIZED (
  SELECT v.*, vc.trigger_class_rank, c.trigger_class, c.is_confirmed, c.class_note
  FROM (
    SELECT f.trace_episode_id, f.policy_cpu, f.counter_id, f.onset_ts, f.value_end_ts,
      f.limit_khz, f.prev_valid_limit_khz, f.direction, f.direction_basis, f.reference_max_limit_khz,
      f.paired_tightening, f.paired_cdev_name, f.pair_lead_ns, f.daemon_slices,
      f.tied_active AS tied_cooling_active, f.untied_activity AS untied_cooling_activity,
      f.cooling_transition_coverage,
      CASE
        WHEN f.direction = 'unknown' AND f.direction_basis = 'onset_after_invalid_sample'
          THEN 'onset_after_invalid_sample'
        WHEN f.direction = 'unknown' THEN 'onset_unknown_capped_at_data_start'
        WHEN f.direction = 'relaxed' THEN 'limit_relaxed'
        WHEN f.paired_tightening = 1 THEN 'thermal_cooling_device_confirmed'
        WHEN f.daemon_slices > 0 THEN 'userspace_thermal_daemon_active_before_limit'
        WHEN f.paired_relaxing = 1 OR f.tied_after = 1 OR f.tied_before = 1 OR f.tied_active = 1
          THEN 'policy_cooling_active_background'
        WHEN f.untied_activity = 1 THEN 'cooling_activity_policy_unassociated'
        WHEN f.cooling_transition_coverage = 1 THEN 'limit_changed_no_thermal_evidence'
        ELSE 'thermal_evidence_not_captured'
      END AS onset_verdict,
      -- The cooling side alone, for frame-level readers: why a capped value
      -- is or is not attributed to a tied cooling device. Independent of the
      -- daemon tier.
      CASE
        WHEN f.direction = 'unknown' AND f.direction_basis = 'onset_after_invalid_sample'
          THEN 'onset_after_invalid_sample'
        WHEN f.direction = 'unknown' THEN 'onset_unobserved'
        WHEN f.direction = 'relaxed' THEN 'cap_value_set_by_relaxation'
        WHEN f.paired_tightening = 1 THEN 'limit_set_by_paired_policy_cooling_transition'
        WHEN f.paired_relaxing = 1 THEN 'discordant_cooling_pair'
        WHEN f.tied_after = 1 THEN 'cooling_follows_limit_change'
        WHEN f.tied_before = 1 THEN 'policy_cooling_not_paired_with_this_onset'
        WHEN f.tied_active = 1 THEN 'policy_cooling_active_limit_set_elsewhere'
        WHEN f.untied_activity = 1 THEN 'cooling_unassociated_with_policy'
        WHEN f.cooling_transition_coverage = 1 THEN 'no_cooling_evidence'
        ELSE 'cooling_track_unavailable'
      END AS cooling_basis,
      'observation_not_causal' AS evidence_scope
    FROM (
      SELECT o.trace_episode_id, o.policy_cpu, o.counter_id, o.ts AS onset_ts, o.value_end_ts,
        o.limit_khz, o.prev_valid_limit_khz, o.direction, o.direction_basis, o.reference_max_limit_khz,
        COALESCE(pa.paired_tightening, 0) AS paired_tightening,
        COALESCE(pa.paired_relaxing, 0) AS paired_relaxing,
        pa.paired_cdev_name, pa.pair_lead_ns,
        COALESCE(nb.tied_transition_after, 0) AS tied_after,
        COALESCE(nb.tied_transition_before, 0) AS tied_before,
        COALESCE(ca.tied_active, 0) AS tied_active,
        COALESCE(ca.untied_active, 0) OR COALESCE(ut.untied_transition, 0) AS untied_activity,
        COALESCE(dm.daemon_slices, 0) AS daemon_slices,
        cov.cooling_transition_coverage
      FROM _flv_onsets o
      CROSS JOIN thermal_cooling_transition_coverage cov
      LEFT JOIN _flv_pairing pa ON pa.counter_id = o.counter_id
      LEFT JOIN _flv_tied_nearby nb ON nb.counter_id = o.counter_id
      LEFT JOIN _flv_cooling_activity ca ON ca.counter_id = o.counter_id
      LEFT JOIN _flv_untied_transitions ut ON ut.counter_id = o.counter_id
      LEFT JOIN _flv_daemon dm ON dm.counter_id = o.counter_id
    ) f
  ) v
  JOIN system_cpu_freq_limit_onset_verdict_classes vc ON vc.onset_verdict = v.onset_verdict
  JOIN system_cpu_freq_limit_trigger_classes c ON c.trigger_class_rank = vc.trigger_class_rank
),
-- Scopes over which onsets are summarised. Window scopes keep only onsets
-- whose value is in force inside the window (including the onset before the
-- window that set the value in force at its start) and never cite a later
-- onset. The trace scope covers every onset and is labelled trace-wide.
_flv_window_onsets AS (
  SELECT e.window_id, e.episode_id, ov.counter_id
  FROM system_cpu_freq_limit_episodes e
  JOIN system_windows w ON w.window_id = e.window_id
  JOIN system_cpu_freq_limit_onset_verdicts ov ON ov.trace_episode_id = e.trace_episode_id
    AND ov.onset_ts < w.window_end_ts AND ov.value_end_ts > w.window_start_ts
),
_flv_scoped AS MATERIALIZED (
  SELECT k.scope, k.window_id, k.scope_key, ov.*
  FROM (
    SELECT 'window_episode' AS scope, window_id, episode_id AS scope_key, counter_id FROM _flv_window_onsets
    UNION ALL
    SELECT 'window', window_id, CAST(window_id AS TEXT), counter_id FROM _flv_window_onsets
    UNION ALL
    SELECT 'trace', NULL, 'trace', counter_id FROM system_cpu_freq_limit_onset_verdicts
  ) k
  JOIN system_cpu_freq_limit_onset_verdicts ov ON ov.counter_id = k.counter_id
),
-- Window-scoped onset rows of each window episode: what an episode detail
-- lists, with the same verdicts the episode summary is built from.
system_cpu_freq_limit_window_onset_verdicts AS (
  SELECT * FROM _flv_scoped WHERE scope = 'window_episode'
),
-- One row per scope, onsets or not: every window episode, every window and
-- the trace.
_flv_scope_keys AS (
  SELECT 'window_episode' AS scope, window_id, episode_id AS scope_key FROM system_cpu_freq_limit_episodes
  UNION ALL
  SELECT 'window', window_id, CAST(window_id AS TEXT) FROM system_windows
  UNION ALL
  SELECT 'trace', NULL, 'trace'
),
_flv_scope_summary AS MATERIALIZED (
  SELECT k.scope, k.window_id, k.scope_key,
    COALESCE(r.onset_count, 0) AS onset_count,
    COALESCE(r.causal_onset_count, 0) AS causal_onset_count,
    COALESCE(r.confirmed_onset_count, 0) AS confirmed_onset_count,
    COALESCE(r.relaxed_onset_count, 0) AS relaxed_onset_count,
    r.trigger_class_rank, c.trigger_class, c.is_confirmed, c.class_note,
    b.onset_verdict AS best_onset_verdict, b.onset_ts AS best_onset_ts,
    b.cooling_basis AS best_cooling_basis, b.paired_cdev_name AS best_paired_cdev_name,
    m.onset_trigger_mix
  FROM _flv_scope_keys k
  LEFT JOIN (
    SELECT scope, window_id, scope_key,
      COUNT(*) AS onset_count,
      SUM(CASE WHEN trigger_class <> 'LIMIT_RELAXED' THEN 1 ELSE 0 END) AS causal_onset_count,
      SUM(is_confirmed) AS confirmed_onset_count,
      SUM(CASE WHEN trigger_class = 'LIMIT_RELAXED' THEN 1 ELSE 0 END) AS relaxed_onset_count,
      MIN(trigger_class_rank) AS trigger_class_rank
    FROM _flv_scoped
    GROUP BY scope, window_id, scope_key
  ) r ON r.scope = k.scope AND r.window_id IS k.window_id AND r.scope_key = k.scope_key
  LEFT JOIN system_cpu_freq_limit_trigger_classes c ON c.trigger_class_rank = r.trigger_class_rank
  LEFT JOIN (
    SELECT * FROM (
      SELECT s.scope, s.window_id, s.scope_key, s.onset_verdict, s.onset_ts, s.cooling_basis, s.paired_cdev_name,
        ROW_NUMBER() OVER (PARTITION BY s.scope, s.window_id, s.scope_key
          ORDER BY s.trigger_class_rank, s.onset_ts, s.counter_id) AS rn
      FROM _flv_scoped s
    ) WHERE rn = 1
  ) b ON b.scope = k.scope AND b.window_id IS k.window_id AND b.scope_key = k.scope_key
  LEFT JOIN (
    SELECT scope, window_id, scope_key,
      GROUP_CONCAT(trigger_class || ':' || n, ',' ORDER BY trigger_class_rank) AS onset_trigger_mix
    FROM (
      SELECT scope, window_id, scope_key, trigger_class, trigger_class_rank, COUNT(*) AS n
      FROM _flv_scoped
      GROUP BY scope, window_id, scope_key, trigger_class, trigger_class_rank
    )
    GROUP BY scope, window_id, scope_key
  ) m ON m.scope = k.scope AND m.window_id IS k.window_id AND m.scope_key = k.scope_key
),
_flv_policy_ties AS (
  SELECT policy_cpu, COUNT(*) AS tied_cooling_device_count, MIN(cdev_name) AS tied_cooling_device
  FROM _flv_tied GROUP BY policy_cpu
),
-- Window-scoped: one row per window episode. `episode_verdict` is the verdict
-- of the best in-window onset; `onset_trigger_mix` lists every in-window
-- onset class with its count. Materialized because both consumers and the
-- window summary's episode facts read it.
system_cpu_freq_limit_episode_verdicts AS MATERIALIZED (
  SELECT e.*,
    ss.onset_count, ss.causal_onset_count, ss.confirmed_onset_count, ss.relaxed_onset_count,
    ss.trigger_class_rank, ss.trigger_class, COALESCE(ss.is_confirmed, 0) AS is_confirmed, ss.class_note,
    ss.best_onset_verdict AS episode_verdict,
    ss.best_onset_ts, ss.best_cooling_basis, ss.best_paired_cdev_name,
    ss.onset_trigger_mix,
    COALESCE(pt.tied_cooling_device_count, 0) AS tied_cooling_device_count,
    pt.tied_cooling_device,
    CASE WHEN pt.tied_cooling_device_count IS NULL THEN 'no_cooling_device_tied_to_policy'
      ELSE 'tied_by_transition_limit_pairing' END AS cooling_policy_association,
    'window_scoped' AS verdict_scope
  FROM system_cpu_freq_limit_episodes e
  JOIN _flv_scope_summary ss ON ss.scope = 'window_episode'
    AND ss.window_id = e.window_id AND ss.scope_key = e.episode_id
  LEFT JOIN _flv_policy_ties pt ON pt.policy_cpu = e.policy_cpu
),
-- Per-window episode facts, counted by each episode's own class: what a
-- windowed consumer reports next to the window classification.
_flv_window_episode_facts AS (
  SELECT window_id,
    COUNT(*) AS episode_count,
    COUNT(DISTINCT policy_cpu) AS policy_count,
    ROUND(MAX(depth_pct), 1) AS deepest_depth_pct,
    MAX(episode_dur_ns) AS longest_episode_ns,
    SUM(is_confirmed) AS confirmed_episode_count,
    SUM(CASE WHEN trigger_class = 'THERMAL_DAEMON_SUSPECTED' THEN 1 ELSE 0 END) AS daemon_suspected_episode_count,
    SUM(CASE WHEN trigger_class = 'THERMAL_COOLING_BACKGROUND' THEN 1 ELSE 0 END) AS cooling_background_episode_count,
    SUM(CASE WHEN trigger_class = 'THERMAL_COOLING_UNASSOCIATED' THEN 1 ELSE 0 END) AS cooling_unassociated_episode_count,
    SUM(CASE WHEN onset_observed = 0 THEN 1 ELSE 0 END) AS onset_unknown_episode_count
  FROM system_cpu_freq_limit_episode_verdicts
  GROUP BY window_id
),
-- Distinct cooling devices tied to any policy the window's episodes touch: two
-- policies each tied to its own device are two devices, and one policy with
-- several episodes is counted once.
_flv_window_tied_devices AS (
  SELECT wp.window_id, COUNT(DISTINCT t.cdev_name) AS tied_cooling_device_count
  FROM (SELECT DISTINCT window_id, policy_cpu FROM system_cpu_freq_limit_episode_verdicts) wp
  JOIN _flv_tied t ON t.policy_cpu = wp.policy_cpu
  GROUP BY wp.window_id
),
-- Classification per query window. NO_LIMIT_EPISODE and
-- LIMIT_EVIDENCE_MISSING are the only values that do not come from an onset;
-- an episode whose onsets are all unobservable reads LIMIT_ONSET_UNKNOWN,
-- never a non-thermal trigger. `is_confirmed` and `class_note` belong to the
-- window classification.
system_cpu_freq_limit_window_summary AS (
  SELECT s.*, c.is_confirmed, c.class_note
  FROM (
    SELECT w.window_id, w.window_start_ts, w.window_end_ts,
      COALESCE(ef.episode_count, 0) AS episode_count,
      COALESCE(ef.policy_count, 0) AS policy_count,
      ef.deepest_depth_pct, ef.longest_episode_ns,
      COALESCE(ef.confirmed_episode_count, 0) AS confirmed_episode_count,
      COALESCE(ef.daemon_suspected_episode_count, 0) AS daemon_suspected_episode_count,
      COALESCE(ef.cooling_background_episode_count, 0) AS cooling_background_episode_count,
      COALESCE(ef.cooling_unassociated_episode_count, 0) AS cooling_unassociated_episode_count,
      COALESCE(ef.onset_unknown_episode_count, 0) AS onset_unknown_episode_count,
      COALESCE(wt.tied_cooling_device_count, 0) AS tied_cooling_device_count,
      ss.onset_count, ss.causal_onset_count, ss.confirmed_onset_count, ss.relaxed_onset_count,
      ss.trigger_class_rank,
      CASE
        WHEN ds.has_max_limit_data = 0 THEN ds.limit_evidence_classification
        WHEN COALESCE(ef.episode_count, 0) = 0 THEN 'NO_LIMIT_EPISODE'
        ELSE COALESCE(ss.trigger_class, 'LIMIT_ONSET_UNKNOWN')
      END AS freq_limit_classification,
      ss.onset_trigger_mix,
      ss.best_onset_verdict, ss.best_onset_ts, ss.best_paired_cdev_name,
      ds.has_max_limit_data, ds.limit_evidence_missing_reason,
      cov.cooling_transition_coverage,
      'window_scoped' AS classification_scope
    FROM system_windows w
    CROSS JOIN system_cpu_freq_limit_data_status ds
    CROSS JOIN thermal_cooling_transition_coverage cov
    JOIN _flv_scope_summary ss ON ss.scope = 'window' AND ss.window_id = w.window_id
    LEFT JOIN _flv_window_episode_facts ef ON ef.window_id = w.window_id
    LEFT JOIN _flv_window_tied_devices wt ON wt.window_id = w.window_id
  ) s
  JOIN system_cpu_freq_limit_trigger_classes c ON c.trigger_class = s.freq_limit_classification
),
system_cpu_freq_limit_trace_summary AS (
  SELECT s.*, c.is_confirmed, c.class_note
  FROM (
    SELECT te.episode_count,
      ss.onset_count, ss.causal_onset_count, ss.confirmed_onset_count, ss.relaxed_onset_count,
      ss.trigger_class_rank,
      CASE
        WHEN ds.has_max_limit_data = 0 THEN ds.limit_evidence_classification
        WHEN te.episode_count = 0 THEN 'NO_LIMIT_EPISODE'
        ELSE COALESCE(ss.trigger_class, 'LIMIT_ONSET_UNKNOWN')
      END AS freq_limit_classification,
      ss.onset_trigger_mix,
      ss.best_onset_verdict, ss.best_onset_ts, ss.best_paired_cdev_name,
      ds.has_max_limit_data, ds.limit_evidence_missing_reason,
      cov.cooling_transition_coverage,
      'trace_wide' AS classification_scope
    FROM system_cpu_freq_limit_data_status ds
    CROSS JOIN thermal_cooling_transition_coverage cov
    CROSS JOIN (SELECT COUNT(*) AS episode_count FROM system_cpu_freq_limit_trace_episodes) te
    JOIN _flv_scope_summary ss ON ss.scope = 'trace'
  ) s
  JOIN system_cpu_freq_limit_trigger_classes c ON c.trigger_class = s.freq_limit_classification
)
