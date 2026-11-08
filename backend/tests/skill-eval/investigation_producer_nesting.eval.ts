// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Producer evidence reached through a Skill reference, on real corpus traces:
 * the investigation ledger records a child Skill's declared metric when a
 * composite runs it as a skill-ref step, and a fired diagnostic rule reports
 * its structured fact (rule id, bound producer values with the source
 * column's unit, and the locator of the result they came from).
 *
 * Each run goes through the shared Skill-run core with an ArtifactStore and a
 * completed product call observation, as invoke_skill and scene entry
 * evidence run Skills. Composite fixtures reuse the production step objects
 * (scrolling_analysis system_runnable_cpu_occupancy, anr_analysis
 * first_anr_binder_pool_saturation and anr_diagnosis) unchanged, behind small
 * window steps that stand in for the parent's own ANR/window detection.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {afterAll, beforeAll, expect, it} from '@jest/globals';

import {ArtifactStore} from '../../src/agentv3/artifactStore';
import {executePreparedSkillRun, prepareSkillRun, type SkillRunDeps} from '../../src/agentv3/skillRunCore';
import {runWithinRuntimeToolInvocation} from '../../src/agentRuntime/runtimeToolInvocationContext';
import type {SkillRegistryView} from '../../src/services/skillEngine/skillAnalysisAdapter';
import type {SkillDefinition, SkillStep} from '../../src/services/skillEngine/types';
import {createSkillEvaluator, describeWithTrace, getTestTracePath, type SkillEvaluator} from './runner';

const RUN = 'run-nesting';
const FIXTURE = 'com.smartperfetto.fixture';

function productionStep(file: string, stepId: string): SkillStep {
  const definition = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8')) as SkillDefinition;
  const step = definition.steps!.find(candidate => candidate.id === stepId);
  if (!step) throw new Error(`${file} has no step ${stepId}`);
  return step;
}

async function fixtureWindow(evaluator: SkillEvaluator): Promise<{start: string; end: string}> {
  const result = await evaluator.executeSQL(`
    SELECT printf('%d', MIN(s.ts)) AS start_ts, printf('%d', MAX(s.ts + MAX(s.dur, 0))) AS end_ts
    FROM slice s JOIN thread_track tt ON tt.id = s.track_id JOIN thread t USING (utid) JOIN process p USING (upid)
    WHERE p.name = '${FIXTURE}'`);
  expect(result.error).toBeUndefined();
  return {start: String(result.rows[0][0]), end: String(result.rows[0][1])};
}

/** Run a Skill through the shared run core as one observed product call; returns its outcome and ledger. */
async function runSkill(evaluator: SkillEvaluator, skillId: string, params: Record<string, unknown>,
  extra: SkillDefinition[] = []) {
  const executor = evaluator['executor']!;
  for (const definition of extra) executor.registerSkill(definition);
  const lookup = (id: string) => extra.find(definition => definition.name === id) ?? executor['skillRegistry'].get(id);
  const store = new ArtifactStore();
  const traceId = evaluator['traceId']!;
  const deps: SkillRunDeps = {traceId, traceProcessorService: evaluator['traceProcessor'], skillExecutor: executor,
    artifactStore: store, outputLanguage: 'en'};
  const preparation = await prepareSkillRun(deps, {skillId, params,
    registry: {getSkill: lookup} as unknown as SkillRegistryView});
  if (preparation.status !== 'ready') throw new Error(`${skillId} refused: ${JSON.stringify(preparation.refusal)}`);
  const toolCallId = `nesting:${skillId}`;
  const event = {toolCallId, toolName: 'invoke_skill', params: {}, extra: {}};
  store.observeInvestigationTool({...event, phase: 'started'}, RUN);
  const outcome = await runWithinRuntimeToolInvocation({toolCallId, runId: RUN}, () =>
    executePreparedSkillRun(deps, preparation.prepared, {producer: {sourceToolCallId: toolCallId, paramsHash: skillId}}));
  store.observeInvestigationTool({...event, phase: 'completed', result: {content: []}}, RUN);
  if (outcome.status !== 'committed') throw new Error(`${skillId} commit refused`);
  const ledger = store.createEvidenceReadView({ownerKey: 'owner', currentRunId: RUN,
    allowedTraces: [{traceId, traceSide: 'current'}]}).investigationEvidence!();
  return {outcome, store, ledger, records: (metricId: string) => ledger.records.filter(record => record.metricId === metricId)};
}

describeWithTrace('producer metrics through skill-ref steps (binder pool saturation)', 'binder-pool-saturation', () => {
  let evaluator: SkillEvaluator;
  let window: {start: string; end: string};

  beforeAll(async () => {
    evaluator = createSkillEvaluator('anr_analysis');
    await evaluator.loadTrace(getTestTracePath('binder-pool-saturation'));
    window = await fixtureWindow(evaluator);
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('records the pool saturation of anr_main_thread_blocking\'s skill-ref step, and no fabricated binder wait', async () => {
    await evaluator.selectSkill('anr_main_thread_blocking');
    const run = await runSkill(evaluator, 'anr_main_thread_blocking',
      {process_name: FIXTURE, start_ts: window.start, end_ts: window.end});
    const pool = run.records('system.binder.pool.saturated_duration');
    const saturated = pool.find(record => record.role === 'sync_binder_server');
    expect(saturated).toMatchObject({skillId: 'binder_pool_saturation_in_range', stepId: 'pool_saturation',
      status: 'observed', unit: 'ns', origin: 'current_run'});
    expect(Number(saturated!.value)).toBeGreaterThan(0);
    // The record points at the parent's skill-ref result the model reads.
    const poolArtifact = run.outcome.result.displayResults.findIndex(display => display.stepId === 'binder_pool_saturation');
    expect(saturated!.artifactId).toBe(run.outcome.artifactIdsByDisplayIndex[poolArtifact]);
    // The fixture's main-thread sync call is no android_binder_txns row, so binder_blocking returns
    // none: the ledger reports that capture as empty, never an observed or a zero wait.
    expect(run.outcome.result.displayResults.find(display => display.stepId === 'binder_blocking')?.data.rows).toEqual([]);
    expect(run.records('android.main_thread.binder_wait.duration')).toEqual([]);
    expect(run.ledger.issues).toContain('capture_empty');
  }, 120000);

  it('records anr_analysis first_anr_binder_pool_saturation and reports anr.binder_pool_saturated as a fact', async () => {
    await evaluator.selectSkill('anr_analysis');
    // Stand-ins for anr_analysis' own detection and ANR context, over the fixture window.
    const parent = {name: 'anr_pool_nesting_fixture', version: '1', type: 'composite',
      meta: {display_name: 'ANR pool nesting fixture', description: 'Fixture'},
      steps: [
        {id: 'fixture_detection', type: 'atomic', sql: 'SELECT 1 AS total_anr_count', save_as: 'detection'},
        {id: 'fixture_anr_context', type: 'atomic', save_as: 'anr_ctx',
          sql: `SELECT '${window.start}' AS window_start_ts, '${window.end}' AS anr_ts, '${FIXTURE}' AS process_name`},
        productionStep('composite/anr_analysis.skill.yaml', 'first_anr_binder_pool_saturation'),
        productionStep('composite/anr_analysis.skill.yaml', 'anr_diagnosis'),
      ],
    } as unknown as SkillDefinition;
    const run = await runSkill(evaluator, parent.name, {}, [parent]);
    const pool = run.records('system.binder.pool.saturated_duration');
    const saturated = pool.find(record => record.role === 'sync_binder_server');
    expect(saturated).toMatchObject({skillId: 'binder_pool_saturation_in_range', stepId: 'pool_saturation', status: 'observed'});

    const rule = run.outcome.facts?.rules?.find(candidate => candidate.ruleId === 'anr.binder_pool_saturated');
    const displayIndex = run.outcome.result.displayResults.findIndex(display => display.stepId === 'first_anr_binder_pool_saturation');
    const locator = {sourceStepId: 'first_anr_binder_pool_saturation', artifactId: run.outcome.artifactIdsByDisplayIndex[displayIndex],
      evidenceRefId: run.outcome.evidenceRefIdsByDisplayIndex[displayIndex]};
    expect(run.outcome.facts).toMatchObject({skillId: parent.name, diagnosticsArtifactId: run.outcome.diagnosticsArtifactId});
    expect(rule).toEqual({ruleId: 'anr.binder_pool_saturated', bindings: [
      {name: 'process_name', value: 'com.smartperfetto.binderserver', ...locator},
      {name: 'target_role', value: 'sync_binder_server', ...locator},
      {name: 'pool_size', value: 3, unit: 'count', ...locator},
      {name: 'peak_busy_threads', value: 3, unit: 'count', ...locator},
      {name: 'saturated_ns', value: saturated!.value, unit: 'ns', ...locator},
    ]});
    expect(JSON.stringify(run.outcome.facts)).not.toMatch(/diagnosis|severity|suggestion|confidence/);
  }, 120000);
});

describeWithTrace('producer metrics through skill-ref steps (scheduler CPU contention)', 'scheduler-cpu-contention', () => {
  let evaluator: SkillEvaluator;
  let window: {start: string; end: string};

  beforeAll(async () => {
    evaluator = createSkillEvaluator('scrolling_analysis');
    await evaluator.loadTrace(getTestTracePath('scheduler-cpu-contention'));
    window = await fixtureWindow(evaluator);
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('records scrolling_analysis system_runnable_cpu_occupancy in the ledger', async () => {
    // A stand-in for scrolling_analysis' system_context_window over the fixture window.
    const parent = {name: 'runnable_occupancy_nesting_fixture', version: '1', type: 'composite',
      meta: {display_name: 'Runnable occupancy nesting fixture', description: 'Fixture'},
      inputs: [{name: 'package', type: 'string', required: false}],
      steps: [
        {id: 'fixture_window', type: 'atomic', save_as: 'system_context_window',
          sql: `SELECT '${window.start}' AS start_ts, '${window.end}' AS end_ts`},
        productionStep('composite/scrolling_analysis.skill.yaml', 'system_runnable_cpu_occupancy'),
      ],
    } as unknown as SkillDefinition;
    const run = await runSkill(evaluator, parent.name, {package: FIXTURE}, [parent]);
    const occupancy = run.records('system.thread.runnable.cpu_occupancy');
    expect(occupancy.length).toBeGreaterThan(0);
    expect(occupancy.every(record => record.skillId === 'runnable_cpu_occupancy_in_range' && record.stepId === 'root'
      && record.unit === 'ns' && record.origin === 'current_run')).toBe(true);
    expect(occupancy.some(record => record.status === 'observed' && Number(record.value) > 0)).toBe(true);
    const displayIndex = run.outcome.result.displayResults.findIndex(display => display.stepId === 'system_runnable_cpu_occupancy');
    expect(new Set(occupancy.map(record => record.artifactId))).toEqual(new Set([run.outcome.artifactIdsByDisplayIndex[displayIndex]]));
  }, 120000);
});

describeWithTrace('anr_analysis producer evidence and facts (input-dispatch ANR)', 'binder-io-blocking', () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('anr_analysis');
    await evaluator.loadTrace(getTestTracePath('binder-io-blocking'));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('records the ANR timer delay and the first window pool, and reports fired rules as facts without conclusions', async () => {
    const run = await runSkill(evaluator, 'anr_analysis', {});
    const timer = run.records('android.anr.timer_delay');
    expect(timer.length).toBeGreaterThan(0);
    // Both producers: the ANR event list, and anr_context_in_range run as the get_anr_context skill-ref step.
    expect(new Set(timer.map(record => `${record.skillId}.${record.stepId}`)))
      .toEqual(new Set(['anr_analysis.get_anr_events', 'anr_context_in_range.root']));
    expect(timer.every(record => record.unit === 'ns' && record.domain === 'critical_path')).toBe(true);
    const pool = run.records('system.binder.pool.saturated_duration');
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every(record => record.skillId === 'binder_pool_saturation_in_range' && record.stepId === 'pool_saturation')).toBe(true);

    expect(run.outcome.facts).toMatchObject({skillId: 'anr_analysis', diagnosticsArtifactId: run.outcome.diagnosticsArtifactId});
    expect(run.outcome.facts?.rules?.map(rule => rule.ruleId)).toEqual(expect.arrayContaining(['anr.trigger.input_dispatching_timeout']));
    expect(JSON.stringify(run.outcome.facts)).not.toMatch(/diagnosis|severity|suggestion|confidence|触发类型分流/);
  }, 180000);
});
