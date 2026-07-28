// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildStrategyRegistrySnapshot,
  fingerprintStrategyDefinition,
  type StrategyRegistryContribution,
} from '../../agentv3/strategyLoader';
import type {
  RunManifestScope,
  SkillOverlayDeltaV1,
} from '../../types/selfEvolution';
import type {EnterpriseRepositoryScope} from '../enterpriseRepository';
import type {SkillOriginMetadata} from '../skillPacks/skillPackTypes';
import {
  getWorkspaceSkillRegistry,
  type WorkspaceSkillRegistryProviderOptions,
} from '../skillPacks/workspaceSkillRegistryProvider';
import type {VendorOverride} from '../skillEngine/skillLoader';
import type {SkillRegistryView} from '../skillEngine/skillAnalysisAdapter';
import type {SkillDefinition} from '../skillEngine/types';
import {canonicalContentHash} from './canonicalJson';
import {
  composeEffectiveSkills,
  type EffectiveSkillCompositionResult,
} from './effectiveSkillComposer';
import {
  currentEffectiveRuntimeRegistrySnapshot,
  type EffectiveRuntimeRegistrySnapshot,
  type ReadonlySkillRegistrySnapshot,
} from './effectiveRuntimeRegistryContext';
import {buildSkillRegistryAttribution} from './skillFingerprint';
import {currentRunManifestAttributionSink} from './runManifestLifecycle';
import {
  validateSkillDefinitionsInProcess,
  validateStrategyDefinitionsInProcess,
} from './inProcessValidator';

export interface BuildEffectiveRuntimeRegistrySnapshotInput {
  scope: EnterpriseRepositoryScope;
  skillOverlays?: readonly SkillOverlayDeltaV1[];
  strategyContributions?: readonly StrategyRegistryContribution[];
  workspaceOptions?: WorkspaceSkillRegistryProviderOptions;
}

const publishedByScope = new Map<string, EffectiveRuntimeRegistrySnapshot>();

