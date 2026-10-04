// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import {SkillExecutor} from '../skillExecutor';
import {normalizeSkillDefinition} from '../skillLoader';
import {injectFragmentCtes, readSkillFragmentFile} from '../skillFragments';
import {sqlLiteral} from '../sqlTemplate';
import {diagnoseRuleStep, stepOf} from '../../../../tests/helpers/skillRuleHarness';

const sqlite3Available = spawnSync('sqlite3', ['-version'], {encoding: 'utf-8'}).status === 0;
const describeWithSqlite = sqlite3Available ? describe : describe.skip;

const loadYaml = (relativePath: string): any =>
  yaml.load(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8')) as any;

const fragmentsDir = path.join(process.cwd(), 'skills/fragments');

// Step SQL with its sql_fragments injected by the production composer.
const loadStepSql = (skillPath: string, stepId: string): string => {
  const skill = loadYaml(skillPath);
  const step = skill.steps?.find((candidate: any) => candidate.id === stepId);
  expect(step?.sql).toBeTruthy();
  const fragments = (step.sql_fragments ?? []).map((fragment: string) =>
    readSkillFragmentFile(fragmentsDir, path.basename(fragment)));
  return injectFragmentCtes(step.sql, fragments);
};

// Fragment inputs shared by the heap Skills (fragments/heap_target_process.sql).
const heapScopeParams = {
  '${upid}': 'NULL',
  '${process_name|}': '',
  '${package|}': '',
  '${graph_sample_ts}': 'NULL',
};

const replaceParams = (sql: string, params: Record<string, string>): string =>
  sql.replace(/\$\{[^}]+}/g, token => {
    const value = params[token];
    if (value === undefined) {
      throw new Error(`Missing SQL fixture replacement for ${token}`);
    }
    return value;
  });

const runSqliteJson = (sql: string): Array<Record<string, any>> => {
  const result = spawnSync('sqlite3', ['-json', ':memory:'], {
    input: sql,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim() || '[]') as Array<Record<string, any>>;
};

const heapGraphSchema = `
  CREATE TABLE process(upid INTEGER, name TEXT);
  CREATE TABLE thread(utid INTEGER, upid INTEGER);
  CREATE TABLE thread_track(id INTEGER, utid INTEGER);
  CREATE TABLE slice(track_id INTEGER, name TEXT, ts INTEGER, dur INTEGER);
  CREATE TABLE heap_graph_class(id INTEGER, name TEXT, deobfuscated_name TEXT);
  CREATE TABLE heap_graph_object(
    id INTEGER,
    upid INTEGER,
    graph_sample_ts INTEGER,
    type_id INTEGER,
    self_size INTEGER,
    native_size INTEGER,
    reachable INTEGER
  );
  CREATE TABLE heap_graph_reference(
    id INTEGER,
    owner_id INTEGER,
    owned_id INTEGER,
    field_name TEXT,
    deobfuscated_field_name TEXT,
    field_type_name TEXT
  );
  CREATE TABLE _excluded_refs(id INTEGER);
  CREATE TABLE stats(name TEXT, idx INTEGER, severity TEXT, value INTEGER);
  CREATE TABLE heap_graph(upid INTEGER, ts INTEGER);
  CREATE TABLE process_counter_track(id INTEGER, upid INTEGER, name TEXT);
  CREATE TABLE heap_profile_allocation(upid INTEGER, heap_name TEXT, callsite_id INTEGER, size INTEGER, count INTEGER);
`;

const heapGraphFixture = `
  INSERT INTO process VALUES (1, 'com.example.app');
  INSERT INTO thread VALUES (10, 1);
  INSERT INTO thread_track VALUES (100, 10);

  INSERT INTO heap_graph_class VALUES (1, 'com.example.LeakyActivity', NULL);
  INSERT INTO heap_graph_class VALUES (2, 'com.example.ActiveActivity', NULL);
  INSERT INTO heap_graph_class VALUES (3, 'com.example.SessionViewModel', NULL);
  INSERT INTO heap_graph_class VALUES (4, 'com.example.Owner', NULL);
  INSERT INTO heap_graph_class VALUES (5, 'java.lang.ref.SoftReference', NULL);
  INSERT INTO heap_graph_class VALUES (6, 'com.example.InProgressDestroyActivity', NULL);

  INSERT INTO heap_graph_object VALUES (1, 1, 1000, 1, 1048576, 0, 1);
  INSERT INTO heap_graph_object VALUES (2, 1, 1000, 2, 1048576, 0, 1);
  INSERT INTO heap_graph_object VALUES (3, 1, 1000, 3, 512, 0, 1);
  INSERT INTO heap_graph_object VALUES (4, 1, 1000, 3, 512, 0, 1);
  INSERT INTO heap_graph_object VALUES (50, 1, 1000, 4, 256, 0, 1);
  INSERT INTO heap_graph_object VALUES (51, 1, 1000, 5, 256, 0, 1);
  INSERT INTO heap_graph_object VALUES (6, 1, 1000, 2, 1048576, 0, 1);
  INSERT INTO heap_graph_object VALUES (7, 1, 1000, 6, 1048576, 0, 1);

  INSERT INTO slice VALUES (100, 'SI$com.example.LeakyActivity.onDestroy', 800, 100);
  INSERT INTO slice VALUES (100, 'SI$com.example.ActiveActivity.onResume', 700, 50);
  INSERT INTO slice VALUES (100, 'SI$com.example.InProgressDestroyActivity.onDestroy', 900, 200);

  INSERT INTO heap_graph_reference VALUES (101, 50, 1, 'owner.leaky', NULL, 'com.example.LeakyActivity');
  INSERT INTO heap_graph_reference VALUES (102, 51, 1, 'java.lang.ref.Reference.referent', NULL, 'java.lang.Object');
  INSERT INTO _excluded_refs VALUES (102);
  INSERT INTO heap_graph VALUES (1, 1000);
`;

const heapParams = {
  ...heapScopeParams,
  '${class_name_glob|}': '*ViewModel',
  '${lifecycle_slice_prefix|SI$}': 'SI$',
  '${max_candidates|50}': '50',
  '${max_reference_edges|100}': '100',
};

// An incomplete dump keeps forward references as self_size = -1 placeholders
// typed with class id 0; they are not instances of that class.
const placeholderFixture = `
  INSERT INTO heap_graph_object VALUES (90, 1, 1000, 1, -1, 0, 1);
  INSERT INTO heap_graph_object VALUES (91, 1, 1000, 1, -1, 0, 1);
`;

describe('memory skill SQL semantic guards', () => {
  it('defines a bounded dominator path extraction contract with retained-size propagation', () => {
    const skill = loadYaml('skills/composite/android_heap_dominator_path_extract.skill.yaml');
    const passSql = loadStepSql('skills/composite/android_heap_dominator_path_extract.skill.yaml', 'dominator_tree_pass');
    const sql = loadStepSql('skills/composite/android_heap_dominator_path_extract.skill.yaml', 'dominator_paths');

    expect(skill.batch_analysis).toEqual({
      operation: 'heap_path_cluster',
      source_step: 'dominator_paths',
      output_contract: 'HeapPathClusterAnalysisV1',
      per_trace_row_limit: 500,
      total_row_limit: 5000,
      required_columns: [
        'upid', 'process_name', 'graph_sample_ts', 'path', 'class_name',
        'root_type', 'self_count', 'retained_count', 'self_size_bytes',
        'retained_size_bytes',
      ],
    });
    expect(passSql).toContain('_graph_aggregating_scan!');
    expect(passSql).toContain('WITH RECURSIVE paths');
    expect(passSql).toContain('PARTITION BY tree.upid, tree.graph_sample_ts');
    expect(sql).toContain('JOIN heap_graph_dump_scope AS scope');
    expect(sql).toContain('c.cumulative_size AS retained_size_bytes');
    expect(sql).toContain('p.root_type');
    expect(sql).toContain('MIN(MAX(COALESCE(${max_rows|500}, 500), 1), 500)');
  });

  it('names the reference kinds the pinned _excluded_refs filters', () => {
    // android_heap_graph_leak_candidates.eval.ts runs the pinned runtime's module.
    const skill = loadYaml('skills/atomic/android_heap_graph_leak_candidates.skill.yaml');
    const holderDescription = skill.output.fields.find((field: any) => field.name === 'reference_holders')?.description;
    expect(holderDescription).toContain('weak/phantom/finalizer');
    expect(holderDescription).toContain('soft reference edges are not filtered');
  });

  it('bounds heap graph row limits inside SQL', () => {
    const candidatesSql = loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates');
    const holdersSql = loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'reference_holders');

    expect(candidatesSql).toContain('MIN(MAX(COALESCE(${max_candidates|50}, 50), 1), 200)');
    expect(holdersSql).toContain('MIN(MAX(COALESCE(${max_candidates|50}, 50), 1), 200)');
    expect(holdersSql).toContain('MIN(MAX(COALESCE(${max_reference_edges|100}, 100), 1), 500)');
  });
});

