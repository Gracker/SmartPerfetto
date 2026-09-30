// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from '@jest/globals';

jest.mock('commander', () => ({
  Command: class {
    description() { return this; }
    argument() { return this; }
    option() { return this; }
    action() { return this; }
  },
}));

import { validateContracts } from '../commands/validate';
import type { SkillDefinition } from '../../services/skillEngine/types';

/** `validate:skills` resolves `save_from` against every Skill on disk. */
describe('validate --contracts save_from', () => {
  const withReference = (skill: string, saveFrom: string): SkillDefinition => ({
    name: 'save_from_contract_probe', version: '1', type: 'composite',
    meta: {display_name: 'probe', description: 'probe'},
    steps: [{id: 'ref', skill, save_as: 'rows', save_from: saveFrom} as any],
  });
  const saveFromErrors = (skill: SkillDefinition) =>
    validateContracts(skill).errors.filter(error => error.includes('save_from'));

  it('accepts the shipped binding and a real child step', () => {
    const shipped = yaml.load(fs.readFileSync(
      path.join(process.cwd(), 'skills/composite/jank_frame_detail.skill.yaml'), 'utf8')) as SkillDefinition;
    expect(saveFromErrors(shipped)).toEqual([]);
    expect(saveFromErrors(withReference('cpu_throttling_in_range', 'throttle_detection'))).toEqual([]);
  });

  it('rejects an unknown child step and an unknown child Skill', () => {
    expect(saveFromErrors(withReference('cpu_throttling_in_range', 'no_such_step')))
      .toEqual([expect.stringContaining("has no top-level step 'no_such_step'")]);
    expect(saveFromErrors(withReference('no_such_skill_d10', 'limit_evidence')))
      .toEqual([expect.stringContaining("'no_such_skill_d10' does not exist")]);
  });
});

/** No runtime interpolates a rule confidence: a template or a severity word would misreport. */
describe('validate --contracts diagnostic confidence', () => {
  const withConfidence = (confidence: unknown): SkillDefinition => ({
    name: 'confidence_contract_probe', version: '1', type: 'composite',
    meta: {display_name: 'probe', description: 'probe'},
    steps: [{id: 'verdict', type: 'diagnostic', inputs: [], rules: [
      {condition: 'true', diagnosis: 'observed', confidence},
    ]} as any],
  });
  const confidenceErrors = (confidence: unknown) =>
    validateContracts(withConfidence(confidence)).errors.filter(error => error.includes('confidence'));

  it('accepts a literal level, a number, or no confidence', () => {
    for (const confidence of ['high', 'medium', 'low', 0.8, undefined]) {
      expect(confidenceErrors(confidence)).toEqual([]);
    }
  });

  it('rejects a template, a severity word and a non-finite number', () => {
    for (const confidence of ["${level === '高' ? 'high' : 'low'}", 'critical', Number.NaN]) {
      expect(confidenceErrors(confidence)).toEqual([
        expect.stringContaining('steps[0].rules[0].confidence: Diagnostic rule confidence must be high, medium, low or a number'),
      ]);
    }
  });
});
