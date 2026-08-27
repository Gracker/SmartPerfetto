// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {describe, expect, it} from '@jest/globals';
import * as yaml from 'js-yaml';

import {
  loadSourceInvestigationPolicy,
  parseSourceInvestigationPolicy,
  resolveSourceInvestigationPolicy,
} from '../sourceInvestigationPolicy';
import {getRegisteredScenes, invalidateStrategyCache} from '../strategyLoader';

const POLICY_PATH = path.resolve(
  __dirname,
  '../../../strategies/source-investigation-policy.yaml',
);

function loadRawPolicy(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(POLICY_PATH, 'utf8')) as Record<string, unknown>;
}

describe('source investigation policy', () => {
  beforeEach(() => invalidateStrategyCache());

  it('loads the exact product policy defaults and five confirmed profiles', () => {
    const policy = loadSourceInvestigationPolicy();

    expect(policy.schemaVersion).toBe('source_investigation_policy@1');
    expect(policy.default).toEqual({
      eligibleAnchors: [
        'exact_symbol',
        'app_owned_slice',
        'native_frame',
        'binder_descriptor',
        'module_build_id',
      ],
      targetDomains: ['app_source', 'aosp', 'kernel_source', 'oem_sdk'],
      fallback: [
        'resolve_symbol',
        'code_pinpoint',
        'search_codebase',
        'read_or_indexed_lookup',
      ],
      stopStates: [
        'not_needed',
        'no_queryable_anchor',
        'ambiguous_candidates',
        'not_found_complete',
        'search_incomplete',
        'unverified',
      ],
    });
    expect(Object.keys(policy.profiles).sort()).toEqual([
      'anr',
      'interaction',
      'scroll_response',
      'scrolling',
      'startup',
    ]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.default.eligibleAnchors)).toBe(true);
  });

  it('resolves every discovered routable scene through the default policy', () => {
    const policy = loadSourceInvestigationPolicy();
    const registeredScenes = getRegisteredScenes().map(definition => definition.scene);

    expect(registeredScenes.length).toBeGreaterThan(0);
    for (const scene of registeredScenes) {
      const resolved = resolveSourceInvestigationPolicy(scene);
      expect(resolved).toBeDefined();
      expect(resolved).toEqual(expect.objectContaining({
        scene,
        targetDomains: policy.default.targetDomains,
        fallback: policy.default.fallback,
        stopStates: policy.default.stopStates,
      }));
      expect(resolved!.anchors).toEqual(expect.arrayContaining(
        [...policy.default.eligibleAnchors],
      ));
    }
    expect(resolveSourceInvestigationPolicy('not-a-routable-scene')).toBeUndefined();
  });

  it('rejects unknown profile scenes and extra schema keys', () => {
    const registeredScenes = getRegisteredScenes().map(definition => definition.scene);
    const unknownProfile = structuredClone(loadRawPolicy());
    const unknownProfiles = unknownProfile.profiles as Record<string, unknown>;
    unknownProfiles.not_a_scene = {anchors: ['exact_symbol']};

    expect(() => parseSourceInvestigationPolicy(unknownProfile, registeredScenes))
      .toThrow('source_investigation_policy_unknown_profile:not_a_scene');

    const extraKey = structuredClone(loadRawPolicy());
    (extraKey.default as Record<string, unknown>).unexpected = [];
    expect(() => parseSourceInvestigationPolicy(extraKey, registeredScenes))
      .toThrow('source_investigation_policy_invalid_default');
  });

  it('keeps every policy value in YAML rather than duplicating it in TypeScript constants', () => {
    const policy = loadSourceInvestigationPolicy();
    const policyValues = new Set([
      ...policy.default.eligibleAnchors,
      ...policy.default.targetDomains,
      ...policy.default.fallback,
      ...policy.default.stopStates,
      ...Object.values(policy.profiles).flatMap(profile => profile.anchors),
    ]);
    const productionSource = [
      '../sourceInvestigationPolicy.ts',
      '../scenePlanTemplates.ts',
      '../strategyLoader.ts',
    ].map(relativePath => fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8'))
      .join('\n');

    for (const value of policyValues) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(productionSource).not.toMatch(
        new RegExp(`[\\'\\"\\\`]${escaped}[\\'\\"\\\`]`),
      );
    }
  });
});
