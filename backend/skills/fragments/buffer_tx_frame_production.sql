-- BufferTX frame production evidence for one package.
-- Counts only positive per-track queue-depth deltas, then selects one primary
-- track deterministically to avoid summing duplicate producer/layer tracks.
-- Requires vsync_config to be injected before this fragment.
-- BUFFER_TX_FALLBACK_CTES_BEGIN
buffer_tx_samples AS (
  SELECT
    c.id as counter_id,
    c.track_id,
    ct.name as track_name,
    c.ts,
    c.value,
    LAG(c.value) OVER (
      PARTITION BY c.track_id
      ORDER BY c.ts, c.id
    ) as prev_value
  FROM counter c
  JOIN counter_track ct ON c.track_id = ct.id
  WHERE '${package}' != ''
    AND ct.name GLOB 'BufferTX - *'
    AND INSTR(ct.name, '${package}') > 0
    AND (
      INSTR(ct.name, '${package}') = 1
      OR SUBSTR(ct.name, INSTR(ct.name, '${package}') - 1, 1)
        IN (' ', '[', '(', ':', '/', '-')
    )
    AND (
      INSTR(ct.name, '${package}') + LENGTH('${package}') > LENGTH(ct.name)
      OR SUBSTR(
        ct.name,
        INSTR(ct.name, '${package}') + LENGTH('${package}'),
        1
      ) IN ('/', ':', '#', ']', ')', ' ')
    )
    AND (${start_ts} IS NULL OR c.ts >= ${start_ts})
    AND (${end_ts} IS NULL OR c.ts < ${end_ts})
),
buffer_tx_deltas AS (
  SELECT
    counter_id,
    track_id,
    track_name,
    ts,
    CASE
      WHEN prev_value IS NOT NULL AND value > prev_value
        THEN CAST(value - prev_value AS INTEGER)
      ELSE 0
    END as produced_frames
  FROM buffer_tx_samples
),
buffer_tx_track_stats AS (
  SELECT
    track_id,
    track_name,
    CAST(SUM(produced_frames) AS INTEGER) as produced_frames,
    MIN(ts) as first_sample_ts,
    MAX(ts) as last_sample_ts,
    MAX(ts) - MIN(ts) as effective_span_ns
  FROM buffer_tx_deltas
  GROUP BY track_id, track_name
  HAVING SUM(produced_frames) >= 5
    AND MAX(ts) > MIN(ts)
    AND MAX(ts) - MIN(ts) >= 5 * (SELECT vsync_period_ns FROM vsync_config)
),
selected_buffer_tx_track AS (
  SELECT *
  FROM buffer_tx_track_stats
  ORDER BY produced_frames DESC, effective_span_ns DESC, track_id ASC
  LIMIT 1
)
-- BUFFER_TX_FALLBACK_CTES_END
