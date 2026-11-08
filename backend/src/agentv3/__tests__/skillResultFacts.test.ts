// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import type {SkillDefinition} from '../../services/skillEngine/types';

const WIDE_COLUMNS = Array.from({length: 26}, (_, index) => `c${index}`);
const fixtureSkill = {
  name: 'facts_fixture', version: '1', type: 'composite',
  meta: {display_name: 'Facts fixture', description: 'Producer notes and rule facts'},
  steps: [
    {id: 'pools', type: 'atomic', sql: 'SELECT pools_fixture', save_as: 'pools',
      investigation_evidence: {window: {start: 'start_ts', end: 'end_ts'}, identity: {upid: 'upid'},
        metrics: [{domain: 'dependency_chain', metric_id: 'fixture.pool.saturated', value: 'saturated_ns', unit: 'ns',
          status: 'status', aggregation: 'window_total'}]},
      display: {level: 'key', layer: 'overview', title: 'Pools', row_semantics: 'per_entity', columns: [
        {name: 'start_ts', type: 'timestamp', unit: 'ns', hidden: true},
        {name: 'end_ts', type: 'timestamp', unit: 'ns', hidden: true},
        {name: 'upid', type: 'number'},
        {name: 'process_name', type: 'string'},
        {name: 'saturated_ns', type: 'duration', unit: 'ns', semantics: 'Time every observed pool thread was busy at once.'},
        {name: 'timer_delay', type: 'duration', unit: 'ns', semantics_ref: 'android_anrs.timer_delay'},
        {name: 'status', type: 'string'},
      ]}},
    {id: 'wide', type: 'atomic', sql: 'SELECT wide_fixture',
      display: {level: 'detail', layer: 'list', title: 'Wide',
        columns: WIDE_COLUMNS.map(name => ({name, type: 'number', unit: 'count', semantics: `Fixture column ${name}.`}))}},
    {id: 'verdict', type: 'diagnostic', inputs: ['pools'], rules: [
      {id: 'fixture.pool_saturated', condition: "pools.data?.find(r => r.status === 'observed')",
        diagnosis: 'PRODUCT_CONCLUSION_TEXT', severity: 'critical', confidence: 'high', suggestions: ['PRODUCT_SUGGESTION'],
        binds: [
          {name: 'saturated_ns', field: "pools.data.find(r => r.status === 'observed').saturated_ns"},
          {name: 'process_name', field: 'pools.data[0].process_name'},
        ]},
      {condition: 'true', diagnosis: 'RULE_WITHOUT_ID', confidence: 'low'},
    ]},
  ],
} as unknown as SkillDefinition;

const childColumns = [{name: 'occupied_ns', type: 'duration', unit: 'ns', semantics: 'Child producer meaning.'}];
const rootChild = {name: 'root_child', version: '1', type: 'atomic', meta: {display_name: 'Root child', description: 'Atomic root'},
  sql: 'SELECT child_fixture', output: {display: {level: 'key', layer: 'list', row_semantics: 'per_entity', columns: childColumns}}} as unknown as SkillDefinition;
const stepChild = {name: 'step_child', version: '1', type: 'composite', meta: {display_name: 'Step child', description: 'Child steps'},
  steps: [{id: 'child_rows', type: 'atomic', sql: 'SELECT child_fixture',
    display: {level: 'key', layer: 'list', row_semantics: 'per_event', columns: childColumns}}]} as unknown as SkillDefinition;
const refParent = {name: 'ref_parent', version: '1', type: 'composite', meta: {display_name: 'Ref parent', description: 'Skill references'},
  steps: [{id: 'via_root', skill: 'root_child', display: {level: 'key', layer: 'list'}},
    {id: 'via_step', skill: 'step_child', display: {level: 'key', layer: 'list'}}]} as unknown as SkillDefinition;
const fixtureSkills = [fixtureSkill, rootChild, stepChild, refParent];

jest.mock('../../services/skillEngine/skillLoader', () => {
  const registry = {
    getSkill: (id: string) => fixtureSkills.find(skill => skill.name === id),
    getSkillOrigin: () => ({origin: 'external_pack'}),
    hasVendorOverrides: () => false,
    getVendorOverride: () => undefined,
    getAllSkills: () => fixtureSkills,
    getFragmentCache: () => new Map(),
    isInitialized: () => true,
  };
  return {skillRegistry: registry, ensureSkillRegistryInitialized: async () => undefined};
});

