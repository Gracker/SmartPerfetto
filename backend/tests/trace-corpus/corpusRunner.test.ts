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
  exactScopeBindingError,
  exactSqlUnitPaths,
  exactUnitKey,
  exactUnitResultError,
  loadCorpus,
  resolveFrameTokens,
  resolveParameterTokens,
  runCorpusRegression,
  scopeIsolationFailures,
  selectExactScopeInstance,
  sqlResultState,
  unboundExactUnitFailures,
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
      if (!statement.reader) {
        statement.run();
        return {columns: [], rows: []};
      }
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
  // The fixture evaluating `skill` in place of the default definition.
  const withDefinition = (skill: SkillDefinition) => {
    const fixture = scopedEvaluator();
    fixture.executor.registerSkills([skill]);
    Object.assign(fixture.evaluator, {skill});
    return {...fixture, skill};
  };

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

  it('runs a step exact_sql under the issued exact UPID and records exact target evidence', async () => {
    const {db, executor, evaluator, definition} = scopedEvaluator();
    const [{condition: _condition, ...target}, context] = definition.steps as any[];
    const exactSkill: SkillDefinition = {...definition, steps: [{...target,
      exact_sql: {process_scope: {role: 'target', binding: 'native_upid'},
        sql: "SELECT upid AS selected_upid, 'exact' AS variant FROM process WHERE upid = ${__process_scope.upid}"}},
    context]};
    executor.registerSkills([exactSkill]);
    Object.assign(evaluator, {skill: exactSkill});
    try {
      expect(exactSqlUnitPaths(exactSkill)).toEqual(['target.exact_sql']);
      const [exact] = await evaluator.executeStepSequence(['target', 'context'], {upid: 43});
      expect(exact.data).toEqual([{selected_upid: 43, variant: 'exact'}]);
      expect(exactUnitResultError('target.exact_sql', exact, 43)).toBeUndefined();
      expect(exactUnitResultError('target.exact_sql', exact, 42)).toContain('did not record evidence');
      // A named run executes the step's own SQL and records named, not exact, evidence.
      const [named] = await evaluator.executeStepSequence(['target', 'context'], {package: 'com.example.worker'});
      expect(named.data).toEqual([{selected_upid: 43}]);
      expect(exactUnitResultError('target.exact_sql', named, 43)).toContain('did not record evidence');
    } finally {db.close();}
  });

  // `first` declares save_as `marker`, the name of an input too: a step that did
  // not observe anything binds null, so `second` must not read the input instead.
  it.each([
    ['failed', undefined, {sql: 'SELECT missing FROM no_such_table'}],
    ['skipped by its condition', 'condition_not_met', {condition: 'false', sql: "SELECT 'from-step' AS value"}],
  ])('binds an earlier %s step\'s save_as to null in every run, as production does', async (_label, code, first) => {
    const {db, executor, evaluator, skill} = withDefinition({name: 'corpus_scoped_steps', version: '1', type: 'composite',
      meta: {display_name: 'Unobserved save_as', description: 'Binding fixture'},
      identity: {policy: 'required'},
      inputs: [{name: 'upid', type: 'integer', required: false}, {name: 'marker', type: 'string', required: false}],
      steps: [{id: 'first', type: 'atomic', save_as: 'marker', process_scope: {role: 'identity_metadata'}, ...first},
        {id: 'second', type: 'atomic', process_scope: {role: 'identity_metadata'}, sql: "SELECT '${marker}' AS seen"}]});
    const params = {upid: 42, marker: 'from-input'};
    try {
      const production = await executor.executeCompositeSkill(skill, params, {traceId: 'scope-trace'});
      expect(production.stepResults?.find(step => step.stepId === 'second')?.data).toEqual([{seen: ''}]);
      const [earlier, later] = await evaluator.executeStepSequence(['first', 'second'], params, {scopeProbeStepIds: ['second']});
      expect(earlier).toMatchObject({success: false, data: [], code});
      expect(later.data).toEqual([{seen: ''}]);
      expect(later.scopeProbe?.blanked.data).toEqual([{seen: ''}]);
      expect(later.scopeProbe?.open?.data).toEqual([{seen: ''}]);
    } finally {db.close();}
  });

  describe('scope-isolation probe', () => {
    // A native_upid step whose own SQL an exact run executes, in the fixture
    // above: 42 is com.example, 43 its same-uid com.example.worker.
    const probeSkill = (sql: string): SkillDefinition => ({name: 'corpus_scoped_steps', version: '1', type: 'composite',
      meta: {display_name: 'Probe', description: 'Scope isolation fixture'},
      identity: {policy: 'required'},
      inputs: [{name: 'upid', type: 'integer', required: false}, {name: 'package', type: 'string', required: false}],
      steps: [{id: 'target', type: 'atomic', process_scope: {role: 'target', binding: 'native_upid'}, sql}]});
    const isolated = 'SELECT upid FROM process WHERE (${__process_scope.upid} IS NULL OR upid = ${__process_scope.upid})'
      + " AND (${__process_scope.upid} IS NOT NULL OR '${package}' = '' OR name = '${package}') ORDER BY upid";
    // Keeps the trusted token but still admits rows by the package parameter.
    const leaky = "SELECT upid FROM process WHERE upid = ${__process_scope.upid} OR '${package}' = ''"
      + " OR name GLOB '${package}:*' ORDER BY upid";
    // The probe as the runner applies it: one run with the unit's step probed.
    const probeRun = (evaluator: SkillEvaluator, stepIds = ['target']) =>
      evaluator.executeStepSequence(stepIds, {upid: 42}, {scopeProbeStepIds: ['target']});
    const isolationOf = (results: Awaited<ReturnType<typeof probeRun>>) =>
      scopeIsolationFailures([{unit: 'target', stepId: 'target'}], results, 42);
    const probe = async (evaluator: SkillEvaluator, stepIds?: string[]) => isolationOf(await probeRun(evaluator, stepIds));
    const withSkill = (sql: string) => withDefinition(probeSkill(sql));

    it('counts a native_upid step without exact_sql as an exact unit by its step name', () => {
      expect(exactSqlUnitPaths(probeSkill(isolated))).toEqual(['target']);
      const unavailable = probeSkill(isolated);
      (unavailable.steps![0] as any).process_scope = {role: 'target', binding: 'native_upid', exact_unavailable: 'no exact form'};
      expect(exactSqlUnitPaths(unavailable)).toEqual([]);
      expect(unboundExactUnitFailures([probeSkill(isolated)], new Map(), new Set())[0].reason)
        .toBe('exact SQL unit target was not executed by any corpus exact_scope binding');
    });

    it('counts a target step bound through effective_target_processes, and no context step', () => {
      const relation = probeSkill(isolated);
      (relation.steps![0] as any).process_scope = {role: 'target', binding: 'effective_target_processes'};
      expect(exactSqlUnitPaths(relation)).toEqual(['target']);
      (relation.steps![0] as any).process_scope = {role: 'global_context'};
      expect(exactSqlUnitPaths(relation)).toEqual([]);
      (relation.steps![0] as any).process_scope = {role: 'target'};
      expect(exactSqlUnitPaths(relation)).toEqual([]);
    });

    it('reruns a probed step in both probe runs: blanked keeps the exact scope, open is every process', async () => {
      const {db, evaluator} = withSkill(isolated);
      try {
        const [result] = await evaluator.executeStepSequence(['target'], {upid: 42}, {scopeProbeStepIds: ['target']});
        expect(result.data).toEqual([{upid: 42}]);
        expect(result.scopeProbe?.blanked.data).toEqual([{upid: 42}]);
        expect(result.scopeProbe?.open?.data).toEqual([{upid: 42}, {upid: 43}]);
        await expect(probe(evaluator)).resolves.toEqual([]);
      } finally {db.close();}
    });

    it('fails a unit that still admits rows by package under the exact scope', async () => {
      const {db, evaluator} = withSkill(leaky);
      try {
        expect(await probe(evaluator)).toEqual([expect.stringContaining('target reads more than its exact UPID')]);
      } finally {db.close();}
    });

    it('calls a trace that cannot tell the processes apart inconclusive, not the Skill wrong', async () => {
      const {db, evaluator} = withSkill(isolated);
      try {
        db.exec('DELETE FROM process WHERE upid = 43');
        const failures = await probe(evaluator);
        expect(failures).toEqual([expect.stringContaining('target isolation is inconclusive')]);
        expect(failures[0]).toContain('the fixture is insufficient, not the Skill');
      } finally {db.close();}
    });

    it('gives a step with an exact_sql no unscoped rerun, which would run its named SQL', async () => {
      const {db, evaluator, skill} = withSkill(leaky);
      (skill.steps![0] as any).exact_sql = {process_scope: {role: 'target', binding: 'native_upid'},
        sql: 'SELECT upid FROM process WHERE upid = ${__process_scope.upid}'};
      try {
        const [result] = await evaluator.executeStepSequence(['target'], {upid: 42}, {scopeProbeStepIds: ['target']});
        expect(result.data).toEqual([{upid: 42}]);
        expect(result.scopeProbe).toEqual({blanked: expect.objectContaining({data: [{upid: 42}]})});
      } finally {db.close();}
    });

    // A target unit that takes its process from an earlier step's result, as
    // cpu_analysis's steps take target_process: `pick` falls back to the
    // highest UPID when nothing selects a process.
    const pickedSkill = (pickSql: string): SkillDefinition => ({...probeSkill(isolated), steps: [
      {id: 'pick', type: 'atomic', save_as: 'picked', process_scope: {role: 'target', binding: 'native_upid'}, sql: pickSql},
      {id: 'target', type: 'atomic', process_scope: {role: 'target', binding: 'native_upid'},
        sql: 'SELECT upid FROM process WHERE upid = ${picked.data[0].upid} AND COALESCE(${__process_scope.upid}, upid) = upid'}]});
    const pickIsolated = isolated + ' DESC LIMIT 1';
    const pickLeaky = "SELECT upid FROM process WHERE upid = ${__process_scope.upid} OR '${package}' = '' ORDER BY upid DESC LIMIT 1";

    it('judges a unit that reads an earlier result through the result each probe run computed', async () => {
      const {db, evaluator} = withDefinition(pickedSkill(pickIsolated));
      try {
        const results = await probeRun(evaluator, ['pick', 'target']);
        const result = results[1];
        expect(result.data).toEqual([{upid: 42}]);
        expect(result.scopeProbe?.blanked.data).toEqual([{upid: 42}]);
        // Unscoped, the open run's own pick chose another process. A fork of the
        // production context would have kept its pick and called this inconclusive.
        expect(result.scopeProbe?.open?.data).toEqual([{upid: 43}]);
        expect(isolationOf(results)).toEqual([]);
      } finally {db.close();}
    });

    it('fails a unit whose earlier result still reads the package under the exact scope', async () => {
      const {db, evaluator} = withDefinition(pickedSkill(pickLeaky));
      try {
        expect(await probe(evaluator, ['pick', 'target'])).toEqual([expect.stringContaining('target reads more than its exact UPID')]);
      } finally {db.close();}
    });

    it('lets the probe runs share a placeholder-free state-writing step, and refuses any other', async () => {
      const withSetup = (setupSql: string) => {
        const skill = probeSkill(isolated);
        skill.steps!.unshift({id: 'setup', type: 'atomic', process_scope: {role: 'identity_metadata'}, sql: setupSql} as any);
        return withDefinition(skill);
      };
      const shared = withSetup('CREATE VIEW IF NOT EXISTS probe_setup AS SELECT 1 AS one');
      try {
        const [, result] = await probeRun(shared.evaluator, ['setup', 'target']);
        expect(result.scopeProbe?.open?.data).toEqual([{upid: 42}, {upid: 43}]);
      } finally {shared.db.close();}
      const scoped = withSetup("CREATE VIEW IF NOT EXISTS probe_setup AS SELECT '${package}' AS name");
      try {
        await expect(probeRun(scoped.evaluator, ['setup', 'target']))
          .rejects.toThrow('Scope-isolation probe of setup needs read-only step SQL');
      } finally {scoped.db.close();}
    });

    it('refuses to probe SQL that changes state', async () => {
      const {db, evaluator} = withSkill("CREATE VIEW IF NOT EXISTS probe_view AS SELECT ${__process_scope.upid} AS upid");
      try {
        await expect(evaluator.executeStepSequence(['target'], {upid: 42}, {scopeProbeStepIds: ['target']}))
          .rejects.toThrow('Scope-isolation probe of target needs read-only step SQL');
      } finally {db.close();}
    });

    describe('same-named sibling', () => {
      // 44 is com.example again: the app after a restart, beside 42.
      const restarted = (sql: string) => {
        const fixture = withSkill(sql);
        fixture.db.exec("INSERT INTO process VALUES (44,4444,'com.example','com.example',1000,1000,500,1000)");
        return fixture;
      };
      // Reads the bound UPID's name and then every process carrying it, as a
      // step that re-selects its target process by name would.
      const byName = 'SELECT upid FROM process WHERE ${__process_scope.upid} IS NULL OR name = '
        + '(SELECT name FROM process WHERE upid = ${__process_scope.upid}) ORDER BY upid';
      const siblingRun = (evaluator: SkillEvaluator) => evaluator.executeStepSequence(['target'], {upid: 42},
        {scopeProbeStepIds: ['target'], scopeProbeSiblingUpid: 44});

      it('admits the sibling through the identity gate and runs the unit under its UPID', async () => {
        const {db, evaluator} = restarted(isolated);
        try {
          const results = await siblingRun(evaluator);
          expect(results[0].data).toEqual([{upid: 42}]);
          expect(results[0].scopeProbe?.sibling?.data).toEqual([{upid: 44}]);
          expect(scopeIsolationFailures([{unit: 'target', stepId: 'target'}], results, 42, 44)).toEqual([]);
        } finally {db.close();}
      });

      it('fails a unit that selects by name, which the blanked and open runs cannot see', async () => {
        const {db, evaluator} = restarted(byName);
        try {
          const results = await siblingRun(evaluator);
          expect(results[0].data).toEqual([{upid: 42}, {upid: 44}]);
          expect(scopeIsolationFailures([{unit: 'target', stepId: 'target'}], results, 42)).toEqual([]);
          expect(scopeIsolationFailures([{unit: 'target', stepId: 'target'}], results, 42, 44))
            .toEqual([expect.stringContaining('target answers alike under UPID 42 and UPID 44')]);
        } finally {db.close();}
      });

      it('reports a probe that never ran under the sibling', async () => {
        const {db, evaluator} = restarted(isolated);
        try {
          const results = await probeRun(evaluator);
          expect(scopeIsolationFailures([{unit: 'target', stepId: 'target'}], results, 42, 44))
            .toEqual(['target was not probed under same-named UPID 44']);
        } finally {db.close();}
      });
    });
  });

  describe('exact_scope instance', () => {
    const binding = (instance?: 'newest' | 'oldest') => ({process_name: 'com.example', instance});

    it('keeps a unique name to exactly one UPID when no instance is named', () => {
      expect(selectExactScopeInstance([42], binding())).toEqual({upid: 42});
      expect(() => selectExactScopeInstance([42, 44], binding()))
        .toThrow('matches 2 process(es); an exact binding needs exactly one positive UPID, or an instance');
      expect(() => selectExactScopeInstance([], binding())).toThrow('matches 0 process(es)');
    });

    it('picks one of several same-named instances by UPID order, with the next as its sibling', () => {
      expect(selectExactScopeInstance([42, 44, 47], binding('newest'))).toEqual({upid: 47, sibling: 44});
      expect(selectExactScopeInstance([42, 44, 47], binding('oldest'))).toEqual({upid: 42, sibling: 44});
    });

    it('refuses an instance on an unshared name, and a UPID that is not positive', () => {
      expect(() => selectExactScopeInstance([42], binding('newest')))
        .toThrow('instance newest picks among same-named processes, so the name must be shared');
      expect(() => selectExactScopeInstance([0, 42], binding('oldest'))).toThrow('not all with a positive UPID');
    });
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

  describe('exact_sql bindings', () => {
    const scope = {role: 'target' as const, binding: 'native_upid' as const};
    const exactSkill: SkillDefinition = {name: 'exact_fixture', version: '1', type: 'composite',
      meta: {display_name: 'Exact', description: 'Exact unit fixture'},
      steps: [{id: 'probe', type: 'atomic', process_scope: scope, sql: 'SELECT ${__process_scope.upid} AS upid',
        exact_sql: {process_scope: scope, sql: 'SELECT ${__process_scope.upid} AS upid'}}]};
    const semantic = {unit: 'probe.exact_sql', mode: 'semantic' as const, required_columns: ['upid'],
      assertions: [{column: 'upid', operator: 'gt' as const, value: 0}]};
    const exactEvidence = (upid: number) => ({version: 'process_scope_evidence@1' as const, entries: [{
      role: 'target' as const, scope: {mode: 'exact_upid' as const, traceId: 't', traceSide: 'current' as const, upid}}]});

    it('binds only exact units of the Skill, once each', () => {
      const bind = (units: any[]) => exactScopeBindingError('exact_fixture', exactSkill, {process_name: 'p', units});
      expect(bind([semantic])).toBeUndefined();
      expect(bind([{unit: 'probe.exact_sql', mode: 'execution'}])).toBeUndefined();
      expect(bind([semantic, semantic])).toContain('more than once');
      expect(bind([{unit: 'other.exact_sql', mode: 'execution'}]))
        .toBe('exact_scope binds other.exact_sql, which exact_fixture does not run as exact SQL (exact units: probe.exact_sql)');
    });

    it('counts a unit only when it executed and recorded target evidence under the bound UPID', () => {
      const ok = {success: true, stepId: 'probe', data: [{upid: 7}], executionTimeMs: 0, scopeProvenance: exactEvidence(7)};
      expect(exactUnitResultError('probe.exact_sql', ok, 7)).toBeUndefined();
      expect(exactUnitResultError('probe.exact_sql', undefined, 7)).toContain('was not attempted');
      expect(exactUnitResultError('probe.exact_sql', {...ok, success: false, code: 'condition_not_met'}, 7))
        .toContain('skipped by its condition');
      expect(exactUnitResultError('probe.exact_sql', {...ok, success: false, error: 'no such table: x'}, 7))
        .toContain('failed under exact UPID 7: no such table: x');
      expect(exactUnitResultError('probe.exact_sql', {...ok, scopeProvenance: exactEvidence(8)}, 7))
        .toContain('did not record evidence');
      const [target] = exactEvidence(7).entries;
      const context = {role: 'global_context' as const, relativeTo: target.scope,
        scope: {mode: 'unscoped' as const, traceId: 't', traceSide: 'current' as const}};
      const provenance = (entry: object) => ({version: 'process_scope_evidence@1' as const, entries: [entry as any]});
      expect(exactUnitResultError('probe.exact_sql', {...ok, scopeProvenance: provenance(context)}, 7)).toBeUndefined();
      expect(exactUnitResultError('probe.exact_sql',
        {...ok, scopeProvenance: provenance({...target, availability: 'unavailable'})}, 7)).toContain('did not record evidence');
    });

    it('fails every exact unit no passing binding executed instead of skipping it', () => {
      const supports = new Map([['exact_fixture', {supported: true}]]);
      expect(unboundExactUnitFailures([exactSkill], supports, new Set())).toEqual([{case_id: 'corpus', target: 'exact_fixture',
        reason: 'exact SQL unit probe.exact_sql was not executed by any corpus exact_scope binding'}]);
      expect(unboundExactUnitFailures([exactSkill], supports, new Set(['exact_fixture:probe.exact_sql']))).toEqual([]);
      expect(unboundExactUnitFailures([exactSkill], supports, new Set(), new Set(['other']))).toEqual([]);
      // A Skill the executor never admits to an exact run owes no binding; one it does not know of still does.
      expect(unboundExactUnitFailures([exactSkill],
        new Map([['exact_fixture', {supported: false, reason: 'other: SQL has no process_scope declaration'}]]),
        new Set())).toEqual([]);
      expect(unboundExactUnitFailures([exactSkill], new Map(), new Set())).toHaveLength(1);
    });

    it('names a nested exact unit as unsupported rather than not attempted', () => {
      const [probe] = exactSkill.steps as any[];
      const nestedSkill: SkillDefinition = {...exactSkill, name: 'nested_fixture',
        steps: [{id: 'group', type: 'composite', steps: [{...probe, id: 'inner'}]} as any]};
      const [unit] = exactSqlUnitPaths(nestedSkill);
      expect(unit).toBeDefined();
      expect(exactScopeBindingError('nested_fixture', nestedSkill, {process_name: 'p', units: [{unit, mode: 'execution'}]}))
        .toBe(`nested exact units are not yet supported by the corpus runner: ${unit}`);
      expect(unboundExactUnitFailures([nestedSkill], new Map(), new Set())[0].reason)
        .toContain('(nested exact units are not yet supported by the corpus runner)');
    });

    it('binds every exact unit of the registry in the generated corpus', () => {
      const bound = new Set(loadCorpus(repoRoot).cases.flatMap(entry => entry.coverage.expectations
        .flatMap(expectation => (expectation.exact_scope?.units ?? []).map(unit => exactUnitKey(expectation.target, unit.unit)))));
      const definitions = SkillEvaluator.listSkillDefinitions();
      expect(definitions.some(definition => exactSqlUnitPaths(definition).length > 0)).toBe(true);
      expect(unboundExactUnitFailures(definitions, SkillEvaluator.exactScopeSupportCatalog(), bound)).toEqual([]);
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
