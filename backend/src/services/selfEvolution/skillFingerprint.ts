// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SkillDefinition} from '../skillEngine/types';
import type {SkillOriginMetadata} from '../skillPacks/skillPackTypes';
import type {
  RunSkillDefinitionAttribution,
  RunSkillRegistryAttribution,
} from '../../types/selfEvolution';
import {canonicalContentHash} from './canonicalJson';

export interface SkillFingerprintRegistry {
  getAllSkills(): SkillDefinition[];
  getSkillOrigin(skillId: string): SkillOriginMetadata | undefined;
  getFragmentCache(): Map<string, string>;
  getAppliedOverlayIds?(skillId: string): readonly string[];
  readonly overlayGeneration?: string;
}

function collectFragmentKeys(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(entry => collectFragmentKeys(entry, out));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === 'fragments' || key === 'sql_fragments')
      && Array.isArray(entry)
    ) {
      for (const fragment of entry) {
        if (typeof fragment === 'string' && fragment.trim()) {
          out.add(fragment.trim());
        }
      }
      continue;
    }
    collectFragmentKeys(entry, out);
  }
}

function originAttribution(
  skillId: string,
  origin: SkillOriginMetadata | undefined,
): Omit<RunSkillDefinitionAttribution, 'skillId' | 'version' | 'contentFingerprint'> {
  if (origin?.origin === 'external_pack') {
    return {
      origin: 'external_pack',
      ...(origin.packId ? {packId: origin.packId} : {}),
      ...(origin.packVersion ? {packVersion: origin.packVersion} : {}),
      ...(origin.trustState ? {trustState: origin.trustState} : {}),
    };
  }
  if (origin?.origin && origin.origin !== 'built_in') {
    throw new Error(`unsupported_skill_origin:${skillId}:${origin.origin}`);
  }
  return {origin: 'built_in'};
}

export function fingerprintSkillDefinition(
  skill: SkillDefinition,
  fragments: ReadonlyMap<string, string> = new Map(),
): string {
  const fragmentKeys = new Set<string>();
  collectFragmentKeys(skill, fragmentKeys);
  const referencedFragments = [...fragmentKeys]
    .sort()
    .map(id => {
      const content = fragments.get(id);
      if (content === undefined) {
        throw new Error(`skill_fragment_missing:${skill.name}:${id}`);
      }
      return {id, contentHash: canonicalContentHash(content)};
    });
  return canonicalContentHash({
    definition: skill,
    referencedFragments,
  });
}

export function buildSkillRegistryAttribution(
  registry: SkillFingerprintRegistry,
): RunSkillRegistryAttribution {
  const fragments = registry.getFragmentCache();
  const skills = registry.getAllSkills()
    .map(skill => {
      const appliedOverlayIds = [
        ...(registry.getAppliedOverlayIds?.(skill.name) ?? []),
      ].sort();
      return {
        skillId: skill.name,
        version: skill.version,
        contentFingerprint: fingerprintSkillDefinition(skill, fragments),
        ...(appliedOverlayIds.length > 0
          ? {origin: 'evolution_overlay' as const}
          : originAttribution(skill.name, registry.getSkillOrigin(skill.name))),
        appliedOverlayIds,
      };
    })
    .sort((a, b) => a.skillId.localeCompare(b.skillId));
  const allFragments = [...fragments.entries()]
    .map(([id, content]) => ({id, contentHash: canonicalContentHash(content)}))
    .sort((a, b) => a.id.localeCompare(b.id));
  const registryFingerprint = canonicalContentHash({
    skills,
    fragments: allFragments,
  });
  return {
    registryFingerprint,
    evolutionOverlayGeneration:
      registry.overlayGeneration ?? `builtin:${registryFingerprint}`,
    skills,
  };
}

export const __testing = {
  collectFragmentKeys,
};
