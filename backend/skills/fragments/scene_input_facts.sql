-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Shared input observation contract. Legacy android_input_events contains only
-- acknowledged deliveries: absence never proves that a user/device was idle.
-- Do not infer scrolling, long-click recognition or fling from MOVE counts,
-- contact duration or subsequent frames. Preserve native device/display IDs.
-- Requires fragments/android_input_events_normalized.sql listed before this
-- fragment: the legacy branch reads its prefix-free actions (MOVE, DOWN, UP)
-- and receiver_owns_window.
scene_raw_input AS (
  SELECT 'android_motion_events' AS source_table, CAST(id AS TEXT) AS source_id,
    ts, 'MOTION' AS event_type,
    CASE action & 255
      WHEN 0 THEN 'DOWN' WHEN 1 THEN 'UP' WHEN 2 THEN 'MOVE'
      WHEN 3 THEN 'CANCEL' WHEN 5 THEN 'POINTER_DOWN' WHEN 6 THEN 'POINTER_UP'
      WHEN 7 THEN 'HOVER_MOVE' WHEN 8 THEN 'SCROLL' ELSE 'UNKNOWN' END AS event_action,
    device_id, display_id, source AS input_source, NULL AS upid,
    NULL AS process_name, NULL AS event_channel, 0 AS receiver_owns_window,
    'device:' || COALESCE(CAST(device_id AS TEXT), 'unknown:' || id) ||
      ':display:' || COALESCE(CAST(display_id AS TEXT), 'unknown') ||
      ':source:' || COALESCE(CAST(source AS TEXT), 'unknown') AS stream_key,
    'event:' || event_id AS event_key, CAST(event_id AS TEXT) AS physical_event_id, id AS source_order
  FROM android_motion_events
  UNION ALL
  SELECT 'android_key_events', CAST(id AS TEXT), ts, 'KEY',
    CASE action WHEN 0 THEN 'KEY_DOWN' WHEN 1 THEN 'KEY_UP' ELSE 'UNKNOWN' END,
    device_id, display_id, source, NULL, NULL, NULL, 0,
    'device:' || COALESCE(CAST(device_id AS TEXT), 'unknown:' || id) ||
      ':display:' || COALESCE(CAST(display_id AS TEXT), 'unknown') ||
      ':source:' || COALESCE(CAST(source AS TEXT), 'unknown'),
    'event:' || event_id, CAST(event_id AS TEXT), id
  FROM android_key_events
  UNION ALL
  SELECT 'android_input_events',
    COALESCE(input_event_id, event_seq, '') || ':' || COALESCE(event_channel, '') || ':' || dispatch_ts,
    COALESCE(read_time, dispatch_ts, receive_ts), event_type,
    COALESCE(NULLIF(event_action, ''), 'UNKNOWN'), NULL, NULL, NULL, upid,
    process_name, event_channel, receiver_owns_window,
    -- Channel + process incarnation, not pid/name or a global DOWN counter.
    COALESCE(CAST(upid AS TEXT), 'unknown') || ':' ||
      COALESCE(event_channel, 'unknown:' || COALESCE(input_event_id, event_seq, CAST(dispatch_ts AS TEXT))),
    COALESCE(input_event_id, event_seq, '') || ':' || COALESCE(event_channel, '') || ':' || dispatch_ts,
    input_event_id, dispatch_ts
  FROM android_input_events_normalized AS legacy
  WHERE NOT EXISTS (
    SELECT 1 FROM android_motion_events AS m
    WHERE legacy.input_event_id IN (CAST(m.event_id AS TEXT), printf('0x%x', m.event_id))
  ) AND NOT EXISTS (
    SELECT 1 FROM android_key_events AS k
    WHERE legacy.input_event_id IN (CAST(k.event_id AS TEXT), printf('0x%x', k.event_id))
  )
),
scene_input_facts AS (
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY source_table, stream_key, event_key, ts, event_action ORDER BY source_id
    ) AS duplicate_rank FROM scene_raw_input
    WHERE ts IS NOT NULL AND ts >= (SELECT start_ts FROM trace_bounds)
      AND ts <= (SELECT end_ts FROM trace_bounds)
  ) WHERE duplicate_rank = 1
),
-- Multiple dispatch targets are observations of one physical event. Rank by
-- action availability on the receiving stream, then receiver_owns_window
-- (defined in android_input_events_normalized.sql), never by app/vendor name.
-- Candidates are the action-bearing receivers, else the window owners, else
-- every receiver; the ranking and receiver_count follow that same precedence.
-- More than one candidate stays unassigned; the selected row is provenance,
-- never a claim that this recipient owns the user's action.
scene_stream_quality AS (
  SELECT stream_key, SUM(event_action != 'UNKNOWN') AS known_actions
  FROM scene_input_facts GROUP BY stream_key
),
scene_physical_ranked AS (
  SELECT f.*, q.known_actions,
    COALESCE(f.physical_event_id || ':' || f.ts, f.source_table || ':' || f.source_id) AS physical_event_key,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(f.physical_event_id || ':' || f.ts, f.source_table || ':' || f.source_id)
      ORDER BY f.event_action = 'UNKNOWN', q.known_actions DESC, f.receiver_owns_window DESC,
        f.stream_key, f.source_id
    ) AS physical_rank
  FROM scene_input_facts f JOIN scene_stream_quality q USING (stream_key)
),
scene_physical_quality AS (
  SELECT physical_event_key, COUNT(*) AS dispatch_count,
    CASE WHEN MAX(known_actions) > 0
        THEN COUNT(DISTINCT CASE WHEN known_actions > 0 THEN stream_key END)
      WHEN MAX(receiver_owns_window) = 1
        THEN COUNT(DISTINCT CASE WHEN receiver_owns_window = 1 THEN stream_key END)
      ELSE COUNT(DISTINCT stream_key) END AS receiver_count,
    COUNT(DISTINCT CASE WHEN event_action != 'UNKNOWN' THEN event_action END) AS action_variants
  FROM scene_physical_ranked GROUP BY physical_event_key
),
scene_primary_input AS (
  SELECT f.source_table, f.source_id, f.ts, f.event_type,
    CASE WHEN q.action_variants > 1 THEN 'UNKNOWN' ELSE f.event_action END AS event_action,
    f.device_id, f.display_id, f.input_source,
    CASE WHEN q.receiver_count <= 1 THEN f.upid END AS upid,
    CASE WHEN q.receiver_count <= 1 THEN f.process_name END AS process_name,
    CASE WHEN q.receiver_count <= 1 THEN f.event_channel END AS event_channel,
    f.stream_key, f.source_order, f.physical_event_id, f.physical_event_key, q.dispatch_count, q.receiver_count,
    CASE WHEN q.receiver_count > 1 THEN 'multiple_recipients'
      WHEN f.upid IS NULL THEN 'unresolved' ELSE 'observed_recipient' END AS identity_status
  FROM scene_physical_ranked f JOIN scene_physical_quality q USING (physical_event_key)
  WHERE f.physical_rank = 1
),
scene_input_ordered AS (
  SELECT *, LAG(event_action) OVER (
    PARTITION BY stream_key ORDER BY ts, source_order, source_id
  ) AS previous_action
  FROM scene_primary_input
),
scene_input_grouped AS (
  SELECT *, SUM(CASE WHEN event_action = 'DOWN' OR previous_action IS NULL
      OR previous_action IN ('UP', 'CANCEL') OR event_type != 'MOTION'
      OR event_action IN ('SCROLL', 'HOVER_MOVE') THEN 1 ELSE 0 END)
    OVER (PARTITION BY stream_key ORDER BY ts, source_order, source_id ROWS UNBOUNDED PRECEDING) AS gesture_id
  FROM scene_input_ordered
),
scene_input_segmented AS (
  SELECT *, FIRST_VALUE(source_id) OVER (
      PARTITION BY stream_key, gesture_id ORDER BY ts, source_order, source_id
    ) AS start_source_id,
    FIRST_VALUE(source_id) OVER (
      PARTITION BY stream_key, gesture_id ORDER BY ts DESC, source_order DESC, source_id DESC
    ) AS end_source_id,
    FIRST_VALUE(physical_event_id) OVER (
      PARTITION BY stream_key, gesture_id ORDER BY ts, source_order, source_id
    ) AS first_physical_event_id,
    FIRST_VALUE(physical_event_id) OVER (
      PARTITION BY stream_key, gesture_id ORDER BY ts DESC, source_order DESC, source_id DESC
    ) AS last_physical_event_id
  FROM scene_input_grouped
),
scene_contacts AS (
  SELECT stream_key, gesture_id, MIN(ts) AS ts, MAX(ts) AS end_ts,
    MAX(ts) - MIN(ts) AS dur, CASE WHEN MAX(identity_status = 'multiple_recipients') = 0 THEN MAX(upid) END AS upid,
    CASE WHEN MAX(identity_status = 'multiple_recipients') = 0 THEN MAX(process_name) END AS app_package,
    CASE WHEN MAX(identity_status = 'multiple_recipients') = 0 THEN MAX(event_channel) END AS event_channel,
    MAX(device_id) AS device_id, MAX(display_id) AS display_id, MAX(input_source) AS input_source,
    SUM(dispatch_count) AS dispatch_count, MAX(receiver_count) AS receiver_count,
    CASE WHEN MAX(identity_status = 'multiple_recipients') THEN 'multiple_recipients'
      WHEN MAX(identity_status = 'unresolved') THEN 'unresolved' ELSE 'observed_recipient' END AS identity_status,
    MIN(source_table) AS source_table, MIN(start_source_id) AS source_id,
    MIN(start_source_id) || ',' || MAX(end_source_id) AS source_ids,
    MAX(first_physical_event_id) AS first_physical_event_id,
    MAX(last_physical_event_id) AS last_physical_event_id, COUNT(*) AS event_count,
    SUM(event_action = 'MOVE') AS move_count,
    SUM(event_action = 'UNKNOWN') AS missing_action_count,
    MIN(CASE WHEN event_action = 'DOWN' THEN ts END) AS down_ts,
    MAX(CASE WHEN event_action = 'UP' THEN ts END) AS up_ts,
    MAX(event_action = 'CANCEL') AS was_cancelled,
    MAX(event_type = 'KEY') AS is_key,
    -- ACTION_SCROLL describes axis input, not the physical device or app content motion.
    MAX(event_action = 'SCROLL') AS has_scroll_action,
    MAX(event_action IN ('POINTER_DOWN', 'POINTER_UP')) AS multi_pointer
  FROM scene_input_segmented GROUP BY stream_key, gesture_id
),
scene_gestures AS (
  SELECT *,
    CASE WHEN was_cancelled THEN 'cancelled'
      WHEN is_key THEN 'key' WHEN has_scroll_action THEN 'scroll_input'
      WHEN move_count > 0 THEN 'touch_move'
      WHEN missing_action_count > 0 OR down_ts IS NULL OR up_ts IS NULL THEN 'input_unknown'
      WHEN multi_pointer THEN 'input_unknown'
      WHEN dur >= 500000000 THEN 'touch_hold' ELSE 'tap' END AS gesture_type,
    CASE WHEN down_ts IS NOT NULL AND up_ts IS NOT NULL AND missing_action_count = 0
      AND was_cancelled = 0 THEN 1 ELSE 0 END AS boundary_complete,
    CASE WHEN missing_action_count > 0 OR identity_status = 'multiple_recipients' OR (is_key = 0 AND has_scroll_action = 0
      AND (down_ts IS NULL OR (up_ts IS NULL AND was_cancelled = 0)))
      THEN 'partial' ELSE 'observed' END AS source_status
  FROM scene_contacts
),
-- A one-nanosecond occupancy is used only for gap subtraction at an instant.
-- The event itself keeps dur=0. Open contacts stop at their last observation.
scene_input_occupied AS (
  SELECT ts, MIN(MAX(end_ts, ts + 1), (SELECT end_ts FROM trace_bounds)) AS end_ts
  FROM scene_gestures
),
scene_input_union_scan AS (
  SELECT *, MAX(end_ts) OVER (
    ORDER BY ts, end_ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS previous_end FROM scene_input_occupied
),
scene_input_gaps AS (
  SELECT (SELECT start_ts FROM trace_bounds) AS ts,
    COALESCE(MIN(ts), (SELECT end_ts FROM trace_bounds)) AS end_ts FROM scene_input_occupied
  UNION ALL
  SELECT previous_end, ts FROM scene_input_union_scan WHERE ts > previous_end
  UNION ALL
  SELECT MAX(end_ts), (SELECT end_ts FROM trace_bounds) FROM scene_input_occupied
  HAVING MAX(end_ts) < (SELECT end_ts FROM trace_bounds)
)
