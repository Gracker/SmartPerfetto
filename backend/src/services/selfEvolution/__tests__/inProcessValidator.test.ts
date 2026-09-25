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

    expect(gate.validatorVersion).toBe('2');
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
