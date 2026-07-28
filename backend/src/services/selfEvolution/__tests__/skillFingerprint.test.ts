// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {SkillDefinition} from '../../skillEngine/types';
import {buildSkillRegistryAttribution, fingerprintSkillDefinition} from '../skillFingerprint';

function skill(sql = 'select 1'): SkillDefinition {
  return {
    name: 'stable_skill',
    version: '1.0.0',
    type: 'atomic',
    meta: {
      display_name: 'Stable skill',
      description: 'Tests canonical attribution.',
    },
    sql,
    steps: [{
      id: 'fragment_step',
      type: 'atomic',
      sql: 'select * from {{shared_filter}}',
      sql_fragments: ['shared_filter'],
    }],
  };
}

describe('skillFingerprint', () => {
  it('changes for semantic Skill or referenced fragment content changes', () => {
    const fragments = new Map([['shared_filter', 'x = 1']]);
    const base = fingerprintSkillDefinition(skill(), fragments);

    expect(fingerprintSkillDefinition(skill('select 2'), fragments)).not.toBe(base);
    expect(fingerprintSkillDefinition(
      skill(),
      new Map([['shared_filter', 'x = 2']]),
    )).not.toBe(base);
  });

  it('keeps registry attribution stable across enumeration order and source paths', () => {
    const definitions = [skill(), {...skill('select 2'), name: 'other_skill'}];
    const fragments = new Map([['shared_filter', 'x = 1']]);
    const registry = (reverse: boolean, sourceRoot: string) => ({
      getAllSkills: () => reverse ? [...definitions].reverse() : definitions,
      getFragmentCache: () => fragments,
      getSkillOrigin: (skillId: string) => skillId === 'other_skill'
        ? {
            origin: 'external_pack' as const,
            packId: 'pack-a',
            packVersion: '1',
            trustState: 'approved' as const,
            sourcePath: `${sourceRoot}/${skillId}.skill.yaml`,
          }
        : {
            origin: 'built_in' as const,
            sourcePath: `${sourceRoot}/${skillId}.skill.yaml`,
          },
    });

    expect(buildSkillRegistryAttribution(registry(false, '/first'))).toEqual(
      buildSkillRegistryAttribution(registry(true, '/moved')),
    );
  });

  it('fails closed when a referenced fragment is missing', () => {
    expect(() => fingerprintSkillDefinition(skill(), new Map())).toThrow(
      'skill_fragment_missing:stable_skill:shared_filter',
    );
  });
});
