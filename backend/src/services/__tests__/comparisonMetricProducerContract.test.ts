// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {describe, expect, it} from '@jest/globals';
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import type {AnalysisResultSnapshot, NormalizedMetricValue} from '../../types/multiTraceComparison';
import {buildCompletedAnalysisResultSnapshot} from '../analysisResultSnapshotPipeline';
import {buildComparisonMatrix} from '../comparisonMatrixService';
import {
  BIG_CORE_PCT_DEFINITION,
  producerContractFor,
} from '../comparisonMetricProducerContract';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

const D = BIG_CORE_PCT_DEFINITION;
const contract = producerContractFor('cpu.big_core_pct')!;
const skillsDir = path.join(process.cwd(), 'skills');

/** A main-thread row as the admitted producers emit it, overridable per case. */
const mainRow = (overrides: Record<string, unknown> = {}) => ({
  thread_type: 'MainThread', big_core_pct: 72.5, unknown_core_ms: 0, unknown_core_pct: 0,
  unknown_core_ns: 0, main_thread_count: 1, big_core_pct_definition: D, ...overrides,
});

function envelope(
  rows: Array<Record<string, unknown>>,
  meta: {type?: 'skill_result' | 'sql_result'; skillId?: string; stepId?: string; traceSide?: 'current' | 'reference'} = {},
): DataEnvelope {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const {type = 'skill_result', skillId = 'startup_detail', stepId = 'cpu_core_analysis', traceSide} = meta;
  return createDataEnvelope({columns, rows: rows.map(row => columns.map(column => row[column]))}, {
    type, source: type === 'sql_result' ? 'execute_sql' : `${skillId}:${stepId}`,
    ...(type === 'skill_result' ? {skillId, stepId} : {}),
    ...(traceSide ? {traceSide} : {}),
    title: 'cpu cores',
  });
}

/** An iterator envelope whose items carry the child step as a section of row objects. */
function iteratorEnvelope(skillId: string, stepId: string, sections: Array<Array<Record<string, unknown>> | undefined>) {
  const env = envelope([{startup_id: 1}], {skillId, stepId});
  (env.data as any).expandableData = sections.map((rows, index) => ({
    item: {startup_id: index + 1},
    result: {success: rows !== undefined, sections: rows ? {cpu_core_analysis: {title: 'cpu', data: rows}} : {}},
  }));
  return env;
}

function snapshotOf(envelopes: DataEnvelope[], id = 'run-1'): AnalysisResultSnapshot {
  return buildCompletedAnalysisResultSnapshot({
    tenantId: 'tenant-a', workspaceId: 'workspace-a', traceId: `trace-${id}`, sessionId: `session-${id}`,
    runId: id, query: 'startup', conclusion: 'done', dataEnvelopes: envelopes, privateContext: NO_PRIVATE_CONTEXT,
  })!;
}

const bigCore = (envelopes: DataEnvelope[]): NormalizedMetricValue | undefined =>
  snapshotOf(envelopes).metrics.find(metric => metric.key === 'cpu.big_core_pct');