describeWithSqlite('android_heap_graph_leak_candidates SQL semantics', () => {
  it('classifies lifecycle evidence only when the lifecycle slice completed before the heap sample', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      heapParams
    );
    const rows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${sql};`);

    const leaky = rows.find(row => row.class_name === 'com.example.LeakyActivity');
    expect(leaky).toEqual(expect.objectContaining({
      lifecycle_phase_at_sample: 'destroyed',
      leak_state: 'destroyed_reachable',
      confidence: 'high',
      component_type: 'Activity',
    }));

    const activeMultiInstance = rows.find(row => row.class_name === 'com.example.ActiveActivity');
    expect(activeMultiInstance).toEqual(expect.objectContaining({
      lifecycle_phase_at_sample: 'active',
      leak_state: 'multi_instance_reachable',
      confidence: 'low',
    }));

    const inProgressDestroy = rows.find(row => row.class_name === 'com.example.InProgressDestroyActivity');
    expect(inProgressDestroy).toEqual(expect.objectContaining({
      lifecycle_phase_at_sample: 'unknown',
      leak_state: 'unknown_reachable',
      confidence: 'info',
    }));

    const custom = rows.find(row => row.class_name === 'com.example.SessionViewModel');
    expect(custom).toEqual(expect.objectContaining({
      component_type: 'custom',
      leak_state: 'multi_instance_reachable',
      confidence: 'low',
    }));
  });

  it('starts holder lookup from suspect objects and excludes Perfetto excluded_refs', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'reference_holders'),
      heapParams
    );
    const rows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${sql};`);

    expect(rows).toEqual([
      expect.objectContaining({
        candidate_class: 'com.example.LeakyActivity',
        owned_object_id: 1,
        owner_class: 'com.example.Owner',
        field_display: 'owner.leaky',
        leak_state: 'destroyed_reachable',
      }),
    ]);
  });

  it('clamps candidate and holder row limits to at least one row', () => {
    const limitParams = {
      ...heapParams,
      '${max_candidates|50}': '0',
      '${max_reference_edges|100}': '0',
    };
    const candidatesSql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      limitParams
    );
    const candidateRows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${candidatesSql};`);

    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]).toEqual(expect.objectContaining({
      class_name: 'com.example.LeakyActivity',
      leak_state: 'destroyed_reachable',
    }));

    const holdersSql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'reference_holders'),
      limitParams
    );
    const holderRows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${holdersSql};`);

    expect(holderRows).toHaveLength(1);
    expect(holderRows[0]).toEqual(expect.objectContaining({
      candidate_class: 'com.example.LeakyActivity',
      field_display: 'owner.leaky',
    }));
  });

  it('excludes self_size = -1 placeholders and flags the dump incomplete', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      heapParams
    );
    const rows = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${placeholderFixture}\n${sql};`);

    const leaky = rows.find(row => row.class_name === 'com.example.LeakyActivity');
    expect(leaky).toEqual(expect.objectContaining({
      reachable_obj_count: 1,
      self_size_mb: 1,
      dump_completeness: 'incomplete_dump',
    }));
  });

  it('falls back to the unnamed .hprof process instead of returning nothing for a package filter', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      {...heapParams, '${package|}': 'com.example.app'}
    );
    const unnamedFixture = heapGraphFixture.replace(
      "INSERT INTO process VALUES (1, 'com.example.app');",
      'INSERT INTO process VALUES (1, NULL);'
    );
    const rows = runSqliteJson(`${heapGraphSchema}\n${unnamedFixture}\n${sql};`);

    const leaky = rows.find(row => row.class_name === 'com.example.LeakyActivity');
    expect(leaky).toEqual(expect.objectContaining({
      process_name: 'upid:1',
      process_identity: 'process_name_unavailable_upid_fallback',
      dump_completeness: 'no_incompleteness_signal',
      leak_state: 'destroyed_reachable',
    }));

    // Exact or `name:*` matching only: a prefix of the package is not a match.
    const prefix = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      {...heapParams, '${package|}': 'com.example'}
    )};`);
    expect(prefix).toEqual([]);

    const named = runSqliteJson(`${heapGraphSchema}\n${heapGraphFixture}\n${replaceParams(
      loadStepSql('skills/atomic/android_heap_graph_leak_candidates.skill.yaml', 'leak_candidates'),
      {...heapParams, '${package|}': 'com.other.app'}
    )};`);
    expect(named).toEqual([]);
  });
});

