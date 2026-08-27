// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  getRegisteredScenes,
  loadStrategyYaml,
} from './strategyLoader';

const POLICY_ASSET_NAME = 'source-investigation-policy';
const POLICY_SCHEMA_VERSION = 'source_investigation_policy@1' as const;

export interface SourceInvestigationDefaults {
  eligibleAnchors: readonly string[];
  targetDomains: readonly string[];
  fallback: readonly string[];
  stopStates: readonly string[];
}

export interface SourceInvestigationProfile {
  anchors: readonly string[];
}

export interface SourceInvestigationPolicy {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  default: SourceInvestigationDefaults;
  profiles: Readonly<Record<string, SourceInvestigationProfile>>;
}

export interface ResolvedSourceInvestigationPolicy {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  scene: string;
  anchors: readonly string[];
  targetDomains: readonly string[];
  fallback: readonly string[];
  stopStates: readonly string[];
}

export interface SourceInvestigationPlanAspect {
  id: string;
  matchKeywords: string[];
  suggestion: string;
  waivable: false;
  decisionStatuses: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actualKeys.length === expected.length &&
    actualKeys.every((key, index) => key === expected[index]);
}

function parseIdentifierArray(value: unknown, errorCode: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(errorCode);
  const identifiers = value.map(entry => {
    if (
      typeof entry !== 'string' ||
      !/^[a-z][a-z0-9_]{0,79}$/.test(entry)
    ) {
      throw new Error(errorCode);
    }
    return entry;
  });
  if (new Set(identifiers).size !== identifiers.length) throw new Error(errorCode);
  return Object.freeze(identifiers);
}

export function parseSourceInvestigationPolicy(
  value: unknown,
  routableSceneIds: readonly string[],
): SourceInvestigationPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schema_version', 'default', 'profiles']) ||
    value.schema_version !== POLICY_SCHEMA_VERSION
  ) {
    throw new Error('source_investigation_policy_invalid_root');
  }
  if (
    !isRecord(value.default) ||
    !hasExactKeys(value.default, [
      'eligible_anchors',
      'target_domains',
      'fallback',
      'stop_states',
    ])
  ) {
    throw new Error('source_investigation_policy_invalid_default');
  }
  if (!isRecord(value.profiles) || Object.keys(value.profiles).length === 0) {
    throw new Error('source_investigation_policy_invalid_profiles');
  }

  const registeredScenes = new Set(routableSceneIds);
  const profiles: Record<string, SourceInvestigationProfile> = {};
  for (const [scene, rawProfile] of Object.entries(value.profiles).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (!registeredScenes.has(scene)) {
      throw new Error(`source_investigation_policy_unknown_profile:${scene}`);
    }
    if (!isRecord(rawProfile) || !hasExactKeys(rawProfile, ['anchors'])) {
      throw new Error(`source_investigation_policy_invalid_profile:${scene}`);
    }
    profiles[scene] = Object.freeze({
      anchors: parseIdentifierArray(
        rawProfile.anchors,
        `source_investigation_policy_invalid_profile:${scene}`,
      ),
    });
  }

  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    default: Object.freeze({
      eligibleAnchors: parseIdentifierArray(
        value.default.eligible_anchors,
        'source_investigation_policy_invalid_default',
      ),
      targetDomains: parseIdentifierArray(
        value.default.target_domains,
        'source_investigation_policy_invalid_default',
      ),
      fallback: parseIdentifierArray(
        value.default.fallback,
        'source_investigation_policy_invalid_default',
      ),
      stopStates: parseIdentifierArray(
        value.default.stop_states,
        'source_investigation_policy_invalid_default',
      ),
    }),
    profiles: Object.freeze(profiles),
  });
}

export function loadSourceInvestigationPolicy(): SourceInvestigationPolicy {
  const policy = loadStrategyYaml(
    POLICY_ASSET_NAME,
    value => parseSourceInvestigationPolicy(
      value,
      getRegisteredScenes().map(definition => definition.scene),
    ),
  );
  if (!policy) throw new Error('source_investigation_policy_missing');
  return policy;
}

export function resolveSourceInvestigationPolicy(
  scene: string,
): ResolvedSourceInvestigationPolicy | undefined {
  const registeredScenes = new Set(
    getRegisteredScenes().map(definition => definition.scene),
  );
  if (!registeredScenes.has(scene)) return undefined;

  const policy = loadSourceInvestigationPolicy();
  const profileAnchors = policy.profiles[scene]?.anchors ?? [];
  return Object.freeze({
    schemaVersion: policy.schemaVersion,
    scene,
    anchors: Object.freeze([
      ...new Set([...policy.default.eligibleAnchors, ...profileAnchors]),
    ]),
    targetDomains: policy.default.targetDomains,
    fallback: policy.default.fallback,
    stopStates: policy.default.stopStates,
  });
}

export function buildSourceInvestigationPlanAspect(
  scene: string,
): SourceInvestigationPlanAspect | undefined {
  const policy = resolveSourceInvestigationPolicy(scene);
  if (!policy) return undefined;
  const schemaName = policy.schemaVersion.slice(0, policy.schemaVersion.indexOf('@'));
  const id = `${schemaName.replace(/_policy$/, '')}_decision`;
  return {
    id,
    matchKeywords: [],
    suggestion: JSON.stringify({
      schema_version: policy.schemaVersion,
      eligible_anchors: policy.anchors,
      target_domains: policy.targetDomains,
      fallback: policy.fallback,
      stop_states: policy.stopStates,
    }),
    waivable: false,
    decisionStatuses: policy.stopStates,
  };
}
