// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {loadStrategyYaml} from '../../agentv3/strategyLoader';
import {exactKeys, isRecord, positiveInteger} from './policyYaml';

const POLICY_ASSET_NAME = 'analysis-source-activation-policy';
const POLICY_SCHEMA_VERSION = 'analysis_source_activation_policy@3' as const;

export type AnalysisSourceActivation =
  | 'dormant'
  | 'bounded_explicit'
  | 'deep_supplement';

export interface AnalysisSourceActivationPolicy {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly safeReplay: {
    readonly maxTurns: number;
    readonly maxCharsPerEntry: number;
  };
}

interface AnalysisSourcePolicyInput {
  query: string;
  analysisMode?: AnalysisOptions['analysisMode'];
  hasAuthorizedCodebase?: boolean;
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: readonly string[];
}

export function parseAnalysisSourceActivationPolicy(value: unknown): AnalysisSourceActivationPolicy {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schema_version', 'safe_replay']) ||
    value.schema_version !== POLICY_SCHEMA_VERSION
  ) {
    throw new Error('analysis_source_activation_policy_invalid_root');
  }
  if (
    !isRecord(value.safe_replay) ||
    !exactKeys(value.safe_replay, ['max_turns', 'max_chars_per_entry'])
  ) {
    throw new Error('analysis_source_activation_policy_invalid_safe_replay');
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    safeReplay: Object.freeze({
      maxTurns: positiveInteger(
        value.safe_replay.max_turns,
        'analysis_source_activation_policy_invalid_safe_replay',
      ),
      maxCharsPerEntry: positiveInteger(
        value.safe_replay.max_chars_per_entry,
        'analysis_source_activation_policy_invalid_safe_replay',
      ),
    }),
  });
}

export function loadAnalysisSourceActivationPolicy(): AnalysisSourceActivationPolicy {
  const policy = loadStrategyYaml(
    POLICY_ASSET_NAME,
    parseAnalysisSourceActivationPolicy,
  );
  if (!policy) throw new Error('analysis_source_activation_policy_missing');
  return policy;
}

export function hasAuthorizedCodebase(input: Pick<
  AnalysisSourcePolicyInput,
  'hasAuthorizedCodebase' | 'codeAwareMode' | 'codebaseIds'
>): boolean {
  return input.hasAuthorizedCodebase !== false &&
    (input.codeAwareMode === 'metadata_only' || input.codeAwareMode === 'provider_send') &&
    Boolean(input.codebaseIds?.length);
}

export function resolveAnalysisSourceActivation(
  input: AnalysisSourcePolicyInput,
): AnalysisSourceActivation {
  return hasAuthorizedCodebase(input) ? 'bounded_explicit' : 'dormant';
}

export function projectPrimaryAnalysisOptions<T extends AnalysisOptions>(
  options: T,
  _activation: AnalysisSourceActivation,
): T {
  // Source selection is caller authorization, independent of analysis wording or mode.
  // Keep caller policy intact: adding a policy also changes the MCP tool surface.
  return options;
}