// Raw ART slices for fragments/memory_gc_events.sql: process, thread,
// thread_track and slice, one track per thread (track id = utid).
const gcSliceSchema = `
  CREATE TABLE process(upid INTEGER, pid INTEGER, name TEXT);
  CREATE TABLE thread(utid INTEGER, tid INTEGER, name TEXT, upid INTEGER);
  CREATE TABLE thread_track(id INTEGER, utid INTEGER);
  CREATE TABLE slice(id INTEGER, ts INTEGER, dur INTEGER, name TEXT, track_id INTEGER);
`;
const gcEventParams = {'${package}': '', '${start_ts}': 'NULL', '${end_ts}': 'NULL'};

describeWithSqlite('ART GC names (fragments/art_gc_names.sql)', () => {
  const fragment = readSkillFragmentFile(fragmentsDir, 'art_gc_names.sql');
  const classify = (names: string[], query: string) => runSqliteJson(`${injectFragmentCtes(
    `WITH input(name) AS (VALUES ${names.map(name => `(${sqlLiteral(name)})`).join(', ')})
    ${query}`, [fragment])};`);

  it('names collector runs and waits, and nothing that only says gc', () => {
    const kinds: Array<[string, string | null]> = [
      ['Background concurrent copying GC', 'collection'],
      ['Background young concurrent copying GC', 'collection'],
      ['Alloc concurrent copying GC', 'collection'],
      ['Background concurrent mark compact GC', 'collection'],
      ['Alloc partial concurrent mark sweep GC', 'collection'],
      ['Background sticky concurrent mark sweep GC', 'collection'],
      ['Explicit mark sweep GC', 'collection'],
      ['Alloc semispace GC', 'collection'],
      ['GC: Wait For Completion Alloc', 'wait'],
      ['MetricsCollector', null],
      ['BatchSignalCollector', null],
      ['PackUcscIgc1DLut', null],
      ['lhc->lgc', null],
      ['/system/bin/logcat', null],
      ['SparseArray.gc()', null],
      ['art::gc::Heap::TrimSpaces', null],
      ['Lock contention on GC barrier lock (owner tid: 0)', null],
      ['f2fs_gc-254:48', null],
      ['SmartPerfetto::CASE::memory-gc-pressure', null],
    ];
    const rows = classify(kinds.map(([name]) => name), `SELECT name,
      (SELECT n.gc_kind FROM art_gc_slice_name_patterns n WHERE input.name GLOB n.pattern ORDER BY n.gc_kind LIMIT 1) AS kind,
      (SELECT n.gc_kind FROM art_gc_slice_name_patterns n WHERE lower(input.name) GLOB lower(n.pattern) ORDER BY n.gc_kind LIMIT 1) AS lower_kind
      FROM input`);
    expect(rows).toEqual(kinds.map(([name, kind]) => ({name, kind, lower_kind: kind})));
  });

  it('reads ART GC log lines, not a bare gc in a path or method', () => {
    const lines: Array<[string, number]> = [
      ['Background concurrent copying GC freed 123(4KB) AllocSpace objects, 0(0B) LOS objects', 1],
      ['WaitForGcToComplete blocked Alloc on HeapTrim for 12.3ms', 1],
      ['Waiting for a blocking GC Alloc', 1],
      ['Starting a blocking GC Alloc', 1],
      ['Clamp target GC heap from 256MB to 128MB', 1],
      ['/system/bin/logcat -b all', 0],
      ['open com/xiaomi/push/gcp failed', 0],
      ['SparseArray.gc() took 2ms', 0],
      ['Starting activity com.example/.Main', 0],
    ];
    const rows = classify(lines.map(([line]) => line), `SELECT name,
      EXISTS (SELECT 1 FROM art_gc_text_patterns g WHERE lower(input.name) GLOB g.pattern) AS gc_text
      FROM input`);
    expect(rows).toEqual(lines.map(([name, gc_text]) => ({name, gc_text})));
  });
});

