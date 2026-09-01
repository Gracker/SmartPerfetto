// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {loadStrategyYaml} from '../../agentv3/strategyLoader';

const POLICY_ASSET_NAME = 'analysis-source-activation-policy';
const POLICY_SCHEMA_VERSION = 'analysis_source_activation_policy@1' as const;

export type AnalysisSourceActivation =
  | 'dormant'
  | 'bounded_explicit'
  | 'deep_supplement';

export interface AnalysisSourceBudget {
  readonly maxSearchCalls: number;
  readonly maxReadCalls: number;
  readonly maxDurationMs: number;
}

export interface AnalysisSourceActivationPolicy {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly boundedExplicit: AnalysisSourceBudget;
  readonly safeReplay: {
    readonly maxTurns: number;
    readonly maxCharsPerEntry: number;
  };
  readonly explicitPatterns: readonly RegExp[];
  readonly deepPatterns: readonly RegExp[];
}

interface AnalysisSourcePolicyInput {
  query: string;
  analysisMode?: AnalysisOptions['analysisMode'];
  hasAuthorizedCodebase?: boolean;
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function positiveInteger(value: unknown, errorCode: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(errorCode);
  return Number(value);
}

function compilePatterns(
  value: unknown,
  errorCode: string,
  flags = 'i',
): readonly RegExp[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(errorCode);
  const patterns = value.map(entry => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error(errorCode);
    try {
      return new RegExp(entry, flags);
    } catch {
      throw new Error(errorCode);
    }
  });
  return Object.freeze(patterns);
}

export function parseAnalysisSourceActivationPolicy(value: unknown): AnalysisSourceActivationPolicy {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schema_version', 'bounded_explicit', 'safe_replay', 'intent']) ||
    value.schema_version !== POLICY_SCHEMA_VERSION
  ) {
    throw new Error('analysis_source_activation_policy_invalid_root');
  }
  if (
    !isRecord(value.bounded_explicit) ||
    !exactKeys(value.bounded_explicit, [
      'max_search_calls',
      'max_read_calls',
      'max_duration_ms',
    ])
  ) {
    throw new Error('analysis_source_activation_policy_invalid_budget');
  }
  if (
    !isRecord(value.safe_replay) ||
    !exactKeys(value.safe_replay, ['max_turns', 'max_chars_per_entry'])
  ) {
    throw new Error('analysis_source_activation_policy_invalid_safe_replay');
  }
  if (
    !isRecord(value.intent) ||
    !exactKeys(value.intent, [
      'explicit_patterns',
      'explicit_case_sensitive_patterns',
      'deep_patterns',
    ])
  ) {
    throw new Error('analysis_source_activation_policy_invalid_intent');
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    boundedExplicit: Object.freeze({
      maxSearchCalls: positiveInteger(
        value.bounded_explicit.max_search_calls,
        'analysis_source_activation_policy_invalid_budget',
      ),
      maxReadCalls: positiveInteger(
        value.bounded_explicit.max_read_calls,
        'analysis_source_activation_policy_invalid_budget',
      ),
      maxDurationMs: positiveInteger(
        value.bounded_explicit.max_duration_ms,
        'analysis_source_activation_policy_invalid_budget',
      ),
    }),
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
    explicitPatterns: Object.freeze([
      ...compilePatterns(
        value.intent.explicit_patterns,
        'analysis_source_activation_policy_invalid_explicit_patterns',
      ),
      ...compilePatterns(
        value.intent.explicit_case_sensitive_patterns,
        'analysis_source_activation_policy_invalid_explicit_patterns',
        '',
      ),
    ]),
    deepPatterns: compilePatterns(
      value.intent.deep_patterns,
      'analysis_source_activation_policy_invalid_deep_patterns',
    ),
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
  if (input.hasAuthorizedCodebase !== undefined) return input.hasAuthorizedCodebase;
  return input.codeAwareMode !== undefined &&
    input.codeAwareMode !== 'off' &&
    Boolean(input.codebaseIds?.length);
}

export function resolveAnalysisSourceActivation(
  input: AnalysisSourcePolicyInput,
): AnalysisSourceActivation {
  if (!hasAuthorizedCodebase(input)) return 'dormant';
  const policy = loadAnalysisSourceActivationPolicy();
  if (
    input.analysisMode === 'full' &&
    policy.deepPatterns.some(pattern => pattern.test(input.query))
  ) {
    return 'deep_supplement';
  }
  return policy.explicitPatterns.some(pattern => pattern.test(input.query))
    ? 'bounded_explicit'
    : 'dormant';
}

export function boundedAnalysisSourceUsePolicy(): NonNullable<AnalysisOptions['sourceUsePolicy']> {
  return {
    phase: 'explicit',
    ...loadAnalysisSourceActivationPolicy().boundedExplicit,
  };
}

export function projectPrimaryAnalysisOptions<T extends AnalysisOptions>(
  options: T,
  activation: AnalysisSourceActivation,
): T {
  if (!hasAuthorizedCodebase(options)) return options;
  if (activation === 'bounded_explicit') {
    return {
      ...options,
      sourceUsePolicy: boundedAnalysisSourceUsePolicy(),
    };
  }
  return {
    ...options,
    codeAwareMode: 'off',
    codebaseIds: undefined,
    sourceUsePolicy: undefined,
    analysisContextFingerprint: undefined,
  };
}
