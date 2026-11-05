// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {resolveAnalysisInvestigationRequirements} from '../analysisInvestigationRequirements';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes, parseInvestigationContract,
  parseInvestigationProfiles, type StrategyDefinition} from '../../agentv3/strategyLoader';

const registry = () => buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: 'test'});
function intent(pin: string, overrides: Partial<AnalysisTurnIntent> = {}): AnalysisTurnIntent {
  return {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'investigation', sceneId: 'startup',
    scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'answer', evidenceAccess: 'read_new',
    registryFingerprint: pin, ...overrides};
}

describe('pinned investigation requirements', () => {
  it('configures every built-in scene and only expands the selected scene profiles', () => {
    const pin = registry();
    for (const strategy of pin.getAllStrategies()) {
      const result = resolveAnalysisInvestigationRequirements({strategyRegistry: pin, intent: intent(pin.registryFingerprint, {sceneId: strategy.scene})});
      expect(result.status).toBe(strategy.strategyKind === 'contract_only' ? 'not_applicable' : 'resolved');
      expect(strategy.investigationContract).toBeDefined();
      if (strategy.strategyKind === 'normal') {
        expect(result.requirements.length).toBeGreaterThan(0);
        expect(new Set(result.requirements.map(requirement => requirement.id)).size).toBe(result.requirements.length);
      }
    }
    const startup = pin.getStrategy('startup')!.investigationContract!.requirements;
    expect(startup.map(requirement => requirement.id)).toContain('startup_critical_path');
    expect(startup.map(requirement => requirement.id)).not.toContain('game_critical_path');
    expect(startup.find(requirement => requirement.id === 'cpu_frequency')).toMatchObject({profileId: 'system_execution', profileVersion: 2,
      evidenceMetrics: ['system.cpu.frequency.time_weighted']});
  });

  it.each(['investigation', 'comparison'] as const)('keeps %s scope/access independent of budget/deliverable', taskKind => {
    const pin = registry();
    const resolve = (overrides: Partial<AnalysisTurnIntent>) => resolveAnalysisInvestigationRequirements({strategyRegistry: pin,
      intent: intent(pin.registryFingerprint, {taskKind, ...overrides})});
    const baseline = resolve({});
    for (const scope of ['bounded_question', 'scene_wide'] as const) {
      for (const evidenceAccess of ['existing_only', 'read_new'] as const) {
        for (const deliverable of ['answer', 'report'] as const) {
          const result = resolve({scope, evidenceAccess, deliverable, recommendedComplexity: 'quick'});
          expect(result).toMatchObject({status: 'resolved', scope, evidenceAccess, contractFingerprint: baseline.contractFingerprint});
          expect(result.requirements).toEqual(baseline.requirements);
          expect(result.requirements.find(requirement => requirement.id === 'cpu_frequency')?.condition?.kind).toBe('semantic');
        }
      }
    }
  });

  it.each(['fact', 'acknowledgement'] as const)('exempts %s without an evidence scan', taskKind => {
    const pin = registry();
    expect(resolveAnalysisInvestigationRequirements({strategyRegistry: pin, intent: intent(pin.registryFingerprint, {taskKind})}))
      .toMatchObject({status: 'not_applicable', requirements: []});
  });

  it('leaves missing pins, unresolved intent and legacy obligations not_checked', () => {
    const pin = registry();
    expect(resolveAnalysisInvestigationRequirements({}).status).toBe('not_checked');
    expect(resolveAnalysisInvestigationRequirements({strategyRegistry: pin, intent: intent('stale')}))
      .toMatchObject({status: 'not_checked', reason: 'registry_fingerprint_mismatch'});
    expect(resolveAnalysisInvestigationRequirements({strategyRegistry: pin, intent: intent(pin.registryFingerprint, {status: 'unavailable'})}))
      .toMatchObject({status: 'not_checked', reason: 'intent_unavailable'});
    const {investigationContract: _contract, ...legacyDefinition} = pin.getStrategy('startup')!;
    const legacy: StrategyDefinition = {...legacyDefinition, investigationRequirements: ['Old guidance']};
    const old = buildStrategyRegistrySnapshotFromDefinitions({definitions: [legacy], overlayGeneration: 'old'});
    expect(resolveAnalysisInvestigationRequirements({strategyRegistry: old, intent: intent(old.registryFingerprint)}))
      .toMatchObject({status: 'not_checked', requirements: [], legacyRequirements: ['Old guidance'], reason: 'legacy_requirements_only'});
  });

  it('deep clones profile refs, semantic conditions and metric IDs and hashes profile changes', () => {
    const definition = getRegisteredScenes().find(item => item.scene === 'startup')!;
    const mutable: StrategyDefinition = {...definition, investigationContract: JSON.parse(JSON.stringify(definition.investigationContract))};
    const pin = buildStrategyRegistrySnapshotFromDefinitions({definitions: [mutable], overlayGeneration: 'one'});
    const contract = pin.getStrategy('startup')!.investigationContract!;
    const before = JSON.stringify(contract);
    mutable.investigationContract!.requirements[0].description = 'Changed profile meaning';
    mutable.investigationContract!.profileRefs[0].version = 2;
    expect(JSON.stringify(contract)).toBe(before);
    expect(Object.isFrozen(contract.requirements[0].condition)).toBe(true);
    expect(Object.isFrozen(contract.requirements[0].evidenceMetrics)).toBe(true);
    const mutableEntry = mutable.investigationContract!.requirements.find(requirement => requirement.entryAcquisition)!.entryAcquisition!;
    const frozenEntry = contract.requirements.find(requirement => requirement.entryAcquisition)!.entryAcquisition!;
    (mutableEntry.params as Record<string, string>).start_ts = 'selected_end';
    expect(frozenEntry.params.start_ts).toBe('selected_start');
    expect(Object.isFrozen(frozenEntry.params)).toBe(true);
    expect(buildStrategyRegistrySnapshotFromDefinitions({definitions: [mutable], overlayGeneration: 'one'}).registryFingerprint)
      .not.toBe(pin.registryFingerprint);
  });
});

