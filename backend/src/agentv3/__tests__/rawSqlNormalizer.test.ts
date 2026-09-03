// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { normalizeRawSql } from '../rawSqlNormalizer';

describe('normalizeRawSql', () => {
  it('removes actual_frame_timeline_slice JOIN thread USING(utid) when thread is not referenced', () => {
    const input = `
      SELECT p.name AS process_name, p.upid, COUNT(*) AS frame_count
      FROM actual_frame_timeline_slice a
      JOIN thread USING(utid)
      JOIN process p USING(upid)
      GROUP BY p.upid
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).not.toMatch(/JOIN\s+thread\s+USING\s*\(\s*utid\s*\)/i);
    expect(result.sql).toMatch(/JOIN\s+process\s+p\s+USING\s*\(\s*upid\s*\)/i);
    expect(result.rewrites).toHaveLength(1);
  });

  it('keeps the join when a thread alias is referenced elsewhere', () => {
    const input = `
      SELECT t.name AS thread_name, p.name AS process_name
      FROM actual_frame_timeline_slice a
      JOIN thread t USING(utid)
      JOIN process p USING(upid)
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('JOIN thread t USING(utid)');
    expect(result.rewrites).toEqual([]);
  });

  it('does not rewrite unrelated thread joins', () => {
    const input = `
      SELECT t.name
      FROM slice s
      JOIN thread t USING(utid)
    `;

    expect(normalizeRawSql(input)).toEqual({ sql: input, rewrites: [] });
  });

  it('joins slice_self_dur when thread_slice SQL reads self_dur directly', () => {
    const input = `
      SELECT
        name AS slice_name,
        ROUND(dur/1e6, 2) AS total_ms,
        ROUND(self_dur/1e6, 2) AS self_ms
      FROM thread_slice
      WHERE process_name = 'com.example'
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toMatch(/\bFROM\s+thread_slice\s+LEFT\s+JOIN\s+slice_self_dur\s+USING\s*\(\s*id\s*\)/i);
    expect(result.rewrites).toEqual([
      'joined slice_self_dur for thread_slice self_dur lookup; thread_slice does not expose self_dur directly',
    ]);
  });

  it('does not duplicate slice_self_dur joins', () => {
    const input = `
      SELECT s.name, self_dur
      FROM thread_slice s
      LEFT JOIN slice_self_dur USING(id)
    `;

    expect(normalizeRawSql(input)).toEqual({ sql: input, rewrites: [] });
  });

  it('rewrites dangling thread aliases when thread_slice is already the source', () => {
    const input = `
      SELECT s.name AS slice_name, s.dur / 1e6 AS dur_ms, t.name AS thread_name
      FROM thread_slice s
      WHERE t.name IN ('RenderThread', 'GPU completion')
        AND s.process_name GLOB 'com.example*'
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('s.thread_name AS thread_name');
    expect(result.sql).toContain("s.thread_name IN ('RenderThread', 'GPU completion')");
    expect(result.sql).not.toMatch(/\bt\.name\b/);
    expect(result.rewrites).toEqual([
      'rewrote dangling t.name reference to thread_slice thread_name; thread_slice already exposes thread columns',
    ]);
  });

  it('rewrites dangling process aliases when thread_slice is already the source', () => {
    const input = `
      SELECT name AS slice_name, dur / 1e6 AS dur_ms
      FROM thread_slice
      WHERE p.name GLOB 'com.example*'
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain("process_name GLOB 'com.example*'");
    expect(result.sql).not.toMatch(/\bp\.name\b/);
    expect(result.rewrites).toEqual([
      'rewrote dangling p.name reference to thread_slice process_name; thread_slice already exposes process columns',
    ]);
  });

  it('keeps valid t.name references when a t alias is declared', () => {
    const input = `
      SELECT s.name, t.name
      FROM thread_slice s
      JOIN thread t USING(utid)
    `;

    expect(normalizeRawSql(input)).toEqual({ sql: input, rewrites: [] });
  });

  it('swaps reversed numeric BETWEEN bounds', () => {
    const input = `
      SELECT state, SUM(dur)
      FROM thread_state
      WHERE ts BETWEEN 564168124787136 AND 564168036989793
      GROUP BY state
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('BETWEEN 564168036989793 AND 564168124787136');
    expect(result.rewrites).toContain('swapped reversed numeric BETWEEN bounds so the time range is start <= end');
  });

  it('qualifies bare slice columns after joins with other name columns', () => {
    const input = `
      SELECT name, dur/1e6 as dur_ms, t.name as thread_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name GLOB 'com.example*'
      ORDER BY dur DESC
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('SELECT s.name AS slice_name, s.dur/1e6 as dur_ms');
    expect(result.sql).toContain('ORDER BY s.dur DESC');
    expect(result.rewrites).toEqual(expect.arrayContaining([
      'qualified bare slice name as s.name after joins with other name columns',
      'qualified bare slice dur as s.dur after slice joins',
    ]));
  });

  it('inserts missing whitespace between boolean operators and known Perfetto columns', () => {
    const input = `
      SELECT ts, dur, state
      FROM thread_state
      WHERE utid = (
        SELECT utid FROM thread WHERE name = 'main' ANDupid IN (SELECT upid FROM process WHERE name = 'com.example')
      )
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain("name = 'main' AND upid IN");
    expect(result.sql).not.toContain('ANDupid');
    expect(result.rewrites).toContain('inserted missing whitespace between boolean operators and known Perfetto columns');
  });

  it('rewrites thread main_thread filters to the real is_main_thread column', () => {
    const input = `
      SELECT s.name AS slice_name, s.dur / 1e6 AS dur_ms, s.ts, ts2.state
      FROM thread_slice s
      JOIN thread_state ts2 ON ts2.utid = (
        SELECT utid FROM thread WHERE name = 'unch.aosp.heavy' AND main_thread = 1
      )
      WHERE s.process_name GLOB 'com.example.launch.aosp.heavy*'
        AND s.is_main_thread = 1
        AND s.name = 'LoadSimulator_ActivityInit'
        AND ts2.ts >= s.ts
        AND ts2.ts < s.ts + s.dur
        AND ts2.state = 'S'
      ORDER BY ts2.dur DESC
      LIMIT 10
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain("SELECT utid FROM thread WHERE name = 'unch.aosp.heavy' AND is_main_thread = 1");
    expect(result.sql).not.toMatch(/\bmain_thread\s*=/i);
    expect(result.rewrites).toContain(
      'rewrote thread main_thread column to is_main_thread; Perfetto thread table uses is_main_thread',
    );
  });

  it('rewrites qualified thread aliases from main_thread to is_main_thread', () => {
    const input = `
      SELECT t.utid
      FROM thread t
      WHERE t.main_thread = 1
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('WHERE t.is_main_thread = 1');
    expect(result.sql).not.toMatch(/\bt\.main_thread\b/i);
    expect(result.rewrites).toContain(
      'rewrote thread main_thread column to is_main_thread; Perfetto thread table uses is_main_thread',
    );
  });

  it('rewrites thread main_thread references in comma-joined table lists', () => {
    const input = `
      SELECT t.utid
      FROM slice s, thread t
      WHERE t.main_thread = 1
        AND s.utid = t.utid
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('WHERE t.is_main_thread = 1');
    expect(result.sql).not.toMatch(/\bt\.main_thread\b/i);
    expect(result.rewrites).toContain(
      'rewrote thread main_thread column to is_main_thread; Perfetto thread table uses is_main_thread',
    );
  });

  it('rewrites bare selected and ordered main_thread columns on the thread table', () => {
    const input = `
      SELECT main_thread
      FROM thread
      ORDER BY main_thread DESC
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('SELECT is_main_thread');
    expect(result.sql).toContain('ORDER BY is_main_thread DESC');
    expect(result.sql).not.toMatch(/(?<!is_)\bmain_thread\b/i);
    expect(result.rewrites).toContain(
      'rewrote thread main_thread column to is_main_thread; Perfetto thread table uses is_main_thread',
    );
  });

  it('does not rewrite a compatibility alias named main_thread', () => {
    const input = `
      SELECT is_main_thread AS main_thread
      FROM thread
    `;

    const result = normalizeRawSql(input);

    expect(result).toEqual({ sql: input, rewrites: [] });
  });

  it('rewrites main_thread filters when the thread table is quoted', () => {
    const input = `
      SELECT t.utid
      FROM "thread" AS t
      WHERE t.main_thread = 1
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('WHERE t.is_main_thread = 1');
    expect(result.sql).not.toMatch(/\bt\.main_thread\b/i);
    expect(result.rewrites).toContain(
      'rewrote thread main_thread column to is_main_thread; Perfetto thread table uses is_main_thread',
    );
  });

  it('does not rewrite main_thread-looking text inside SQL literals or comments', () => {
    const input = `
      SELECT 'main_thread = 1' AS note
      FROM thread
      WHERE name = 'main_thread = 1'
        -- main_thread = 1 is documentation text, not SQL
    `;

    expect(normalizeRawSql(input)).toEqual({ sql: input, rewrites: [] });
  });

  it('does not rewrite when a CTE named thread shadows the Perfetto thread table', () => {
    const input = `
      WITH thread AS (
        SELECT 1 AS main_thread
      )
      SELECT *
      FROM thread
      WHERE main_thread = 1
    `;

    expect(normalizeRawSql(input)).toEqual({ sql: input, rewrites: [] });
  });

  it('inserts thread join when SQL joins process through thread_track.upid', () => {
    const input = `
      SELECT
        s.name AS slice_name,
        s.dur / 1e6 AS dur_ms,
        t.name AS thread_name,
        p.name AS process_name
      FROM slice s
      JOIN thread_track t ON s.track_id = t.id
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*CustomScroll_longFrameLoad*'
      ORDER BY s.dur DESC
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('JOIN thread th ON t.utid = th.utid');
    expect(result.sql).toContain('JOIN process p ON th.upid = p.upid');
    expect(result.sql).toContain('th.name AS thread_name');
    expect(result.sql).not.toMatch(/\bt\.upid\b/);
    expect(result.rewrites).toContain(
      'joined thread between thread_track t and process p; thread_track exposes utid but not upid',
    );
  });

  it('downgrades unsupported actual_frame_timeline_slice frequency lookups to safe frame duration lookups', () => {
    const input = `
      SELECT frame_id, dur_ms, big_avg_freq_mhz, device_peak_freq_mhz,
             big_avg_freq_mhz * 1.0 / NULLIF(device_peak_freq_mhz, 0) AS freq_ratio,
             cpu_freq_clusters_json
      FROM (
        SELECT frame_id, dur_ms, big_avg_freq_mhz, device_peak_freq_mhz, cpu_freq_clusters_json
        FROM (SELECT '59665234' AS frame_id UNION SELECT '59666150' UNION SELECT '59667110') f
      ) ref
      LEFT JOIN (
        SELECT frame_id, dur_ms, big_avg_freq_mhz, device_peak_freq_mhz, cpu_freq_clusters_json
        FROM actual_frame_timeline_slice a
        JOIN process p ON a.upid = p.upid
      ) d USING(frame_id)
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('WITH requested_frames AS');
    expect(result.sql).toContain("SELECT '59665234' AS frame_id");
    expect(result.sql).toContain("UNION ALL SELECT '59666150' AS frame_id");
    expect(result.sql).toContain('ROUND(a.dur / 1e6, 2) AS dur_ms');
    expect(result.sql).toContain('CAST(NULL AS REAL) AS big_avg_freq_mhz');
    expect(result.sql).toContain('CAST(a.display_frame_token AS TEXT) = r.frame_id');
    expect(result.sql).not.toMatch(/\bSELECT\s+frame_id,\s+dur_ms,\s+big_avg_freq_mhz\b/i);
    expect(result.rewrites).toContain(
      'replaced unsupported actual_frame_timeline_slice frequency lookup with a safe frame duration lookup; frequency columns are skill-derived, not FrameTimeline table columns',
    );
  });

  it('rewrites unsupported intrinsic batch root-cause table lookups to safe FrameTimeline lookups', () => {
    const input = `
      SELECT
        printf('%d', start_ts) as start_ts,
        printf('%d', start_ts + dur) as end_ts,
        round(dur / 1e6, 2) as dur_ms,
        jank_type,
        jank_responsibility,
        reason_code,
        top_slice_name,
        round(top_slice_ms, 2) as top_slice_ms,
        main_q4b_pct
      FROM __intrinsic_batch_frame_root_cause
      WHERE frame_id = 59665234
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('WITH frame_lookup AS');
    expect(result.sql).toContain("SELECT '59665234' AS frame_id");
    expect(result.sql).toContain('FROM actual_frame_timeline_slice a');
    expect(result.sql).toContain('CAST(NULL AS TEXT) AS reason_code');
    expect(result.sql).toContain("f.jank_type GLOB '*App Resynced Jitter*'");
    expect(result.sql).toContain("f.jank_type GLOB '*Prediction Error*'");
    expect(result.sql).toContain("f.jank_type GLOB '*Display HAL*'");
    expect(result.sql.indexOf("f.jank_type GLOB '*Buffer Stuffing*'"))
      .toBeLessThan(result.sql.indexOf("f.jank_type GLOB '*Prediction Error*'"));
    expect(result.sql).toContain('source_note');
    expect(result.sql).not.toContain('__intrinsic_batch_frame_root_cause');
    expect(result.rewrites).toContain(
      'replaced unsupported __intrinsic_batch_frame_root_cause lookup with a safe FrameTimeline lookup; batch_frame_root_cause is a skill artifact and derived fields require fetch_artifact',
    );
  });

  it('rewrites quoted intrinsic batch root-cause table lookups to safe FrameTimeline lookups', () => {
    const input = `
      SELECT reason_code
      FROM "__intrinsic_batch_frame_root_cause"
      WHERE frame_id IN ('59665234', '59666150')
    `;

    const result = normalizeRawSql(input);

    expect(result.sql).toContain('WITH frame_lookup AS');
    expect(result.sql).toContain("SELECT '59665234' AS frame_id");
    expect(result.sql).toContain("UNION ALL SELECT '59666150' AS frame_id");
    expect(result.sql).not.toContain('__intrinsic_batch_frame_root_cause');
    expect(result.rewrites).toContain(
      'replaced unsupported __intrinsic_batch_frame_root_cause lookup with a safe FrameTimeline lookup; batch_frame_root_cause is a skill artifact and derived fields require fetch_artifact',
    );
  });
});
