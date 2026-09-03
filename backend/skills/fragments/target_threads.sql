-- Fragment: target_threads
-- Resolves MainThread + RenderThread for the target package.
-- Supports standard Android (RenderThread), Flutter (N.raster/N.ui), and Compose.
-- Params: ${package}, ${start_ts}, ${end_ts}
-- Optional: ${main_start_ts}, ${main_end_ts}, ${render_start_ts}, ${render_end_ts}
target_threads AS (
  SELECT t.utid, t.tid, t.name as thread_name, p.pid, p.name as process_name,
    CASE
      WHEN t.tid = p.pid THEN 'MainThread'
      WHEN t.name = 'RenderThread' THEN 'RenderThread'
      WHEN t.name GLOB '[0-9]*.raster' THEN 'RenderThread'
      WHEN t.name GLOB '[0-9]*.ui' THEN 'MainThread'
      ELSE 'Other'
    END as thread_type,
    CASE
      WHEN t.tid = p.pid THEN COALESCE(${main_start_ts}, ${start_ts})
      WHEN t.name = 'RenderThread' THEN COALESCE(${render_start_ts}, ${start_ts})
      WHEN t.name GLOB '[0-9]*.raster' THEN COALESCE(${render_start_ts}, ${start_ts})
      WHEN t.name GLOB '[0-9]*.ui' THEN COALESCE(${main_start_ts}, ${start_ts})
      ELSE ${start_ts}
    END as thread_start_ts,
    CASE
      WHEN t.tid = p.pid THEN COALESCE(${main_end_ts}, ${end_ts})
      WHEN t.name = 'RenderThread' THEN COALESCE(${render_end_ts}, ${end_ts})
      WHEN t.name GLOB '[0-9]*.raster' THEN COALESCE(${render_end_ts}, ${end_ts})
      WHEN t.name GLOB '[0-9]*.ui' THEN COALESCE(${main_end_ts}, ${end_ts})
      ELSE ${end_ts}
    END as thread_end_ts
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE (
      '${package}' = ''
      OR p.name = '${package}'
      OR p.name GLOB '${package}:*'
    )
    AND (t.tid = p.pid OR t.name = 'RenderThread'
         OR t.name GLOB '[0-9]*.raster' OR t.name GLOB '[0-9]*.ui')
)
