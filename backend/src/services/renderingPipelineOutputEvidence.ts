// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {mediaOutputEvidenceSql} from './renderingMediaOutputEvidence';

// All detector steps use the same package scope. Without a supplied target,
// infer only a unique app with recurring output work; a busy launcher or an
// adjacent app must not lend its buffers to the app under investigation.
export const renderingAppScopeSql = `
      producing_packages AS (
        SELECT CASE WHEN instr(p.name, ':') > 0 THEN substr(p.name, 1, instr(p.name, ':') - 1)
          ELSE p.name END AS pkg
        FROM slice s JOIN thread_track tt ON tt.id = s.track_id
        JOIN thread t USING (utid) JOIN process p USING (upid)
        WHERE '\${package}' = '' AND p.name GLOB '*.*' AND p.name NOT GLOB '/*'
          AND p.name NOT IN ('com.android.systemui', 'system_server')
          AND (s.name IN ('queueBuffer', 'eglSwapBuffers', 'vkQueuePresentKHR', 'unlockCanvasAndPost')
            OR (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*'))
        GROUP BY pkg HAVING COUNT(DISTINCT s.ts) >= 2
      ),
      target AS (
        SELECT CASE WHEN '\${package}' != '' THEN '\${package}'
          WHEN COUNT(*) = 1 THEN MIN(pkg) END AS pkg FROM producing_packages
      ),
      app_filter_upids AS (
        SELECT p.upid FROM process p, target
        WHERE p.name = target.pkg OR instr(p.name, target.pkg || ':') = 1
      )`;

