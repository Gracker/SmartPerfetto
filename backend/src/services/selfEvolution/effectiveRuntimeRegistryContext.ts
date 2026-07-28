// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {AsyncLocalStorage} from 'async_hooks';

import type {StrategyDefinition} from '../../agentv3/strategyLoader';
import type {RunManifestScope} from '../../types/selfEvolution';
import type {SkillOriginMetadata} from '../skillPacks/skillPackTypes';
import type {VendorOverride} from '../skillEngine/skillLoader';
import type {SkillDefinition} from '../skillEngine/types';

export interface ReadonlySkillRegistrySnapshot {
  readonly registryFingerprint: string;
  readonly overlayGeneration: string;
  isInitialized(): true;
  getSkill(name: string): SkillDefinition | undefined;
  getAllSkills(): SkillDefinition[];
  getFragmentCache(): Map<string, string>;
  getSkillOrigin(name: string): SkillOriginMetadata | undefined;
  getAppliedOverlayIds(name: string): readonly string[];
  getVendorOverride(skillId: string, vendor: string): VendorOverride | undefined;
  getVendorOverridesForSkill(skillId: string): VendorOverride[];
  findMatchingSkill(question: string): SkillDefinition | undefined;
}

export interface ReadonlyStrategyRegistrySnapshot {
  readonly registryFingerprint: string;
  readonly overlayGeneration: string;
  getStrategy(scene: string): StrategyDefinition | undefined;
  getAllStrategies(): StrategyDefinition[];
}

export interface EffectiveRuntimeRegistrySnapshot {
  readonly scope: RunManifestScope;
  readonly baseSkillRegistryFingerprint: string;
  readonly baseStrategyRegistryFingerprint: string;
  readonly overlayGeneration: string;
  readonly skillRegistry: ReadonlySkillRegistrySnapshot;
  readonly strategyRegistry: ReadonlyStrategyRegistrySnapshot;
}

const context = new AsyncLocalStorage<EffectiveRuntimeRegistrySnapshot>();

export function currentEffectiveRuntimeRegistrySnapshot():
  | EffectiveRuntimeRegistrySnapshot
  | undefined {
  return context.getStore();
}

export function withEffectiveRuntimeRegistrySnapshot<T>(
  snapshot: EffectiveRuntimeRegistrySnapshot,
  callback: () => T,
): T {
  const inherited = currentEffectiveRuntimeRegistrySnapshot();
  if (
    inherited
    && (
      inherited.scope.tenantId !== snapshot.scope.tenantId
      || inherited.scope.workspaceId !== snapshot.scope.workspaceId
      || inherited.overlayGeneration !== snapshot.overlayGeneration
    )
  ) {
    throw new Error('effective_runtime_registry_snapshot_context_conflict');
  }
  return context.run(snapshot, callback);
}