describeWithSqlite('memory_analysis GC steps', () => {
  const MS = 1000000;
  // com.example.app (upid 1, main tid 101): a 45ms Alloc collection and a
  // 10ms wait on the main thread, a 30ms background collection on its heap
  // daemon, and two slices that only say gc. upid 3 runs one main-thread
  // collection and records no FrameTimeline at all.
  const fixture = `${gcSliceSchema}
    CREATE TABLE actual_frame_timeline_slice(id INTEGER, upid INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT);
    INSERT INTO process VALUES (1, 101, 'com.example.app'), (2, 201, 'com.other'), (3, 301, 'com.third');
    INSERT INTO thread VALUES
      (1, 101, 'com.example.app', 1), (2, 102, 'HeapTaskDaemon', 1), (3, 301, 'com.third', 3);
    INSERT INTO thread_track VALUES (1, 1), (2, 2), (3, 3);
    INSERT INTO slice VALUES
      (1, 0, ${45 * MS}, 'Alloc young concurrent copying GC', 1),
      (2, ${100 * MS}, ${10 * MS}, 'GC: Wait For Completion Alloc', 1),
      (3, ${95 * MS}, ${30 * MS}, 'Background concurrent copying GC', 2),
      (4, ${200 * MS}, ${50 * MS}, 'MetricsCollector', 1),
      (5, ${300 * MS}, ${50 * MS}, 'SmartPerfetto::CASE::memory-gc-pressure', 1),
      (6, 0, ${20 * MS}, 'Background concurrent copying GC', 3);
    INSERT INTO actual_frame_timeline_slice VALUES
      (1, 1, ${5 * MS}, ${8 * MS}, 'None'),
      (2, 1, ${20 * MS}, ${30 * MS}, 'App Deadline Missed'),
      (3, 2, ${10 * MS}, ${30 * MS}, 'Buffer Stuffing');`;
  const step = (stepId: string, params: Record<string, string> = {}) => runSqliteJson(`${fixture}
    ${replaceParams(loadStepSql('skills/composite/memory_analysis.skill.yaml', stepId), {...gcEventParams, ...params})};`);

  it('reports each main-thread GC once over the frames of its own process', () => {
    expect(step('gc_frame_impact', {'\${vsync_info.data[0].vsync_period_ns|16666667}': '16666667'})).toEqual([
      {gc_name: 'Alloc young concurrent copying GC', gc_dur_ms: 45, frame_count: 2, janky_frame_count: 1,
        jank_type: 'App Deadline Missed', frame_dur_ms: 30, impact: 'GC导致掉帧'},
      {gc_name: 'Background concurrent copying GC', gc_dur_ms: 20, frame_count: 0, janky_frame_count: 0,
        jank_type: null, frame_dur_ms: null, impact: '无帧时间线数据'},
      {gc_name: 'GC: Wait For Completion Alloc', gc_dur_ms: 10, frame_count: 0, janky_frame_count: 0,
        jank_type: null, frame_dur_ms: null, impact: '无重叠帧'},
    ]);
  });

  it('counts collector runs and reports the waits on them apart', () => {
    const [overview] = step('gc_overview', {
      '\${gc_count_critical|100}': '100',
      '\${gc_count_warning|50}': '50',
      '\${gc_total_time_critical_ms|2000}': '2000',
      '\${package}': 'com.example.app',
    });
    expect(overview).toEqual(expect.objectContaining({
      total_gc_count: 2,
      total_gc_time_ms: 75,
      main_thread_gc_count: 1,
      main_thread_gc_time_ms: 45,
      main_thread_gc_wait_count: 1,
      main_thread_gc_wait_ms: 10,
      gc_wait_ms: 10,
    }));
  });
});