describe('strict investigation profile configuration', () => {
  const selectedEntry = {schema_version: 1, metric_id: 'work.duration', subject_binding: 'selected_thread_interval',
    params: {start_ts: 'selected_start', end_ts: 'selected_end', upid: 'selected_upid', utid: 'selected_utid'}};
  it('parses the closed selected-thread entry declaration without changing the evidence obligation', () => {
    const raw = {schema_version: 1, requirements: [{id: 'selected_work', domain: 'execution', description: 'Explain work',
      evidence_metrics: ['fixture.work'], entry_acquisition: {schema_version: 1, metric_id: 'fixture.work',
        subject_binding: 'selected_thread_interval', params: {start_ts: 'selected_start', end_ts: 'selected_end',
          upid: 'selected_upid', utid: 'selected_utid'}}}]};
    expect(parseInvestigationContract(raw, new Map())?.requirements[0]).toMatchObject({
      evidenceMetrics: ['fixture.work'], entryAcquisition: {schemaVersion: 1, metricId: 'fixture.work',
        subjectBinding: 'selected_thread_interval', params: raw.requirements[0].entry_acquisition.params}});
  });

  const requirement = {id: 'observed_work', domain: 'execution', description: 'Explain observed work', evidence_metrics: ['work.duration']};
  const profiles = () => parseInvestigationProfiles({schema_version: 1, profiles: {shared: {version: 1, requirements: [requirement]}}});
  it.each([
    null, {...selectedEntry, schema_version: 2}, {...selectedEntry, metric_id: 'unrelated'},
    {...selectedEntry, subject_binding: 'whole_trace'}, {...selectedEntry, extra: true},
    {...selectedEntry, params: {...selectedEntry.params, literal: 123}},
    {...selectedEntry, params: {...selectedEntry.params, package: 'user_target'}},
    {...selectedEntry, params: {...selectedEntry.params, utid: 'selected_upid'}},
    {...selectedEntry, params: {start_ts: 'selected_start', end_ts: 'selected_end', upid: 'selected_upid'}},
    {...selectedEntry, params: {'Bad-Name': 'selected_start', end_ts: 'selected_end', upid: 'selected_upid', utid: 'selected_utid'}},
    {...selectedEntry, params: {'start_ts\n': 'selected_start', end_ts: 'selected_end', upid: 'selected_upid', utid: 'selected_utid'}},
  ])('rejects an open or incomplete entry acquisition shape %#', entry_acquisition => {
    expect(() => parseInvestigationContract({schema_version: 1, requirements: [{...requirement, entry_acquisition}]}, new Map()))
      .toThrow('strategy_invalid_entry_acquisition');
  });

  it('preserves normalized identical shared/local and cross-profile dedupe before counting minimum entries', () => {
    const entryRequirement = {...requirement, entry_acquisition: selectedEntry};
    const reordered = {...entryRequirement, entry_acquisition: {...selectedEntry,
      params: {utid: 'selected_utid', upid: 'selected_upid', end_ts: 'selected_end', start_ts: 'selected_start'}}};
    const shared = parseInvestigationProfiles({schema_version: 1, profiles: {
      a: {version: 2, requirements: [entryRequirement]}, b: {version: 2, requirements: [reordered]},
    }});
    const contract = parseInvestigationContract({schema_version: 1, profiles: [{id: 'a', version: 2}, {id: 'b', version: 2}],
      requirements: [reordered]}, shared);
    expect(contract?.requirements).toHaveLength(1);
    expect(contract?.requirements[0].entryAcquisition?.metricId).toBe('work.duration');
    expect(() => parseInvestigationContract({schema_version: 1, profiles: [{id: 'a', version: 1}]}, shared))
      .toThrow('strategy_investigation_profile_unavailable');
    expect(() => parseInvestigationContract({schema_version: 1, requirements: [entryRequirement, entryRequirement]}, shared))
      .toThrow('strategy_duplicate_investigation_requirement');
    expect(() => parseInvestigationContract({schema_version: 1, profiles: [{id: 'a', version: 2}],
      requirements: [{...entryRequirement, entry_acquisition: {...selectedEntry,
        params: {begin: 'selected_start', end_ts: 'selected_end', upid: 'selected_upid', utid: 'selected_utid'}}}]}, shared))
      .toThrow('strategy_conflicting_investigation_requirement');
  });

  it('rejects multiple entries in an unused profile and after distinct requirements are merged', () => {
    const a = {...requirement, entry_acquisition: selectedEntry};
    const b = {...a, id: 'other_work'};
    expect(() => parseInvestigationProfiles({schema_version: 1, profiles: {unused: {version: 1, requirements: [a, b]}}}))
      .toThrow('strategy_multiple_entry_acquisitions');
    const shared = parseInvestigationProfiles({schema_version: 1, profiles: {
      a: {version: 1, requirements: [a]}, b: {version: 1, requirements: [b]},
    }});
    expect(() => parseInvestigationContract({schema_version: 1, profiles: [{id: 'a', version: 1}, {id: 'b', version: 1}]}, shared))
      .toThrow('strategy_multiple_entry_acquisitions');
  });
  it('expands and deduplicates identical declarations without silently overriding meanings', () => {
    const contract = parseInvestigationContract({schema_version: 1, profiles: [{id: 'shared', version: 1}], requirements: [requirement]}, profiles());
    expect(contract?.requirements).toHaveLength(1);
    expect(contract?.requirements[0]).toMatchObject({profileId: 'shared', profileVersion: 1, required: true});
    expect(() => parseInvestigationContract({schema_version: 1, profiles: [{id: 'shared', version: 1}],
      requirements: [{...requirement, description: 'Conflicting meaning'}]}, profiles())).toThrow('conflicting');
  });
  it.each([
    {schema_version: 2}, {schema_version: 1, profiles: [{id: 'missing', version: 1}]},
    {schema_version: 1, profiles: [{id: 'shared', version: 2}]},
    {schema_version: 1, profiles: [{id: 'shared', version: 1}, {id: 'shared', version: 1}]},
    {schema_version: 1, requirements: [requirement, requirement]},
    {schema_version: 1, requirements: [{...requirement, condition: {kind: 'semantic', description: ''}}]},
    {schema_version: 1, requirements: [{...requirement, evidence_metrics: ['same', 'same']}]},
    {schema_version: 1, requirements: [requirement], not_applicable_reason: 'Exempt'},
  ])('rejects malformed or conflicting declarations %#', declaration => {
    expect(() => parseInvestigationContract(declaration, profiles())).toThrow();
  });
  it('keeps absent legacy contracts readable and rejects invalid profiles before loading scenes', () => {
    expect(parseInvestigationContract(undefined, profiles())).toBeUndefined();
    expect(() => parseInvestigationProfiles({schema_version: 1, profiles: {shared: {version: 0, requirements: [requirement]}}})).toThrow();
    expect(() => parseInvestigationProfiles({schema_version: 1, profiles: {shared: {version: 1, requirements: [requirement, requirement]}}})).toThrow();
  });
});
