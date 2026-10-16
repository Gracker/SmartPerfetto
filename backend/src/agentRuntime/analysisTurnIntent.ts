// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ComplexityClassifierInput, QueryComplexity} from '../agentv3/types';
import {buildAnalysisTurnIntentPrompt} from '../agentv3/queryComplexityPrompt';
import {
  buildStrategyRegistrySnapshotFromDefinitions,
  getRegisteredScenes,
  loadPromptTemplate,
} from '../agentv3/strategyLoader';
import {
  currentEffectiveRuntimeRegistrySnapshot,
  type ReadonlyStrategyRegistrySnapshot,
} from '../services/selfEvolution/effectiveRuntimeRegistryContext';
import {dispatchWithModelCallRecord, type IntentTransportInput, type IntentTransportResult,
  type IntentTransportUnavailableReason} from './intentTransport';
import {currentRunManifestAttributionSink} from '../services/selfEvolution/runManifestLifecycle';
import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import {resolveSceneProductScope} from '../agent/scene/sceneRuntimeBinding';
import {SOURCE_NEEDS, type SourceNeed} from '../types/sourceNeed';

const TASK_KINDS = ['acknowledgement', 'fact', 'investigation', 'comparison'] as const;
const SCOPES = ['bounded_question', 'scene_wide'] as const;
const COMPLEXITIES = ['quick', 'full'] as const;
const DELIVERABLES = ['answer', 'report'] as const;
const EVIDENCE_ACCESS = ['existing_only', 'read_new'] as const;

/** The model supplies a decision, never the authority or status of that decision. */
export interface AnalysisTurnIntentDecision {
  schemaVersion: 1;
  taskKind: typeof TASK_KINDS[number];
  sceneId: string;
  scope: typeof SCOPES[number];
  recommendedComplexity: QueryComplexity;
  deliverable: typeof DELIVERABLES[number];
  evidenceAccess: typeof EVIDENCE_ACCESS[number];
  /** Asked only when the run has source selected; absent otherwise or when the model omitted it. */
  sourceNeed?: SourceNeed;
  reason?: string;
}

export type AnalysisTurnIntent = Readonly<AnalysisTurnIntentDecision & {
  status: 'resolved' | 'unavailable';
  source: 'semantic' | 'fallback' | 'product';
  registryFingerprint: string;
  unavailableReason?: IntentTransportUnavailableReason | 'prompt_unavailable' | 'context_limit';
  actualModel?: string;
  finishReason?: string;
}>;

const OUTPUT_BYTE_LIMIT = 8192;
const PROMPT_BYTE_LIMIT = 64 * 1024;

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

/** Strict protocol parsing; prose containing JSON is not a classifier response. */
export function parseAnalysisTurnIntentDecision(
  text: string,
  registry: ReadonlyStrategyRegistrySnapshot,
  options: {sourceSelected?: boolean} = {},
): AnalysisTurnIntentDecision | undefined {
  if (Buffer.byteLength(text, 'utf8') > OUTPUT_BYTE_LIMIT) return undefined;
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    value = parsed as Record<string, unknown>;
  } catch { return undefined; }
  const keys = ['schemaVersion', 'taskKind', 'sceneId', 'scope', 'recommendedComplexity', 'deliverable', 'evidenceAccess',
    'reason', ...(options.sourceSelected ? ['sourceNeed'] : [])];
  if (Object.keys(value).some(key => !keys.includes(key))) return undefined;
  // A missing source need leaves the rest of the decision valid; the depth then follows the budget.
  if (value.sourceNeed !== undefined && !member(value.sourceNeed, SOURCE_NEEDS)) return undefined;
  const scene = typeof value.sceneId === 'string' ? registry.getStrategy(value.sceneId) : undefined;
  if (value.schemaVersion !== 1 || !scene || scene.strategyKind === 'contract_only'
    || !member(value.taskKind, TASK_KINDS) || !member(value.scope, SCOPES)
    || !member(value.recommendedComplexity, COMPLEXITIES)
    || !member(value.deliverable, DELIVERABLES) || !member(value.evidenceAccess, EVIDENCE_ACCESS)
    || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 800))) return undefined;
  if (value.taskKind === 'acknowledgement' && (value.scope !== 'bounded_question'
    || value.recommendedComplexity !== 'quick' || value.deliverable !== 'answer'
    || value.evidenceAccess !== 'existing_only' || (value.sourceNeed !== undefined && value.sourceNeed !== 'none'))) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    taskKind: value.taskKind,
    sceneId: scene.scene,
    scope: value.scope,
    recommendedComplexity: value.recommendedComplexity,
    deliverable: value.deliverable,
    evidenceAccess: value.evidenceAccess,
    ...(value.sourceNeed === undefined ? {} : {sourceNeed: value.sourceNeed}),
    ...(value.reason === undefined ? {} : {reason: value.reason as string}),
  };
}

