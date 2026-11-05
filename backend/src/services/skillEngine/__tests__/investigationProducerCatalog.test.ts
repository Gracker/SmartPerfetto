// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {investigationProducerCatalog} from '../investigationProducerCatalog';
import type {SkillDefinition} from '../types';
import type {InvestigationEvidenceDeclaration} from '../../evidence/investigationEvidenceLedger';

const metricId = 'fixture.task.duration';
const declaration: InvestigationEvidenceDeclaration = {window: {start: 'begin', end: 'end'},
  metrics: [{domain: 'fixture', metric_id: metricId, value: 'duration', unit: 'ns', status: 'status',
    coverage: 'covered', denominator: 'total'}]};
const atomic = (name = 'fixture'): SkillDefinition => ({name, version: '1', type: 'atomic',
  meta: {display_name: name, description: 'Fixture'}, sql: 'SELECT private_sql_body',
  investigation_evidence: declaration,
  inputs: [{name: 'start_ts', type: 'timestamp', required: true},
    {name: 'count', type: 'integer', required: true, default: 20},
    {name: 'selector', type: 'string', required: false}],
  prerequisites: {required_tables: ['fixture_table'], modules: ['fixture.module']}});

describe('registry-declared investigation producer catalog', () => {
  it('projects exact renamed metrics and complete input requirements without private SQL/default values', () => {
    const skill = atomic('renamed_producer');
    skill.inputs!.push({name: 'private_default', type: 'object', required: false, default: {secret: 'PRIVATE_DEFAULT'}});
    const result = investigationProducerCatalog([skill], metricId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({skillId: 'renamed_producer', stepId: 'root', sqlAt: 'sql',
      requiredWithoutDefault: ['start_ts'], guarded: false, availability: 'not_checked',
      inputs: [{name: 'start_ts', required: true, hasDefault: false},
        {name: 'count', required: true, hasDefault: true}, {name: 'selector', required: false},
        {name: 'private_default', hasDefault: true}],
      prerequisites: {requiredTables: ['fixture_table'], modules: ['fixture.module']},
      metrics: [{metricId, valueColumn: 'duration', statusColumn: 'status', unit: 'ns',
        coverageColumn: 'covered', denominatorColumn: 'total'}]});
    expect(JSON.stringify(result)).not.toMatch(/private_sql_body|PRIVATE_DEFAULT/);
    expect(result[0].inputs).toHaveLength(skill.inputs!.length);
    expect(investigationProducerCatalog([skill], 'fixture.task')).toEqual([]);
    expect(investigationProducerCatalog([skill], '')).toEqual([]);
  });

  it('deduplicates SQL variants by node while retaining different guarded nodes with the same step id', () => {
    const step = {id: 'same_id', type: 'atomic', sql: 'SELECT 1', investigation_evidence: declaration,
      exact_sql: {sql: 'SELECT 2', process_scope: {role: 'target', binding: 'native_upid'}}};
    const skill = {...atomic(), type: 'composite', sql: undefined, investigation_evidence: undefined,
      steps: [step, {id: 'branch', type: 'conditional', conditions: [{when: 'true', then: {...step, optional: true}}]}]} as SkillDefinition;
    const result = investigationProducerCatalog([skill], metricId);
    expect(result.map(card => [card.stepId, card.sqlAt, card.guarded, card.stepOptional])).toEqual([
      ['same_id', 'steps[0].sql', false, false], ['same_id', 'steps[1].conditions[0].then.sql', true, true],
    ]);
  });

  it('does not infer producers from aliases, metadata-only definitions, unexecuted steps or parent references', () => {
    const child = atomic('child');
    const root = {...atomic('root'), investigation_evidence: undefined,
      steps: [{id: 'ignored', type: 'atomic', sql: 'SELECT 1', investigation_evidence: declaration}]} as SkillDefinition;
    const parent = {...atomic('parent'), type: 'composite', sql: undefined, investigation_evidence: undefined,
      steps: [{id: 'child_call', skill: 'child'}]} as SkillDefinition;
    const metadata = {...atomic('metadata'), type: 'pipeline_definition'} as SkillDefinition;
    const alias = {...atomic('alias'), investigation_evidence: undefined, sql: `SELECT 1 AS "${metricId}"`};
    expect(investigationProducerCatalog([parent, root, metadata, alias, child], metricId).map(card => card.skillId))
      .toEqual(['child']);
  });

  it('rejects malformed declarations and producer field semantic conflicts through the shared validator', () => {
    const badWindow = {...atomic('bad_window'), investigation_evidence: {...declaration, window: {start: 'same', end: 'same'}}};
    const conflict = {...atomic('conflict'), investigation_evidence: {...declaration,
      metrics: [...declaration.metrics, {...declaration.metrics[0], metric_id: 'other.metric', unit: 'ms'}]}};
    expect(investigationProducerCatalog([badWindow, conflict], metricId)).toEqual([]);
  });

  it('uses the real producer inputs and actual process-gate selectors without claiming thread-scoped identity', () => {
    const skill = yaml.load(fs.readFileSync(path.resolve(__dirname,
      '../../../../skills/atomic/thread_system_summary_in_range.skill.yaml'), 'utf8')) as SkillDefinition;
    const [card] = investigationProducerCatalog([skill], 'system.thread.state.duration');
    expect(card).toMatchObject({skillId: skill.name, stepId: 'root', requiredWithoutDefault: ['start_ts', 'end_ts']});
    expect(card.inputs).toEqual(expect.arrayContaining([{name: 'utid', type: 'number', required: false, hasDefault: false}]));
    expect(card.processIdentitySelectors).toContain('upid');
    expect(card.processIdentitySelectors).not.toContain('utid');
    expect(card).not.toHaveProperty('params');
    expect(card.availability).toBe('not_checked');
  });

  it('derives each catalog from its supplied registry rather than retaining another run or workspace', () => {
    const first = atomic('first_workspace');
    const second = {...atomic('second_workspace'), investigation_evidence: undefined};
    expect(investigationProducerCatalog([first], metricId).map(card => card.skillId)).toEqual(['first_workspace']);
    expect(investigationProducerCatalog([second], metricId)).toEqual([]);
    expect(first.investigation_evidence).toBe(declaration);
  });
});
