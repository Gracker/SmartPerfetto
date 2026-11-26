-- Strictly in-window counter evidence; cadence audits require measured intervals.
-- Keep both sources so minimum-sample policies can admit the next candidate.
panel_counter_stats AS (
  SELECT track_name, CAST(PERCENTILE(interval_ns, 50) AS INTEGER) AS period_ns,
    COUNT(*) AS sample_count
  FROM vsync_counter_intervals
  WHERE interval_ns > 5500000 AND interval_ns < 50000000
    AND (${start_ts} IS NULL OR ts - interval_ns >= ${start_ts})
    AND (${end_ts} IS NULL OR ts < ${end_ts})
  GROUP BY track_name
),
preferred_panel_counter AS (
  SELECT * FROM panel_counter_stats
  ORDER BY (track_name = 'VSYNC-app') DESC LIMIT 1
)
