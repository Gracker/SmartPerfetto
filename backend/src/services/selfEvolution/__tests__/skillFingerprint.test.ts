// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {SkillDefinition} from '../../skillEngine/types';
import {buildSkillRegistryAttribution, fingerprintSkillDefinition, skillRegistryCacheKey} from '../skillFingerprint';
import {causeWordingReaders, registryCauseWordingReaders} from '../../skillEngine/causeWordingEvidence';
import {exactProcessScopeSupportCatalog} from '../../skillEngine/processScopeSql';

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

/**
 * State derived from a whole registry is computed once per registry content:
 * the evidence readers by skillRegistryCacheKey, the exact scope catalog by the
 * attribution fingerprint its caller holds. A changed registry is a new key.
 */
describe('registry-derived caches', () => {
  const capReader = (name: string, sql: string): SkillDefinition => ({
    name, version: '1', type: 'composite', meta: {display_name: name, description: name},
    steps: [{id: 'read', type: 'atomic', sql}],
  } as SkillDefinition);
  const reader = capReader('cap_reader', 'SELECT * FROM cpufreq_limit');
  const plain = capReader('plain', 'SELECT 1 AS n');

  it('keys a registry by its content, not its objects or order', () => {
    const key = skillRegistryCacheKey([reader, plain]);
    expect(skillRegistryCacheKey([structuredClone(plain), structuredClone(reader)])).toBe(key);
    expect(skillRegistryCacheKey([reader, capReader('plain', 'SELECT 2 AS n')])).not.toBe(key);
    expect(skillRegistryCacheKey([reader, plain], new Map([['fragments/a.sql', 'a']]))).not.toBe(key);
    // A missing fragment is no error for the key.
    expect(() => skillRegistryCacheKey([skill()])).not.toThrow();
  });

  it('computes the evidence readers once per registry content', () => {
    const readers = registryCauseWordingReaders([reader, plain]);
    expect(readers.named.cap.has('cap_reader')).toBe(true);
    expect(registryCauseWordingReaders([structuredClone(reader), structuredClone(plain)])).toBe(readers);
    // Another registry is another key: the readers follow its content.
    const changed = registryCauseWordingReaders([capReader('cap_reader', 'SELECT 1 AS n'), plain]);
    expect(changed).not.toBe(readers);
    expect(changed.named.cap.has('cap_reader')).toBe(false);
    expect(changed).toEqual(causeWordingReaders([capReader('cap_reader', 'SELECT 1 AS n'), plain]));
  });

  it('computes the exact scope catalog once per registry fingerprint, and afresh without one', () => {
    const scoped = {name: 'scoped', version: '1', type: 'atomic', meta: {display_name: 'scoped', description: 'scoped'},
      sql: 'SELECT * FROM process WHERE upid = ${__process_scope.upid}',
      process_scope: {role: 'target', binding: 'native_upid'}} as unknown as SkillDefinition;
    const registry = new Map([[scoped.name, scoped], [plain.name, plain]]);
    const fingerprint = (definitions: SkillDefinition[]) => buildSkillRegistryAttribution({
      getAllSkills: () => definitions, getSkillOrigin: () => undefined, getFragmentCache: () => new Map(),
    }).registryFingerprint;
    const catalog = exactProcessScopeSupportCatalog(registry, new Map(), {registryFingerprint: fingerprint([scoped, plain])});
    expect(catalog.get('scoped')).toEqual({supported: true});
    expect(catalog.get('plain')?.supported).toBe(false);
    expect(Object.isFrozen(catalog.get('scoped'))).toBe(true);
    expect(exactProcessScopeSupportCatalog(new Map(registry), new Map(), {registryFingerprint: fingerprint([scoped, plain])}))
      .toBe(catalog);
    // A changed registry has another fingerprint and its own catalog.
    const {process_scope: _scope, ...unscoped} = scoped;
    const changed = exactProcessScopeSupportCatalog(new Map([[unscoped.name, unscoped]]), new Map(),
      {registryFingerprint: fingerprint([unscoped as SkillDefinition])});
    expect(changed.get('scoped')?.supported).toBe(false);
    expect(exactProcessScopeSupportCatalog(registry, new Map())).not.toBe(catalog);
    expect(exactProcessScopeSupportCatalog(registry, new Map())).toEqual(catalog);
  });
});
