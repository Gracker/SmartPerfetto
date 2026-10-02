// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SkillDefinition} from '../../skillEngine/types';
import {
  validateStrategyDefinitionsInProcess,
  validateSkillDefinitionsInProcess,
} from '../inProcessValidator';
import {loadStrategies} from '../../../agentv3/strategyLoader';

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

    expect(gate.validatorVersion).toBe('4');
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
});