describeWithSqlite('art_module GC totals', () => {
  const MS = 1000000;
  const ART = 'skills/modules/framework/art_module.skill.yaml';
  // A ProfileSaver wait on the main thread and no collector run at all.
  const fixture = `${gcSliceSchema}
    INSERT INTO process VALUES (1, 101, 'com.example.app'), (2, 201, 'com.other');
    INSERT INTO thread VALUES (1, 101, 'com.example.app', 1), (2, 201, 'com.other', 2);
    INSERT INTO thread_track VALUES (1, 1), (2, 2);
    INSERT INTO slice VALUES
      (1, 0, ${154 * MS}, 'GC: Wait For Completion ProfileSaver', 1),
      (2, 0, ${300 * MS}, 'Background concurrent copying GC', 2);`;
  const step = (stepId: string) => runSqliteJson(`${fixture}
    ${replaceParams(loadStepSql(ART, stepId), {...gcEventParams, '${package}': 'com.example.app'})};`);

  it('does not read a wait, or another process, as GC time', async () => {
    const totals = step('gc_totals');
    expect(totals).toEqual([{
      collection_count: 0, collection_ms: 0, wait_count: 1, wait_ms: 154,
      main_thread_collection_count: 0, main_thread_wait_count: 1, main_thread_gc_ms: 154,
    }]);
    const events = step('gc_events');
    const rules = stepOf(loadYaml(ART), 'art_diagnosis');
    const diagnoses = (await diagnoseRuleStep(rules, {
      gc_overview: step('gc_overview'), gc_totals: totals, gc_events: events,
      main_thread_gc: step('gc_during_main_thread'), jit_events: [],
    })).map(result => result.diagnosis);
    expect(diagnoses).toEqual(['主线程执行 GC 回收 0 次、等待 GC 完成 1 次，共 154ms，可能导致卡顿']);
  });
});

describeWithSqlite('gc_analysis frame impact attribution', () => {
  // One 45ms GC in com.example.app (upid 1); six janky frames overlap it.
  const sqlFor = (frameUpid: number, frameCount = 6, gcCount = 1) => {
    const frames = Array.from({length: frameCount}, (_, index) =>
      `INSERT INTO actual_frame_timeline_slice VALUES (${index + 1}, ${frameUpid}, ${index * 7000000}, 5000000, 'App Deadline Missed');`);
    const gcs = Array.from({length: gcCount}, () =>
      "INSERT INTO android_garbage_collection_events VALUES (1, 'com.example.app', 'young', 0, 45000000, 4, 60, 64);");
    return `
      CREATE TABLE android_garbage_collection_events(
        upid INTEGER, process_name TEXT, gc_type TEXT, gc_ts INTEGER, gc_dur INTEGER,
        reclaimed_mb REAL, min_heap_mb REAL, max_heap_mb REAL
      );
      CREATE TABLE actual_frame_timeline_slice(id INTEGER, upid INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT);
      ${gcs.join('\n')}
      ${frames.join('\n')}
      ${replaceParams(loadStepSql('skills/composite/gc_analysis.skill.yaml', 'root_cause_classification'), {
        '${package}': '',
        '${start_ts}': 'NULL',
        '${end_ts}': 'NULL',
      })};`;
  };

  it('counts janky frames of the process that ran the GC', () => {
    expect(runSqliteJson(sqlFor(1)).map(row => row.category)).toEqual(['GC_FRAME_IMPACT']);
  });

  it('does not charge a GC with janky frames of another process', () => {
    expect(runSqliteJson(sqlFor(2)).map(row => row.category)).toEqual(['GC_NORMAL']);
  });

  it('counts a janky frame several GCs overlap once', () => {
    // Three janky frames under two overlapping GCs are three frames, not six.
    expect(runSqliteJson(sqlFor(1, 3, 2)).map(row => row.category)).toEqual(['GC_NORMAL']);
  });
});

describeWithSqlite('RSS memory skill SQL semantics', () => {
  const rssSchema = `
    CREATE TABLE memory_rss_and_swap_per_process(
      upid INTEGER,
      pid INTEGER,
      process_name TEXT,
      ts INTEGER,
      dur INTEGER,
      rss INTEGER,
      swap INTEGER,
      anon_rss_and_swap INTEGER
    );
  `;
  const rssFixture = `
    INSERT INTO memory_rss_and_swap_per_process VALUES (1, 123, 'com.example.app', 10, 0, 104857600, 0, 83886080);
    INSERT INTO memory_rss_and_swap_per_process VALUES (1, 123, 'com.example.app', 20, 0, 167772160, 0, 150994944);
  `;
  const rssParams = {
    '${package|}': '',
    '${process_name|}': '',
    '${growth_warning_mb}': 'NULL',
    '${growth_pct_min_mb|5}': '5',
    '${growth_warning_pct|20}': '20',
    '${growth_critical_pct|50}': '50',
    '${jump_warning_mb|10}': '10',
    '${peak_avg_warning_ratio|2}': '2',
    '${start_ts}': 'NULL',
    '${end_ts}': 'NULL',
  };

  it('includes the last instant RSS sample when end_ts is omitted', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/memory_growth_detector.skill.yaml', 'memory_growth'),
      rssParams
    );
    const rows = runSqliteJson(`${rssSchema}\n${rssFixture}\n${sql};`);

    expect(rows).toEqual([
      expect.objectContaining({
        process_name: 'com.example.app',
        samples: 2,
        rss_growth_mb: 60,
        rss_growth_pct: 60,
        rating: 'critical',
      }),
    ]);
  });

  it('keeps RSS/Swap peak timeline defaults inclusive for instant samples', () => {
    const sql = replaceParams(
      loadStepSql('skills/atomic/linux_process_rss_swap_timeline.skill.yaml', 'rss_swap_peaks'),
      {
        '${package|}': '',
        '${process_name|}': '',
        '${start_ts}': 'NULL',
        '${end_ts}': 'NULL',
      }
    );
    const rows = runSqliteJson(`${rssSchema}\n${rssFixture}\n${sql};`);

    expect(rows).toEqual([
      expect.objectContaining({
        process_name: 'com.example.app',
        samples: 2,
        max_rss_mb: 160,
      }),
    ]);
  });
});

