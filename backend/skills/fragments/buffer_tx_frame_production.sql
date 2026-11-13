-- BufferTX received pending-buffer updates for one package name.
-- Positive deltas describe SF-side pending transaction updates, not produced,
-- ready, latched or displayed frames. Track-name matching is not exact UPID
-- attribution. Select one track to avoid summing duplicate layer tracks.
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
    ) as prev_value,
    LAG(c.ts) OVER (
      PARTITION BY c.track_id
      ORDER BY c.ts, c.id
    ) as prev_ts
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
    -- Keep the preceding sample for deltas at the requested window boundary.
    AND (${end_ts} IS NULL OR c.ts < ${end_ts})
),
buffer_tx_deltas AS (
  SELECT
    counter_id,
    track_id,
    track_name,
    ts,
    CASE
      WHEN ${start_ts} IS NOT NULL AND prev_ts < ${start_ts} THEN ${start_ts}
      ELSE COALESCE(prev_ts, ts)
    END as observation_start_ts,
    CASE
      WHEN prev_value IS NOT NULL AND value > prev_value
        THEN CAST(value - prev_value AS INTEGER)
      ELSE 0
    END as received_buffer_updates
  FROM buffer_tx_samples
  WHERE (${start_ts} IS NULL OR ts >= ${start_ts})
),
buffer_tx_track_stats AS (
  SELECT
    track_id,
    track_name,
    CAST(SUM(received_buffer_updates) AS INTEGER) as received_buffer_updates,
    -- Legacy internal alias; its value counts received updates, never frames.
    CAST(SUM(received_buffer_updates) AS INTEGER) as produced_frames,
    MIN(observation_start_ts) as first_sample_ts,
    MAX(ts) as last_sample_ts,
    MAX(ts) - MIN(observation_start_ts) as effective_span_ns
  FROM buffer_tx_deltas
  GROUP BY track_id, track_name
  HAVING SUM(received_buffer_updates) >= 5
    AND MAX(ts) > MIN(observation_start_ts)
    AND MAX(ts) - MIN(observation_start_ts) >= 5 * (SELECT vsync_period_ns FROM vsync_config)
),
selected_buffer_tx_track AS (
  SELECT *
  FROM buffer_tx_track_stats
  ORDER BY received_buffer_updates DESC, effective_span_ns DESC, track_id ASC
  LIMIT 1
)
-- BUFFER_TX_FALLBACK_CTES_END
