-- Camera/media observation primitives. No configured FPS, panel period,
-- headroom or fault mechanism is inferred from these measurements.
camera_input AS (
  SELECT MIN(COALESCE(${start_ts}, trace_start()), COALESCE(${end_ts}, trace_end())) AS start_ts,
    MAX(COALESCE(${start_ts}, trace_start()), COALESCE(${end_ts}, trace_end())) AS end_ts,
    MIN(MAX(COALESCE(${max_rows|20}, 20), 1), 100) AS max_rows
),
camera_frame_rows AS (
  -- Retain intersecting metadata across either edge. Endpoint cadence and
  -- work-start population select their own window membership below.
  SELECT f.*, p.name AS process_name,
    CASE WHEN f.surface_frame_token IS NULL THEN 'display_frame' ELSE 'surface_frame' END AS frame_kind,
    CASE WHEN f.surface_frame_token IS NULL AND f.dur >= 0 AND f.present_type != 'Dropped Frame'
      THEN f.ts + f.dur END AS completed_display_present_ts,
    CASE WHEN f.surface_frame_token IS NULL AND f.dur >= 0 AND f.present_type != 'Dropped Frame'
      AND f.ts + f.dur >= i.start_ts AND f.ts + f.dur < i.end_ts
      THEN f.ts + f.dur END AS display_present_ts
  FROM actual_frame_timeline_slice f LEFT JOIN process p USING (upid), camera_input i
  WHERE f.ts < i.end_ts AND (f.dur IS NULL OR f.dur < 0 OR f.ts + f.dur >= i.start_ts)
),
camera_display_intervals AS (
  SELECT *, display_present_ts - LAG(display_present_ts) OVER (
    PARTITION BY upid ORDER BY display_present_ts, id) AS display_interval_ns
  FROM camera_frame_rows WHERE display_present_ts IS NOT NULL
),
camera_callback_raw AS (
  SELECT s.id AS callback_id, s.ts AS arrival_ts, t.upid AS source_upid,
    p.name AS source_process, t.utid, t.tid,
    SUBSTR(s.name, LENGTH('onFrameAvailable - ') + 1) AS marker
  FROM slice s JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t USING (utid) LEFT JOIN process p USING (upid), camera_input i
  WHERE s.name GLOB 'onFrameAvailable - *' AND s.ts >= i.start_ts AND s.ts < i.end_ts
),
camera_callbacks AS (
  -- BLAST runtime counters are not part of the observed queue instance name.
  -- All instance suffixes remain; no identity is inferred across naming domains.
  SELECT *, CASE WHEN INSTR(marker, '(f:') > 0
    THEN SUBSTR(marker, 1, INSTR(marker, '(f:') - 1) ELSE marker END AS source_surface
  FROM camera_callback_raw
),
camera_callback_intervals AS (
  SELECT *, arrival_ts - LAG(arrival_ts) OVER (
    PARTITION BY source_upid, source_surface ORDER BY arrival_ts, callback_id) AS callback_interval_ns
  FROM camera_callbacks
),
camera_latch_raw AS (
  SELECT s.id AS latch_id, s.ts AS latch_ts, s.track_id AS latch_track_id,
    t.upid AS sf_upid, s.id, s.parent_id, s.name,
    SUBSTR(s.name, LENGTH('latchBuffer ') + 1) AS marker,
    SUBSTR(s.name, INSTR(s.name, ' - ') + LENGTH(' - ')) AS buffer_text
  FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING (utid), camera_input i
  WHERE s.name GLOB 'latchBuffer * - *' AND s.ts >= i.start_ts AND s.ts < i.end_ts
),
camera_latches AS (
  SELECT *, SUBSTR(marker, 1, INSTR(marker, ' - ') - 1) AS bindable_surface,
    CAST(buffer_text AS INTEGER) AS buffer_number
  FROM camera_latch_raw
  WHERE INSTR(marker, ' SurfaceView[') > 1 AND INSTR(marker, ']') > INSTR(marker, ' SurfaceView[')
    AND buffer_text != '' AND buffer_text NOT GLOB '*[^0-9]*'
),
camera_latch_ancestors AS (
  SELECT latch_id, latch_ts, latch_track_id, sf_upid, bindable_surface, buffer_number,
    id, parent_id, name FROM camera_latches
  UNION ALL
  SELECT l.latch_id, l.latch_ts, l.latch_track_id, l.sf_upid, l.bindable_surface, l.buffer_number,
    s.id, s.parent_id, s.name
  FROM camera_latch_ancestors l JOIN slice s ON s.id = l.parent_id AND s.track_id = l.latch_track_id
  WHERE l.name NOT GLOB 'commit *'
),
camera_commit_raw AS (
  SELECT *, SUBSTR(name, LENGTH('commit ') + 1) AS token_text
  FROM camera_latch_ancestors WHERE name GLOB 'commit *'
),
camera_unique_latches AS (
  SELECT l.bindable_surface, l.buffer_number, COUNT(*) AS latch_matches,
    l.sf_upid, MIN(l.latch_id) AS latch_id, MIN(l.latch_ts) AS latch_ts,
    MIN(c.id) AS commit_id, MIN(CAST(c.token_text AS INTEGER)) AS display_token
  FROM camera_latches l LEFT JOIN camera_commit_raw c ON c.latch_id = l.latch_id
    AND c.token_text != '' AND c.token_text NOT GLOB '*[^0-9]*'
  GROUP BY l.sf_upid, l.bindable_surface, l.buffer_number
),
camera_display_tokens AS (
  SELECT upid, display_frame_token, COUNT(*) AS display_matches,
    MIN(id) AS display_id, MIN(display_present_ts) AS display_present_ts,
    MIN(completed_display_present_ts) AS completed_display_present_ts
  FROM camera_frame_rows WHERE frame_kind = 'display_frame'
  GROUP BY upid, display_frame_token
),
camera_buffer_links AS (
  SELECT l.*, d.display_id, d.display_matches, d.display_present_ts,
    CASE WHEN l.latch_matches != 1 THEN 'ambiguous_latch'
      WHEN l.commit_id IS NULL THEN 'commit_binding_missing'
      WHEN d.display_matches IS NULL THEN 'display_frame_missing'
      WHEN d.display_matches != 1 THEN 'ambiguous_display_frame'
      WHEN d.display_present_ts IS NULL AND d.completed_display_present_ts IS NOT NULL
        THEN 'display_endpoint_outside_window'
      WHEN d.display_present_ts IS NULL THEN 'display_endpoint_unavailable'
      WHEN l.latch_ts > d.display_present_ts THEN 'timestamp_order_invalid'
      ELSE 'sf_commit_display_bound' END AS binding_status
  FROM camera_unique_latches l
  LEFT JOIN camera_display_tokens d ON d.upid = l.sf_upid AND d.display_frame_token = l.display_token
),
camera_surface_presents AS (
  SELECT *, display_present_ts - LAG(display_present_ts) OVER (
    PARTITION BY sf_upid, bindable_surface ORDER BY display_present_ts, display_id) AS surface_present_interval_ns
  FROM camera_buffer_links
  WHERE latch_matches = 1 AND display_matches = 1 AND display_present_ts IS NOT NULL
    AND latch_ts <= display_present_ts
)