describe('cpu.big_core_pct producer contract (static)', () => {
  let parsed: Map<string, any> | undefined;
  /** Every Skill by name, each file parsed once. */
  function skills(): Map<string, any> {
    if (parsed) return parsed;
    parsed = new Map();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '_template') walk(full); }
        else if (entry.name.endsWith('.skill.yaml')) {
          const text = fs.readFileSync(full, 'utf8');
          // A comment-only file (pipelines/_base) holds no Skill.
          if (!/^[^#\s]/m.test(text)) continue;
          const skill: any = yaml.load(text);
          if (typeof skill?.name === 'string') parsed!.set(skill.name, skill);
        }
      }
    };
    walk(skillsDir);
    return parsed;
  }
  const loadSkill = (skillId: string): any => {
    const skill = skills().get(skillId);
    if (!skill) throw new Error(`skill ${skillId} not found`);
    return skill;
  };
  const stepOf = (skill: any, id: string) => skill.steps.find((step: any) => step.id === id);

  const direct = contract.producers.filter(producer => !producer.section);
  const nested = contract.producers.filter(producer => producer.section);

  it.each(direct.map(producer => [`${producer.skillId}.${producer.stepId}`, producer] as const))(
    '%s emits the declared row, unrounded unknown time and its thread count',
    (_name, producer) => {
      const step = stepOf(loadSkill(producer.skillId), producer.stepId);
      expect(step?.type).toBe('atomic');
      const sql: string = step.sql;
      expect(sql).toContain(`'${D}'`);
      for (const field of [contract.valueField, contract.unknownTimeField, contract.threadCountField, contract.definitionField]) {
        expect(sql).toMatch(new RegExp(`\\bAS\\s+${field}\\b`, 'i'));
        // Display projection keeps only declared columns.
        expect(step.display.columns.map((column: any) => column.name)).toContain(field);
      }
      const unknownExpr = new RegExp(`([^\\n]*)\\bAS\\s+${contract.unknownTimeField}\\b`, 'i').exec(sql)![1];
      expect(unknownExpr).not.toMatch(/ROUND\s*\(/i);
      expect(unknownExpr).toMatch(/NOT IN \('prime', ?'big', ?'medium', ?'little'\)/);
    });

  it.each(nested.map(producer => [`${producer.skillId}.${producer.stepId}[].${producer.section}`, producer] as const))(
    '%s iterates an admitted direct producer',
    (_name, producer) => {
      const step = stepOf(loadSkill(producer.skillId), producer.stepId);
      expect(step?.type).toBe('iterator');
      expect(direct).toContainEqual({skillId: step.item_skill, stepId: producer.section});
    });

  it('has no declaration on a step outside the contract', () => {
    const declares = new RegExp(`\\bAS\\s+${contract.definitionField}\\b`, 'i');
    const declaring: string[] = [];
    for (const [skillId, skill] of skills()) {
      const visit = (steps: any[] | undefined) => {
        for (const step of steps ?? []) {
          if (typeof step.sql === 'string' && declares.test(step.sql)) declaring.push(`${skillId}.${step.id ?? 'root'}`);
          visit(step.steps);
        }
      };
      visit([skill]);
    }
    expect(declaring.sort()).toEqual(direct.map(producer => `${producer.skillId}.${producer.stepId}`).sort());
  });
});