import {ArtifactStore} from '../artifactStore';
import {createClaudeMcpServer} from '../claudeMcpServer';
import {createSkillResultNoteMemory, skillResultFactsEnabled, SKILL_RESULT_FACTS_ENV} from '../skillResultSemanticNotes';
import {skillResultFacts, SKILL_RESULT_FACTS_MAX_BYTES} from '../../services/evidence/investigationFacts';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import {decodeRuntimeToolResult} from '../../agentRuntime/runtimeToolResult';

const TRACE = 'trace-facts';
const POOL_COLUMNS = ['start_ts', 'end_ts', 'upid', 'process_name', 'saturated_ns', 'timer_delay', 'status'];
const POOL_ROWS = [[100, 900, 7, 'com.example.server', 420, 50000000, 'observed']];
const tp = () => ({query: async (_trace: string, sql: string) => sql.includes('child_fixture')
  ? {columns: ['occupied_ns'], rows: [[7]], durationMs: 1}
  : sql.includes('pools_fixture')
  ? {columns: POOL_COLUMNS, rows: POOL_ROWS, durationMs: 1}
  : {columns: WIDE_COLUMNS, rows: [WIDE_COLUMNS.map((_, index) => index)], durationMs: 1}}) as any;

function server(options: {facts?: boolean; store?: ArtifactStore | null; updates?: unknown[]} = {}) {
  const on = options.facts !== false;
  const executor = new SkillExecutor(tp(), undefined, undefined, {diagnosticFacts: on});
  for (const skill of fixtureSkills) executor.registerSkill(skill);
  const store = options.store === null ? undefined : options.store ?? new ArtifactStore();
  const skillResultNotes = on ? createSkillResultNoteMemory({}) : undefined;
  const mcp = createClaudeMcpServer({traceId: TRACE, traceProcessorService: tp(), skillExecutor: executor,
    ...(store ? {artifactStore: store} : {}), outputLanguage: 'en', runId: 'run-facts',
    ...(skillResultNotes ? {skillResultNotes} : {}),
    ...(options.updates ? {emitUpdate: (update: unknown) => options.updates!.push(update)} : {}),
  } as any);
  const tool = (name: string) => mcp.toolDefinitions.find(definition => definition.name === name)!;
  return {store, skillResultNotes, call: async (name: string, input: Record<string, unknown>) => {
    const result = await tool(name).shared.handler(input, {toolCallId: `${name}-call`}) as any;
    return {result, body: decodeRuntimeToolResult(result).body as any};
  }};
}

/** The model reads content text; structuredContent is the same payload, before decorations. */
function expectTextMatchesStructured(result: any): void {
  expect(result.content[0].text.startsWith(JSON.stringify(result.structuredContent))).toBe(true);
}

