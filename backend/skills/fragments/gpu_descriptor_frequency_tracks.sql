-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- No input CTE. GPU counter tracks other than the trace_processor gpufreq
-- (fragments/gpu_frequency_intervals.sql) whose name says frequency or clock:
-- GpuCounterDescriptor counters, which declare their own unit. to_mhz
-- converts a declared MHz, kHz or Hz; it is NULL for any other or no unit,
-- and such a track is named rather than read by guessing its unit.
gpu_descriptor_frequency_tracks AS (
  SELECT
    t.id,
    t.name,
    t.unit,
    CASE t.unit WHEN 'MHz' THEN 1.0 WHEN 'kHz' THEN 1e-3 WHEN 'Hz' THEN 1e-6 END AS to_mhz
  FROM gpu_counter_track t
  WHERE t.name != 'gpufreq'
    AND (LOWER(t.name) GLOB '*freq*' OR LOWER(t.name) GLOB '*clock*')
)