describeWithSqlite('heap profile skill SQL semantics', () => {
  // Minimal stand-ins for heap_profile_allocation and the stdlib callstack
  // forest: upid 1 has a libc.malloc profile (allocations and frees) and a
  // com.android.art Java allocation profile (allocations only).
  const heapProfileSchema = `
    CREATE TABLE process(upid INTEGER, name TEXT, pid INTEGER);
    CREATE TABLE heap_graph(upid INTEGER, ts INTEGER);
    CREATE TABLE process_counter_track(id INTEGER, upid INTEGER, name TEXT);
    CREATE TABLE stats(name TEXT, idx INTEGER, severity TEXT, value INTEGER);
    CREATE TABLE stack_profile_mapping(id INTEGER, name TEXT);
    CREATE TABLE _callstack_spc_forest(
      id INTEGER,
      parent_id INTEGER,
      name TEXT,
      mapping_id INTEGER,
      source_file TEXT,
      callsite_id INTEGER,
      is_leaf_function_in_callsite_frame INTEGER
    );
    CREATE TABLE heap_profile_allocation(
      upid INTEGER,
      heap_name TEXT,
      callsite_id INTEGER,
      size INTEGER,
      count INTEGER
    );
  `;
  const heapProfileFixture = `
    INSERT INTO process VALUES (1, 'com.example.app', 100);
    INSERT INTO process VALUES (2, 'com.other.app', 200);
    INSERT INTO stats VALUES ('heapprofd_buffer_overran', 100, 'data_loss', 3);
    INSERT INTO stats VALUES ('heapprofd_unwind_samples', 100, 'info', 50);

    INSERT INTO stack_profile_mapping VALUES (1, '/apex/com.android.runtime/lib64/bionic/libc.so');
    INSERT INTO stack_profile_mapping VALUES (2, '/data/app/libexample.so');
    INSERT INTO stack_profile_mapping VALUES (3, '/apex/com.android.art/lib64/libart.so');
    INSERT INTO stack_profile_mapping VALUES (4, '/data/app/base.apk');
    INSERT INTO stack_profile_mapping VALUES (5, '/system/bin/app_process64');

    INSERT INTO _callstack_spc_forest VALUES (1, NULL, 'main', 5, NULL, 1, 1);
    INSERT INTO _callstack_spc_forest VALUES (2, 1, 'LeakyNativeCache', 2, 'cache.cc', 2, 1);
    INSERT INTO _callstack_spc_forest VALUES (3, 2, 'malloc', 1, NULL, 10, 1);
    INSERT INTO _callstack_spc_forest VALUES (4, 1, 'TransientBufferBuilder', 2, 'buffer.cc', 4, 1);
    INSERT INTO _callstack_spc_forest VALUES (5, 4, 'malloc', 1, NULL, 11, 1);
    INSERT INTO _callstack_spc_forest VALUES (6, 1, 'com.example.IconBuffer.<init>', 4, NULL, 6, 1);
    INSERT INTO _callstack_spc_forest VALUES (7, 6, 'art::gc::Heap::AllocWithNewTLAB', 3, NULL, 12, 1);

    INSERT INTO heap_profile_allocation VALUES (1, 'libc.malloc', 10, 26214400, 10);
    INSERT INTO heap_profile_allocation VALUES (1, 'libc.malloc', 10, -5242880, -2);
    INSERT INTO heap_profile_allocation VALUES (1, 'libc.malloc', 11, 104857600, 1000);
    INSERT INTO heap_profile_allocation VALUES (1, 'libc.malloc', 11, -103809024, -990);
    INSERT INTO heap_profile_allocation VALUES (1, 'com.android.art', 12, 62914560, 500);
    INSERT INTO heap_profile_allocation VALUES (2, 'libc.malloc', 10, 52428800, 7);
  `;
  const hotspotSql = () => replaceParams(
    loadStepSql('skills/atomic/native_heap_breakdown.skill.yaml', 'native_heap_hotspots'),
    {
      ...heapScopeParams,
      '${process_name|}': 'com.example.app',
      '${min_size_mb|1}': '10',
      '${min_alloc_mb|0}': '50',
      '${max_rows|100}': '100',
    }
  );
  const inventorySql = (processName = 'com.example.app') => replaceParams(
    loadStepSql('skills/atomic/native_heap_breakdown.skill.yaml', 'heap_profile_inventory'),
    {...heapScopeParams, '${process_name|}': processName}
  );

  it('inventories each (process, heap) and never measures retention without recorded frees', () => {
    const rows = runSqliteJson(`${heapProfileSchema}\n${heapProfileFixture}\n${inventorySql()};`);

    expect(rows.every(row => row.upid === 1)).toBe(true);

    expect(rows.find(row => row.heap_name === 'libc.malloc')).toEqual(expect.objectContaining({
      process_name: 'com.example.app',
      heap_semantics: 'allocations_and_frees',
      alloc_mb: 125,
      unreleased_mb: 21,
      retention_claim: 'retention_measurable',
      heapprofd_issues: 'heapprofd_buffer_overran=3',
    }));
    expect(rows.find(row => row.heap_name === 'com.android.art')).toEqual(expect.objectContaining({
      heap_semantics: 'java_allocations_only',
      alloc_mb: 60,
      unreleased_mb: null,
      retention_claim: 'churn_only_frees_not_recorded',
    }));
  });

  it('reports an explicit no-data row when heapprofd recorded nothing', () => {
    const rows = runSqliteJson(`${heapProfileSchema}\n${inventorySql('')};`);

    expect(rows).toEqual([expect.objectContaining({status: 'no_heap_profile_data', heapprofd_issues: 'none'})]);
  });

  it('attributes native allocations to the first frame above the allocator and separates retention from churn', () => {
    const rows = runSqliteJson(`${heapProfileSchema}\n${heapProfileFixture}\n${hotspotSql()};`);
    const nativeRows = rows.filter(row => row.heap_name === 'libc.malloc');

    expect(nativeRows.find(row => row.name === 'malloc')).toBeUndefined();
    expect(nativeRows.find(row => row.name === 'LeakyNativeCache')).toEqual(expect.objectContaining({
      cumulative_size_mb: 20,
      self_size_mb: 20,
      cumulative_alloc_mb: 25,
      unreleased_to_alloc_pct: 80,
      churn_ratio: 1.25,
      native_signal: 'unreleased_native_retention',
      source_file: 'cache.cc',
    }));
    expect(nativeRows.find(row => row.name === 'TransientBufferBuilder')).toEqual(expect.objectContaining({
      cumulative_size_mb: 1,
      cumulative_alloc_mb: 100,
      unreleased_to_alloc_pct: 1,
      churn_ratio: 100,
      native_signal: 'allocation_churn',
    }));
    expect(nativeRows.find(row => row.name === 'main')).toEqual(expect.objectContaining({
      self_alloc_mb: 0,
      native_signal: 'call_path_ancestor',
    }));
  });

  it('classifies a com.android.art allocation profile as churn only, never retention', () => {
    const rows = runSqliteJson(`${heapProfileSchema}\n${heapProfileFixture}\n${hotspotSql()};`);
    const javaRows = rows.filter(row => row.heap_name === 'com.android.art');

    expect(javaRows).toEqual([
      expect.objectContaining({
        name: 'com.example.IconBuffer.<init>',
        cumulative_size_mb: null,
        self_size_mb: null,
        self_alloc_mb: 60,
        unreleased_to_alloc_pct: null,
        native_signal: 'allocation_churn',
      }),
    ]);
  });
});

