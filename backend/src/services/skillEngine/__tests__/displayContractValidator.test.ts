// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  isDisplayTitleTranslations,
  sanitizeDisplayConfigForRuntime,
  validateSkillDisplayContract,
} from '../displayContractValidator';
import type { SkillDefinition } from '../types';

describe('authored display title translations', () => {
  it.each([null, [], 'title', {en: ''}, {en: '  '}, {en: 7}, {fr: 'Titre'}])('rejects malformed overrides: %p', value => {
    expect(isDisplayTitleTranslations(value)).toBe(false);
    expect(validateSkillDisplayContract(baseSkill({steps: [{id: 'step', type: 'atomic',
      display: {title_i18n: value}} as any]})).some(issue => issue.field.endsWith('title_i18n'))).toBe(true);
  });
  it.each(['display_name_i18n', 'description_i18n'])('checks meta.%s as the Skill name and description translations', field => {
    const issues = (value: unknown) => validateSkillDisplayContract(baseSkill({
      meta: {display_name: 'Name', description: 'Description', [field]: value},
    } as any)).filter(issue => issue.field === `meta.${field}`);
    expect(issues({en: 'English'})).toEqual([]);
    expect(issues({en: ''})).toHaveLength(1);
    expect(issues({fr: 'Nom'})).toHaveLength(1);
  });
  it('accepts partial locale overrides and removes authoring metadata from runtime display', () => {
    expect(isDisplayTitleTranslations({en: 'Observed interval'})).toBe(true);
    expect(sanitizeDisplayConfigForRuntime({title: 'Observed interval', title_i18n: {en: 'Observed interval'}}).config.title_i18n)
      .toBeUndefined();
    expect(sanitizeDisplayConfigForRuntime({columns: [{name: 'n', label: '次数', label_i18n: {en: 'Count'}}]}).config.columns)
      .toEqual([{name: 'n', label: '次数'}]);
  });
  // The display walk is stepNodesOf: the branches the executor runs. A `then`
  // written on the conditional itself is no branch; the closed step schema
  // rejects it (conditional_step_invalid).
  it.each(['root', 'output', 'else', 'conditions', 'unnamed'])('rejects title overrides at unsupported %s locations', location => {
    const display = {title_i18n: {en: 'Explicit title'}};
    const child = {id: 'child', type: 'atomic', display};
    const branch = location === 'conditions' ? {conditions: [{then: child}]} : {[location]: child};
    const definition = location === 'root' ? {display} : location === 'output' ? {output: {display}}
      : location === 'unnamed' ? {steps: [{type: 'atomic', display}]}
      : {steps: [{id: 'parent', type: 'conditional', ...branch}]};
    expect(validateSkillDisplayContract(baseSkill(definition as any)).some(issue => issue.field.endsWith('title_i18n'))).toBe(true);
  });
  it('accepts overrides on recursively nested named steps without changing ordinary branch titles', () => {
    const definition = baseSkill({steps: [{id: 'parent', type: 'parallel', steps: [{id: 'child', type: 'atomic',
      display: {title_i18n: {en: 'Explicit title'}}}]}, {id: 'branch', type: 'conditional',
      then: {id: 'then', type: 'atomic', display: {title: 'Ordinary title'}}}] as any});
    expect(validateSkillDisplayContract(definition)).toEqual([]);
  });
});

const baseSkill = (overrides: Partial<SkillDefinition> & Record<string, unknown> = {}): SkillDefinition & Record<string, unknown> => ({
  name: 'display_contract_test',
  type: 'composite',
  version: '1.0',
  meta: {
    display_name: 'Display Contract Test',
    description: 'Display contract validator test skill',
  },
  steps: [],
  ...overrides,
});

