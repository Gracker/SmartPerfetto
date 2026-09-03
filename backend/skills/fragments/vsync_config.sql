-- Fragment: vsync_config
-- Estimates VSync period using scoped then trace-wide VSYNC/FrameTimeline evidence.
-- The explicit 16.67ms default is used only when the trace has no usable timing evidence.
-- Snaps to nearest standard refresh rate (30/60/90/120/144/165 Hz) to avoid
-- half-period toggle contamination and jitter-induced miscalculation.
-- Params: ${start_ts}, ${end_ts}
vsync_ticks AS (
  SELECT c.ts, c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
    AND (${start_ts} IS NULL OR c.ts >= ${start_ts} - 100000000)
    AND (${end_ts} IS NULL OR c.ts < ${end_ts} + 100000000)
),
trace_vsync_ticks AS (
  SELECT c.ts, c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
),
expected_frame_vsync AS (
  SELECT CAST(PERCENTILE(dur, 50) AS INTEGER) as period_ns
  FROM expected_frame_timeline_slice
  WHERE dur > 5000000 AND dur < 50000000
    AND (${start_ts} IS NULL OR ts >= ${start_ts})
    AND (${end_ts} IS NULL OR ts < ${end_ts})
),
trace_expected_frame_vsync AS (
  SELECT CAST(PERCENTILE(dur, 50) AS INTEGER) as period_ns
  FROM expected_frame_timeline_slice
  WHERE dur > 5000000 AND dur < 50000000
),
raw_vsync_config AS (
  SELECT
    CAST(COALESCE(
      (SELECT PERCENTILE(interval_ns, 50)
       FROM vsync_ticks
       WHERE interval_ns > 5500000 AND interval_ns < 50000000),
      (SELECT period_ns FROM expected_frame_vsync WHERE period_ns > 0),
      (SELECT PERCENTILE(interval_ns, 50)
       FROM trace_vsync_ticks
       WHERE interval_ns > 5500000 AND interval_ns < 50000000),
      (SELECT period_ns FROM trace_expected_frame_vsync WHERE period_ns > 0),
      16666667
    ) AS INTEGER) as raw_ns,
    CASE
      WHEN (SELECT COUNT(*) FROM vsync_ticks WHERE interval_ns > 5500000 AND interval_ns < 50000000) > 0
        THEN CASE
          WHEN ${start_ts} IS NULL OR ${end_ts} IS NULL THEN 'trace_wide_vsync_counter'
          ELSE 'scoped_vsync_counter'
        END
      WHEN (SELECT period_ns FROM expected_frame_vsync WHERE period_ns > 0) IS NOT NULL
        THEN CASE
          WHEN ${start_ts} IS NULL OR ${end_ts} IS NULL THEN 'trace_wide_expected_frame'
          ELSE 'scoped_expected_frame'
        END
      WHEN (SELECT COUNT(*) FROM trace_vsync_ticks WHERE interval_ns > 5500000 AND interval_ns < 50000000) > 0
        THEN 'trace_wide_vsync_counter'
      WHEN (SELECT period_ns FROM trace_expected_frame_vsync WHERE period_ns > 0) IS NOT NULL
        THEN 'trace_wide_expected_frame'
      ELSE 'default_60hz_no_trace_timing'
    END as vsync_source
),
vsync_config AS (
  SELECT
    CASE
      WHEN raw_ns BETWEEN 5500000 AND 6500000 THEN 6060606
      WHEN raw_ns BETWEEN 6500001 AND 7500000 THEN 6944444
      WHEN raw_ns BETWEEN 7500001 AND 9500000 THEN 8333333
      WHEN raw_ns BETWEEN 9500001 AND 12500000 THEN 11111111
      WHEN raw_ns BETWEEN 12500001 AND 20000000 THEN 16666667
      WHEN raw_ns BETWEEN 20000001 AND 35000000 THEN 33333333
      ELSE raw_ns
    END AS vsync_period_ns,
    vsync_source
  FROM raw_vsync_config
)
