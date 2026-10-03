// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SkillDefinition} from '../../skillEngine/types';
import {
  validateStrategyDefinitionsInProcess,
  validateSkillDefinitionsInProcess,
} from '../inProcessValidator';
import {loadStrategies} from '../../../agentv3/strategyLoader';
import {ensureSkillRegistryInitialized, skillRegistry} from '../../skillEngine/skillLoader';
import * as skillFragments from '../../skillEngine/skillFragments';

function skill(
  name: string,
  sql = 'SELECT 1 AS value',
): SkillDefinition {
  return {
    name,
    version: '1',
    type: 'composite',
    meta: {
      display_name: name,
      description: name,
    },
    steps: [{
      id: 'root',
      type: 'atomic',
      sql,
    }],
  };
}

describe('in-process effective Skill validator', () => {
  it('validates only the requested affected subset', () => {
    const valid = skill('valid');
    const invalid = skill('invalid');
    invalid.steps = [
      {id: 'duplicate', type: 'atomic', sql: 'SELECT 1'},
      {id: 'duplicate', type: 'atomic', sql: 'SELECT 2'},
    ];

    const selected = validateSkillDefinitionsInProcess({
      definitions: [valid, invalid],
      affectedSkillIds: ['valid'],
    });
    const all = validateSkillDefinitionsInProcess({
      definitions: [valid, invalid],
    });

    expect(selected).toMatchObject({
      valid: true,
      affectedSkillIds: ['valid'],
    });
    expect(all.valid).toBe(false);
    expect(all.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skillId: 'invalid',
        code: 'step_id_duplicate',
      }),
    ]));
  });

  it('rejects a save_as that reuses the id of another step, including a later or nested one', () => {
    const collisions = (steps: unknown[]) => {
      const definition = skill('collide');
      definition.steps = steps as SkillDefinition['steps'];
      return validateSkillDefinitionsInProcess({definitions: [definition]}).issues
        .filter(entry => entry.code === 'save_as_step_id_collision')
        .map(entry => entry.path);
    };

    // A step naming its binding after itself is the common, unambiguous form.
    expect(collisions([{id: 'rows', type: 'atomic', sql: 'SELECT 1', save_as: 'rows'}])).toEqual([]);
    expect(collisions([
      {id: 'first', type: 'atomic', sql: 'SELECT 1', save_as: 'later'},
      {id: 'parallel', type: 'parallel', steps: [
        {id: 'later', type: 'atomic', sql: 'SELECT 2'},
        {id: 'inner', type: 'atomic', sql: 'SELECT 3', save_as: 'first'},
      ]},
    ])).toEqual(['steps[0].save_as', 'steps[1].steps[1].save_as']);
  });

  it('rejects missing nested Skill and fragment references without shelling out', () => {
    const definition = skill('parent');
    definition.steps = [
      {
        id: 'child',
        type: 'skill',
        skill: 'missing_child',
      },
      {
        id: 'fragment',
        type: 'atomic',
        sql: 'SELECT 1',
        sql_fragments: ['fragments/missing.sql'],
      },
    ];

    const result = validateSkillDefinitionsInProcess({
      definitions: [definition],
      affectedSkillIds: ['parent'],
      fragmentCache: new Map(),
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map(entry => entry.code)).toEqual(
      expect.arrayContaining([
        'skill_reference_missing',
        'fragment_reference_missing',
      ]),
    );
  });

  it('checks that save_from binds a top-level step of the referenced Skill', () => {
    const child = skill('child');
    child.steps = [
      {id: 'overview', type: 'atomic', sql: 'SELECT 1'},
      {id: 'detail', type: 'atomic', sql: 'SELECT 2'},
    ];
    const withSteps = (steps: unknown[]) => {
      const parent = skill('parent');
      parent.steps = steps as SkillDefinition['steps'];
      return validateSkillDefinitionsInProcess({
        definitions: [parent, child],
        affectedSkillIds: ['parent'],
      });
    };
    const saveFromIssues = (steps: unknown[]) => withSteps(steps).issues
      .filter(entry => entry.code.startsWith('save_from'))
      .map(entry => `${entry.code} ${entry.path}`);

    // A type-less Skill reference is still a Skill reference.
    expect(withSteps([
      {id: 'ref', skill: 'child', save_as: 'rows', save_from: 'detail'},
    ])).toMatchObject({valid: true});
    expect(saveFromIssues([
      {id: 'ref', type: 'skill', skill: 'child', save_as: 'rows', save_from: 'missing'},
    ])).toEqual(['save_from_step_missing steps[0].save_from']);
    expect(saveFromIssues([
      {id: 'ref', type: 'skill', skill: 'no_such_child', save_as: 'rows', save_from: 'detail'},
    ])).toEqual(['save_from_target_missing steps[0].save_from']);
    // A non-string value is reported, never thrown.
    expect(saveFromIssues([7, false, {}].map((value, index) =>
      ({id: `ref${index}`, type: 'skill', skill: 'child', save_as: `rows${index}`, save_from: value}))))
      .toEqual([0, 1, 2].map(index => `save_from_invalid steps[${index}].save_from`));
    expect(saveFromIssues([
      {id: 'ref', type: 'skill', skill: 'child', save_from: 'detail'},
      {id: 'sql', type: 'atomic', sql: 'SELECT 1', save_as: 'x', save_from: 'detail'},
      {id: 'blank', type: 'skill', skill: 'child', save_as: 'y', save_from: ' '},
    ])).toEqual([
      'save_from_invalid steps[0].save_from',
      'save_from_invalid steps[1].save_from',
      'save_from_invalid steps[2].save_from',
    ]);
    // Changing only the child still re-checks the parent that binds its step.
    const parent = skill('parent');
    parent.steps = [{id: 'ref', skill: 'child', save_as: 'rows', save_from: 'renamed'} as any];
    expect(validateSkillDefinitionsInProcess({definitions: [parent, child], affectedSkillIds: ['child']})
      .issues.map(entry => `${entry.skillId} ${entry.code}`)).toEqual(['parent save_from_step_missing']);
    // Nested steps are executed without binding save_as, so save_from there
    // would validate and silently never bind.
    expect(saveFromIssues([
      {id: 'group', type: 'parallel', steps: [
        {id: 'inner', skill: 'child', save_as: 'rows', save_from: 'detail'},
      ]},
      {id: 'branch', type: 'conditional', conditions: [
        {when: 'true', then: {id: 'inner2', skill: 'child', save_as: 'rows2', save_from: 'detail'}},
      ]},
    ])).toEqual([
      'save_from_invalid steps[0].steps[0].save_from',
      'save_from_invalid steps[1].conditions[0].then[0].save_from',
    ]);
  });

  it('requires a diagnostic rule to read step data only through its declared inputs', () => {
    const diagnosticIssues = (inputs: string[] | undefined, rule: Record<string, unknown>) => {
      const definition = skill('diagnose');
      definition.inputs = [{name: 'threshold_ms', type: 'number'}] as any;
      definition.steps = [
        {id: 'load_rows', type: 'atomic', sql: 'SELECT 1', save_as: 'rows'},
        {id: 'other', type: 'atomic', sql: 'SELECT 2'},
        {id: 'check', type: 'diagnostic', ...(inputs ? {inputs} : {}),
          rules: [{condition: 'true', diagnosis: 'hit', confidence: 'high', ...rule}]} as any,
      ];
      // Structural shape issues and the confidence check have their own tests.
      return validateSkillDefinitionsInProcess({definitions: [definition]}).issues
        .filter(entry => entry.code.startsWith('diagnostic_')
          && !['diagnostic_step_invalid', 'diagnostic_rule_invalid', 'diagnostic_confidence_invalid'].includes(entry.code))
        .map(entry => `${entry.code} ${entry.path}`);
    };
    const at = (code: string, field: string) => `${code} steps[2].rules[0].${field}`;

    // Declared data, a Skill parameter, arrow parameters and a bare existence check are all valid.
    expect(diagnosticIssues(['rows'], {
      condition: '(rows?.data?.length || 0) > 0 && rows.data.find(r => r.dur_ms > threshold_ms) && rows != null',
      diagnosis: 'top ${rows.data[0].name} over ${threshold_ms|16}ms',
      suggestions: ['look at ${rows.data[0]?.name}'],
      evidence_fields: ['rows.data[0]?.dur_ms', "rows.data.filter(r => r.name === 'x').length", 'rows.data'],
    })).toEqual([]);

    // Reading a step the rule did not declare, including through the step id
    // of a step whose binding is its save_as, and with no inputs at all.
    expect(diagnosticIssues(['rows'], {condition: 'other.data.length > 0'}))
      .toEqual([at('diagnostic_input_undeclared', 'condition')]);
    expect(diagnosticIssues(['rows'], {condition: 'load_rows.data.length > 0'}))
      .toEqual([at('diagnostic_input_undeclared', 'condition')]);
    expect(diagnosticIssues(undefined, {diagnosis: 'top ${rows.data[0].name} of ${rows.data.length}'}))
      .toEqual(['diagnostic_inputs_missing steps[2].inputs', at('diagnostic_input_undeclared', 'diagnosis')]);
    // Missing inputs crash the step even when no rule reads step data.
    expect(diagnosticIssues(undefined, {})).toEqual(['diagnostic_inputs_missing steps[2].inputs']);
    expect(diagnosticIssues(['rows'], {suggestions: ['ok', 'see ${other.data[0].name}']}))
      .toEqual([at('diagnostic_input_undeclared', 'suggestions[1]')]);

    // An evidence field cites declared data only, in the read-only grammar.
    expect(diagnosticIssues(['rows'], {evidence_fields: ['rows.data[0].name', 'other.data[0].name']}))
      .toEqual([at('diagnostic_input_undeclared', 'evidence_fields[1]')]);
    expect(diagnosticIssues(['rows'], {evidence_fields: ['threshold_ms.data']}))
      .toEqual([at('diagnostic_evidence_field_root', 'evidence_fields[0]')]);
    const notEvidence = ['rows[0].name', 'rows', 'rows.length', '${rows.data[0].name}', 'rows.data.pop()',
      'rows.data[0].name = "x"', 'rows.data.constructor', 'this.process', 'rows.data.map(r => r.name)'];
    expect(diagnosticIssues(['rows'], {evidence_fields: notEvidence}))
      .toEqual(notEvidence.map((_, index) => at('diagnostic_evidence_field_shape', `evidence_fields[${index}]`)));
    expect(diagnosticIssues(['rows'], {evidence_fields: [
      'rows?.data?.[1]?.name', 'rows.data.length', 'rows.data.find(r => r.name === "it")?.dur_ms',
      "rows.data.filter(t => t.state !== 'D').length", 'rows.data.find(r => r.dur_ms >= -1.5)',
    ]})).toEqual([]);

    // In a condition, step data is read through `.data`; a placeholder the
    // evaluator resolves as a path indexes a save_as validly, but JavaScript in
    // a placeholder, or a whole `${…}` without a default, binds as code does.
    const misread = [at('diagnostic_step_data_shape', 'condition')];
    expect(diagnosticIssues(['rows'], {condition: 'rows[0]?.dur_ms > 1'})).toEqual(misread);
    expect(diagnosticIssues(['rows'], {condition: '${rows[0].dur_ms|0} > 1 && ${rows[0].dur_ms} > 0 && rows != null && (rows ?? 0)',
      diagnosis: '${rows[0].name}'})).toEqual([]);
    expect(diagnosticIssues(['rows'], {condition: '${rows[0].dur_ms * 2} > 1'})).toEqual(misread);
    expect(diagnosticIssues(['rows'], {condition: '${rows[0].dur_ms > 1}'})).toEqual(misread);
    // Each read in a placeholder is checked, whichever comes first.
    expect(diagnosticIssues(['rows'], {condition: '${rows.data.length > 0 && rows[0].x > 0}'})).toEqual(misread);
    expect(diagnosticIssues(['rows'], {condition: '${rows[0].x > 0 && rows.data.length > 0}'})).toEqual(misread);
    // String literals, escaped quotes included, are text.
    expect(diagnosticIssues(['rows'], {condition: "rows.data[0].name === 'it\\'s other.data'"})).toEqual([]);

    // An arrow parameter binds only inside its callback: not past a ternary
    // branch, and not a destructuring key.
    const undeclared = [at('diagnostic_input_undeclared', 'condition')];
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(other => other.x) && other.data.length > 0'}))
      .toEqual(undeclared);
    expect(diagnosticIssues(['rows'], {condition: '(false ? other => other.x : other.data.length > 0)'}))
      .toEqual(undeclared);
    expect(diagnosticIssues(['rows'], {condition: '(false ? other => other.x ?? 0 : other.data.length > 0)'}))
      .toEqual(undeclared);
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(({other: value}) => other.data.length > value)'}))
      .toEqual(undeclared);
    // A destructuring key reads nothing; a destructuring default is a read.
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(({other: value}) => value > 0)'})).toEqual([]);
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.find(({value = other.data[0]}) => value > 0)'}))
      .toEqual(undeclared);
    // A rest parameter binds; a computed key and a parenthesized default are reads.
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some((...other) => other[0].x > 0)'})).toEqual([]);
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(({...other}) => other.x > 0)'})).toEqual([]);
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(({[other.data[0].key]: value}) => value > 0)'}))
      .toEqual(undeclared);
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(({value = (other.data[0])}) => value > 0)'}))
      .toEqual(undeclared);
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(([a, {b: [c]}], i) => a + c + i > 0)'})).toEqual([]);
    expect(diagnosticIssues(['rows'], {condition: 'rows.data.some(({dur_ms}) => dur_ms > 0) && rows.data.some(other => other ? other.x : 0)'}))
      .toEqual([]);

    // Step names inside a regex or comment are not reads; a comment or an escape
    // between a step name and its member is read as the engine reads it.
    expect(diagnosticIssues(['rows'], {condition: "/other.data/.test(rows.data[0].name) /* other.data */"})).toEqual([]);
    expect(diagnosticIssues(['rows'], {condition: 'rows /* c */ [0].x > 0'}))
      .toEqual([at('diagnostic_step_data_shape', 'condition')]);
    expect(diagnosticIssues(['rows'], {condition: 'rows. /* c */ data.length > 0 && rows.\\u0064ata.length > 0'})).toEqual([]);
    expect(diagnosticIssues(['rows'], {condition: 'rows?.["data"]?.length > 0'}))
      .toEqual([at('diagnostic_step_data_shape', 'condition')]);
  });

  it('rejects a diagnostic rule that reads a name no scope binds, only when the read is exact', () => {
    const ruleIssues = (rule: Record<string, unknown>, context?: string[]) => {
      const definition = skill('thresholds');
      definition.inputs = [{name: 'slow_ms', type: 'number', default: 50}] as any;
      if (context) definition.context = context;
      definition.steps = [
        {id: 'rows', type: 'atomic', sql: 'SELECT 1'},
        {id: 'check', type: 'diagnostic', inputs: ['rows'],
          rules: [{condition: 'true', diagnosis: 'hit', confidence: 'high', ...rule}]} as any,
      ];
      return validateSkillDefinitionsInProcess({definitions: [definition]}).issues
        .filter(entry => entry.code.startsWith('diagnostic_')).map(entry => `${entry.code} ${entry.path}`);
    };
    // A declared input, a runtime parameter, a context dependency and arrow parameters are bound.
    expect(ruleIssues({condition: 'rows.data[0].dur_ms > (slow_ms ?? 50) && package && rows.data.some(r => r.x > 0)'}))
      .toEqual([]);
    expect(ruleIssues({condition: 'parent_value > 0'}, ['parent_value'])).toEqual([]);
    // `inputs` is no binding, in a condition or a template placeholder.
    expect(ruleIssues({condition: 'rows.data[0].dur_ms > (inputs?.slow_ms ?? 50)'}))
      .toEqual(['diagnostic_root_unknown steps[1].rules[0].condition']);
    expect(ruleIssues({diagnosis: 'over ${inputs.slow_ms}ms', suggestions: ['raise ${slow_ms|50}']}))
      .toEqual(['diagnostic_root_unknown steps[1].rules[0].diagnosis']);
    // A read that is not exact is a guess, so no check on root names reports it:
    // locals, even ones named like a step, and an unparsed condition.
    expect(ruleIssues({condition: 'rows.data.some(r => { const check = [r]; return check[0].x > 1; })'})).toEqual([]);
    expect(ruleIssues({condition: 'rows.data.some(r => { const limit = 1; return r.x > limit; })'})).toEqual([]);
    expect(ruleIssues({condition: 'rows.data.some(function(r) { return r.x > 1; })'})).toEqual([]);
    expect(ruleIssues({condition: '({check(r) { return r.x > 1; }}).check(rows.data[0])'})).toEqual([]);
    expect(ruleIssues({condition: '({get ok() { return true; }}).ok'})).toEqual([]);
    expect(ruleIssues({condition: "rows.data[0].state === 'ok' OR missing"})).toEqual([]);
  });

  it('rejects a saved-result path read that states neither a default nor a guarding condition', () => {
    const reader = skill('reader');
    reader.steps = [
      {id: 'probe', type: 'atomic', sql: 'SELECT 1 AS status', save_as: 'cov'},
      {id: 'bare', type: 'atomic', sql: "SELECT '${cov.data[0].status}' AS s"},
      {id: 'defaulted', type: 'atomic', sql: "SELECT '${cov.data[0].status|}' AS s"},
      {id: 'guarded', type: 'atomic', condition: 'cov.data?.length > 0', sql: "SELECT '${cov.data[0].status}' AS s"},
    ];
    const result = validateSkillDefinitionsInProcess({definitions: [reader]});
    expect(result.issues.filter(issue => issue.code === 'result_path_read_undecided')
      .map(issue => `${issue.severity} ${issue.path}`)).toEqual(['error steps[1].sql']);
    expect(result.valid).toBe(false);
    // Composing published overlays reports it without taking the scope offline.
    const composed = validateSkillDefinitionsInProcess({definitions: [reader], predatingRuleSeverity: 'warning'});
    expect(composed.issues.filter(issue => issue.code === 'result_path_read_undecided')
      .map(issue => issue.severity)).toEqual(['warning']);
    expect(composed.valid).toBe(true);
  });

  it('rejects heat or cap wording a Skill shows without the evidence behind it, in either language', () => {
    const wordingIssues = (definitions: SkillDefinition[]) =>
      validateSkillDefinitionsInProcess({definitions}).issues
        .filter(issue => issue.code === 'cause_wording_without_evidence')
        .map(issue => `${issue.severity} ${issue.skillId} ${issue.path}`);
    const frequencyOnly = skill('frequency_only');
    frequencyOnly.steps = [{id: 'drops', type: 'atomic', name: '频率突降事件',
      sql: "SELECT ts, '限频导致卡顿' AS note FROM counter c JOIN cpu_counter_track t ON t.id = c.track_id WHERE t.name = 'cpufreq'",
      display: {columns: [{name: 'throttled_core_pct', label: '频率下降核心占比'}]}} as any];
    // A Chinese literal, and an English label humanized from the column name.
    expect(wordingIssues([frequencyOnly])).toEqual([
      'error frequency_only steps.drops.catalog.columns.throttled_core_pct.label.en',
      'error frequency_only steps.drops.sql',
    ]);
    // An authored English label replaces the humanized one, and the authored
    // translations are valid structure too (columns, synthesize fields, step titles).
    const labelled = skill('labelled');
    labelled.steps = [{id: 'drops', type: 'atomic', name: '频率突降事件', sql: 'SELECT 1 AS throttled_core_pct',
      display: {title: '频率突降', title_i18n: {en: 'Frequency drops'},
        columns: [{name: 'throttled_core_pct', label: '频率下降核心占比', label_i18n: {en: 'Frequency-drop cores (%)'}}]},
      synthesize: {role: 'overview', fields: [{key: 'throttled_core_pct', label: '频率下降核心占比',
        label_i18n: {en: 'Frequency-drop cores (%)'}}]}} as any];
    expect(wordingIssues([labelled])).toEqual([]);
    const labelledResult = validateSkillDefinitionsInProcess({definitions: [labelled]});
    expect(labelledResult.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(labelledResult.valid).toBe(true);
    // Reading a cpufreq limit, or calling a Skill that does, allows it.
    const limit = skill('limit_reader');
    limit.steps = [{id: 'limits', type: 'atomic', sql: 'SELECT * FROM cpu_frequency_limits', name: '限频区段'} as any];
    const caller = skill('caller');
    caller.steps = [{id: 'call', type: 'skill', skill: 'limit_reader', name: '限频检测'} as any];
    expect(wordingIssues([limit, caller])).toEqual([]);
    // Composing published overlays reports it without taking the scope offline.
    const composed = validateSkillDefinitionsInProcess({definitions: [frequencyOnly], predatingRuleSeverity: 'warning'});
    expect(composed.valid).toBe(true);
    expect(composed.issues.filter(issue => issue.code === 'cause_wording_without_evidence').map(issue => issue.severity))
      .toEqual(['warning', 'warning']);
    // A malformed translation is the display contract's to report, never a crash here.
    const malformed = skill('malformed');
    malformed.steps = [{id: 'x', type: 'atomic', sql: 'SELECT 1', display: {columns: [{name: 'a', label_i18n: {en: 42}}]}} as any];
    expect(validateSkillDefinitionsInProcess({definitions: [malformed]}).issues.map(issue => issue.code))
      .toContain('display_contract');
  });

  it('rejects a top-level key no loader reads, by the set of the definition type', () => {
    const unknownKeys = (definition: Record<string, unknown>) =>
      validateSkillDefinitionsInProcess({definitions: [definition as unknown as SkillDefinition]}).issues
        .filter(entry => entry.code === 'skill_top_level_key_unknown').map(entry => entry.path);
    const base = skill('top_level_keys');
    expect(unknownKeys({...base, synthesis: {template: 'x'}, thresholds: {}, priority: 'high'}))
      .toEqual(['synthesis', 'thresholds', 'priority']);
    // A Skill may use the legacy spellings the loader folds into meta and output.
    expect(unknownKeys({...base, tier: 'B', display: {level: 'summary'}, description: 'd', tags: ['t']})).toEqual([]);
    // A pipeline is not normalized: it has its own keys and no legacy spellings.
    const pipeline = {name: 'pipeline_x', version: '1', type: 'pipeline_definition', category: 'rendering',
      meta: {}, detection: {}, teaching: {}, auto_pin: {}, analysis: {}};
    expect(unknownKeys(pipeline)).toEqual([]);
    expect(unknownKeys({...pipeline, display: {}, steps: []})).toEqual(['display', 'steps']);
  });

  it('validates every definition when no affected Skill is named, as a new Skill proposal does', () => {
    const existing = skill('existing');
    existing.steps = [
      {id: 'rows', type: 'atomic', sql: 'SELECT 1'},
      {id: 'check', type: 'diagnostic', inputs: ['rows'],
        rules: [{condition: 'rows.data.length > (inputs?.limit ?? 1)', diagnosis: 'hit', confidence: 'high'}]} as any,
    ];
    const codes = validateSkillDefinitionsInProcess({definitions: [existing, skill('candidate')]}).issues.map(entry => entry.code);
    expect(codes).toContain('diagnostic_root_unknown');
  });

  it('rejects invalid display contracts on effective definitions', () => {
    const definition = skill('display');
    definition.output = {
      display: {
        title: 'Invalid',
        layer: 'invalid-layer' as never,
        level: 'summary',
        format: 'table',
      },
    };

    const result = validateSkillDefinitionsInProcess({
      definitions: [definition],
      affectedSkillIds: ['display'],
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'display_contract'}),
    ]));
  });

  it('rejects ratio-scale Perfetto percentiles while preserving legacy guardrails as warnings', () => {
    const percentile = validateSkillDefinitionsInProcess({
      definitions: [skill('bad_percentile', 'SELECT PERCENTILE(value, 0.95) FROM samples')],
    });
    const legacy = validateSkillDefinitionsInProcess({
      definitions: [skill('legacy_warning', 'CREATE VIEW unsafe_view AS SELECT 1')],
    });

    expect(percentile.valid).toBe(false);
    expect(percentile.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code: 'sql_guardrail_percentile-percent-scale',
      }),
    ]));
    expect(legacy.valid).toBe(true);
    expect(legacy.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        code: 'sql_guardrail_idempotent-create',
      }),
    ]));
  });

  it('accepts metadata-only pipeline definitions and rejects incomplete steps', () => {
    const pipelineDefinition: SkillDefinition = {
      name: 'pipeline_catalog_entry',
      version: '1',
      type: 'pipeline_definition',
      meta: {
        display_name: 'Pipeline catalog entry',
        description: 'Metadata-only rendering pipeline contract.',
      },
    };
    const invalid = skill('invalid_step');
    invalid.steps = [{
      id: 'broken',
      type: 'diagnostic',
    } as never];

    expect(validateSkillDefinitionsInProcess({
      definitions: [pipelineDefinition],
    })).toMatchObject({valid: true});
    expect(validateSkillDefinitionsInProcess({
      definitions: [invalid],
    })).toMatchObject({valid: false});
  });

  it('validates only affected Strategy references against effective Skills', () => {
    const base = loadStrategies().get('general')!;
    const invalid = {
      ...base,
      content: `${base.content}\ninvoke_skill("missing_skill")`,
    };
    const selected = validateStrategyDefinitionsInProcess({
      definitions: [invalid],
      affectedScenes: [],
      skills: new Map(),
      undeclaredSkillParamSeverity: 'error',
    });
    const affected = validateStrategyDefinitionsInProcess({
      definitions: [invalid],
      affectedScenes: ['general'],
      skills: new Map(),
      undeclaredSkillParamSeverity: 'error',
    });

    expect(selected.valid).toBe(true);
    expect(affected.valid).toBe(false);
    expect(affected.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'strategy_skill_reference_missing',
        scene: 'general',
      }),
    ]));
  });

  it('reports undeclared invoke_skill example keys at the caller-chosen severity', () => {
    const base = loadStrategies().get('general')!;
    const withAlias = {
      ...base,
      content: 'invoke_skill("jank_frame_detail", { start_ts, process_name: "a" })',
      detailSections: [{
        id: 'drill',
        ref: 'general:drill',
        title: 'Drill',
        keywords: [],
        default: false,
        content: 'intro\ninvoke_skill("jank_frame_detail", { package, pid })',
      }],
      phaseHints: [],
    };
    const skills = new Map([[
      'jank_frame_detail',
      {inputs: ['start_ts', 'package'].map(name =>
        ({name, type: 'string' as const, required: false}))},
    ]]);
    const gate = validateStrategyDefinitionsInProcess({
      definitions: [withAlias],
      affectedScenes: ['general'],
      skills,
      undeclaredSkillParamSeverity: 'error',
    });
    const reconcile = validateStrategyDefinitionsInProcess({
      definitions: [withAlias],
      affectedScenes: ['general'],
      skills,
      undeclaredSkillParamSeverity: 'warning',
    });

    expect(gate.validatorVersion).toBe('8');
    expect(gate.valid).toBe(false);
    expect(gate.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'strategy_skill_param_undeclared',
        scene: 'general',
        path: 'content',
        message: expect.stringContaining('line 1: invoke_skill("jank_frame_detail") passes process_name,'),
      }),
      expect.objectContaining({
        severity: 'error',
        path: 'detailSections.drill',
        message: expect.stringContaining('line 2: invoke_skill("jank_frame_detail") passes pid,'),
      }),
    ]);
    expect(reconcile.valid).toBe(true);
    expect(reconcile.issues.map(issue => issue.severity)).toEqual(['warning', 'warning']);
  });

  // validate:skills and the Self-Evolution gates run this same validator, so a
  // base Skill error would reject every overlay of the scope it sits in.
  it('finds no error in the built-in registry', async () => {
    await ensureSkillRegistryInitialized();
    const definitions = skillRegistry.getAllSkills()
      .filter(definition => skillRegistry.getSkillOrigin(definition.name)?.origin !== 'external_pack');
    const result = validateSkillDefinitionsInProcess({definitions, fragmentCache: skillRegistry.getFragmentCache()});
    expect(result.issues.filter(entry => entry.severity === 'error')).toEqual([]);
  });

  it('checks the process_scope, exact_sql and investigation_evidence an atomic step or root declares', () => {
    const scope = {role: 'target', binding: 'native_upid'};
    const evidence = {window: {start: 'ts', end: 'end_ts'}, metrics: []};
    const declaring = (fields: Record<string, unknown>, root = false): SkillDefinition => {
      const definition = skill('scoped');
      if (root) return {...definition, type: 'atomic', steps: undefined, sql: 'SELECT 1', ...fields} as SkillDefinition;
      definition.steps = [{id: 'rows', type: 'atomic', sql: 'SELECT 1', ...fields} as any];
      return definition;
    };
    // The precise issue, beside the closed schema's generic one for its step.
    const codes = (definition: SkillDefinition) =>
      validateSkillDefinitionsInProcess({definitions: [definition]}).issues
        .filter(entry => entry.severity === 'error' && entry.code !== 'atomic_step_invalid')
        .map(entry => `${entry.code}@${entry.path}`);

    for (const root of [false, true]) {
      expect(codes(declaring({process_scope: scope, investigation_evidence: evidence,
        exact_sql: {sql: 'SELECT 2', sql_fragments: [], process_scope: scope}}, root))).toEqual([]);
    }
    expect(codes(declaring({process_scope: {role: 'target', bindings: 'native_upid'}})))
      .toEqual(['process_scope_invalid@steps[0].process_scope']);
    expect(codes(declaring({process_scope: {role: 'owner'}}, true))).toEqual(['process_scope_invalid@process_scope']);
    // A malformed process_scope only leaves exact scope unsupported: a published overlay predating the check warns.
    expect(validateSkillDefinitionsInProcess({definitions: [declaring({process_scope: {role: 'owner'}}, true)], predatingRuleSeverity: 'warning'})
      .issues.map(entry => `${entry.severity}:${entry.code}`)).toEqual(['warning:process_scope_invalid']);
    expect(validateSkillDefinitionsInProcess({definitions: [declaring({process_scope: {role: 'owner'}})], predatingRuleSeverity: 'warning'})
      .valid).toBe(true);
    // It does not stop the step checks that follow.
    const twice = declaring({process_scope: {role: 'owner'}});
    twice.steps!.push({id: 'rows', type: 'atomic', sql: 'SELECT 2'} as any);
    expect(codes(twice)).toEqual(expect.arrayContaining(['process_scope_invalid@steps[0].process_scope', 'step_id_duplicate@steps[1].id']));
    // The declaration's own semantics, as the exact-scope admission reads them.
    expect(codes(declaring({process_scope: {role: 'target', context_fields: {peer_context: ['']}}})))
      .toEqual(['process_scope_invalid@steps[0].process_scope']);
    expect(codes(declaring({process_scope: {role: 'peer_context', binding: 'native_upid'}})))
      .toEqual(['process_scope_invalid@steps[0].process_scope']);
    expect(codes(declaring({exact_sql: {sql: 'SELECT 2'}}))).toEqual(['exact_sql_invalid@steps[0].exact_sql']);
    expect(codes(declaring({exact_sql: {sql: 'SELECT 2', process_scope: scope, condition: 'x'}})))
      .toEqual(['exact_sql_invalid@steps[0].exact_sql']);
    expect(codes(declaring({investigation_evidence: {window: {start: 'ts'}, metrics: []}})))
      .toEqual(['investigation_evidence_invalid@steps[0].investigation_evidence']);
    expect(codes(declaring({investigation_evidence: {window: {start: 'ts', end: 'ts'}, metrics: []}})))
      .toEqual(['investigation_evidence_invalid@steps[0].investigation_evidence']);
  });

  it('requires a literal confidence on every diagnostic rule', () => {
    const definition = skill('diagnosing');
    definition.steps = [
      {id: 'rows', type: 'atomic', sql: 'SELECT 1'},
      {id: 'verdict', type: 'diagnostic', inputs: ['rows'], rules: [{condition: 'true', diagnosis: 'seen'}]} as any,
    ];
    expect(validateSkillDefinitionsInProcess({definitions: [definition]}).issues.map(entry => `${entry.code}@${entry.path}`))
      .toEqual(['diagnostic_confidence_invalid@steps[1].rules[0].confidence', 'diagnostic_step_invalid@steps[1]']);
  });

  it('reads the heat and cap wording the SQL of a step shows, in either language, including its fragments', () => {
    const showing = (sql: string, fields: Record<string, unknown> = {}): string[] => {
      const definition = skill('shows');
      definition.steps = [{id: 'rows', type: 'atomic', sql, ...fields} as any];
      return validateSkillDefinitionsInProcess({definitions: [definition], fragmentCache: new Map([['fragments/zz_probe.sql', 'x']])})
        .issues.filter(entry => entry.code === 'cause_wording_without_evidence').map(entry => entry.path);
    };
    // A CASE result and a labelled column are text the step shows.
    expect(showing("SELECT CASE WHEN dur > 0 THEN 'Thermal throttling detected' ELSE 'ok' END AS verdict FROM slice"))
      .toEqual(expect.arrayContaining(['steps.rows.sql']));
    expect(showing("SELECT 'CPU throttled' AS note FROM slice")).toEqual(['steps.rows.sql']);
    // Where a literal stands decides, not its value or its punctuation.
    expect(showing("SELECT '温控导致卡顿' AS note FROM slice WHERE name = '温控导致卡顿'")).toEqual(['steps.rows.sql']);
    expect(showing("SELECT '温控导致卡顿?' AS note FROM slice")).toEqual(['steps.rows.sql']);
    expect(showing("SELECT 1 FROM slice WHERE name IN (1, '温控导致卡顿')")).toEqual([]);
    expect(showing("SELECT 1 FROM slice WHERE ('温控导致卡顿') = name OR name = LOWER('过热导致卡顿')")).toEqual([]);
    expect(showing("SELECT LOWER('温控导致卡顿') AS note FROM slice")).toEqual(['steps.rows.sql']);
    expect(showing("SELECT 1 FROM slice WHERE '温控导致卡顿' || name = 'x' OR dur BETWEEN '过热' AND '温控'")).toEqual([]);
    // A WHEN after a CASE result starts the next branch; a simple CASE's WHEN value is compared.
    for (const result of ["'温控导致卡顿'", "('温控导致卡顿')", "LOWER('温控导致卡顿')"]) {
      expect(showing(`SELECT CASE WHEN dur > 0 THEN ${result} WHEN dur = 0 THEN 'ok' ELSE 'unknown' END AS note FROM slice`))
        .toEqual(['steps.rows.sql']);
    }
    expect(showing("SELECT CASE name WHEN '温控导致卡顿' THEN 1 ELSE 0 END AS hit FROM slice")).toEqual([]);
    expect(showing("SELECT '**CPU throttled**' AS note FROM slice")).toEqual(['steps.rows.sql']);
    // A literal it selects by, a pattern a later GLOB reads, a code and a component name show nothing.
    expect(showing("SELECT dur FROM slice WHERE name = 'Thermal throttling detected'")).toEqual([]);
    expect(showing("SELECT * FROM slice WHERE name GLOB '*thermal*' OR name LIKE '%throttl%'")).toEqual([]);
    expect(showing("SELECT '*thermal-engine*' AS pattern, 'cpu_throttled' AS code, 'OEM thermal manager daemon' AS note")).toEqual([]);
    // An exact run shows its exact_sql's text and reads its exact_sql's evidence, at a step and at the root.
    const exactSql = (sql: string) => ({sql, process_scope: {role: 'target', binding: 'native_upid'}});
    expect(showing('SELECT value FROM cpu_frequency_limits',
      {exact_sql: exactSql("SELECT '温控导致卡顿' AS note FROM slice WHERE upid = ${__process_scope.upid}")}))
      .toEqual(['steps.rows.exact_sql.sql']);
    expect(showing('SELECT 1', {exact_sql: exactSql(
      "SELECT '温控导致卡顿' AS note FROM cpu_frequency_limits WHERE upid = ${__process_scope.upid}")})).toEqual([]);
    // A parent with no exact_sql of its own runs exact through a child that has one.
    const child = {...skill('limit_child'), type: 'atomic', steps: undefined, sql: 'SELECT value FROM cpu_frequency_limits',
      exact_sql: exactSql('SELECT upid FROM process WHERE upid = ${__process_scope.upid}')} as unknown as SkillDefinition;
    const parent = skill('limit_parent');
    parent.steps = [
      {id: 'read', type: 'skill', skill: 'limit_child', save_as: 'read'} as any,
      {id: 'note', type: 'atomic', sql: "SELECT '温控导致卡顿' AS note", condition: 'read.data?.length > 0'} as any,
    ];
    expect(validateSkillDefinitionsInProcess({definitions: [child, parent], affectedSkillIds: ['limit_parent']}).issues
      .filter(entry => entry.code === 'cause_wording_without_evidence').map(entry => entry.path))
      .toEqual(['steps.note.sql']);
    const root = {...skill('root_exact'), type: 'atomic', steps: undefined, sql: 'SELECT 1',
      exact_sql: exactSql("SELECT '温控导致卡顿' AS note FROM slice WHERE upid = ${__process_scope.upid}")} as unknown as SkillDefinition;
    expect(validateSkillDefinitionsInProcess({definitions: [root]}).issues
      .filter(entry => entry.code === 'cause_wording_without_evidence').map(entry => entry.path))
      .toEqual(['skill.exact_sql.sql']);
    // An English component name in a Chinese sentence that blames it still names heat.
    for (const title of ['thermal HAL 是卡顿的根因', 'thermal HAL 让帧变慢', 'thermal HAL 降低帧率']) {
      // Reported once, at the catalog copy of the title the step shows.
      expect(showing('SELECT 1 AS value', {display: {title}})).toEqual(['steps.rows.catalog.title.zh-CN']);
    }
    // Text a declared fragment shows is the step's text too.
    const fragment = jest.spyOn(skillFragments, 'builtInFragmentText')
      .mockImplementation(path => path === 'fragments/zz_probe.sql' ? "zz AS (SELECT 'Throttled by heat' AS note)" : undefined);
    try {
      expect(showing('SELECT * FROM zz', {sql_fragments: ['fragments/zz_probe.sql']}))
        .toEqual(expect.arrayContaining(['steps.rows.sql_fragments.fragments/zz_probe.sql']));
    } finally {
      fragment.mockRestore();
    }
  });
});
