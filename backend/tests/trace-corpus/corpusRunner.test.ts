// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import path from 'path';
import fs from 'fs';
import {spawnSync} from 'child_process';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import {SkillEvaluator} from '../skill-eval/runner';
import {SkillExecutor} from '../../src/services/skillEngine/skillExecutor';
import {normalizeSkillDefinition} from '../../src/services/skillEngine/skillLoader';
import type {SkillDefinition} from '../../src/services/skillEngine/types';
import {assertEffectiveProcessScope} from '../../src/services/processIdentity/effectiveProcessScope';

import {
  assertExpectationRows,
  loadCorpus,
  resolveFrameTokens,
  resolveParameterTokens,
  runCorpusRegression,
  sqlResultState,
  validateStrategyExpectationDeclaration,
} from './corpusRunner';

const repoRoot = path.resolve(__dirname, '../../..');

describe('SkillEvaluator step sequence identity admission', () => {
  function scopedEvaluator() {
    const db = new Database(':memory:');
    db.function('trace_start', () => 0);
    db.function('trace_end', () => 1000);
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, cmdline TEXT,
        uid INTEGER, android_appid INTEGER, start_ts INTEGER, end_ts INTEGER);
      CREATE TABLE android_process_metadata(upid INTEGER, process_name TEXT, package_name TEXT,
        uid INTEGER, shared_uid INTEGER, is_kernel_task INTEGER);
      CREATE TABLE thread(upid INTEGER, utid INTEGER, tid INTEGER, name TEXT, is_main_thread INTEGER);
      CREATE TABLE actual_frame_timeline_slice(upid INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT, layer_name TEXT);
      CREATE TABLE android_oom_adj_intervals(upid INTEGER, ts INTEGER, dur INTEGER, score INTEGER);
      CREATE TABLE android_battery_stats_event_slices(str_value TEXT, ts INTEGER, safe_dur INTEGER, track_name TEXT);
      INSERT INTO process VALUES (42,4242,'com.example','com.example',1000,1000,0,1000),
        (43,4343,'com.example.worker','com.example.worker',1000,1000,0,1000);
    `);
    const query = jest.fn(async (_traceId: string, sql: string) => {
      // SQLite supplies the real relations used by the maintained resolver;
      // only Perfetto's module-loading syntax is removed in this local fixture.
      const rendered = sql.replace(/INCLUDE PERFETTO MODULE [^;]+;/g, '').trim();
      if (!rendered) return {columns: [], rows: []};
      const statement = db.prepare<[], unknown[]>(rendered);
      return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
    });
    const resolverPath = path.join(repoRoot, 'backend/skills/atomic/process_identity_resolver.skill.yaml');
    const resolver = normalizeSkillDefinition(yaml.load(fs.readFileSync(resolverPath, 'utf8')), resolverPath)!;
    const definition: SkillDefinition = {name: 'corpus_scoped_steps', version: '1', type: 'composite',
      meta: {display_name: 'Scoped steps', description: 'Step admission fixture'},
      identity: {policy: 'required'},
      inputs: [{name: 'upid', type: 'integer', required: false}, {name: 'package', type: 'string', required: false}],
      steps: [{id: 'target', type: 'atomic', condition: 'false', save_as: 'selected',
        process_scope: {role: 'target', binding: 'native_upid'},
        sql: "SELECT upid AS selected_upid FROM process WHERE upid = ${__process_scope.upid} OR (${__process_scope.upid} IS NULL AND name = '${package}')"},
      {id: 'context', type: 'atomic', process_scope: {role: 'identity_metadata'},
        sql: "SELECT '${identity_resolution.status}' AS admitted_status, ${selected.data[0].selected_upid} AS previous_upid, '${package}' AS admitted_name"}],
    };
    const executor = new SkillExecutor({query});
    executor.registerSkills([resolver, definition]);
    // Load an in-memory test trace without starting a TP process. The sequence,
    // gate, resolver SQL, parameter rewrite, and step executor remain real.
    const evaluator = Object.assign(Object.create(SkillEvaluator.prototype), {
      executor, skill: definition, traceId: 'scope-trace', availablePrerequisiteModules: [],
    }) as SkillEvaluator;
    return {db, executor, evaluator, query, definition};
  }

  it('prepares the real exact identity before forced SQL and preserves gate parameters and context', async () => {
    const {db, executor, evaluator, query} = scopedEvaluator();
    const prepare = jest.spyOn(executor, 'prepareInvocation');
    try {
      const results = await evaluator.executeStepSequence(['target', 'context'], {upid: 43}, {forceSqlStepIds: ['target']});
      expect(prepare.mock.calls[0]).toEqual(['corpus_scoped_steps', 'scope-trace', {upid: 43}]);
      const gate = await prepare.mock.results[0].value;
      expect(gate.processScope).toMatchObject({mode: 'exact_upid', traceId: 'scope-trace', upid: 43});
      expect(() => assertEffectiveProcessScope(gate.processScope!, 'scope-trace', 'current')).not.toThrow();
      expect(gate.resolution?.upids).toEqual([43]);
      expect(results.map(result => result.success)).toEqual([true, true]);
      expect(results[0].data).toEqual([{selected_upid: 43}]);
      expect(results[1].data).toEqual([{admitted_status: 'verified', previous_upid: 43, admitted_name: 'com.example.worker'}]);
      const targetSql = query.mock.calls.find(([, sql]) => sql.includes('AS selected_upid'))?.[1];
      expect(targetSql).toContain('upid = 43');
      expect(targetSql).not.toContain('upid = NULL');
    } finally {prepare.mockRestore(); db.close();}
  });

  it.each([{upid: 0}, {upid: 999999}])('refuses an invalid or unresolved selector before target SQL: %j', async params => {
    const {db, evaluator, query} = scopedEvaluator();
    try {
      await expect(evaluator.executeStepSequence(['target', 'context'], params, {forceSqlStepIds: ['target']}))
        .rejects.toThrow(params.upid === 0 ? 'positive safe integer' : 'Explicit UPID could not be verified');
      expect(query.mock.calls.some(([, sql]) => sql.includes('AS selected_upid') || sql.includes('AS admitted_status'))).toBe(false);
      if (params.upid === 0) expect(query).not.toHaveBeenCalled();
    } finally {db.close();}
  });

  it('preserves unverified named filtering when the optional resolver is unavailable', async () => {
    const {db, executor, evaluator, definition, query} = scopedEvaluator();
    const optional = {...definition, identity: {policy: 'verify_if_present' as const}};
    executor.replaceRegisteredSkills([optional]);
    Object.assign(evaluator, {skill: optional});
    const prepare = jest.spyOn(executor, 'prepareInvocation');
    try {
      const results = await evaluator.executeStepSequence(['target', 'context'], {package: 'com.example.worker'},
        {forceSqlStepIds: ['target']});
      const gate = await prepare.mock.results[0].value;
      expect(gate.processScope).toMatchObject({mode: 'named', requestedName: 'com.example.worker'});
      expect(gate.resolution?.status).toBe('unresolved');
      expect(gate.inherited.identity_gate_warning).toContain('resolver failed');
      expect(results[0].data).toEqual([{selected_upid: 43}]);
      expect(results[1].data).toEqual([{admitted_status: 'unresolved', previous_upid: 43, admitted_name: 'com.example.worker'}]);
      expect(query.mock.calls.find(([, sql]) => sql.includes('AS selected_upid'))?.[1])
        .toContain("name = 'com.example.worker'");
    } finally {prepare.mockRestore(); db.close();}
  });
});

describe('Trace corpus regression runner', () => {
  it.each([
    ['case-not-in-generated-catalog'],
    ['startup-lifecycle', 'case-not-in-generated-catalog'],
  ])('rejects unknown explicitly requested cases before executing traces: %j', async (...caseIds) => {
    await expect(runCorpusRegression(repoRoot, {caseIds, writeEvidence: false}))
      .rejects.toThrow('Unknown requested corpus case(s): case-not-in-generated-catalog');
  });

  it('rejects an empty explicit case selection instead of reporting zero checks passed', async () => {
    await expect(runCorpusRegression(repoRoot, {caseIds: [], writeEvidence: false}))
      .rejects.toThrow('Explicit corpus case selection must not be empty');
  });

  it.each([['--case'], ['--case', '--quiet']])('rejects CLI selectors without a value: %j', (...args) => {
    const result = spawnSync(process.execPath, [
      require.resolve('tsx/cli'),
      path.join(__dirname, 'trace_corpus_regression.ts'),
      ...args,
    ], {cwd: path.join(repoRoot, 'backend'), encoding: 'utf8', timeout: 30_000});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--case requires a value');
    expect(result.stdout).not.toContain('Trace corpus regression passed');
  });

  it('loads the generated catalog and exact current coverage inventory', () => {
    const corpus = loadCorpus(repoRoot);
    const manifestTools = require(path.join(repoRoot, 'Trace/tools/lib/catalog.cjs')) as {
      loadCatalog: (root: string) => {cases: Array<{id: string; coverage: unknown}>};
      discoverCoverageTargets: (root: string) => {skills: string[]; strategies: string[]};
    };
    const manifestCases = manifestTools.loadCatalog(repoRoot).cases;
    const coverageTargets = manifestTools.discoverCoverageTargets(repoRoot);
    expect(corpus.cases.map(entry => ({id: entry.id, coverage: entry.coverage})))
      .toEqual(manifestCases.map(entry => ({id: entry.id, coverage: entry.coverage})));
    expect(corpus.coverage.missing).toEqual({skills: [], strategies: []});
    expect(corpus.coverage.covered).toEqual(coverageTargets);
  });

  it('validates declared strategy identity without treating query wording as routing evidence', () => {
    for (const query of ['启动很慢', '不要分析启动，只分析滑动卡顿', 'No startup analysis, only the selected row.']) {
      expect(() => validateStrategyExpectationDeclaration({target: 'startup', expected_strategy: 'startup', query}))
        .not.toThrow();
    }
    expect(() => validateStrategyExpectationDeclaration({target: 'startup', expected_strategy: 'scrolling'}))
      .toThrow('does not match registered target');
    expect(() => validateStrategyExpectationDeclaration({target: 'unknown-corpus-strategy'}))
      .toThrow('Strategy loader cannot resolve');
  });

  it('requires declared value-level semantic evidence', () => {
    expect(() => assertExpectationRows(
      [{kernel: 'SyntheticComputeKernelA(float*)', dur_ns: 12_000_000}],
      {
        target: 'gpu_compute_kernel_analysis',
        semantic_step: 'kernel_summary',
        min_rows: 1,
        assertions: [
          {column: 'kernel', operator: 'contains', value: 'SyntheticComputeKernelA'},
          {column: 'dur_ns', operator: 'gte', value: 12_000_000},
        ],
      },
    )).not.toThrow();
    expect(() => assertExpectationRows(
      [
        {kernel: 'SyntheticComputeKernelA(float*)', dur_ns: 1},
        {kernel: 'wrong', dur_ns: 12_000_000},
      ],
      {
        target: 'gpu_compute_kernel_analysis',
        semantic_step: 'kernel_summary',
        assertions: [
          {column: 'kernel', operator: 'contains', value: 'SyntheticComputeKernelA'},
          {column: 'dur_ns', operator: 'gte', value: 12_000_000},
        ],
      },
    )).toThrow('no single result row satisfies');
  });

  it('requires every declared source-level result column to be present', () => {
    expect(() => assertExpectationRows(
      [{frame_id: 1, dur_ns: 20_000_000}],
      {
        target: 'smartperfetto.scrolling.jank_frames',
        semantic_step: 'canonical_view',
        required_columns: ['frame_id', 'dur_ns'],
      },
    )).not.toThrow();
    expect(() => assertExpectationRows(
      [{frame_id: 1}],
      {
        target: 'smartperfetto.scrolling.jank_frames',
        semantic_step: 'canonical_view',
        required_columns: ['frame_id', 'dur_ns'],
      },
    )).toThrow('missing required columns');
  });

  it('resolves trace and fixture identity tokens without changing literals', () => {
    expect(resolveParameterTokens(
      {
        start_ts: '${trace_start}',
        end_ts: '${trace_end}',
        fixture_start: '${fixture_start}',
        fixture_end: '${fixture_end}',
        upid: '${fixture_upid}',
        utid: '${fixture_utid}',
        package: 'com.smartperfetto.fixture',
      },
      {
        trace_start: '10',
        trace_end: '20',
        fixture_start: '12',
        fixture_end: '18',
        fixture_upid: 30,
        fixture_utid: 40,
      },
    )).toEqual({
      start_ts: '10',
      end_ts: '20',
      fixture_start: '12',
      fixture_end: '18',
      upid: 30,
      utid: 40,
      package: 'com.smartperfetto.fixture',
    });
  });

  describe('frame-anchored parameter tokens', () => {
    const FIXTURE = {fixture_upid: 7, fixture_process_found: true};
    // Frames by (upid, layer_name, ts, dur); SQLite runs the resolver's own SQL.
    const frameQuery = (frames: Array<[number, string, bigint | number, number]>) => {
      const db = new Database(':memory:');
      db.defaultSafeIntegers(true);
      db.exec('CREATE TABLE actual_frame_timeline_slice(upid INTEGER, layer_name TEXT, ts INTEGER, dur INTEGER)');
      const insert = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES (?, ?, ?, ?)');
      for (const frame of frames) insert.run(...frame);
      const query = jest.fn(async (sql: string) => {
        const statement = db.prepare(sql);
        return {columns: statement.columns().map(column => column.name), rows: statement.raw().all() as any[][]};
      });
      return {db, query};
    };

    it('queries nothing when no parameter names a frame token', async () => {
      const {db, query} = frameQuery([]);
      try {
        const parameters = {start_ts: '10', end_ts: '${trace_end}', label: 'frame_start:L', package: 'p'};
        await expect(resolveFrameTokens(parameters, FIXTURE, query, 'case-a')).resolves.toEqual(parameters);
        expect(query).not.toHaveBeenCalled();
      } finally { db.close(); }
    });

    it('resolves both bounds of the one fixture frame on that layer, other processes excluded', async () => {
      const {db, query} = frameQuery([[7, 'LayerT', 1000, 30], [8, 'LayerT', 5000, 40], [7, 'LayerL', 2000, 10]]);
      try {
        await expect(resolveFrameTokens(
          {start_ts: '${frame_start:LayerT}', end_ts: '${frame_end:LayerT}', upid: 7}, FIXTURE, query, 'case-a'))
          .resolves.toEqual({start_ts: '1000', end_ts: '1030', upid: 7});
        expect(query).toHaveBeenCalledTimes(1);
      } finally { db.close(); }
    });

    it.each([
      ['no frame on the layer', [[7, 'Other', 1000, 30]], 'matches 0 frames of fixture upid 7'],
      ['the layer only in another process', [[8, 'LayerT', 1000, 30]], 'matches 0 frames of fixture upid 7'],
      ['two frames on the layer', [[7, 'LayerT', 1000, 30], [7, 'LayerT', 2000, 30]], 'matches 2 frames'],
      ['a zero-duration frame', [[7, 'LayerT', 1000, 0]], 'without a positive duration'],
      ['an unfinished frame', [[7, 'LayerT', 1000, -1]], 'without a positive duration'],
    ] as Array<[string, Array<[number, string, number, number]>, string]>)('rejects %s', async (_label, frames, message) => {
      const {db, query} = frameQuery(frames);
      try {
        await expect(resolveFrameTokens({start_ts: '${frame_start:LayerT}'}, FIXTURE, query, 'case-a'))
          .rejects.toThrow(`case-a: frame token layer "LayerT" `);
        await expect(resolveFrameTokens({start_ts: '${frame_start:LayerT}'}, FIXTURE, query, 'case-a'))
          .rejects.toThrow(message);
      } finally { db.close(); }
    });

    it('rejects a frame token when the trace has no fixture process, before querying', async () => {
      const {db, query} = frameQuery([[0, 'LayerT', 1000, 30]]);
      try {
        await expect(resolveFrameTokens({end_ts: '${frame_end:LayerT}'},
          {fixture_upid: 0, fixture_process_found: false}, query, 'case-b'))
          .rejects.toThrow('case-b: frame token layer "LayerT" needs the com.smartperfetto.fixture process');
        expect(query).not.toHaveBeenCalled();
      } finally { db.close(); }
    });

    it('matches a layer name with quotes literally', async () => {
      const layer = "TX - O'Brien's layer' OR '1'='1";
      const {db, query} = frameQuery([[7, layer, 1000, 30], [7, 'Other', 3000, 30]]);
      try {
        await expect(resolveFrameTokens({start_ts: `\${frame_start:${layer}}`}, FIXTURE, query, 'case-a'))
          .resolves.toEqual({start_ts: '1000'});
      } finally { db.close(); }
    });

    it('keeps nanosecond bounds past 2^53 exact', async () => {
      const {db, query} = frameQuery([[7, 'LayerT', 9_007_199_254_740_993n, 30_000_001]]);
      try {
        await expect(resolveFrameTokens(
          {start_ts: '${frame_start:LayerT}', end_ts: '${frame_end:LayerT}'}, FIXTURE, query, 'case-a'))
          .resolves.toEqual({start_ts: '9007199254740993', end_ts: '9007199284740994'});
      } finally { db.close(); }
    });
  });

  it('does not treat skipped or optional-error SQL as executed', () => {
    expect(sqlResultState({success: true, code: 'condition_not_met'})).toBe('condition_skipped');
    expect(sqlResultState({
      success: true,
      code: 'optional_query_error',
      error: 'no such table: optional_table',
    })).toBe('failed');
    expect(sqlResultState({success: true})).toBe('executed');
  });

  it('executes startup_analysis and checks the startup declaration with a real trace marker', async () => {
    const result = await runCorpusRegression(repoRoot, {
      caseIds: ['startup-lifecycle'],
      targetIds: ['startup_analysis', 'startup'],
      writeEvidence: false,
    });

    expect(result.failures).toEqual([]);
    expect(result.strategy).toEqual({declaration_checked: ['startup-lifecycle:strategy:startup'],
      semantic_routing: 'not_evaluated'});
    expect(result.correctness.positive).not.toContain('startup-lifecycle:strategy:startup');
    expect(result.executed).toEqual(expect.arrayContaining([
      'startup-lifecycle:skill:startup_analysis',
      'startup-lifecycle:strategy:startup',
    ]));
  }, 120_000);

  it('executes the exact canonical SQL source against a real trace', async () => {
    const result = await runCorpusRegression(repoRoot, {
      caseIds: ['android-scroll-customer'],
      targetIds: ['smartperfetto.scrolling.jank_frames'],
      writeEvidence: false,
    });

    expect(result.failures).toEqual([]);
    expect(result.executed).toContain(
      'android-scroll-customer:sql:smartperfetto.scrolling.jank_frames',
    );
    expect(result.correctness.positive).toContain(
      'android-scroll-customer:sql:smartperfetto.scrolling.jank_frames',
    );
  }, 120_000);
});
