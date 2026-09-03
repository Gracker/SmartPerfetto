-- Fragment: flutter_process_identity
-- Resolves the Flutter process scope used by Flutter-specific Skills.
-- An explicit package selects that package and its child processes. Without a
-- package, select one dominant process only after paired Flutter thread
-- identity is present; generic SurfaceView or system FrameTimeline rows are
-- never sufficient.
-- Params: ${package}
flutter_thread_identity AS (
  SELECT
    p.upid,
    p.name as process_name,
    MAX(CASE WHEN t.name GLOB '[0-9]*.raster' THEN 1 ELSE 0 END) as has_flutter_raster,
    MAX(CASE WHEN t.name GLOB '[0-9]*.ui' THEN 1 ELSE 0 END) as has_flutter_ui,
    MAX(CASE WHEN t.name GLOB 'DartWorker*' THEN 1 ELSE 0 END) as has_dart_worker
  FROM process p
  LEFT JOIN thread t ON t.upid = p.upid
  WHERE p.name IS NOT NULL
  GROUP BY p.upid, p.name
),
flutter_process_candidates AS (
  SELECT
    identity.*,
    COALESCE((
      SELECT COUNT(*)
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      WHERE t.upid = identity.upid
        AND (
          t.name GLOB '[0-9]*.raster'
          OR t.name GLOB '[0-9]*.ui'
          OR t.name GLOB '[0-9]*.io'
          OR t.name GLOB 'DartWorker*'
        )
    ), 0) as flutter_activity_score
  FROM flutter_thread_identity identity
  WHERE has_flutter_raster = 1
    AND (has_flutter_ui = 1 OR has_dart_worker = 1)
),
detected_flutter_process AS (
  SELECT upid, process_name, 'thread_identity' as resolution_source
  FROM flutter_process_candidates
  ORDER BY flutter_activity_score DESC, upid ASC
  LIMIT 1
),
flutter_processes AS (
  SELECT p.upid, p.name as process_name, 'explicit_package' as resolution_source
  FROM process p
  WHERE '${package}' <> ''
    AND (p.name = '${package}' OR p.name GLOB '${package}:*')
  UNION ALL
  SELECT upid, process_name, resolution_source
  FROM detected_flutter_process
  WHERE '${package}' = ''
)