describe('displayContractValidator', () => {
  it('accepts valid root, output, and step display configs', () => {
    const skill = baseSkill({
      display: {
        layer: 'overview',
        level: 'summary',
        format: 'summary',
      },
      output: {
        display: {
          layer: 'diagnosis',
          level: 'hidden',
          format: 'metric',
        },
      } as any,
      steps: [
        {
          id: 'valid_step',
          type: 'atomic',
          sql: 'select 1',
          display: {
            layer: 'list',
            level: 'detail',
            format: 'table',
            columns: [
              'process_name',
              {
                name: 'duration_ns',
                type: 'duration',
                format: 'duration_ms',
                clickAction: 'navigate_range',
                unit: 'ns',
                width: 'medium',
              },
            ],
            metadataFields: ['process_name'],
          },
        } as any,
      ],
    });

    expect(validateSkillDisplayContract(skill)).toEqual([]);
  });

  it('reports invalid layer, level, and format values', () => {
    const skill = baseSkill({
      display: {
        layer: 'number',
        level: 'list',
        format: 'grid',
      } as any,
      output: {
        display: {
          layer: 'detail',
          level: 'overview',
        },
      } as any,
      steps: [
        {
          id: 'bad_step',
          type: 'atomic',
          sql: 'select 1',
          display: {
            layer: 'duration',
            level: 'frame',
            format: 'cards',
          },
        } as any,
      ],
    });

    const paths = validateSkillDisplayContract(skill).map(issue => issue.path);

    expect(paths).toEqual(expect.arrayContaining([
      'display.layer',
      'display.level',
      'display.format',
      'output.display.layer',
      'output.display.level',
      'steps[0].display.layer',
      'steps[0].display.level',
      'steps[0].display.format',
    ]));
  });

  it('walks nested parallel and conditional steps', () => {
    const skill = baseSkill({
      steps: [
        {
          id: 'parallel_step',
          type: 'parallel',
          steps: [
            {
              id: 'nested_bad',
              type: 'atomic',
              sql: 'select 1',
              display: { layer: 'bytes' },
            },
          ],
        } as any,
        {
          id: 'conditional_step',
          type: 'conditional',
          conditions: [
            {
              if: 'true',
              then: {
                id: 'then_bad',
                type: 'atomic',
                sql: 'select 1',
                display: { level: 'overview' },
              },
            },
          ],
          else: {
            id: 'else_bad',
            type: 'atomic',
            sql: 'select 1',
            display: { format: 'grid' },
          },
        } as any,
      ],
    });

    const issues = validateSkillDisplayContract(skill);

    expect(issues.map(issue => issue.stepId)).toEqual(expect.arrayContaining([
      'nested_bad',
      'then_bad',
      'else_bad',
    ]));
    expect(issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      'steps[0].steps[0].display.layer',
      'steps[1].conditions[0].then.display.level',
      'steps[1].else.display.format',
    ]));
  });

  it('validates column and metadata field shapes', () => {
    const skill = baseSkill({
      steps: [
        {
          id: 'bad_columns',
          type: 'atomic',
          sql: 'select 1',
          display: {
            columns: [
              '',
              42,
              { label: 'Missing name' },
              {
                name: 'ts',
                type: 'integer',
                format: 'bad_format',
                clickAction: 'jump',
                unit: 'minute',
                width: 'huge',
              },
            ],
            metadataFields: ['ok', 1],
          },
        } as any,
      ],
    });

    const paths = validateSkillDisplayContract(skill).map(issue => issue.path);

    expect(paths).toEqual(expect.arrayContaining([
      'steps[0].display.columns[0]',
      'steps[0].display.columns[1]',
      'steps[0].display.columns[2].name',
      'steps[0].display.columns[3].type',
      'steps[0].display.columns[3].format',
      'steps[0].display.columns[3].clickAction',
      'steps[0].display.columns[3].unit',
      'steps[0].display.columns[3].width',
      'steps[0].display.metadataFields[1]',
    ]));
  });

  it('sanitizes invalid runtime display configs before DataEnvelope conversion', () => {
    const { config, issues } = sanitizeDisplayConfigForRuntime({
      layer: 'number',
      level: 'list',
      format: 'grid',
      columns: [
        'ts',
        '',
        {
          name: 'duration_ns',
          type: 'integer',
          format: 'bad_format',
          clickAction: 'jump',
          unit: 'minute',
          width: 'huge',
        },
        { label: 'Missing name' },
      ],
      metadataFields: ['ts', 7],
    } as any, {
      stepId: 'bad_step',
      defaultLayer: 'list',
      defaultLevel: 'detail',
      defaultFormat: 'table',
    });

    expect(config.layer).toBe('list');
    expect(config.level).toBe('detail');
    expect(config.format).toBe('table');
    expect(config.columns).toEqual([
      { name: 'ts' },
      { name: 'duration_ns' },
    ]);
    expect(config.metadataFields).toEqual(['ts']);
    expect(issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      'display.layer',
      'display.level',
      'display.format',
      'display.columns[1]',
      'display.columns[2].type',
      'display.columns[2].format',
      'display.columns[2].clickAction',
      'display.columns[2].unit',
      'display.columns[2].width',
      'display.columns[3].name',
      'display.metadataFields[1]',
    ]));
  });
});
