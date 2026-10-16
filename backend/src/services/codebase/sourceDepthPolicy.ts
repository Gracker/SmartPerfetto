// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SourceNeed} from '../../types/sourceNeed';
import type {CodeAwareMode} from './codeAwareFeature';
import {loadStrategyYaml} from '../../agentv3/strategyLoader';
import {exactKeys, isRecord, positiveInteger} from './policyYaml';

const POLICY_ASSET_NAME = 'source-depth-policy';
const POLICY_SCHEMA_VERSION = 'source_depth_policy@1' as const;

/** How deep a run may go into source: locating code, or reading its mechanism. */
export type SourceDepth = 'locate' | 'mechanism';
/** What a request asks for; `auto` follows the turn intent's source need, else the run's budget. */
export type RequestedSourceDepth = SourceDepth | 'auto';

const REQUESTED_SOURCE_DEPTHS: readonly RequestedSourceDepth[] = ['auto', 'locate', 'mechanism'];

export function isRequestedSourceDepth(value: unknown): value is RequestedSourceDepth {
  return REQUESTED_SOURCE_DEPTHS.includes(value as RequestedSourceDepth);
}

interface SourceDepthLimits {
  readonly searches: number;
  readonly reads: number;
  readonly locates: number;
  readonly maxReadLines: number;
  readonly tokens: number;
}

/**
 * Retrieved knowledge's own budget: the token pool every knowledge surface
 * (Pack, Wiki, document collections) draws on, and the document-collection
 * tools' call counts and section part size.
 */
interface KnowledgeLimits {
  readonly tokens: number;
  readonly searches: number;
  readonly reads: number;
  readonly partChars: number;
}

export interface SourceDepthPolicy {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly depths: Readonly<Record<SourceDepth, SourceDepthLimits>>;
  readonly knowledge: KnowledgeLimits;
}

const LIMIT_KEYS = ['searches', 'reads', 'locates', 'max_read_lines', 'tokens'] as const;
const KNOWLEDGE_KEYS = ['tokens', 'searches', 'reads', 'part_chars'] as const;

function parseLimits(value: unknown): SourceDepthLimits {
  if (!isRecord(value) || !exactKeys(value, LIMIT_KEYS)) throw new Error('source_depth_policy_invalid_depth');
  return Object.freeze({
    searches: positiveInteger(value.searches, 'source_depth_policy_invalid_depth'),
    reads: positiveInteger(value.reads, 'source_depth_policy_invalid_depth'),
    locates: positiveInteger(value.locates, 'source_depth_policy_invalid_depth'),
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
    !exactKeys(value.knowledge, KNOWLEDGE_KEYS)
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
    knowledge: Object.freeze({
      tokens: positiveInteger(value.knowledge.tokens, 'source_depth_policy_invalid_knowledge'),
      searches: positiveInteger(value.knowledge.searches, 'source_depth_policy_invalid_knowledge'),
      reads: positiveInteger(value.knowledge.reads, 'source_depth_policy_invalid_knowledge'),
      partChars: positiveInteger(value.knowledge.part_chars, 'source_depth_policy_invalid_knowledge'),
    }),
  });
}

export function loadSourceDepthPolicy(): SourceDepthPolicy {
  const policy = loadStrategyYaml(POLICY_ASSET_NAME, parseSourceDepthPolicy);
  if (!policy) throw new Error('source_depth_policy_missing');
  return policy;
}

/** How a run's source depth was decided; stored with the run's source use. */
export interface SourceDepthDecisionV1 {
  requested: RequestedSourceDepth;
  effective: SourceDepth;
  /** `requested`: the user chose it; `intent`: the turn intent's source need; `budget`: the run's budget. */
  origin: 'requested' | 'intent' | 'budget';
  /** Why `auto` fell back to the budget. */
  fallbackReason?: SourceNeedMissingReason;
  /** A cap that lowered the depth wanted. */
  cap?: 'metadata_only';
}

export const SOURCE_DEPTH_ORIGINS = ['requested', 'intent', 'budget'] as const;
export const SOURCE_NEED_MISSING_REASONS = ['intent_unavailable', 'product_run', 'source_need_missing'] as const;
/** Why a turn has no source need: no classification, a product run, or a decision that omitted it. */
export type SourceNeedMissingReason = typeof SOURCE_NEED_MISSING_REASONS[number];

/**
 * The depth a run's source tools get. An explicit request wins; `auto`
 * follows the turn intent's source need (a mechanism needs one; nothing or a
 * location needs only locating), and the run's budget when the intent did not
 * say (unavailable, a product run, or an omitted field). `metadata_only` sends
 * no body, so it is capped at `locate`. This sizes the source budget and
 * selects the recipe; it grants no access.
 */
export function resolveEffectiveSourceDepth(input: {
  requested?: RequestedSourceDepth;
  sourceNeed?: SourceNeed;
  /** Why the intent gave no source need; `source_need_missing` when unsaid. */
  sourceNeedMissing?: SourceNeedMissingReason;
  budgetMode: 'quick' | 'full';
  codeAwareMode?: CodeAwareMode;
}): SourceDepthDecisionV1 {
  const requested = input.requested ?? 'auto';
  const [wanted, origin]: [SourceDepth, SourceDepthDecisionV1['origin']] = requested !== 'auto' ? [requested, 'requested']
    : input.sourceNeed ? [input.sourceNeed === 'mechanism' ? 'mechanism' : 'locate', 'intent']
      : [input.budgetMode === 'full' ? 'mechanism' : 'locate', 'budget'];
  const capped = input.codeAwareMode === 'metadata_only' && wanted === 'mechanism';
  return {requested, effective: capped ? 'locate' : wanted, origin,
    ...(origin === 'budget' ? {fallbackReason: input.sourceNeedMissing ?? 'source_need_missing'} : {}),
    ...(capped ? {cap: 'metadata_only' as const} : {})};
}

/** The depth decision for a runtime's MCP server, from its turn policy and request options. */
export function runtimeSourceDepth(
  policy: {budgetMode: 'quick' | 'full'; sourceNeed?: SourceNeed; sourceNeedMissing?: SourceNeedMissingReason},
  options: {sourceDepth?: RequestedSourceDepth; codeAwareMode?: CodeAwareMode} | undefined,
): SourceDepthDecisionV1 {
  return resolveEffectiveSourceDepth({requested: options?.sourceDepth, sourceNeed: policy.sourceNeed,
    sourceNeedMissing: policy.sourceNeedMissing, budgetMode: policy.budgetMode, codeAwareMode: options?.codeAwareMode});
}