describe('cpu.big_core_pct extraction', () => {
  it('admits a declared main-thread row with zero unknown time', () => {
    expect(bigCore([envelope([mainRow()])])).toMatchObject({
      value: 72.5, confidence: 0.75,
      source: {type: 'skill', skillId: 'startup_detail', stepId: 'cpu_core_analysis', metricDefinition: D},
    });
  });

  it('ignores raw SQL rows, whatever they declare', () => {
    const rawDeclared = envelope([mainRow({big_core_pct: 5})], {type: 'sql_result'});
    const rawWrongDefinition = envelope([{big_core_pct: 9, big_core_pct_definition: 'top_thread'}], {type: 'sql_result'});
    expect(bigCore([rawDeclared, rawWrongDefinition])).toBeUndefined();
    expect(bigCore([rawDeclared, rawWrongDefinition, envelope([mainRow()])])).toMatchObject({value: 72.5});
  });

  it('ignores a non-Skill envelope even under an admitted producer\'s ids', () => {
    for (const type of ['sql_result', 'ai_response'] as const) {
      const forged = envelope([mainRow({big_core_pct: 5})]);
      forged.meta.type = type;
      expect(bigCore([forged])).toBeUndefined();
      expect(bigCore([forged, envelope([mainRow()])])?.value).toBe(72.5);
    }
  });

  it('ignores producers outside the contract, including a nested skill step', () => {
    const topThread = envelope([{thread_name: 'RenderThread', big_core_pct: 3, unknown_core_pct: 0}],
      {skillId: 'scheduler_module', stepId: 'core_distribution'});
    const profiled = envelope([{thread_name: 'main', big_core_pct: 4, unknown_core_ms: 0}],
      {skillId: 'cpu_profiling', stepId: 'core_distribution'});
    // startup_detail's own nested Skill step: a bucket row under the parent ids.
    const placement = envelope([mainRow({big_core_pct: 6})], {skillId: 'startup_detail', stepId: 'cpu_placement'});
    expect(bigCore([topThread, profiled, placement])).toBeUndefined();
    expect(bigCore([topThread, profiled, placement, envelope([mainRow()])])?.value).toBe(72.5);
  });

  it('withholds the rounding counterexample instead of reading it as zero unknown time', () => {
    // 0.010 ms running, 0.004 ms on an unclassified core: ms rounds to 0.00.
    const metric = bigCore([envelope([mainRow({big_core_pct: 60, unknown_core_ms: 0, unknown_core_ns: 4000})])]);
    expect(metric).toMatchObject({value: null, confidence: 0, missingReason: 'producer_contract:unknown_core_time'});
    expect(metric?.source).not.toHaveProperty('metricDefinition');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['another definition', {big_core_pct_definition: 'core_tier_group:prime+big+medium@2'}, 'definition_mismatch'],
    ['no definition', {big_core_pct_definition: undefined}, 'definition_mismatch'],
    ['two merged main threads', {main_thread_count: 2}, 'ambiguous_population'],
    ['a formatted NULL unknown time', {unknown_core_ns: '-'}, 'unknown_core_time_unverified'],
    ['unknown time as a string', {unknown_core_ns: '0'}, 'unknown_core_time_unverified'],
    ['a thread count as a string', {main_thread_count: '1'}, 'ambiguous_population'],
    ['no unknown time column', {unknown_core_ns: undefined}, 'unknown_core_time_unverified'],
    ['a formatted NULL share', {big_core_pct: '-'}, 'value_unavailable'],
  ])('withholds a row with %s', (_name, overrides, reason) => {
    expect(bigCore([envelope([mainRow(overrides)])])?.missingReason).toBe(`producer_contract:${reason}`);
  });

  it('withholds a step that returned one row per process', () => {
    const rows = [mainRow(), mainRow({big_core_pct: 10})];
    expect(bigCore([envelope(rows, {skillId: 'click_response_detail'})])?.missingReason)
      .toBe('producer_contract:ambiguous_population');
  });

  it('lets the first candidate decide: a refused one is not replaced by a later envelope', () => {
    const refused = envelope([mainRow({unknown_core_ns: 1})]);
    const later = envelope([mainRow({big_core_pct: 90})], {skillId: 'click_response_detail'});
    expect(bigCore([refused, later])).toMatchObject({value: null, missingReason: 'producer_contract:unknown_core_time',
      source: {skillId: 'startup_detail'}});
  });

  it('skips an admitted step that returned no rows', () => {
    expect(bigCore([envelope([]), envelope([mainRow({big_core_pct: 40})], {skillId: 'click_response_detail'})]))
      .toMatchObject({value: 40, source: {skillId: 'click_response_detail'}});
  });

  it.each<[string, (env: DataEnvelope) => void]>([
    ['meta', env => { env.meta.traceSide = 'reference'; }],
    ['the envelope', env => { (env as any).traceSide = 'reference'; }],
    ['trace provenance', env => { (env as any).traceProvenance = {traceSide: 'reference'}; }],
  ])('ignores a reference-trace envelope marked on %s', (_name, mark) => {
    const reference = envelope([mainRow({big_core_pct: 11})]);
    mark(reference);
    expect(bigCore([reference])).toBeUndefined();
    expect(bigCore([reference, envelope([mainRow()])])?.value).toBe(72.5);
  });

  it('reads an iterator item section and records which item it was', () => {
    const env = iteratorEnvelope('startup_analysis', 'analyze_startups', [undefined, [mainRow({big_core_pct: 33})]]);
    expect(bigCore([env])).toMatchObject({
      value: 33,
      source: {skillId: 'startup_analysis', stepId: 'analyze_startups', section: 'cpu_core_analysis', itemIndex: 1, metricDefinition: D},
    });
  });

  it('does not fall through to a later iterator item after a refusal', () => {
    const env = iteratorEnvelope('click_response_analysis', 'analyze_slow_events',
      [[mainRow({unknown_core_ns: 5})], [mainRow({big_core_pct: 90})]]);
    expect(bigCore([env])).toMatchObject({value: null, missingReason: 'producer_contract:unknown_core_time',
      source: {section: 'cpu_core_analysis', itemIndex: 0}});
  });

  it('does not read sections of an iterator outside the contract', () => {
    expect(bigCore([iteratorEnvelope('scrolling_analysis', 'analyze_frames', [[mainRow()]])])).toBeUndefined();
  });

  it('marks a snapshot whose only metric was withheld as partial', () => {
    const snapshot = snapshotOf([envelope([mainRow({unknown_core_ns: 7})])]);
    expect(snapshot.status).toBe('partial');
    expect(snapshot.summary.partialReasons).toContain('No normalized comparison metrics extracted yet');
  });
});