/** Whether a run's request selects source, which is when its intent judges the source need. */
function analysisOptionsSelectSource(options: Pick<AnalysisOptions, 'codeAwareMode' | 'codebaseIds'> | undefined): boolean {
  return Boolean(options?.codeAwareMode && options.codeAwareMode !== 'off' && options.codebaseIds?.length);
}

export function resolveTurnIntentComplexity(
  intent: AnalysisTurnIntent,
  requested: 'auto' | 'fast' | 'full' = 'auto',
): QueryComplexity {
  return requested === 'fast' ? 'quick' : requested === 'full' ? 'full' : intent.recommendedComplexity;
}

export interface AnalysisTurnIntentResolverInput {
  context: ComplexityClassifierInput;
  signal?: AbortSignal;
  deadlineMs: number;
  dispatch: (input: IntentTransportInput) => Promise<IntentTransportResult>;
  /** Reuse this pin for all later strategy loads in the same run. */
  strategyRegistry?: ReadonlyStrategyRegistrySnapshot;
  template?: string;
  /** A pre-existing backend restriction may narrow, never widen, model intent. */
  evidenceAccessLimit?: 'existing_only';
  /** Internal options capability; serialized product labels confer no authority. */
  productRun?: {options: AnalysisOptions; runId: string; sessionId: string; traceId: string};
}

