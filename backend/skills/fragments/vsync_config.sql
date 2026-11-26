-- Fragment: vsync_config
-- Estimates VSync period using scoped then trace-wide VSYNC/FrameTimeline evidence.
-- The explicit 16.67ms default is used only when the trace has no usable timing evidence.
-- Snaps to nearest standard refresh rate (30/60/90/120/144/165 Hz) to avoid
-- half-period toggle contamination and jitter-induced miscalculation.
-- Params: ${start_ts}, ${end_ts}
vsync_counter_intervals AS (
  SELECT t.name AS track_name, c.ts,
    c.ts - LAG(c.ts) OVER (PARTITION BY c.track_id ORDER BY c.ts) AS interval_ns
  FROM counter_track t JOIN counter c ON c.track_id = t.id
  WHERE t.name IN ('VSYNC-app', 'VSYNC-sf')
),
-- SF can sleep through display ticks when the app produces frames slowly.
-- Keep both ends of each scoped interval inside the padded window.
vsync_counter_periods AS (
  SELECT track_name,
    PERCENTILE(interval_ns, 50) FILTER (WHERE
      (${start_ts} IS NULL OR ts - interval_ns >= ${start_ts} - 100000000)
      AND (${end_ts} IS NULL OR ts < ${end_ts} + 100000000)) AS scoped_ns,
    PERCENTILE(interval_ns, 50) AS trace_ns
  FROM vsync_counter_intervals
  WHERE interval_ns > 5500000 AND interval_ns < 50000000
  GROUP BY track_name
),
vsync_candidates AS (
  SELECT scoped_ns AS period_ns, 1 AS priority, track_name, 'vsync_counter' AS source
    FROM vsync_counter_periods
  UNION ALL
  SELECT PERCENTILE(dur, 50), 2, NULL, 'expected_frame'
    FROM expected_frame_timeline_slice WHERE dur > 5000000 AND dur < 50000000
    AND (${start_ts} IS NULL OR ts >= ${start_ts})
    AND (${end_ts} IS NULL OR ts < ${end_ts})
  UNION ALL
  SELECT trace_ns, 3, track_name, 'vsync_counter' FROM vsync_counter_periods
  UNION ALL
  SELECT PERCENTILE(dur, 50), 4, NULL, 'expected_frame'
    FROM expected_frame_timeline_slice WHERE dur > 5000000 AND dur < 50000000
  UNION ALL
  SELECT 16666667, 5, NULL, 'default_60hz_no_trace_timing'
),
raw_vsync_config AS (
  SELECT CAST(period_ns AS INTEGER) AS raw_ns, track_name,
    CASE WHEN priority = 5 THEN source
      WHEN priority <= 2 AND ${start_ts} IS NOT NULL AND ${end_ts} IS NOT NULL THEN 'scoped_' || source
      ELSE 'trace_wide_' || source END AS vsync_source
  FROM vsync_candidates WHERE period_ns > 0
  ORDER BY priority, CASE WHEN track_name = 'VSYNC-app' THEN 0 ELSE 1 END LIMIT 1
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
    vsync_source, track_name AS counter_source
  FROM raw_vsync_config
)
