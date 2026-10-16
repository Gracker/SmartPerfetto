-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: system_windows(window_id, window_start_ts, window_end_ts).
-- Kernel cooling-device state from the ftrace event thermal/cdev_update, typed
-- as counter_track.type='cooling_device_counter'. The value is the requested
-- target state; 0 means the device is not cooling.
--
-- `cdev_kind_hint` is derived from the device NAME and is a hint only: the
-- kernel does not export the governed subsystem through this event, so the
-- hint cannot establish which policy a cooling device actually throttles;
-- thermal_cdev_policy_association.sql ties a device to a policy from
-- transition/limit-change timing instead.
-- Absence of these tracks is not absence of throttling. Platforms whose
-- userspace thermal daemon writes the cpufreq sysfs limits directly emit no
-- cdev_update at all.
--
-- Device identity is resolved once per track, not once per sample: the
-- `linux_device` dimension lookup is a correlated subquery and dominated the
-- per-sample scan when it sat there.
thermal_cooling_devices AS (
  SELECT ct.id AS cdev_track_id,
    COALESCE(
      (SELECT a.string_value FROM args a
       WHERE a.arg_set_id = ct.dimension_arg_set_id AND a.key = 'linux_device'),
      ct.name
    ) AS cdev_name,
    CASE
      WHEN LOWER(ct.name) GLOB '*cpufreq*' THEN 'cpufreq'
      WHEN LOWER(ct.name) GLOB '*gpufreq*' THEN 'gpufreq'
      ELSE 'other'
    END AS cdev_kind_hint,
    'name_pattern_hint_not_kernel_declared_target' AS cdev_kind_basis
  FROM counter_track ct
  WHERE ct.type = 'cooling_device_counter'
),
-- `direction` compares a sample with the previous one of the same device; it
-- is the only cooling direction rule, shared by the windowed spans and by
-- thermal_cdev_policy_association.sql. `raw_end_ts` is the unclipped end of
-- the state a sample sets.
thermal_cooling_raw AS MATERIALIZED (
  SELECT x.*,
    CASE
      WHEN x.prev_state IS NULL THEN 'first_observed_sample'
      WHEN x.state > x.prev_state THEN 'tightened'
      WHEN x.state < x.prev_state THEN 'relaxed'
      ELSE 'unchanged'
    END AS direction,
    COALESCE(x.next_ts, (SELECT end_ts FROM trace_bounds)) AS raw_end_ts
  FROM (
    SELECT c.track_id AS cdev_track_id,
      c.id AS counter_id, c.ts, CAST(c.value AS INTEGER) AS state,
      CAST(LAG(c.value) OVER (PARTITION BY c.track_id ORDER BY c.ts, c.id) AS INTEGER) AS prev_state,
      LEAD(c.ts) OVER (PARTITION BY c.track_id ORDER BY c.ts, c.id) AS next_ts
    FROM counter c
    WHERE c.track_id IN (SELECT cdev_track_id FROM thermal_cooling_devices)
  ) x
),
thermal_cooling_spans AS (
  SELECT w.window_id, w.window_start_ts, w.window_end_ts,
    d.cdev_track_id, d.cdev_name, d.cdev_kind_hint, d.cdev_kind_basis,
    r.counter_id, r.ts, r.state, r.prev_state, r.direction,
    r.state > 0 AS is_cooling_active,
    r.ts AS raw_start_ts, r.raw_end_ts,
    MAX(r.ts, w.window_start_ts) AS clipped_start_ts,
    MIN(r.raw_end_ts, w.window_end_ts) AS clipped_end_ts,
    MIN(r.raw_end_ts, w.window_end_ts) - MAX(r.ts, w.window_start_ts) AS dur_ns,
    r.ts < w.window_start_ts AS left_censored,
    r.next_ts IS NULL OR r.next_ts > w.window_end_ts AS right_censored,
    'ftrace:thermal/cdev_update' AS cooling_source
  FROM system_windows w
  JOIN thermal_cooling_raw r
    ON r.ts < w.window_end_ts AND r.raw_end_ts > w.window_start_ts
  JOIN thermal_cooling_devices d ON d.cdev_track_id = r.cdev_track_id
  WHERE w.window_end_ts > w.window_start_ts
)