describe('android_memory_v57_ai_diagnostics heap profile scope', () => {
  it('passes its process scope through to the shared heap profile Skill', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER, name TEXT, pid INTEGER);
      CREATE TABLE stats(name TEXT, idx INTEGER, severity TEXT, value INTEGER);
      CREATE TABLE heap_graph(upid INTEGER, ts INTEGER);
      CREATE TABLE process_counter_track(id INTEGER, upid INTEGER, name TEXT);
      CREATE TABLE heap_graph_object(id INTEGER, upid INTEGER, graph_sample_ts INTEGER, self_size INTEGER);
      CREATE TABLE android_heap_graph_stats(upid INTEGER);
      CREATE TABLE android_heap_graph_class_summary_tree(upid INTEGER);
      CREATE TABLE stack_profile_mapping(id INTEGER, name TEXT);
      CREATE TABLE _callstack_spc_forest(id INTEGER, parent_id INTEGER, name TEXT, mapping_id INTEGER,
        source_file TEXT, callsite_id INTEGER, is_leaf_function_in_callsite_frame INTEGER);
      CREATE TABLE heap_profile_allocation(upid INTEGER, heap_name TEXT, callsite_id INTEGER, size INTEGER, count INTEGER);
      INSERT INTO process VALUES (1, 'com.example.app', 100), (2, 'com.other.app', 200);
      INSERT INTO stack_profile_mapping VALUES (1, '/apex/com.android.runtime/lib64/bionic/libc.so'), (2, '/data/app/libexample.so');
      INSERT INTO _callstack_spc_forest VALUES (1, NULL, 'LeakyNativeCache', 2, NULL, 1, 1), (2, 1, 'malloc', 1, NULL, 10, 1);
      INSERT INTO heap_profile_allocation VALUES (1, 'libc.malloc', 10, 20971520, 4), (2, 'libc.malloc', 10, 20971520, 4);
    `);
    const executor = new SkillExecutor({query: async (_traceId: string, sql: string) => {
      const sqliteSql = sql.replace(/INCLUDE PERFETTO MODULE [^;]+;/g, '').trim();
      if (!sqliteSql) return {columns: [], rows: []};
      const statement = db.prepare(sqliteSql);
      return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
    }} as any);
    const load = (relativePath: string) =>
      normalizeSkillDefinition(loadYaml(relativePath), path.join(process.cwd(), relativePath))!;
    executor.registerSkills([
      load('skills/composite/android_memory_v57_ai_diagnostics.skill.yaml'),
      load('skills/atomic/native_heap_breakdown.skill.yaml'),
    ]);
    executor.setFragmentRegistry(new Map(['heap_target_process.sql', 'heap_profile_scope.sql', 'heap_graph_dump_scope.sql']
      .map(file => [`fragments/${file}`, readSkillFragmentFile(fragmentsDir, file)])));

    const result = await executor.execute('android_memory_v57_ai_diagnostics', 'trace', {process_name: 'com.example.app'});
    const hotspots = result.rawResults?.heap_profile_hotspots?.data as any;
    const inventory = hotspots?.rawResults?.heap_profile_inventory?.data ?? [];

    expect(hotspots?.success).toBe(true);
    expect(inventory).toEqual([expect.objectContaining({upid: 1, process_name: 'com.example.app'})]);

    const unscoped = await executor.execute('android_memory_v57_ai_diagnostics', 'trace', {});
    const unscopedInventory = (unscoped.rawResults?.heap_profile_hotspots?.data as any)
      ?.rawResults?.heap_profile_inventory?.data ?? [];
    expect(unscopedInventory.map((row: any) => row.upid).sort()).toEqual([1, 2]);
    db.close();
  });
});

describeWithSqlite('android_bitmap_memory_per_process scope (fragments/heap_target_process.sql)', () => {
  const skillPath = 'skills/atomic/android_bitmap_memory_per_process.skill.yaml';
  const bitmapSchema = `
    CREATE TABLE process(upid INTEGER, name TEXT);
    CREATE TABLE heap_graph(upid INTEGER, ts INTEGER);
    CREATE TABLE heap_profile_allocation(upid INTEGER);
    CREATE TABLE process_counter_track(id INTEGER, upid INTEGER, name TEXT);
    CREATE TABLE android_bitmap_counters_per_process(
      upid INTEGER, process_name TEXT, ts INTEGER, dur INTEGER, bitmap_memory INTEGER, bitmap_count INTEGER
    );
    CREATE TABLE heap_graph_bitmaps(
      upid INTEGER, self_size INTEGER, native_size INTEGER, reachable INTEGER, width INTEGER, height INTEGER,
      bitmap_storage_type TEXT, source_id INTEGER, source_pid INTEGER, source_process_name TEXT,
      source_storage_type TEXT
    );
  `;
  // Bitmap counters only (atrace "view"), no heap dump: the counter processes
  // are the candidates. com.example.apps shares a prefix with com.example.app.
  const counterFixture = `
    INSERT INTO process VALUES (1, 'com.example.app'), (2, 'com.example.app:remote'), (3, 'com.example.apps');
    INSERT INTO process_counter_track VALUES (10, 1, 'Bitmap Memory'), (20, 2, 'Bitmap Memory'), (30, 3, 'Bitmap Memory');
    INSERT INTO android_bitmap_counters_per_process VALUES
      (1, 'com.example.app', 100, 10, 4000, 4),
      (1, 'com.example.app', 110, 10, 9000, 7),
      (1, 'com.example.app', 120, 10, 6000, 5),
      (2, 'com.example.app:remote', 100, 10, 2000, 1),
      (3, 'com.example.apps', 100, 10, 8000, 3);
  `;
  const run = (stepId: string, fixture: string, params: Record<string, string> = {}): Array<Record<string, any>> =>
    runSqliteJson(`${bitmapSchema}\n${fixture}\n${replaceParams(
      loadStepSql(skillPath, stepId),
      {...heapScopeParams, ...params}
    )};`);

  it('reports one row per process at its peak sample, all processes when unscoped', () => {
    expect(run('bitmap_memory', counterFixture)).toEqual([
      {process_name: 'com.example.app', bitmap_count: 7, total_bytes: 9000, peak_ts: 110, process_identity: 'all_heap_processes'},
      {process_name: 'com.example.apps', bitmap_count: 3, total_bytes: 8000, peak_ts: 100, process_identity: 'all_heap_processes'},
      {process_name: 'com.example.app:remote', bitmap_count: 1, total_bytes: 2000, peak_ts: 100, process_identity: 'all_heap_processes'},
    ]);
  });

  it('matches process_name or package exactly or as name:*, never by prefix', () => {
    const names = (params: Record<string, string>) => run('bitmap_memory', counterFixture, params).map(row => row.process_name);
    // process_name alone used to be ignored: the package clause was always true.
    expect(names({'${process_name|}': 'com.example.app'})).toEqual(['com.example.app', 'com.example.app:remote']);
    expect(names({'${package|}': 'com.example.app'})).toEqual(['com.example.app', 'com.example.app:remote']);
    expect(names({'${process_name|}': 'com.example'})).toEqual([]);
    expect(names({'${upid}': '3'})).toEqual(['com.example.apps']);
    // An unnamed counter-only process is not an .hprof dump: no upid fallback.
    const unnamedCounter = `${counterFixture}
      INSERT INTO process VALUES (4, NULL);
      INSERT INTO process_counter_track VALUES (40, 4, 'Bitmap Memory');
      INSERT INTO android_bitmap_counters_per_process VALUES (4, NULL, 100, 10, 1000, 1);`;
    expect(run('bitmap_memory', unnamedCounter, {'${package|}': 'com.other'})).toEqual([]);
  });

  it('falls back to the unnamed .hprof dump for heap graph Bitmaps', () => {
    const hprofFixture = `
      INSERT INTO process VALUES (5, NULL);
      INSERT INTO heap_graph VALUES (5, 1000);
      INSERT INTO heap_graph_bitmaps VALUES
        (5, 100, 4096, 1, 64, 64, 'ashmem', 7, 900, 'com.sender', 'ashmem'),
        (5, -1, 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    `;
    expect(run('heap_bitmap_metadata', hprofFixture, {'${package|}': 'com.example.app'})).toEqual([
      expect.objectContaining({
        process_name: 'upid:5',
        bitmap_object_count: 1,
        total_bytes: 4196,
        process_identity: 'process_name_unavailable_upid_fallback',
      }),
    ]);
    expect(run('heap_bitmap_sender_attribution', hprofFixture, {'${package|}': 'com.example.app'})).toEqual([
      expect.objectContaining({
        receiver_process: 'upid:5',
        source_process: 'com.sender',
        process_identity: 'process_name_unavailable_upid_fallback',
      }),
    ]);
    // A named match wins over the unnamed dump.
    expect(run('heap_bitmap_metadata', `${hprofFixture}\n${counterFixture}`, {'${package|}': 'com.example.app'})).toEqual([]);
  });
});