describe('cpu.big_core_pct comparison', () => {
  const withMetric = (id: string, metric: Partial<NormalizedMetricValue> & {source: NormalizedMetricValue['source']}): AnalysisResultSnapshot => {
    const base = snapshotOf([], id);
    return {...base, id, metrics: [{key: 'cpu.big_core_pct', label: 'Big core residency', group: 'cpu',
      value: 50, unit: '%', confidence: 0.75, ...metric}]};
  };
  const current = (id: string, value: number) => withMetric(id, {value,
    source: {type: 'skill', skillId: 'startup_detail', stepId: 'cpu_core_analysis', metricDefinition: D}});
  const row = (snapshots: AnalysisResultSnapshot[]) => {
    const matrix = buildComparisonMatrix(snapshots, {metricKeys: ['cpu.big_core_pct']});
    return {matrix, delta: matrix.rows[0].deltas[0]};
  };

  it('compares two current values, across admitted producers', () => {
    const iterated = withMetric('b', {value: 70, source: {type: 'skill', skillId: 'click_response_analysis',
      stepId: 'analyze_slow_events', section: 'cpu_core_analysis', itemIndex: 0, metricDefinition: D}});
    const {matrix, delta} = row([current('a', 50), iterated]);
    expect(delta).toMatchObject({deltaValue: 20});
    expect(matrix.warnings).toEqual([]);
  });

  it.each<[string, NormalizedMetricValue['source'], string]>([
    ['a historical value from an admitted producer', {type: 'skill', skillId: 'startup_detail', stepId: 'cpu_core_analysis'},
      'legacy_admitted_producer'],
    ["cpu_profiling's earlier declaration", {type: 'skill', skillId: 'cpu_profiling', stepId: 'core_distribution',
      metricDefinition: 'core_tier_group:prime+big+medium@2'}, 'outside_contract'],
    ['a forged declaration outside the contract', {type: 'skill', skillId: 'scheduler_module', stepId: 'core_distribution',
      metricDefinition: D}, 'outside_contract'],
    ['raw SQL declaring the definition', {type: 'sql', metricDefinition: D}, 'non_skill_source'],
  ])('refuses a delta against %s', (_name, source, sourceClass) => {
    const {matrix, delta} = row([current('a', 50), withMetric('b', {value: 10, source})]);
    expect(delta).toMatchObject({deltaValue: null, assessment: 'unknown'});
    expect(matrix.warnings).toContain(`Metric cpu.big_core_pct is comparable only under ${D} from its admitted producers; ` +
      `a is current and b is ${sourceClass}; delta not computed`);
  });

  it('never compares two historical values, even from the same producer', () => {
    const legacy = (id: string, value: number) => withMetric(id, {value,
      source: {type: 'skill', skillId: 'startup_detail', stepId: 'cpu_core_analysis'}});
    expect(row([legacy('a', 0), legacy('b', 0)]).delta.deltaValue).toBeNull();
    const raw = (id: string) => withMetric(id, {source: {type: 'sql'}});
    expect(row([raw('a'), raw('b')]).delta.deltaValue).toBeNull();
  });

  it('reports a withheld value as missing with its contract reason', () => {
    const withheld = withMetric('b', {value: null, confidence: 0, missingReason: 'producer_contract:unknown_core_time',
      source: {type: 'skill', skillId: 'startup_detail', stepId: 'cpu_core_analysis'}});
    const {matrix, delta} = row([current('a', 50), withheld]);
    expect(matrix.rows[0].missingSnapshotIds).toEqual(['b']);
    expect(matrix.missingMatrix.b).toEqual({'cpu.big_core_pct': 'producer_contract:unknown_core_time'});
    expect(delta.deltaValue).toBeNull();
    expect(matrix.warnings.filter(warning => warning.includes('comparable only'))).toEqual([]);
  });

  it('keeps declaration equality for metrics without a contract', () => {
    const fps = (id: string, value: number, metricDefinition?: string) => ({...snapshotOf([], id), id,
      metrics: [{key: 'scrolling.avg_fps' as const, label: 'fps', group: 'scrolling', value, confidence: 0.75,
        source: {type: 'skill' as const, ...(metricDefinition ? {metricDefinition} : {})}}]});
    const matrixOf = (a: AnalysisResultSnapshot, b: AnalysisResultSnapshot) =>
      buildComparisonMatrix([a, b], {metricKeys: ['scrolling.avg_fps']}).rows[0].deltas[0].deltaValue;
    expect(matrixOf(fps('a', 50), fps('b', 60))).toBe(10);
    expect(matrixOf(fps('a', 50, 'x@1'), fps('b', 60))).toBeNull();
  });
});
