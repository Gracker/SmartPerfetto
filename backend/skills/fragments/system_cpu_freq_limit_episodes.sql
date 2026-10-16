-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Requires fragments/system_cpu_freq_limit_spans.sql to be injected FIRST and
-- system_windows(window_id, window_start_ts, window_end_ts) to exist.
--
-- This fragment owns the only rules that classify a limit SAMPLE: whether it
-- is capped, the direction of the change it records, and which value onset
-- it belongs to. Consumers read these CTEs; they never re-derive direction,
-- validity or capping.
--
-- A valid max-limit sample counts as capped when it sits below the per-policy
-- observed reference by more than ${episode_drop_pct|10} percent. Consecutive
-- capped spans separated by a gap shorter than ${merge_gap_ms|500} ms become
-- ONE episode: kernel governors re-write the limit every few tens of
-- milliseconds, so the raw event stream would otherwise report hundreds of
-- "episodes" for a single continuous mitigation.
--
-- Both thresholds are inputs. They bound what is reported, not what happened.
--
-- Direction is computed only against the immediately preceding sample of the
-- same track, and only when that sample is valid (contiguous). The first
-- sample of a track and the first valid value after an invalid one have
-- direction `unknown`: what came before them was not observed.
--
-- A VALUE ONSET is a valid sample whose value differs from the contiguous
-- previous value (or whose direction is unknown). cpufreq re-emits the max
-- limit on every policy update, including min-only boosts, so a re-write with
-- the same value is not an onset: it inherits the onset of the value in force.
system_cpu_freq_limit_samples AS MATERIALIZED (
  SELECT o.*,
    -- PR-B: the per-frame binding maps a binding span to its value onset by this id.
    FIRST_VALUE(o.counter_id) OVER (PARTITION BY o.track_id, o.onset_group ORDER BY o.ts, o.counter_id)
      AS value_onset_counter_id,
    FIRST_VALUE(o.ts) OVER (PARTITION BY o.track_id, o.onset_group ORDER BY o.ts, o.counter_id)
      AS value_onset_ts,
    MAX(o.raw_end_ts) OVER (PARTITION BY o.track_id, o.onset_group) AS value_end_ts
  FROM (
    SELECT d.*,
      SUM(CASE WHEN d.is_value_onset = 1 OR d.limit_value_valid = 0 THEN 1 ELSE 0 END) OVER (
        PARTITION BY d.track_id ORDER BY d.ts, d.counter_id ROWS UNBOUNDED PRECEDING
      ) AS onset_group
    FROM (
      SELECT r.track_id, r.policy_cpu, r.kind, r.counter_id, r.ts, r.raw_end_ts,
        r.limit_khz, r.limit_value_valid, r.prev_sample_limit_khz,
        CASE WHEN r.limit_value_valid = 1 AND r.prev_sample_valid = 1
          THEN r.prev_sample_limit_khz END AS prev_valid_limit_khz,
        CASE
          WHEN r.limit_value_valid = 0 THEN 'invalid_limit_sample'
          WHEN r.prev_sample_valid IS NULL THEN 'first_observed_sample'
          WHEN r.prev_sample_valid = 0 THEN 'onset_after_invalid_sample'
          ELSE 'contiguous_valid_previous'
        END AS direction_basis,
        CASE
          WHEN r.limit_value_valid = 0 OR r.prev_sample_valid IS NULL OR r.prev_sample_valid = 0
            THEN 'unknown'
          WHEN r.limit_khz < r.prev_sample_limit_khz THEN 'decreased'
          WHEN r.limit_khz > r.prev_sample_limit_khz THEN 'increased'
          ELSE 'unchanged'
        END AS value_change,
        CASE WHEN r.limit_value_valid = 1 AND NOT (
            COALESCE(r.prev_sample_valid, 0) = 1 AND r.limit_khz = r.prev_sample_limit_khz)
          THEN 1 ELSE 0 END AS is_value_onset,
        ref.reference_max_limit_khz, ref.reference_basis,
        CASE WHEN r.kind = 'max' AND r.limit_value_valid = 1 AND ref.reference_max_limit_khz > 0
            AND r.limit_khz < ref.reference_max_limit_khz * (1.0 - (${episode_drop_pct|10}) / 100.0)
          THEN 1 ELSE 0 END AS is_capped
      FROM system_cpu_freq_limit_raw r
      LEFT JOIN system_cpu_freq_limit_reference ref ON ref.policy_cpu = r.policy_cpu
    ) d
  ) o
),
-- Trace-wide episodes: the same drop and merge rules, grouped by policy only,
-- on unclipped sample spans. Their ids (`policy%d-tep%d`) and onsets do not
-- depend on any query window, so a window that cuts through an episode can
-- never manufacture an onset at its own start.
system_cpu_freq_limit_trace_episode_spans AS MATERIALIZED (
  SELECT g.*,
    printf('policy%d-tep%d', g.policy_cpu, g.trace_episode_seq) AS trace_episode_id
  FROM (
    SELECT m.*,
      SUM(CASE WHEN m.prev_capped_end_ts IS NULL
        OR m.ts - m.prev_capped_end_ts >= CAST((${merge_gap_ms|500}) * 1000000 AS INTEGER)
        THEN 1 ELSE 0 END) OVER (
        PARTITION BY m.policy_cpu ORDER BY m.ts, m.counter_id ROWS UNBOUNDED PRECEDING
      ) AS trace_episode_seq
    FROM (
      SELECT s.*,
        LAG(s.raw_end_ts) OVER (PARTITION BY s.policy_cpu ORDER BY s.ts, s.counter_id) AS prev_capped_end_ts
      FROM system_cpu_freq_limit_samples s
      WHERE s.kind = 'max' AND s.is_capped = 1 AND s.raw_end_ts > s.ts
    ) m
  ) g
),
-- The onset is observed only when the first capped sample records a change
-- from a contiguous valid value.
system_cpu_freq_limit_trace_episodes AS MATERIALIZED (
  SELECT f.trace_episode_id, f.policy_cpu, f.trace_episode_seq,
    MIN(f.ts) AS onset_ts,
    MAX(f.raw_end_ts) AS end_ts,
    MAX(CASE WHEN f.first_direction_basis = 'contiguous_valid_previous' THEN 1 ELSE 0 END) AS onset_observed,
    MAX(f.first_direction_basis) AS onset_basis
  FROM (
    SELECT e.*,
      FIRST_VALUE(e.direction_basis) OVER (PARTITION BY e.policy_cpu, e.trace_episode_seq ORDER BY e.ts, e.counter_id)
        AS first_direction_basis
    FROM system_cpu_freq_limit_trace_episode_spans e
  ) f
  GROUP BY f.trace_episode_id, f.policy_cpu, f.trace_episode_seq
),
-- One row per limit sample of every policy, inside an episode or not. Max
-- samples are trigger candidates; uncapped restorations and changes outside
-- episodes are events with a direction but no trigger verdict. Min limits
-- (floors) are policy actions too, but they never cap a frequency: they are
-- non-trigger facts, never in an episode, trigger class or rank.
system_cpu_freq_limit_events AS (
  SELECT s.track_id, s.policy_cpu, s.kind, s.counter_id, s.ts, s.raw_end_ts,
    s.limit_khz, s.limit_value_valid, s.prev_sample_limit_khz, s.prev_valid_limit_khz,
    CASE
      WHEN s.value_change NOT IN ('decreased', 'increased') THEN s.value_change
      WHEN s.kind = 'max' THEN CASE s.value_change WHEN 'decreased' THEN 'tightened' ELSE 'relaxed' END
      ELSE CASE s.value_change WHEN 'increased' THEN 'floor_raised' ELSE 'floor_lowered' END
    END AS direction,
    s.direction_basis,
    CASE WHEN s.value_change IN ('decreased', 'increased')
      THEN s.limit_khz - s.prev_valid_limit_khz END AS delta_khz,
    s.is_value_onset, s.value_onset_counter_id, s.value_onset_ts, s.value_end_ts,
    s.is_capped, s.reference_max_limit_khz, s.reference_basis,
    CASE WHEN tes.trace_episode_id IS NULL THEN 0 ELSE 1 END AS in_episode,
    tes.trace_episode_id,
    CASE s.kind WHEN 'max' THEN 'trigger_candidate' ELSE 'non_trigger_fact' END AS event_role
  FROM system_cpu_freq_limit_samples s
  LEFT JOIN system_cpu_freq_limit_trace_episode_spans tes ON tes.counter_id = s.counter_id
),
system_cpu_freq_limit_max_events AS MATERIALIZED (
  SELECT * FROM system_cpu_freq_limit_events WHERE kind = 'max'
),
-- Window-scoped episodes: the capped trace-episode spans that fall inside a
-- window, one row per (window, trace episode). `episode_id` keeps the
-- per-window numbering (`policy%d-ep%d`); `trace_episode_id`, `onset_ts` and
-- `onset_observed` identify the window-independent episode it belongs to.
system_cpu_freq_limit_capped_spans AS (
  SELECT s.*, tes.trace_episode_id, tes.trace_episode_seq
  FROM system_cpu_freq_limit_spans s
  JOIN system_cpu_freq_limit_trace_episode_spans tes ON tes.counter_id = s.counter_id
  WHERE s.kind = 'max' AND s.dur_ns > 0
),
system_cpu_freq_limit_episodes AS (
  SELECT
    g.window_id,
    g.policy_cpu,
    printf('policy%d-ep%d', g.policy_cpu,
      ROW_NUMBER() OVER (PARTITION BY g.window_id, g.policy_cpu ORDER BY g.episode_start_ts, g.trace_episode_seq))
      AS episode_id,
    g.trace_episode_id,
    te.onset_ts,
    te.onset_observed,
    te.onset_basis,
    te.end_ts AS trace_episode_end_ts,
    g.ucpu, g.machine_id, g.capacity, g.core_type, g.topology_source,
    g.episode_start_ts, g.episode_end_ts, g.episode_dur_ns,
    g.min_limit_khz, g.max_limit_khz_in_episode, g.reference_max_limit_khz, g.reference_basis,
    g.depth_pct, g.change_count,
    g.starts_at_data_start, g.ends_at_data_end,
    g.clipped_at_window_start, g.clipped_at_window_end,
    g.limit_source, g.evidence_status, g.evidence_scope
  FROM (
    SELECT c.window_id, c.policy_cpu, c.trace_episode_id, c.trace_episode_seq,
      MAX(c.ucpu) AS ucpu,
      MAX(c.machine_id) AS machine_id,
      MAX(c.capacity) AS capacity,
      MAX(c.core_type) AS core_type,
      MAX(c.topology_source) AS topology_source,
      MIN(c.clipped_start_ts) AS episode_start_ts,
      MAX(c.clipped_end_ts) AS episode_end_ts,
      MAX(c.clipped_end_ts) - MIN(c.clipped_start_ts) AS episode_dur_ns,
      MIN(c.limit_khz) AS min_limit_khz,
      MAX(c.limit_khz) AS max_limit_khz_in_episode,
      MAX(c.reference_max_limit_khz) AS reference_max_limit_khz,
      MAX(c.reference_basis) AS reference_basis,
      ROUND(100.0 * (MAX(c.reference_max_limit_khz) - MIN(c.limit_khz))
        / NULLIF(MAX(c.reference_max_limit_khz), 0), 1) AS depth_pct,
      COUNT(*) AS change_count,
      MAX(CASE WHEN c.is_first_max_sample THEN 1 ELSE 0 END) AS starts_at_data_start,
      MAX(CASE WHEN c.is_last_max_sample THEN 1 ELSE 0 END) AS ends_at_data_end,
      MAX(CASE WHEN c.left_censored THEN 1 ELSE 0 END) AS clipped_at_window_start,
      MAX(CASE WHEN c.right_censored THEN 1 ELSE 0 END) AS clipped_at_window_end,
      MAX(c.limit_source) AS limit_source,
      CASE WHEN MAX(CASE WHEN c.is_first_max_sample THEN 1 ELSE 0 END) = 1
          OR MAX(CASE WHEN c.is_last_max_sample THEN 1 ELSE 0 END) = 1
          OR MAX(CASE WHEN c.left_censored THEN 1 ELSE 0 END) = 1
          OR MAX(CASE WHEN c.right_censored THEN 1 ELSE 0 END) = 1
        THEN 'partial' ELSE 'observed' END AS evidence_status,
      'observation_not_causal' AS evidence_scope
    FROM system_cpu_freq_limit_capped_spans c
    GROUP BY c.window_id, c.policy_cpu, c.trace_episode_id, c.trace_episode_seq
  ) g
  JOIN system_cpu_freq_limit_trace_episodes te ON te.trace_episode_id = g.trace_episode_id
)
