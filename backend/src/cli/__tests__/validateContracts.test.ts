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