// Only observations from one process instance are combined. Queue markers
// describe the actual consumer endpoint. FrameTimeline links additionally
// require a completed SF DisplayFrame for the app's SurfaceFrame.
export function buildLayerSignalsSql(webviewDrawPredicate: string): string {
  return `
      WITH RECURSIVE ${renderingAppScopeSql},
      app_events AS MATERIALIZED (
        SELECT s.id, s.parent_id, s.ts, s.name, t.upid, t.utid, t.name AS thread_name
        FROM thread t JOIN thread_track tt USING (utid) JOIN slice s ON s.track_id = tt.id
        WHERE t.upid IN (SELECT upid FROM app_filter_upids) AND s.dur >= 0
      ),
      display_tokens AS (
        SELECT f.display_frame_token
        FROM actual_frame_timeline_slice f JOIN process p USING (upid)
        WHERE p.name IN ('surfaceflinger', '/system/bin/surfaceflinger')
          AND f.surface_frame_token IS NULL AND f.display_frame_token > 0
        GROUP BY f.display_frame_token
        HAVING COUNT(*) = 1 AND MIN(f.dur) >= 0 AND MIN(f.present_type) IN
          ('On-time Present', 'Late Present', 'Early Present')
      ),
      presented_layers AS (
        SELECT DISTINCT f.upid, f.surface_frame_token, f.layer_name
        FROM actual_frame_timeline_slice f JOIN display_tokens USING (display_frame_token)
        JOIN process p ON p.upid = f.upid
        WHERE f.upid IN (SELECT upid FROM app_filter_upids)
          AND f.surface_frame_token > 0 AND f.dur >= 0 AND f.layer_name IS NOT NULL
          AND (instr(f.layer_name, 'SurfaceView[') = 0 OR instr(f.layer_name, 'SurfaceView[' ||
            CASE WHEN instr(p.name, ':') > 0 THEN substr(p.name, 1, instr(p.name, ':') - 1)
              ELSE p.name END || '/') > 0)
          AND f.present_type IN ('On-time Present', 'Late Present', 'Early Present')
      ),
      sf_layers AS (
        SELECT upid, layer_name, COUNT(*) AS frames,
          instr(layer_name, 'SurfaceView[') > 0 AS child_surface
        FROM presented_layers GROUP BY upid, layer_name
      ),
      -- Producers and consumers record the queue instance before the slot
      -- suffix. A generic onFrameAvailable callback is also emitted by BLAST
      -- host windows and cannot establish a texture path.
      texture_ops AS (
        SELECT e.upid, e.utid, e.thread_name, parent.id AS operation_id, parent.name AS operation,
          substr(e.name, 1, instr(e.name, ': ') - 1) AS queue_name
        FROM app_events e JOIN slice parent ON parent.id = e.parent_id
        WHERE e.name GLOB 'SurfaceTexture-*: *' AND parent.name IN ('queueBuffer', 'acquireBuffer')
      ),
      texture_producers AS (
        SELECT upid, queue_name, MIN(utid) AS utid, COUNT(DISTINCT operation_id) AS submissions
        FROM texture_ops WHERE operation = 'queueBuffer'
        GROUP BY upid, queue_name HAVING COUNT(DISTINCT utid) = 1
      ),
      texture_links AS (
        SELECT prod.upid, prod.utid, prod.queue_name, prod.submissions, cons.operation_id AS acquisition
        FROM texture_producers prod JOIN texture_ops cons USING (upid, queue_name)
        WHERE cons.operation = 'acquireBuffer' AND cons.thread_name = 'RenderThread' AND prod.utid != cons.utid
      ),
      -- Attribute each operation to its enclosing host DrawFrame. Multiple
      -- wrappers, texture slots or acquisitions in one frame count only once.
      host_ancestors(upid, id, parent_id, name, operation, producer_utid) AS (
        SELECT upid, id, parent_id, name, 'functor', NULL FROM app_events WHERE thread_name = 'RenderThread'
          AND (${webviewDrawPredicate})
        UNION
        SELECT upid, id, parent_id, name, 'submit', NULL FROM app_events
          WHERE thread_name = 'RenderThread' AND name = 'queueBuffer'
        UNION
        SELECT e.upid, e.id, e.parent_id, e.name, 'surface', NULL FROM app_events e
        JOIN slice parent ON parent.id = e.parent_id
        WHERE e.name GLOB 'onFrameAvailable - *SurfaceView[[]*' AND e.thread_name = 'RenderThread'
          AND parent.name = 'queueBuffer'
        UNION
        SELECT l.upid, s.id, s.parent_id, s.name, 'texture', l.utid FROM texture_links l
        JOIN slice s ON s.id = l.acquisition
        UNION
        SELECT a.upid, s.id, s.parent_id, s.name, a.operation, a.producer_utid FROM host_ancestors a
        JOIN slice s ON s.id = a.parent_id WHERE a.name NOT GLOB 'DrawFrame*'
      ),
      producer_tracks AS (
        SELECT e.upid, e.utid, e.thread_name,
          COUNT(DISTINCT CASE WHEN name GLOB 'DrawFrame*' AND thread_name = 'RenderThread' THEN ts END) AS draws,
          COUNT(DISTINCT CASE WHEN name = 'queueBuffer' THEN ts END) AS queues,
          COUNT(DISTINCT CASE WHEN (name GLOB 'onFrameAvailable - VRI*' OR name GLOB 'onFrameAvailable - BLASTBufferQueue*') AND parent_id IN (SELECT id FROM app_events WHERE name = 'queueBuffer') THEN parent_id END) AS host_callbacks,
          COUNT(DISTINCT CASE WHEN name GLOB 'dequeueBuffer - VRI*(BLAST Consumer)*' THEN ts END) AS host_blast,
          COUNT(DISTINCT CASE WHEN id IN (SELECT id FROM surface_callbacks) AND parent_id IN (SELECT id FROM app_events WHERE name = 'queueBuffer') THEN parent_id END) AS surface_callbacks,
          COUNT(DISTINCT CASE WHEN name GLOB 'dequeueBuffer - *SurfaceView[[]*(BLAST Consumer)*' THEN ts END) AS surface_blast,
          COUNT(DISTINCT CASE WHEN name GLOB '*Rasterizer::Draw*' THEN ts END) AS raster_draws,
          COUNT(DISTINCT CASE WHEN name GLOB '*Impeller*' OR name GLOB '*EntityPass*' THEN ts END) AS impeller_draws,
          COUNT(DISTINCT CASE WHEN name GLOB '*SkiaGpu*' OR name GLOB '*SkGpu*' THEN ts END) AS skia_draws,
          COUNT(DISTINCT CASE WHEN name GLOB '*eglSwapBuffers*' THEN ts END) AS swaps,
          COUNT(DISTINCT CASE WHEN name IN ('vkQueuePresentKHR', 'QueuePresentKHR') THEN ts END) AS vk_presents,
          COUNT(DISTINCT CASE WHEN name GLOB '*unlockCanvasAndPost*' THEN ts END) AS canvas_posts
        FROM app_events e GROUP BY upid, utid
      ),
      host_frames AS (
        SELECT a.upid,
          -- HWUI can draw directly into a SurfaceView. Those frames have
          -- one destination and must not also count as anonymous host output.
          COUNT(DISTINCT CASE WHEN operation = 'submit' THEN id END) -
            COUNT(DISTINCT CASE WHEN operation = 'surface' THEN id END) AS submitted,
          COUNT(DISTINCT CASE WHEN operation = 'functor' THEN id END) AS functor,
          COUNT(DISTINCT CASE WHEN operation = 'texture' THEN id END) AS textured,
          COUNT(DISTINCT CASE WHEN operation = 'texture' AND (r.thread_name GLOB '[0-9]*.raster' OR r.raster_draws >= 2) THEN id END) AS flutter_textured
        FROM host_ancestors a LEFT JOIN producer_tracks r ON r.utid = a.producer_utid
        WHERE a.name GLOB 'DrawFrame*' GROUP BY a.upid
      ),
      ${mediaOutputEvidenceSql},
      observations AS (
        SELECT p.upid, p.name AS target_process,
          COALESCE(SUM(draws),0) AS hwui_draw_frames,
          MAX(COALESCE(h.submitted,0), SUM(CASE WHEN thread_name = 'RenderThread' THEN host_callbacks ELSE 0 END)) AS host_submissions,
          SUM(CASE WHEN thread_name = 'RenderThread' THEN host_blast ELSE 0 END) AS host_blast,
          COALESCE(SUM(surface_callbacks),0) AS surfaceview_submissions, SUM(surface_blast) AS surface_blast,
          SUM(CASE WHEN thread_name GLOB '[0-9]*.raster' OR raster_draws >= 2 THEN surface_callbacks ELSE 0 END) AS flutter_surface,
          SUM(CASE WHEN surface_callbacks >= 2 AND (thread_name GLOB '[0-9]*.raster' OR raster_draws >= 2) THEN impeller_draws ELSE 0 END) AS impeller,
          SUM(CASE WHEN surface_callbacks >= 2 AND (thread_name GLOB '[0-9]*.raster' OR raster_draws >= 2) THEN skia_draws ELSE 0 END) AS skia,
          SUM(CASE WHEN thread_name GLOB 'GLThread*' THEN MIN(surface_callbacks, swaps) ELSE 0 END) AS gl_surface,
          SUM(CASE WHEN thread_name != 'RenderThread' THEN MIN(surface_callbacks, vk_presents) ELSE 0 END) AS vulkan_surface,
          SUM(CASE WHEN thread_name GLOB 'UnityGfx*' OR thread_name IN ('GameThread','RHIThread','GodotMain') THEN MIN(surface_callbacks, MAX(swaps, vk_presents)) ELSE 0 END) AS game_surface,
          SUM(MIN(canvas_posts, queues)) AS software_posts,
          COALESCE(m.surface_latches,0) AS sf_surface_latches, COALESCE(m.camera_latches,0) AS camera_latches,
          COALESCE(m.video_latches,0) AS video_latches,
          COALESCE((SELECT SUM(submissions) FROM texture_producers producer WHERE producer.upid=p.upid
            AND EXISTS (SELECT 1 FROM texture_links l WHERE l.upid=producer.upid AND l.queue_name=producer.queue_name)),0) AS texture_submissions,
          COALESCE(h.textured,0) AS texture_frames, COALESCE(h.flutter_textured,0) AS flutter_texture,
          COALESCE(h.functor,0) AS functor_frames, COALESCE(h.submitted,0) AS submitted_draw_frames,
          COALESCE((SELECT SUM(frames) FROM sf_layers l WHERE l.upid=p.upid AND NOT child_surface),0) AS sf_host_frames,
          COALESCE((SELECT SUM(frames) FROM sf_layers l WHERE l.upid=p.upid AND child_surface),0) AS sf_surfaceview_frames,
          COALESCE((SELECT SUM(frames) FROM sf_layers l WHERE l.upid=p.upid AND
            (l.layer_name GLOB 'CameraPreview*' OR l.layer_name GLOB 'Camera Preview*')),0) AS camera_frames,
          COALESCE((SELECT SUM(frames) FROM sf_layers l WHERE l.upid=p.upid AND
            (l.layer_name GLOB 'VideoSurface*' OR l.layer_name GLOB 'Video Surface*' OR l.layer_name GLOB 'MediaCodec*')),0) AS video_frames
        FROM process p LEFT JOIN producer_tracks r USING (upid) LEFT JOIN media_output m USING (upid) LEFT JOIN host_frames h USING (upid)
        WHERE p.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY p.upid
      ),
      output_totals AS (
        SELECT o.*, MAX(host_submissions,sf_host_frames) + MAX(surfaceview_submissions,sf_surfaceview_frames,sf_surface_latches) AS observed_buffers
        FROM observations o
      ),
      paths AS (
        SELECT o.*, CASE
          WHEN camera_latches >= 2 AND camera_latches * 2 > observed_buffers THEN 'camera_preview'
          WHEN video_latches >= 2 AND video_latches * 2 > observed_buffers THEN 'video_playback'
          WHEN surfaceview_submissions >= 2 AND surfaceview_submissions > host_submissions AND MAX(sf_surfaceview_frames,sf_surface_latches) >= sf_host_frames THEN
            CASE WHEN flutter_surface * 2 > surfaceview_submissions THEN
              CASE WHEN impeller >= 2 AND skia = 0 THEN 'flutter_surface_impeller'
                   WHEN skia >= 2 AND impeller = 0 THEN 'flutter_surface_skia' ELSE 'flutter_surface' END
              WHEN game_surface * 2 > surfaceview_submissions THEN 'game_surface'
              WHEN gl_surface * 2 > surfaceview_submissions THEN 'gl_surface'
              WHEN vulkan_surface * 2 > surfaceview_submissions THEN 'vulkan_surface'
              WHEN surface_blast * 2 > surfaceview_submissions THEN 'surfaceview_blast' ELSE 'surfaceview' END
          WHEN sf_surfaceview_frames >= 2 AND sf_surfaceview_frames > sf_host_frames
            AND surfaceview_submissions = 0 AND host_submissions = 0 THEN 'surfaceview'
          WHEN hwui_draw_frames >= 2 AND host_submissions >= 2 AND host_submissions > surfaceview_submissions
            AND (submitted_draw_frames >= 2 OR sf_host_frames >= 2)
            AND (MAX(sf_surfaceview_frames,sf_surface_latches) = 0 OR sf_host_frames > MAX(sf_surfaceview_frames,sf_surface_latches)) THEN
            CASE WHEN functor_frames * 2 > hwui_draw_frames THEN 'webview_functor'
                 WHEN texture_submissions >= 2 AND flutter_texture >= 2 AND flutter_texture * 2 > hwui_draw_frames THEN 'flutter_texture'
                 WHEN texture_submissions >= 2 AND texture_frames * 2 > hwui_draw_frames THEN 'texture'
                 WHEN host_blast >= 2 AND host_blast * 2 > hwui_draw_frames THEN 'hwui_blast' ELSE 'hwui' END
          WHEN software_posts >= 2 AND hwui_draw_frames = 0 AND sf_host_frames >= 2 THEN 'software'
          ELSE 'unknown' END AS observed_path
        FROM output_totals o
        WHERE sf_host_frames > 0 OR sf_surfaceview_frames > 0 OR hwui_draw_frames > 0 OR host_submissions > 0 OR surfaceview_submissions > 0
          OR texture_submissions > 0 OR software_posts > 0 OR sf_surface_latches > 0
      ),
      selected AS (
        SELECT * FROM paths
        WHERE (SELECT COUNT(DISTINCT observed_path) FROM paths) = 1
        ORDER BY MAX(host_submissions, surfaceview_submissions, sf_host_frames, sf_surfaceview_frames) DESC, upid LIMIT 1
      )
      SELECT COALESCE(chosen.observed_path, 'unknown') AS observed_path, chosen.target_process,
        -- Compatibility metric: share of the observed output population on this path.
        CASE chosen.observed_path
          WHEN 'unknown' THEN 0.0
          WHEN 'webview_functor' THEN 1.0 * functor_frames / hwui_draw_frames
          WHEN 'texture' THEN MIN(1.0, 1.0 * texture_frames / hwui_draw_frames)
          WHEN 'flutter_texture' THEN MIN(1.0, 1.0 * flutter_texture / hwui_draw_frames)
          WHEN 'camera_preview' THEN 1.0 * camera_latches / observed_buffers
          WHEN 'video_playback' THEN 1.0 * video_latches / observed_buffers
          WHEN 'surfaceview' THEN CASE WHEN surfaceview_submissions = 0 THEN
            1.0 * sf_surfaceview_frames / (sf_surfaceview_frames + sf_host_frames)
            ELSE 1.0 * surfaceview_submissions / (surfaceview_submissions + host_submissions) END
          WHEN 'hwui_blast' THEN MIN(1.0, 1.0 * host_blast / MAX(hwui_draw_frames,observed_buffers))
          WHEN 'surfaceview_blast' THEN MIN(1.0, 1.0 * surface_blast / observed_buffers)
          WHEN 'gl_surface' THEN MIN(1.0, 1.0 * gl_surface / observed_buffers)
          WHEN 'vulkan_surface' THEN MIN(1.0, 1.0 * vulkan_surface / observed_buffers)
          WHEN 'game_surface' THEN MIN(1.0, 1.0 * game_surface / observed_buffers)
          WHEN 'software' THEN MIN(1.0, 1.0 * software_posts / observed_buffers)
          ELSE 1.0 * MAX(host_submissions,surfaceview_submissions) / NULLIF(host_submissions + surfaceview_submissions,0)
        END AS output_share,
        COALESCE(chosen.hwui_draw_frames,0) AS hwui_draw_frames, COALESCE(chosen.host_submissions,0) AS host_submissions,
        COALESCE(chosen.surfaceview_submissions,0) AS surfaceview_submissions, COALESCE(chosen.texture_submissions,0) AS texture_submissions,
        COALESCE(chosen.sf_host_frames,0) AS sf_host_frames, COALESCE(chosen.sf_surfaceview_frames,0) AS sf_surfaceview_frames,
        COALESCE(chosen.sf_surface_latches,0) AS sf_surface_latches, COALESCE(chosen.camera_latches,0) AS camera_latches,
        COALESCE(chosen.video_latches,0) AS video_latches, COALESCE(chosen.functor_frames,0) AS webview_draw_frames,
        (SELECT COUNT(*) FROM sf_layers WHERE upid=chosen.upid) AS app_layer_count,
        COALESCE((SELECT GROUP_CONCAT(layer_name,'; ') FROM sf_layers WHERE upid=chosen.upid),'') AS app_layer_names,
        COALESCE(chosen.sf_surfaceview_frames > 0,0) AS has_surfaceview_layer,
        COALESCE(chosen.video_frames > 0,0) AS has_video_layer, COALESCE(chosen.camera_frames > 0,0) AS has_camera_layer,
        EXISTS (SELECT 1 FROM sf_layers WHERE upid=chosen.upid AND layer_name GLOB '*FlutterSurfaceView*') AS has_flutter_layer
      FROM (SELECT 1) LEFT JOIN selected chosen ON 1
  `;
}