/** One resolver per run. Calls made by preparation/recovery reuse its promise. */
export function createAnalysisTurnIntentResolver(input: AnalysisTurnIntentResolverInput): {
  strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  resolve: () => Promise<AnalysisTurnIntent>;
} {
  const {signal, deadlineMs, dispatch, evidenceAccessLimit} = input;
  const strategyRegistry = input.strategyRegistry ?? currentEffectiveRuntimeRegistrySnapshot()?.strategyRegistry
    ?? buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: 'builtin'});
  const template = input.template ?? loadPromptTemplate('prompt-analysis-turn-intent');
  const context = structuredClone(input.context);
  const sceneIds = strategyRegistry.getAllStrategies()
    .filter(scene => scene.strategyKind !== 'contract_only').map(scene => scene.scene);
  const sourceSelected = analysisOptionsSelectSource(input.productRun?.options);
  const requiredProperties = {
    schemaVersion: {type: 'integer', const: 1},
    taskKind: {type: 'string', enum: TASK_KINDS},
    sceneId: {type: 'string', ...(sceneIds.length > 0 ? {enum: sceneIds} : {not: {}})},
    scope: {type: 'string', enum: SCOPES},
    recommendedComplexity: {type: 'string', enum: COMPLEXITIES},
    deliverable: {type: 'string', enum: DELIVERABLES},
    evidenceAccess: {type: 'string', enum: EVIDENCE_ACCESS},
    ...(sourceSelected ? {sourceNeed: {type: 'string', enum: SOURCE_NEEDS}} : {}),
  };
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: Object.keys(requiredProperties),
    properties: {...requiredProperties, reason: {type: 'string', maxLength: 800}},
    allOf: [{
      if: {properties: {taskKind: {const: 'acknowledgement'}}},
      then: {properties: {scope: {const: 'bounded_question'}, recommendedComplexity: {const: 'quick'},
        deliverable: {const: 'answer'}, evidenceAccess: {const: 'existing_only'},
        ...(sourceSelected ? {sourceNeed: {const: 'none'}} : {})}},
    }],
  };
  const unavailable = (reason: NonNullable<AnalysisTurnIntent['unavailableReason']>): AnalysisTurnIntent => Object.freeze({
    schemaVersion: 1,
    status: 'unavailable',
    source: 'fallback',
    taskKind: 'investigation',
    sceneId: 'general',
    scope: 'bounded_question',
    recommendedComplexity: 'quick',
    deliverable: 'answer',
    evidenceAccess: evidenceAccessLimit ?? 'read_new',
    registryFingerprint: strategyRegistry.registryFingerprint,
    unavailableReason: reason,
  });
  const throwIfCancelled = () => { signal?.throwIfAborted(); };
  let promise: Promise<AnalysisTurnIntent> | undefined;
  const resolve = () => promise ??= (async () => {
    throwIfCancelled();
    if (!Number.isFinite(deadlineMs)) return unavailable('invalid_configuration');
    if (Date.now() >= deadlineMs) return unavailable('timeout');
    const product = input.productRun;
    if (product && resolveSceneProductScope(product.options, product)) {
      const scene = strategyRegistry.getStrategy('scene_reconstruction');
      if (!scene || scene.strategyKind === 'contract_only') throw new Error('scene_investigation_strategy_unavailable');
      return Object.freeze({schemaVersion: 1, status: 'resolved', source: 'product',
        taskKind: 'investigation', sceneId: scene.scene, scope: 'scene_wide', recommendedComplexity: 'full',
        deliverable: 'report', evidenceAccess: evidenceAccessLimit ?? 'read_new',
        registryFingerprint: strategyRegistry.registryFingerprint} satisfies AnalysisTurnIntent);
    }
    if (!template) return unavailable('prompt_unavailable');
    const sourceNeedGuidance = sourceSelected ? loadPromptTemplate('prompt-analysis-turn-intent-source-need') : '';
    if (sourceSelected && !sourceNeedGuidance) return unavailable('prompt_unavailable');
    const prompt = buildAnalysisTurnIntentPrompt({context, strategyRegistry, template, decisionSchema: schema,
      sourceNeedGuidance: sourceNeedGuidance ?? ''});
    if (Buffer.byteLength(prompt, 'utf8') > PROMPT_BYTE_LIMIT) return unavailable('context_limit');
    let result: IntentTransportResult;
    try {
      const recorder = (product?.options.runManifestAttributionSink ?? currentRunManifestAttributionSink())
        ?.runtimePerformanceRecorder;
      result = await dispatchWithModelCallRecord(recorder, {purpose: 'classification'}, {prompt, systemPrompt: '', signal,
        deadlineMs, outputByteLimit: OUTPUT_BYTE_LIMIT}, dispatch);
    } catch {
      throwIfCancelled();
      return unavailable('provider_error');
    }
    throwIfCancelled();
    if (Date.now() >= deadlineMs) return unavailable('timeout');
    if (result.status === 'unavailable') return unavailable(result.reason);
    const decision = parseAnalysisTurnIntentDecision(result.text, strategyRegistry, {sourceSelected});
    if (!decision) return unavailable('invalid_response');
    return Object.freeze({
      ...decision,
      ...(evidenceAccessLimit ? {evidenceAccess: evidenceAccessLimit} : {}),
      status: 'resolved' as const,
      source: 'semantic' as const,
      registryFingerprint: strategyRegistry.registryFingerprint,
      ...(result.actualModel ? {actualModel: result.actualModel} : {}),
      ...(result.finishReason ? {finishReason: result.finishReason} : {}),
    });
  })();
  return {strategyRegistry, resolve};
}