function scopeKey(scope: RunManifestScope): string {
  return `${scope.tenantId}\0${scope.workspaceId}`;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function frozenJsonClone<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function findMatchingSkill(
  skills: readonly SkillDefinition[],
  question: string,
): SkillDefinition | undefined {
  const normalizedQuestion = question.toLowerCase();
  for (const skill of skills) {
    const keywords = skill.triggers?.keywords;
    const keywordList = Array.isArray(keywords)
      ? keywords
      : [
          ...(keywords?.zh ?? []),
          ...(keywords?.en ?? []),
        ];
    if (
      keywordList.some(keyword =>
        normalizedQuestion.includes(keyword.toLowerCase()))
    ) {
      return skill;
    }
    for (const pattern of skill.triggers?.patterns ?? []) {
      try {
        if (new RegExp(pattern, 'i').test(question)) return skill;
      } catch {
        // Invalid base patterns remain the loader/validator's responsibility.
      }
    }
  }
  return undefined;
}

function requireSuccessfulComposition(
  result: EffectiveSkillCompositionResult,
): Extract<EffectiveSkillCompositionResult, {validationState: 'passed'}> {
  if (result.validationState === 'passed') return result;
  const firstIssue = result.issues[0];
  throw new Error([
    'effective_skill_composition_failed',
    result.reason,
    firstIssue?.overlayId,
    firstIssue?.baseSkillId,
    firstIssue?.path,
  ].filter(Boolean).join(':'));
}

function buildReadonlySkillRegistry(input: {
  baseRegistry: Awaited<ReturnType<typeof getWorkspaceSkillRegistry>>['registry'];
  composition: Extract<
    EffectiveSkillCompositionResult,
    {validationState: 'passed'}
  >;
  overlayGeneration: string;
}): ReadonlySkillRegistrySnapshot {
  const skills = [...input.composition.skills];
  const byId = new Map(skills.map(skill => [skill.name, skill]));
  const fragments = new Map(input.baseRegistry.getFragmentCache());
  const origins = new Map<string, SkillOriginMetadata | undefined>(
    skills.map(skill => [
      skill.name,
      input.baseRegistry.getSkillOrigin(skill.name),
    ]),
  );
  const vendorOverrides = new Map<string, readonly VendorOverride[]>(
    skills.map(skill => [
      skill.name,
      frozenJsonClone(
        input.baseRegistry.getVendorOverridesForSkill(skill.name),
      ),
    ]),
  );
  let registryFingerprint = '';
  const snapshot: ReadonlySkillRegistrySnapshot = Object.freeze({
    get registryFingerprint(): string {
      return registryFingerprint;
    },
    overlayGeneration: input.overlayGeneration,
    isInitialized(): true {
      return true;
    },
    getSkill(name: string): SkillDefinition | undefined {
      return byId.get(name);
    },
    getAllSkills(): SkillDefinition[] {
      return [...skills];
    },
    getFragmentCache(): Map<string, string> {
      return new Map(fragments);
    },
    getSkillOrigin(name: string): SkillOriginMetadata | undefined {
      const origin = origins.get(name);
      return origin ? frozenJsonClone(origin) : undefined;
    },
    getAppliedOverlayIds(name: string): readonly string[] {
      return input.composition.appliedOverlayIds[name] ?? [];
    },
    getVendorOverride(skillId: string, vendor: string): VendorOverride | undefined {
      const override = vendorOverrides.get(skillId)
        ?.find(entry => entry.vendor.toLowerCase() === vendor.toLowerCase());
      return override ? frozenJsonClone(override) : undefined;
    },
    getVendorOverridesForSkill(skillId: string): VendorOverride[] {
      return [...(vendorOverrides.get(skillId) ?? [])]
        .map(override => frozenJsonClone(override));
    },
    findMatchingSkill(question: string): SkillDefinition | undefined {
      return findMatchingSkill(skills, question);
    },
  });
  registryFingerprint = buildSkillRegistryAttribution(snapshot)
    .registryFingerprint;
  return snapshot;
}

function deriveOverlayGeneration(input: {
  scope: RunManifestScope;
  baseSkillRegistryFingerprint: string;
  baseStrategyRegistryFingerprint: string;
  compositionFingerprint: string;
  effectiveStrategyRegistryFingerprint: string;
  hasContributions: boolean;
}): string {
  if (!input.hasContributions) {
    return `builtin:${input.baseSkillRegistryFingerprint}`;
  }
  return `overlay:${canonicalContentHash(input)}`;
}

export async function buildEffectiveRuntimeRegistrySnapshot(
  input: BuildEffectiveRuntimeRegistrySnapshotInput,
): Promise<EffectiveRuntimeRegistrySnapshot> {
  const scope: RunManifestScope = {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
  };
  const baseHandle = await getWorkspaceSkillRegistry(
    input.scope,
    input.workspaceOptions,
  );
  const skillOverlays = input.skillOverlays ?? [];
  const strategyContributions = input.strategyContributions ?? [];
  const composition = requireSuccessfulComposition(composeEffectiveSkills({
    scope,
    baseSkills: baseHandle.registry.getAllSkills(),
    fragments: baseHandle.registry.getFragmentCache(),
    overlays: skillOverlays,
  }));
  const affectedSkillIds = Object.keys(composition.appliedOverlayIds);
  if (affectedSkillIds.length > 0) {
    const validation = validateSkillDefinitionsInProcess({
      definitions: composition.skills,
      affectedSkillIds,
      fragmentCache: baseHandle.registry.getFragmentCache(),
    });
    if (!validation.valid) {
      const firstIssue = validation.issues.find(issue =>
        issue.severity === 'error');
      throw new Error([
        'effective_skill_validation_failed',
        firstIssue?.skillId,
        firstIssue?.code,
        firstIssue?.path,
      ].filter(Boolean).join(':'));
    }
  }
  const baseStrategySnapshot = buildStrategyRegistrySnapshot({
    scope,
    overlayGeneration: 'building:base',
  });
  const composedStrategySnapshot = buildStrategyRegistrySnapshot({
    scope,
    overlayGeneration: 'building:composed',
    contributions: strategyContributions,
  });
  const baseStrategies = new Map(
    baseStrategySnapshot.getAllStrategies().map(definition => [
      definition.scene,
      definition,
    ]),
  );
  const affectedScenes = composedStrategySnapshot.getAllStrategies()
    .filter(definition => {
      const base = baseStrategies.get(definition.scene);
      return !base
        || fingerprintStrategyDefinition(base)
          !== fingerprintStrategyDefinition(definition);
    })
    .map(definition => definition.scene);
  if (affectedScenes.length > 0) {
    const validation = validateStrategyDefinitionsInProcess({
      definitions: composedStrategySnapshot.getAllStrategies(),
      affectedScenes,
      knownSkillIds: new Set(
        composition.skills.map(definition => definition.name),
      ),
    });
    if (!validation.valid) {
      const firstIssue = validation.issues[0];
      throw new Error([
        'effective_strategy_validation_failed',
        firstIssue?.scene,
        firstIssue?.code,
        firstIssue?.path,
      ].filter(Boolean).join(':'));
    }
  }
  const overlayGeneration = deriveOverlayGeneration({
    scope,
    baseSkillRegistryFingerprint: baseHandle.registryFingerprint,
    baseStrategyRegistryFingerprint: baseStrategySnapshot.registryFingerprint,
    compositionFingerprint: composition.compositionFingerprint,
    effectiveStrategyRegistryFingerprint:
      composedStrategySnapshot.registryFingerprint,
    hasContributions:
      skillOverlays.length > 0 || strategyContributions.length > 0,
  });
  const strategyRegistry = buildStrategyRegistrySnapshot({
    scope,
    overlayGeneration,
    contributions: strategyContributions,
  });
  const skillRegistry = buildReadonlySkillRegistry({
    baseRegistry: baseHandle.registry,
    composition,
    overlayGeneration,
  });
  return Object.freeze({
    scope: deepFreeze({...scope}),
    baseSkillRegistryFingerprint: baseHandle.registryFingerprint,
    baseStrategyRegistryFingerprint: baseStrategySnapshot.registryFingerprint,
    overlayGeneration,
    skillRegistry,
    strategyRegistry,
  });
}

export function publishEffectiveRuntimeRegistrySnapshot(
  snapshot: EffectiveRuntimeRegistrySnapshot,
): EffectiveRuntimeRegistrySnapshot {
  const key = scopeKey(snapshot.scope);
  const current = publishedByScope.get(key);
  if (
    current
    && current.overlayGeneration === snapshot.overlayGeneration
    && current.skillRegistry.registryFingerprint
      === snapshot.skillRegistry.registryFingerprint
    && current.strategyRegistry.registryFingerprint
      === snapshot.strategyRegistry.registryFingerprint
  ) {
    return current;
  }
  publishedByScope.set(key, snapshot);
  return snapshot;
}

export async function getEffectiveRuntimeRegistrySnapshot(
  input: BuildEffectiveRuntimeRegistrySnapshotInput,
): Promise<EffectiveRuntimeRegistrySnapshot> {
  return publishEffectiveRuntimeRegistrySnapshot(
    await buildEffectiveRuntimeRegistrySnapshot(input),
  );
}

export function getPublishedEffectiveRuntimeRegistrySnapshot(
  scope: RunManifestScope,
): EffectiveRuntimeRegistrySnapshot | undefined {
  return publishedByScope.get(scopeKey(scope));
}

export function currentEffectiveSkillRegistry():
  | ReadonlySkillRegistrySnapshot
  | undefined {
  return currentEffectiveRuntimeRegistrySnapshot()?.skillRegistry;
}

export function resolveEffectiveSkillRegistryForRuntime(
  fallback: SkillRegistryView,
): SkillRegistryView {
  const current = currentEffectiveSkillRegistry();
  if (current) return current;
  if (currentRunManifestAttributionSink()) {
    throw new Error('effective_runtime_registry_snapshot_missing_for_run');
  }
  return fallback;
}

export function clearEffectiveRuntimeRegistrySnapshotsForTests(): void {
  publishedByScope.clear();
}
