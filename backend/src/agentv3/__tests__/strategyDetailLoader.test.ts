// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  buildStrategyRegistrySnapshotFromDefinitions,
  defaultStrategyDetail,
  getRegisteredScenes,
  parseEntrySkill,
  getStrategyContent,
  getStrategyDetails,
  getStrategyDetailByRef,
} from '../strategyLoader';

describe('strategy detail loader', () => {
  it('keeps every normal strategy split into core plus on-demand detail', () => {
    for (const scene of getRegisteredScenes().map(def => def.scene)) {
      const core = getStrategyContent(scene) || '';
      const details = getStrategyDetails(scene);
      expect(core).toContain('Core Strategy');
      expect(core).not.toContain('<!-- strategy-detail');
      expect(details.length).toBeGreaterThan(0);
    }
  });

  it('resolves explicit detail references from the supplied registry pin', () => {
    const definitions = getRegisteredScenes();
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions, overlayGeneration: 'explicit-detail'});
    for (const definition of registry.getAllStrategies()) {
      for (const detail of definition.detailSections) {
        expect(getStrategyDetailByRef(detail.ref, undefined, registry)).toEqual(detail);
        expect(getStrategyDetailByRef(detail.id, definition.scene, registry)).toEqual(detail);
      }
    }
    const empty = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'empty-detail-pin'});
    const existingRef = definitions.find(definition => definition.detailSections.length)!.detailSections[0].ref;
    expect(getStrategyDetailByRef(existingRef, undefined, empty)).toBeUndefined();
  });

  it('exposes the author-designated default detail of a pinned strategy', () => {
    const registry = buildStrategyRegistrySnapshotFromDefinitions({
      definitions: getRegisteredScenes(), overlayGeneration: 'default-detail',
    });
    for (const definition of registry.getAllStrategies()) {
      const detail = defaultStrategyDetail(definition);
      expect(detail).toEqual(definition.detailSections.find(section => section.default));
    }
    expect(defaultStrategyDetail(registry.getStrategy('startup'))?.id).toBe('overview_timing');
    expect(defaultStrategyDetail({detailSections: []})).toBeUndefined();
    expect(defaultStrategyDetail(undefined)).toBeUndefined();
  });
});

describe('entry_skill frontmatter', () => {
  it('parses closed bindings and is absent when not declared', () => {
    expect(parseEntrySkill(undefined)).toBeUndefined();
    expect(parseEntrySkill({id: 'scrolling_analysis', params: {package: 'focus_app', start_ts: 'trace_start'}}))
      .toEqual({id: 'scrolling_analysis', params: {package: 'focus_app', start_ts: 'trace_start'}});
    expect(parseEntrySkill({id: 'anr_analysis'})).toEqual({id: 'anr_analysis', params: {}});
  });

  it.each([
    ['a non-object', 'scrolling_analysis'],
    ['an unknown key', {id: 'scrolling_analysis', when: 'always'}],
    ['a malformed id', {id: 'Scrolling Analysis'}],
    ['a literal value', {id: 'scrolling_analysis', params: {package: 'com.example'}}],
    ['two start bindings', {id: 'scrolling_analysis', params: {start_ts: 'trace_start', begin_ts: 'selection_start'}}],
  ])('refuses %s', (_label, value) => {
    expect(() => parseEntrySkill(value)).toThrow('strategy_invalid_entry_skill');
  });

  it('keeps the declaration through the frozen registry pin and its fingerprint', () => {
    const definitions = getRegisteredScenes().map(definition => definition.scene === 'general'
      ? {...definition, entrySkill: {id: 'cpu_analysis', params: {}}} : definition);
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions, overlayGeneration: 'entry-skill'});
    const plain = buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: 'entry-skill'});
    expect(registry.getStrategy('general')?.entrySkill).toEqual({id: 'cpu_analysis', params: {}});
    expect(Object.isFrozen(registry.getStrategy('general')?.entrySkill?.params)).toBe(true);
    expect(registry.registryFingerprint).not.toBe(plain.registryFingerprint);
  });
});
