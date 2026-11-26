// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Some media producers live in a service and have no app SurfaceFrame.
// Join the app's BLAST acquire to the SF latch on the full SurfaceView
// identity (including the instance prefix) and buffer frame number. Only a
// Binder flow into that very callback can attribute its producer to a service.
export const mediaOutputEvidenceSql = `
      surface_callbacks AS (
        SELECT e.id, e.upid, e.parent_id, e.name,
          substr(e.name, length('onFrameAvailable - ') + 1) AS marker
        FROM app_events e JOIN process p USING (upid)
        WHERE e.name GLOB 'onFrameAvailable - *SurfaceView*'
          AND instr(e.name, 'SurfaceView[' || CASE WHEN instr(p.name, ':') > 0
            THEN substr(p.name, 1, instr(p.name, ':') - 1) ELSE p.name END || '/') > 0
      ),
      app_buffer_ids AS (
        SELECT cb.id, cb.upid, acquire_event.ts,
          substr(cb.marker, 1, instr(cb.marker, ']')) AS endpoint,
          substr(acquire_event.name, instr(acquire_event.name, ')frame=') + length(')frame=')) AS frame_no
        FROM surface_callbacks cb JOIN slice acquire_event ON acquire_event.parent_id = cb.id
        WHERE acquire_event.name GLOB 'acquireNextBufferLocked - *' AND instr(acquire_event.name, ')frame=') > 0
          AND instr(acquire_event.name, 'acquireNextBufferLocked - ' || cb.marker || 'frame=') = 1
          AND instr(cb.marker, ']') > instr(cb.marker, 'SurfaceView[')
      ),
      app_buffers AS (
        SELECT MIN(id) AS callback_id, MIN(upid) AS upid, MIN(ts) AS acquire_ts, endpoint, frame_no
        FROM app_buffer_ids
        WHERE frame_no != '' AND frame_no NOT GLOB '*[^0-9]*'
        GROUP BY endpoint, frame_no HAVING COUNT(*) = 1
      ),
      sf_buffers_raw AS (
        SELECT s.ts, substr(s.name, length('latchBuffer ') + 1) AS marker
        FROM slice s JOIN thread_track tt ON tt.id = s.track_id
        JOIN thread t USING (utid) JOIN process p USING (upid)
        WHERE p.name IN ('surfaceflinger','/system/bin/surfaceflinger')
          AND s.name GLOB 'latchBuffer *SurfaceView* - *' AND s.dur >= 0
      ),
      sf_buffers AS (
        SELECT substr(marker, 1, instr(marker, ']')) AS endpoint,
          substr(marker, instr(marker, ' - ') + length(' - ')) AS frame_no, MIN(ts) AS latch_ts
        FROM sf_buffers_raw
        WHERE instr(marker, ']') > instr(marker, 'SurfaceView[')
        GROUP BY endpoint, frame_no HAVING COUNT(*) = 1
      ),
      consumed_buffers AS (
        SELECT b.* FROM app_buffers b JOIN sf_buffers sf USING (endpoint, frame_no)
        WHERE sf.latch_ts >= b.acquire_ts
      ),
      callback_ancestors(callback_id, parent_id, name, id) AS (
        SELECT cb.id, cb.parent_id, cb.name, cb.id FROM surface_callbacks cb
        JOIN consumed_buffers b ON b.callback_id = cb.id
        UNION ALL
        SELECT a.callback_id, s.parent_id, s.name, s.id
        FROM callback_ancestors a JOIN slice s ON s.id = a.parent_id
        WHERE a.name != 'binder reply'
      ),
      buffer_senders AS (
        SELECT a.callback_id, p.name AS process_name, t.name AS thread_name,
          parent.name AS sender_operation, outer_op.name AS outer_operation
        FROM callback_ancestors a JOIN flow f ON f.slice_in = a.id
        JOIN slice sender ON sender.id = f.slice_out AND sender.name = 'binder transaction'
        JOIN thread_track tt ON tt.id = sender.track_id JOIN thread t USING (utid)
        JOIN process p USING (upid)
        LEFT JOIN slice parent ON parent.id = sender.parent_id
        LEFT JOIN slice outer_op ON outer_op.id = parent.parent_id
        WHERE a.name = 'binder reply'
          AND EXISTS (SELECT 1 FROM callback_ancestors q WHERE q.callback_id = a.callback_id AND q.name = 'queueBuffer')
      ),
      media_senders AS (
        SELECT callback_id, CASE
          WHEN process_name IN ('cameraserver','/system/bin/cameraserver') AND sender_operation = 'queueBuffer' THEN 'camera'
          WHEN (outer_operation GLOB '*Codec*::renderOutputBuffer*' OR sender_operation GLOB '*Codec*::renderOutputBuffer*')
            OR (process_name IN ('mediaserver','/system/bin/mediaserver') AND thread_name = 'NPDecoder-CL') THEN 'video'
        END AS source
        FROM buffer_senders GROUP BY callback_id HAVING COUNT(*) = 1
      ),
      media_output AS (
        SELECT b.upid, COUNT(*) AS surface_latches,
          SUM(CASE WHEN s.source = 'camera' THEN 1 ELSE 0 END) AS camera_latches,
          SUM(CASE WHEN s.source = 'video' THEN 1 ELSE 0 END) AS video_latches
        FROM consumed_buffers b LEFT JOIN media_senders s USING (callback_id) GROUP BY b.upid
      )`;