describe('Skill result producer notes and rule facts', () => {
  it('returns notes once per run and facts with producer values only, consistent in text and structuredContent', async () => {
    const updates: unknown[] = [];
    const {call} = server({updates});
    const first = await call('invoke_skill', {skillId: 'facts_fixture'});
    expectTextMatchesStructured(first.result);
    expect(first.body.success).toBe(true);
    const [poolArtifact, wideArtifact] = first.body.artifacts;
    const poolNote = first.body.resultNotes.steps.find((step: any) => step.stepId === 'pools');
    expect(poolNote).toEqual({stepId: 'pools', artifactId: poolArtifact.id, rows: 'per_entity', columns: [
      {column: 'saturated_ns', semantics: 'Time every observed pool thread was busy at once.',
        metricId: 'fixture.pool.saturated', aggregation: 'window_total'},
      {column: 'timer_delay', semantics: expect.stringContaining('Delay from the ANR timer expiry')},
    ]});
    // Two pool notes, then the per-result bound leaves the rest of the wide step for later.
    const wideNote = first.body.resultNotes.steps.find((step: any) => step.stepId === 'wide');
    expect(wideNote.columns).toHaveLength(22);
    expect(first.body.resultNotes.omittedColumns).toBe(4);

    expect(first.body.facts).toEqual({skillId: 'facts_fixture', diagnosticsArtifactId: first.body.diagnosticsArtifactId,
      rules: [{ruleId: 'fixture.pool_saturated', bindings: [
        {name: 'saturated_ns', value: 420, unit: 'ns', sourceStepId: 'pools', artifactId: poolArtifact.id,
          evidenceRefId: poolArtifact.evidenceRefId},
        {name: 'process_name', value: 'com.example.server', sourceStepId: 'pools', artifactId: poolArtifact.id,
          evidenceRefId: poolArtifact.evidenceRefId},
      ]}]});
    const facts = JSON.stringify(first.body.facts);
    expect(facts).not.toMatch(/PRODUCT_CONCLUSION_TEXT|PRODUCT_SUGGESTION|RULE_WITHOUT_ID|critical|severity|confidence/);
    // Model-only notes never reach a DataEnvelope.
    expect(JSON.stringify(updates)).not.toMatch(/semantics|row_semantics/);

    // A repeated call says nothing already said; the fetch of the wide table returns what the bound left out.
    const second = await call('invoke_skill', {skillId: 'facts_fixture'});
    expectTextMatchesStructured(second.result);
    expect(second.body.resultNotes.steps.flatMap((step: any) => step.columns).map((column: any) => column.column))
      .toEqual(WIDE_COLUMNS.slice(22));
    const fetched = await call('fetch_artifact', {artifactId: wideArtifact.id, detail: 'rows'});
    expectTextMatchesStructured(fetched.result);
    expect(fetched.body.resultNotes).toBeUndefined();
    const third = server();
    const firstOfRun = await third.call('invoke_skill', {skillId: 'facts_fixture'});
    const fetchedWide = await third.call('fetch_artifact', {artifactId: firstOfRun.body.artifacts[1].id, detail: 'summary'});
    expect(fetchedWide.body.resultNotes.steps[0].columns.map((column: any) => column.column)).toEqual(WIDE_COLUMNS.slice(22));

  });

  it('resolves a Skill reference to the child step that produced its rows, at a root or a named step', async () => {
    const {call} = server();
    const {body} = await call('invoke_skill', {skillId: 'ref_parent'});
    expect(body.resultNotes.steps).toEqual([
      {stepId: 'via_root', artifactId: body.artifacts[0].id, rows: 'per_entity',
        columns: [{column: 'occupied_ns', semantics: 'Child producer meaning.'}]},
      {stepId: 'via_step', artifactId: body.artifacts[1].id, rows: 'per_event',
        columns: [{column: 'occupied_ns', semantics: 'Child producer meaning.'}]},
    ]);
  });

  it('carries facts on the non-artifact path, with unavailable locators', async () => {
    const {call} = server({store: null});
    const {result, body} = await call('invoke_skill', {skillId: 'facts_fixture'});
    expectTextMatchesStructured(result);
    expect(body.artifacts).toBeUndefined();
    expect(body.facts.rules[0].bindings.map((binding: any) => binding.evidence)).toEqual(['unavailable', 'unavailable']);
    expect(body.diagnostics.find((diagnostic: any) => diagnostic.diagnosis === 'PRODUCT_CONCLUSION_TEXT').ruleId)
      .toBe('fixture.pool_saturated');
  });

  it('sends one overlay entry once across Skill results and raw SQL notes', () => {
    const memory = createSkillResultNoteMemory({})!;
    const display = {columns: [{name: 'timer_delay', type: 'duration' as const, unit: 'ns', semantics_ref: 'android_anrs.timer_delay'}]};
    const target = (skillId: string) => ({stepId: 'step', columns: ['timer_delay'], producer: {skillId, stepId: 'step', display}});
    const first = memory.notesFor([target('skill_a')]);
    expect(first?.steps[0].columns[0].semantics).toContain('Delay from the ANR timer expiry');
    // The same entry from another producer has nothing left to say, and a metric column keeps only its metric.
    expect(memory.notesFor([target('skill_b')])).toBeUndefined();
    const withMetric = {...target('skill_c').producer, investigationEvidence: {window: {start: 'a', end: 'b'},
      metrics: [{domain: 'd', metric_id: 'fixture.delay', value: 'timer_delay', status: 's'}]}};
    expect(memory.notesFor([{stepId: 'step', columns: ['timer_delay'], producer: withMetric}])?.steps[0].columns)
      .toEqual([{column: 'timer_delay', metricId: 'fixture.delay'}]);
    expect(memory.emittedKeys.has('android_anrs.timer_delay')).toBe(true);
    // A dropped draft says nothing; its notes stay eligible.
    const fresh = createSkillResultNoteMemory({})!;
    expect(fresh.draft([target('skill_a')]).notes).toBeDefined();
    expect(fresh.emittedKeys.has('android_anrs.timer_delay')).toBe(false);
    expect(fresh.notesFor([target('skill_a')])?.steps[0].columns).toHaveLength(1);
  });

  it('caps facts by bytes and counts the rules left out', () => {
    const diagnostics = Array.from({length: 40}, (_, index) => ({id: `d_${index}`, ruleId: `fixture.rule_${index}`,
      bindings: [{name: 'long_binding_name', value: 'v'.repeat(40), sourceStepId: 'step', artifactId: 'art-1', evidenceRefId: 'e'.repeat(60)}],
      diagnosis: 'x', confidence: 0.5, severity: 'info' as const, source: 'rule' as const}));
    const facts = skillResultFacts('fixture', diagnostics, 'art-9')!;
    expect(Buffer.byteLength(JSON.stringify(facts), 'utf8')).toBeLessThanOrEqual(SKILL_RESULT_FACTS_MAX_BYTES);
    expect(facts.rules!.length).toBeGreaterThan(0);
    expect(facts.rules!.length + facts.omittedRuleCount!).toBe(40);
    expect(skillResultFacts('fixture', [{...diagnostics[0], ruleId: undefined}])).toBeUndefined();
  });

  it('withholds the bound values, keeping the rule and locators, when the request forbids rows', async () => {
    const executor = new SkillExecutor(tp(), undefined, undefined, {diagnosticFacts: true});
    executor.registerSkill(fixtureSkill);
    const mcp = createClaudeMcpServer({traceId: TRACE, traceProcessorService: tp(), skillExecutor: executor,
      artifactStore: new ArtifactStore(), outputLanguage: 'en', runId: 'run-facts', userQuery: 'do not fetch raw rows',
      skillResultNotes: createSkillResultNoteMemory({})} as any);
    const invoke = mcp.toolDefinitions.find(definition => definition.name === 'invoke_skill')!;
    const body = decodeRuntimeToolResult(await invoke.shared.handler({skillId: 'facts_fixture'}, {toolCallId: 'c'}) as any).body as any;
    expect(body.artifacts[0].preview).toBeUndefined();
    expect(body.facts.rules[0].bindings[0]).toMatchObject({name: 'saturated_ns', sourceStepId: 'pools'});
    expect(body.facts.rules[0].bindings[0]).not.toHaveProperty('value');
  });

  it('emits no rule facts or notes anywhere for a runtime without the opt-in, and honours the kill switch spellings', async () => {
    for (const off of ['false', '0', 'off', 'no', ' FALSE ']) {
      expect(skillResultFactsEnabled({[SKILL_RESULT_FACTS_ENV]: off})).toBe(false);
      expect(createSkillResultNoteMemory({[SKILL_RESULT_FACTS_ENV]: off})).toBeUndefined();
    }
    for (const on of [undefined, '', 'true', '1', 'unrecognized']) {
      expect(skillResultFactsEnabled({[SKILL_RESULT_FACTS_ENV]: on})).toBe(true);
      expect(createSkillResultNoteMemory({[SKILL_RESULT_FACTS_ENV]: on})).toBeDefined();
    }
    const updates: unknown[] = [];
    const store = new ArtifactStore();
    const {call} = server({facts: false, store, updates});
    const invoked = await call('invoke_skill', {skillId: 'facts_fixture'});
    expect(JSON.stringify(invoked.body)).not.toMatch(/ruleId|bindings|resultNotes|"facts"/);
    expect(JSON.stringify(updates)).not.toMatch(/ruleId|bindings|semantics/);
    expect(JSON.stringify(store.serialize())).not.toMatch(/ruleId|bindings/);
    for (const detail of ['full', 'rows', 'summary']) {
      const fetched = await call('fetch_artifact', {artifactId: invoked.body.diagnosticsArtifactId, detail});
      expect(JSON.stringify(fetched.body)).not.toMatch(/ruleId|bindings|resultNotes/);
    }
    const full = await call('fetch_artifact', {artifactId: invoked.body.diagnosticsArtifactId, detail: 'full'});
    expect(full.body.diagnostics.map((diagnostic: any) => diagnostic.diagnosis))
      .toEqual(['PRODUCT_CONCLUSION_TEXT', 'RULE_WITHOUT_ID']);
    const nonArtifact = server({facts: false, store: null});
    const direct = await nonArtifact.call('invoke_skill', {skillId: 'facts_fixture'});
    expect(JSON.stringify(direct.body)).not.toMatch(/ruleId|bindings|resultNotes|"facts"/);
  });
});
