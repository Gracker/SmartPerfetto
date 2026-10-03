-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: fragments/gpu_frequency_intervals.sql and
-- fragments/gpu_frequency_window.sql, listed before this fragment. One row
-- per GPU over the window: observed time split into running, off and
-- out-of-domain time, and the running frequencies (MHz) weighted by time.
-- A share of running time and a share of observed time are different
-- numbers; a consumer names which one it reports.
gpu_frequency_summary AS (
  SELECT
    gpu_id,
    SUM(dur) AS observed_ns,
    SUM(CASE WHEN running_mhz IS NOT NULL THEN dur ELSE 0 END) AS running_ns,
    SUM(CASE WHEN is_off THEN dur ELSE 0 END) AS off_ns,
    SUM(CASE WHEN freq_mhz IS NULL THEN dur ELSE 0 END) AS out_of_domain_ns,
    SUM(running_mhz * dur) / NULLIF(SUM(CASE WHEN running_mhz IS NOT NULL THEN dur END), 0) AS avg_running_mhz,
    MAX(running_mhz) AS max_running_mhz,
    MIN(running_mhz) AS min_running_mhz,
    COUNT(DISTINCT running_mhz) AS running_levels,
    SUM(is_running_change) AS running_change_count
  FROM gpu_frequency_window
  GROUP BY gpu_id
)
