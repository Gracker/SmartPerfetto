// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodeAwareMode} from './codeAwareFeature';
import {loadStrategyYaml} from '../../agentv3/strategyLoader';
import {exactKeys, isRecord, positiveInteger} from './policyYaml';

const POLICY_ASSET_NAME = 'source-depth-policy';
const POLICY_SCHEMA_VERSION = 'source_depth_policy@1' as const;

/** How deep a run may go into source: locating code, or reading its mechanism. */
export type SourceDepth = 'locate' | 'mechanism';
/** What a request asks for; `auto` lets the run's budget decide. */
export type RequestedSourceDepth = SourceDepth | 'auto';

const REQUESTED_SOURCE_DEPTHS: readonly RequestedSourceDepth[] = ['auto', 'locate', 'mechanism'];

export function isRequestedSourceDepth(value: unknown): value is RequestedSourceDepth {
  return REQUESTED_SOURCE_DEPTHS.includes(value as RequestedSourceDepth);
}

interface SourceDepthLimits {
  readonly searches: number;
  readonly reads: number;
  readonly maxReadLines: number;
  readonly tokens: number;
}

export interface SourceDepthPolicy {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly depths: Readonly<Record<SourceDepth, SourceDepthLimits>>;
  readonly knowledge: {readonly tokens: number};
}

const LIMIT_KEYS = ['searches', 'reads', 'max_read_lines', 'tokens'] as const;

function parseLimits(value: unknown): SourceDepthLimits {
  if (!isRecord(value) || !exactKeys(value, LIMIT_KEYS)) throw new Error('source_depth_policy_invalid_depth');
  return Object.freeze({
    searches: positiveInteger(value.searches, 'source_depth_policy_invalid_depth'),
    reads: positiveInteger(value.reads, 'source_depth_policy_invalid_depth'),
    maxReadLines: positiveInteger(value.max_read_lines, 'source_depth_policy_invalid_depth'),
    tokens: positiveInteger(value.tokens, 'source_depth_policy_invalid_depth'),
  });
}

export function parseSourceDepthPolicy(value: unknown): SourceDepthPolicy {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schema_version', 'depths', 'knowledge']) ||
    value.schema_version !== POLICY_SCHEMA_VERSION ||
    !isRecord(value.depths) ||
    !exactKeys(value.depths, ['locate', 'mechanism']) ||
    !isRecord(value.knowledge) ||
    !exactKeys(value.knowledge, ['tokens'])
  ) {
    throw new Error('source_depth_policy_invalid_root');
  }
  const locate = parseLimits(value.depths.locate);
  const mechanism = parseLimits(value.depths.mechanism);
  // A deeper run never gets less of anything than a shallower one.
  if ((Object.keys(locate) as Array<keyof SourceDepthLimits>).some(key => mechanism[key] < locate[key])) {
    throw new Error('source_depth_policy_mechanism_below_locate');
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    depths: Object.freeze({locate, mechanism}),
    knowledge: Object.freeze({tokens: positiveInteger(value.knowledge.tokens, 'source_depth_policy_invalid_knowledge')}),
  });
}

export function loadSourceDepthPolicy(): SourceDepthPolicy {
  const policy = loadStrategyYaml(POLICY_ASSET_NAME, parseSourceDepthPolicy);
  if (!policy) throw new Error('source_depth_policy_missing');
  return policy;
}

/**
 * The depth a run's source tools get. An explicit request wins; `auto` follows
 * the run's budget (a full run explains mechanisms, a quick one locates).
 * `metadata_only` sends no body, so it is capped at `locate`. This sizes the
 * source budget only; it grants no access.
 */
export function resolveEffectiveSourceDepth(input: {
  requested?: RequestedSourceDepth;
  budgetMode: 'quick' | 'full';
  codeAwareMode?: CodeAwareMode;
}): SourceDepth {
  const wanted: SourceDepth = input.requested === 'locate' || input.requested === 'mechanism'
    ? input.requested
    : input.budgetMode === 'full' ? 'mechanism' : 'locate';
  return input.codeAwareMode === 'metadata_only' ? 'locate' : wanted;
}

/** The effective depth for a runtime's MCP server, from its turn policy and request options. */
export function runtimeSourceDepth(
  policy: {budgetMode: 'quick' | 'full'},
  options: {sourceDepth?: RequestedSourceDepth; codeAwareMode?: CodeAwareMode} | undefined,
): SourceDepth {
  return resolveEffectiveSourceDepth({requested: options?.sourceDepth, budgetMode: policy.budgetMode,
    codeAwareMode: options?.codeAwareMode});
}
