// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {describe, expect, it} from '@jest/globals';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';

import {SkillRegistry} from '../skillLoader';
import {injectFragmentCtes} from '../skillFragments';

const skillPath = path.join(
  process.cwd(),
  'skills',
  'composite',
  'camera_trace_evidence.skill.yaml',
);
const skill = yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;

const EXPECTED_STEP_IDS = [
  'camera_frame_population',
  'camera_callback_cadence',
  'camera_display_cadence',
  'camera_surface_cadence',
  'camera_buffer_delivery',
  'camera_binder_execution',
  'evidence_coverage',
  'camera_process_candidates',
  'camera_slice_candidates',
  'camera_binder_summary',
  'camera_dmabuf_summary',
  'pixel_camera_stage_summary',
] as const;

function getStep(id: string): any {
  const step = skill.steps?.find((candidate: any) => candidate.id === id);
  expect(step).toBeDefined();
  return step;
}

function expectTypedColumns(stepId: string, expected: Record<string, string>): void {
  const columns = getStep(stepId).display?.columns;
  expect(Array.isArray(columns)).toBe(true);

  for (const [name, type] of Object.entries(expected)) {
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({name, type}),
    ]));
  }
}

function renderSqlForSqlite(sql: string): string {
  return sql
    .split('${start_ts}').join('NULL')
    .split('${end_ts}').join('NULL')
    .split('${max_rows|20}').join('20');
}

function composedSql(step: any): string {
  return injectFragmentCtes(step.sql, (step.sql_fragments ?? []).map((fragment: string) =>
    fs.readFileSync(path.join(process.cwd(), 'skills', fragment), 'utf8')));
}

function observationDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.function('trace_start', () => 0);
  database.function('trace_end', () => 200_000_000);
  database.aggregate('PERCENTILE', {
    start: () => ({values: [] as number[], percentile: 0}),
    step: (state: any, value: number | null, percentile?: number) => {
      if (value !== null) state.values.push(Number(value));
      state.percentile = percentile ?? 0;
      return state;
    },
    result: (state: any) => {
      const values = state.values.sort((left: number, right: number) => left - right);
      if (!values.length) return null;
      const at = (values.length - 1) * state.percentile / 100;
      return values[Math.floor(at)] + (values[Math.ceil(at)] - values[Math.floor(at)]) * (at % 1);
    },
  });
  database.exec(`
    CREATE TABLE slice(id INTEGER, ts INTEGER, dur INTEGER, track_id INTEGER, parent_id INTEGER, name TEXT);
    CREATE TABLE thread_track(id INTEGER, utid INTEGER);
    CREATE TABLE thread(utid INTEGER, tid INTEGER, upid INTEGER, name TEXT);
    CREATE TABLE process(upid INTEGER, pid INTEGER, name TEXT);
    CREATE TABLE actual_frame_timeline_slice(id INTEGER, ts INTEGER, dur INTEGER, upid INTEGER,
      surface_frame_token INTEGER, display_frame_token INTEGER, layer_name TEXT, present_type TEXT, jank_type TEXT);
    INSERT INTO process VALUES (1,100,'com.preview'),(2,200,'/system/bin/surfaceflinger'),(3,300,'com.other');
    INSERT INTO thread VALUES (11,101,1,'CallbackA'),(12,102,1,'CallbackB'),(21,201,2,'surfaceflinger'),(31,301,3,'OtherCallback');
    INSERT INTO thread_track VALUES (11,11),(12,12),(21,21),(31,31);
  `);
  return database;
}

function addBuffer(database: Database.Database, number: number, arrival: number, present?: number): void {
  const surface = 'shared SurfaceView[com.preview/PreviewActivity]#1';
  const id = number * 10;
  const insert = database.prepare('INSERT INTO slice VALUES (?,?,?,?,?,?)');
  insert.run(id, arrival, 100_000, number % 2 ? 11 : 12, null, `onFrameAvailable - ${surface}(f:0,a:1)`);
  insert.run(id + 1, arrival + 1000, 1000, number % 2 ? 11 : 12, id,
    `acquireNextBufferLocked - ${surface}(f:0,a:1)frame=${number}`);
  insert.run(id + 2, arrival + 5_000_000, 2_000_000, 21, null, `commit ${7000 + number}`);
  insert.run(id + 3, arrival + 6_000_000, 0, 21, id + 2, `latchBuffer ${surface.replace(']#1', '](BLAST)#17')} - ${number}`);
  if (present !== undefined) database.prepare('INSERT INTO actual_frame_timeline_slice VALUES (?,?,?,?,?,?,?,?,?)')
    .run(100 + number, arrival + 5_000_000, present - arrival - 5_000_000, 2, null,
      7000 + number, null, 'Early Present', 'Prediction Error');
}

describe('camera_trace_evidence skill schema', () => {
  it('routes only requests with an explicit Camera domain anchor', () => {
    const registry = new SkillRegistry();
    const loaded = registry.loadSingleSkill(
      path.join(process.cwd(), 'skills'),
      'composite/camera_trace_evidence.skill.yaml',
    );

    expect(loaded?.name).toBe('camera_trace_evidence');
    for (const question of [
      'debug preview first frame',
      'analyze capture latency',
      '分析预览首帧',
      'generic dmabuf memory',
    ]) {
      expect(registry.findMatchingSkill(question)).toBeUndefined();
    }
    for (const question of [
      'analyze Camera preview latency',
      '分析相机首帧预览',
      'inspect cameraserver DMA-BUF',
    ]) {
      expect(registry.findMatchingSkill(question)?.name).toBe('camera_trace_evidence');
    }
  });

  it('summarizes legacy ION-only Camera allocation deltas', () => {
    const database = new Database(':memory:');
    database.function('trace_start', () => 0);
    database.function('trace_end', () => 10_000);
    database.exec(`
      CREATE TABLE android_dmabuf_allocs (
        ts INTEGER,
        buf_size INTEGER,
        process_name TEXT,
        thread_name TEXT,
        upid INTEGER,
        pid INTEGER,
        utid INTEGER,
        tid INTEGER
      );
      CREATE TABLE counter (ts INTEGER, track_id INTEGER, value INTEGER);
      CREATE TABLE thread_counter_track (id INTEGER, name TEXT, utid INTEGER);
      CREATE TABLE thread (utid INTEGER, tid INTEGER, upid INTEGER, name TEXT);
      CREATE TABLE process (upid INTEGER, pid INTEGER, name TEXT);

      INSERT INTO process VALUES (1, 100, 'cameraserver');
      INSERT INTO thread VALUES (2, 101, 1, 'CameraWorker');
      INSERT INTO thread_counter_track VALUES (3, 'mem.ion_change', 2);
      INSERT INTO counter VALUES (100, 3, 4096), (200, 3, -1024);
    `);

    try {
      const sql = renderSqlForSqlite(getStep('camera_dmabuf_summary').sql);
      const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;

      expect(rows).toEqual([
        expect.objectContaining({
          process_name: 'cameraserver',
          upid: 1,
          pid: 100,
          memory_source: 'legacy_ion',
          allocation_count: 1,
          allocation_bytes: 4096,
          release_bytes: 1024,
          observed_net_delta_bytes: 3072,
          peak_event_bytes: 4096,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it('declares the evidence-first Camera composite contract', () => {
    expect(skill).toMatchObject({
      name: 'camera_trace_evidence',
      type: 'composite',
      category: 'rendering',
      tier: 'B',
    });
    expect(skill.prerequisites.required_tables).toEqual(
      expect.arrayContaining(['slice', 'thread', 'process']),
    );
    expect(skill.prerequisites.modules).toEqual(expect.arrayContaining([
      'slices.with_context',
      'android.binder',
      'android.frames.timeline',
      'android.memory.dmabuf',
      'linux.cpu.frequency',
      'pixel.camera',
    ]));
    expect(skill.steps.map((step: any) => step.id)).toEqual(EXPECTED_STEP_IDS);
  });

  it('keeps all inputs optional and window controls bounded in production SQL', () => {
    expect(skill.inputs).toEqual([
      expect.objectContaining({name: 'start_ts', type: 'timestamp', required: false}),
      expect.objectContaining({name: 'end_ts', type: 'timestamp', required: false}),
      expect.objectContaining({name: 'max_rows', type: 'integer', required: false}),
    ]);

    for (const step of skill.steps) {
      expect(step.process_scope).toEqual({role: 'global_context', limitations: [
        expect.stringContaining('not filtered to a target UPID'),
      ]});
      expect(step.process_scope.binding).toBeUndefined();
      const sql = composedSql(step);
      expect(sql).toContain('trace_start()');
      expect(sql).toContain('trace_end()');
      expect(sql).toMatch(/MIN\(MAX\(COALESCE\(\$\{max_rows\|20\}/);
    }
  });

  it('publishes stable coverage and typed evidence detail columns', () => {
    expectTypedColumns('evidence_coverage', {
      evidence_family: 'string',
      status: 'string',
      row_count: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_process_candidates', {
      identity_kind: 'string',
      process_name: 'string',
      thread_name: 'string',
      upid: 'number',
      pid: 'number',
      utid: 'number',
      tid: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_slice_candidates', {
      ts: 'timestamp',
      dur_ns: 'duration',
      slice_name: 'string',
      process_name: 'string',
      thread_name: 'string',
      upid: 'number',
      utid: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_binder_summary', {
      ts: 'timestamp',
      dur_ns: 'duration',
      client_process: 'string',
      client_thread: 'string',
      server_process: 'string',
      server_thread: 'string',
      client_upid: 'number',
      client_utid: 'number',
      server_upid: 'number',
      server_utid: 'number',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('camera_dmabuf_summary', {
      process_name: 'string',
      upid: 'number',
      pid: 'number',
      memory_source: 'string',
      allocation_count: 'number',
      allocation_bytes: 'bytes',
      release_bytes: 'bytes',
      observed_net_delta_bytes: 'bytes',
      peak_event_bytes: 'bytes',
      source: 'string',
      limitation: 'string',
    });
    expectTypedColumns('pixel_camera_stage_summary', {
      cam_id: 'number',
      node: 'string',
      port_group: 'string',
      frame_count: 'number',
      avg_duration_ns: 'duration',
      max_duration_ns: 'duration',
      source: 'string',
      limitation: 'string',
    });
  });

  it('publishes both buffer-memory evidence paths and their interpretation boundary', () => {
    const coverageStep = getStep('evidence_coverage');
    const memoryStep = getStep('camera_dmabuf_summary');

    expect(memoryStep.name).toContain('DMA-BUF/legacy ION');
    expect(memoryStep.display.title).toContain('DMA-BUF/legacy ION');
    expect(memoryStep.synthesize.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({key: 'memory_source'}),
    ]));
    for (const step of [coverageStep, memoryStep]) {
      expect(step.sql).toContain('android_dmabuf_allocs');
      expect(step.sql).toContain('thread_counter_track');
      expect(step.sql).toContain('mem.ion_change');
      expect(step.sql).toContain('retained memory');
      expect(step.sql).toContain('leak proof');
    }
  });

  it('keeps each step self-describing for evidence and report consumers', () => {
    for (const step of skill.steps) {
      expect(step.display).toEqual(expect.objectContaining({
        layer: expect.stringMatching(/^(overview|list)$/),
        level: expect.stringMatching(/^(summary|detail)$/),
        columns: expect.any(Array),
      }));
      expect(step.display.columns.length).toBeGreaterThan(0);
      expect(step.display.columns.every((column: any) => (
        typeof column.name === 'string' && typeof column.type === 'string'
      ))).toBe(true);
      expect(step.save_as).toBe(step.id);
      expect(step.synthesize).toEqual(expect.objectContaining({
        role: expect.stringMatching(/^(overview|list)$/),
        fields: expect.any(Array),
      }));
      expect(step.synthesize.fields.length).toBeGreaterThan(0);
    }
  });

  it('avoids unsupported timing and leak conclusions', () => {
    const productionText = JSON.stringify(skill).toLowerCase();
    expect(productionText).not.toMatch(/time[_ -]?to[_ -]?(open|first[_ -]?frame)/);
    expect(productionText).not.toMatch(/retained[_ -]?at[_ -]?trace[_ -]?end/);
    expect(skill.steps.every((step: any) => step.type !== 'diagnostic')).toBe(true);
  });
});

describe('camera observation SQL', () => {
  function rows(database: Database.Database, stepId: string, window?: [number, number]): any[] {
    let sql = composedSql(getStep(stepId));
    if (window) sql = sql.split('${start_ts}').join(String(window[0])).split('${end_ts}').join(String(window[1]));
    return database.prepare(renderSqlForSqlite(sql)).all();
  }

  it('separates frame populations, callback cadence, SF context and same-surface endpoints', () => {
    const database = observationDatabase();
    try {
      addBuffer(database, 1, 10_000_000, 20_000_000);
      addBuffer(database, 2, 40_000_000, 60_000_000);
      addBuffer(database, 3, 70_000_000, 90_000_000);
      addBuffer(database, 4, 100_000_000);
      database.exec(`
        INSERT INTO actual_frame_timeline_slice VALUES
          (201,55000000,0,2,NULL,7999,NULL,'Early Present','Prediction Error'),
          (202,160000000,1000000,2,NULL,8000,NULL,'Dropped Frame','Dropped Frame'),
          (203,170000000,-1,2,NULL,8001,NULL,'Unknown','Unknown'),
          (204,20000000,1000000,3,55,7001,'Decor','Dropped Frame','Dropped Frame');
      `);
      expect(rows(database, 'camera_frame_population')).toEqual(expect.arrayContaining([
        expect.objectContaining({frame_kind: 'display_frame', upid: 2, frame_count: 6,
          dropped_frames: 1, incomplete_frames: 1}),
        expect.objectContaining({frame_kind: 'surface_frame', upid: 3, frame_count: 1,
          dropped_frames: 1, incomplete_frames: 0}),
      ]));
      expect(rows(database, 'camera_callback_cadence')).toEqual([
        expect.objectContaining({source_upid: 1, callback_count: 4, callback_threads: 2,
          observed_intervals: 3, max_interval_ns: 30_000_000, configured_target_status: 'not_measured'}),
      ]);
      expect(rows(database, 'camera_display_cadence')).toEqual([
        expect.objectContaining({upid: 2, presented_display_frames: 4, observed_intervals: 3,
          max_present_interval_ns: 35_000_000, scope: 'sf_process_context'}),
      ]);
      expect(rows(database, 'camera_surface_cadence')).toEqual([
        expect.objectContaining({observed_buffer_keys: 4, presented_buffers: 3,
          arrival_binding_status: 'not_measured', unavailable_bindings: 1, max_present_interval_ns: 40_000_000}),
      ]);
      const delivery = rows(database, 'camera_buffer_delivery');
      expect(delivery).toHaveLength(3);
      // An unrelated SF endpoint is at 55ms; the matched SF commit ends at 60ms.
      // Neither one establishes which app callback corresponds to this SF layer.
      expect(delivery.find(row => row.buffer_number === 2)).toMatchObject({
        sf_upid: 2, display_present_ts: 60_000_000,
        arrival_binding_status: 'not_measured', binding_status: 'sf_commit_display_bound',
      });
      expect(delivery.some(row => row.buffer_number === 4)).toBe(false);
      expect(delivery.every(row => !('arrival_ts' in row) && !('arrival_to_present_ns' in row))).toBe(true);
    } finally {
      database.close();
    }
  });

  it('does not bind an app callback owner and refuses duplicate SF display tokens', () => {
    const database = observationDatabase();
    try {
      addBuffer(database, 1, 10_000_000, 20_000_000);
      addBuffer(database, 2, 40_000_000, 60_000_000);
      database.exec(`
        INSERT INTO slice VALUES
          (900,11000000,100000,31,NULL,'onFrameAvailable - shared SurfaceView[com.preview/PreviewActivity]#1(f:0,a:1)'),
          (901,11001000,1000,31,900,'acquireNextBufferLocked - shared SurfaceView[com.preview/PreviewActivity]#1(f:0,a:1)frame=1');
        INSERT INTO actual_frame_timeline_slice VALUES
          (999,45000001,14999999,2,NULL,7002,NULL,'Early Present','Prediction Error');
      `);
      expect(rows(database, 'camera_buffer_delivery')).toEqual([
        expect.objectContaining({buffer_number: 1, arrival_binding_status: 'not_measured'}),
      ]);
      expect(rows(database, 'camera_surface_cadence')).toEqual([
        expect.objectContaining({presented_buffers: 1, unavailable_bindings: 1,
          arrival_binding_status: 'not_measured'}),
      ]);
    } finally {
      database.close();
    }
  });

  it('leaves absent frame and callback data empty rather than declaring health', () => {
    const database = observationDatabase();
    try {
      for (const id of EXPECTED_STEP_IDS.slice(0, 5)) expect(rows(database, id)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('keeps two SF layer generations with the same prefix and buffer number separate', () => {
    const database = observationDatabase();
    try {
      addBuffer(database, 1, 10_000_000, 20_000_000);
      addBuffer(database, 2, 40_000_000, 60_000_000);
      database.prepare('UPDATE slice SET name=? WHERE id=23').run(
        'latchBuffer shared SurfaceView[com.preview/PreviewActivity](BLAST)#18 - 1');
      expect(rows(database, 'camera_surface_cadence')).toEqual([
        expect.objectContaining({bindable_surface: 'shared SurfaceView[com.preview/PreviewActivity](BLAST)#17',
          observed_buffer_keys: 1, presented_buffers: 1, observed_intervals: 0, arrival_binding_status: 'not_measured'}),
        expect.objectContaining({bindable_surface: 'shared SurfaceView[com.preview/PreviewActivity](BLAST)#18',
          observed_buffer_keys: 1, presented_buffers: 1, observed_intervals: 0, arrival_binding_status: 'not_measured'}),
      ]);
      expect(rows(database, 'camera_buffer_delivery').every(row => !('arrival_to_present_ns' in row))).toBe(true);
    } finally {
      database.close();
    }
  });

  it('excludes crossing-window frames instead of measuring an endpoint outside the request', () => {
    const database = observationDatabase();
    try {
      addBuffer(database, 1, 10_000_000, 20_000_000);
      addBuffer(database, 2, 40_000_000, 60_000_000);
      addBuffer(database, 3, 70_000_000, 90_000_000);
      const window: [number, number] = [12_000_000, 60_000_000];
      expect(rows(database, 'camera_frame_population', window)).toEqual([
        expect.objectContaining({frame_count: 2, incomplete_frames: 0, window_excluded_endpoints: 1}),
      ]);
      expect(rows(database, 'camera_display_cadence', window)).toEqual([
        expect.objectContaining({presented_display_frames: 1, observed_intervals: 0,
          max_present_interval_ns: null}),
      ]);
      expect(rows(database, 'camera_surface_cadence', window)).toEqual([
        expect.objectContaining({observed_buffer_keys: 2, presented_buffers: 1,
          arrival_binding_status: 'not_measured', unavailable_bindings: 1}),
      ]);
      expect(rows(database, 'camera_buffer_delivery', window)).toEqual([
        expect.objectContaining({buffer_number: 1, arrival_binding_status: 'not_measured'}),
      ]);
      // Work-start population and endpoint cadence intentionally have different window membership.
      expect(rows(database, 'camera_frame_population', [18_000_000, 30_000_000])).toEqual([]);
      expect(rows(database, 'camera_display_cadence', [18_000_000, 30_000_000])).toEqual([
        expect.objectContaining({presented_display_frames: 1, observed_intervals: 0}),
      ]);
      expect(rows(database, 'camera_buffer_delivery', [18_000_000, 30_000_000])).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('does not let entirely past or future duplicate display tokens pollute an intersecting frame', () => {
    const database = observationDatabase();
    try {
      addBuffer(database, 1, 10_000_000, 20_000_000);
      database.exec(`
        INSERT INTO actual_frame_timeline_slice VALUES
          (901,1000000,1000000,2,NULL,7001,NULL,'Early Present','Prediction Error'),
          (902,150000000,1000000,2,NULL,7001,NULL,'Early Present','Prediction Error');
      `);
      const window: [number, number] = [12_000_000, 30_000_000];
      expect(rows(database, 'camera_buffer_delivery', window)).toEqual([
        expect.objectContaining({buffer_number: 1, display_id: 101,
          display_present_ts: 20_000_000, binding_status: 'sf_commit_display_bound'}),
      ]);
      expect(rows(database, 'camera_surface_cadence', window)).toEqual([
        expect.objectContaining({observed_buffer_keys: 1, presented_buffers: 1, unavailable_bindings: 0}),
      ]);
    } finally {
      database.close();
    }
  });

  it('counts a latch with missing commit parentage as unavailable', () => {
    const database = observationDatabase();
    try {
      addBuffer(database, 1, 10_000_000, 20_000_000);
      database.exec('UPDATE slice SET parent_id=NULL WHERE id=13');
      expect(rows(database, 'camera_surface_cadence')).toEqual([
        expect.objectContaining({observed_buffer_keys: 1, presented_buffers: 0, unavailable_bindings: 1}),
      ]);
      expect(rows(database, 'camera_buffer_delivery')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('measures Binder server Running separately from wall and preserves missing state coverage', () => {
    const database = observationDatabase();
    database.exec(`
      CREATE TABLE android_binder_txns(binder_txn_id INTEGER,binder_reply_id INTEGER,
        client_upid INTEGER,server_upid INTEGER,client_process TEXT,server_process TEXT,
        client_ts INTEGER,client_dur INTEGER,server_dur INTEGER,is_sync INTEGER);
      CREATE TABLE android_sync_binder_thread_state_by_txn(binder_txn_id INTEGER,binder_reply_id INTEGER,
        thread_state_type TEXT,thread_state TEXT,thread_state_dur INTEGER);
      INSERT INTO android_binder_txns VALUES (1,2,7,8,'cameraserver','camera.provider',50000000,33000000,32999998,1);
      INSERT INTO android_sync_binder_thread_state_by_txn VALUES
        (1,2,'binder_reply','Running',2000000),(1,2,'binder_reply','S',30999998);
    `);
    try {
      expect(rows(database, 'camera_binder_execution')).toEqual([
        expect.objectContaining({transactions: 1, avg_client_wall_ns: 33_000_000,
          avg_server_wall_ns: 32_999_998, avg_server_running_ns: 2_000_000,
          server_state_observed_txns: 1, headroom_status: 'not_measured'}),
      ]);
      database.exec('DELETE FROM android_sync_binder_thread_state_by_txn');
      expect(rows(database, 'camera_binder_execution')).toEqual([
        expect.objectContaining({server_state_observed_txns: 0, avg_server_running_ns: null,
          avg_server_state_observed_ns: null, headroom_status: 'not_measured'}),
      ]);
    } finally {
      database.close();
    }
  });
});
