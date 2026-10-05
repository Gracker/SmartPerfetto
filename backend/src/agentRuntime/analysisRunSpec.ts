// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AnalysisOptions } from '../agent/core/orchestratorTypes';
import type { ConversationTurn } from '../agent/types';
import { buildComplexityClassifierInput } from '../agentv3/queryComplexityContext';
import type { SceneType } from '../agentv3/sceneClassifier';
import type { ComplexityClassifierInput, QueryComplexity, SelectionContext, TracePairContext } from '../agentv3/types';
import type { OutputLanguage } from '../agentv3/outputLanguage';
import {
  MAX_CODEBASE_IDS_PER_ANALYSIS,
  MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS,
  normalizeCodeAwareMode,
  type CodeAwareMode,
} from '../services/codebase/codeAwareFeature';
import { effectiveAnalysisSelection } from '../services/effectiveAnalysisSelection';
import type { KnowledgeScope } from '../services/scopedKnowledgeStore';
import type { ProviderScope } from '../services/providerManager';
import type { RuntimeSelection } from './runtimeSelection';
import type { EngineCapabilities } from './runtimeDescriptorTypes';
import { getProductionEngineCapabilities } from './runtimeDescriptors';
import {
  formatTraceContext,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
} from './runtimeCommon';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  isProductionAgentRuntimeKind,
  type AgentRuntimeKind,
} from './runtimeKinds';
import {
  currentRunManifestAttributionSink,
  resolveRunManifestAttributionSink,
} from '../services/selfEvolution/runManifestLifecycle';
import type {AdaptiveRoutingReceiptV1} from '../types/adaptiveRouting';
import {buildAdaptiveRoutingForTurnIntent} from './adaptiveRoutingProjection';
import type {AnalysisTurnIntent} from './analysisTurnIntent';
import type {AnalysisHistoryTurn} from './analysisHistory';

export interface RuntimeBudgetInputs {
  model?: string;
  lightModel?: string;
  maxTurns?: number;
  quickMaxTurns?: number;
  quickTargetTurns?: number;
  maxBudgetUsd?: number;
  maxOutputTokens?: number;
  fullPathPerTurnMs?: number;
  quickPathPerTurnMs?: number;
  classifierTimeoutMs?: number;
}

export type AnalysisRunSelection =
  | {readonly present: false}
  | {
      readonly present: true;
      readonly kind: SelectionContext['kind'];
      readonly context: SelectionContext;
      readonly sideResolution:
        | {readonly status: 'unknown'}
        | {readonly status: 'resolved'; readonly traceSide: 'current'; readonly traceId: string};
    };

export interface AnalysisRunSpec {
  /** Resolved by this run, not accepted from client options or prior snapshots. */
  turnIntent?: AnalysisTurnIntent;
  identity: {
    sessionId: string;
    traceId: string;
    referenceTraceId?: string;
  };
  query: {
    text: string;
  };
  runtime: {
    kind: AgentRuntimeKind;
    selection: RuntimeSelection<string>;
    capabilities: EngineCapabilities;
    actualModel?: string;
  };
  scopes: {
    provider?: ProviderScope;
    knowledge?: KnowledgeScope;
    providerId?: string | null;
  };
  outputLanguage: OutputLanguage;
  scene: {
    type: SceneType;
  };
  mode: {
    requested: NonNullable<AnalysisOptions['analysisMode']>;
    resolved?: QueryComplexity;
    classifierInput: ComplexityClassifierInput;
    adaptiveRouting?: AdaptiveRoutingReceiptV1;
  };
  traceContext: {
    datasetCount: number;
    promptSection: string;
  };
  selection: AnalysisRunSelection;
  tools: {
    requestScope: {
      sessionId: string;
      hasCodebaseAccess: boolean;
    };
    codeAwareMode: CodeAwareMode;
    codebaseIds: string[];
    knowledgeSourceIds: string[];
  };
  budget: RuntimeBudgetInputs;
}

const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const safeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function dataRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getOwnPropertySymbols(value).length) {
    throw new Error('analysis_run_selection_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(key) || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('analysis_run_selection_invalid');
    }
    Object.defineProperty(output, key, {value: descriptor.value, enumerable: true, writable: true, configurable: true});
  }
  return output;
}

function denseArray(value: unknown, maxLength: number): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxLength || Object.getOwnPropertySymbols(value).length) {
    throw new Error('analysis_run_selection_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => key !== 'length' &&
    (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !descriptors[key].enumerable || !('value' in descriptors[key]))) ||
    Object.keys(value).length !== value.length) throw new Error('analysis_run_selection_invalid');
  return Array.from({length: value.length}, (_, index) => descriptors[String(index)].value);
}

function sameOwnData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right) || Object.getOwnPropertySymbols(left).length ||
    Object.getOwnPropertySymbols(right).length) return false;
  if (Array.isArray(left)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (left.length !== (right as unknown[]).length || leftKeys.length !== left.length ||
      rightKeys.length !== (right as unknown[]).length || leftKeys.some((key, index) => key !== String(index)) ||
      rightKeys.some((key, index) => key !== String(index))) return false;
  }
  const leftDescriptors = Object.getOwnPropertyDescriptors(left);
  const rightDescriptors = Object.getOwnPropertyDescriptors(right);
  const leftKeys = Object.keys(leftDescriptors).filter(key => key !== 'length').sort();
  const rightKeys = Object.keys(rightDescriptors).filter(key => key !== 'length').sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every(key => {
    const a = leftDescriptors[key];
    const b = rightDescriptors[key];
    return a.enumerable && b?.enumerable && 'value' in a && 'value' in b && sameOwnData(a.value, b.value);
  });
}

function canonicalString(value: unknown, maxLength: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new Error('analysis_run_selection_invalid');
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maxLength) throw new Error('analysis_run_selection_invalid');
  return normalized || undefined;
}

function canonicalSelectionContext(value: SelectionContext): SelectionContext {
  const raw = dataRecord(value, ['kind', 'source', 'trackUri', 'eventId', 'ts', 'dur',
    'startNs', 'endNs', 'durationNs', 'tracks', 'trackCount']);
  if (raw.kind === 'track_event') {
    if (!exactKeys(raw, ['kind', 'source', 'trackUri', 'eventId', 'ts', 'dur']) ||
      !safeNonNegativeInteger(raw.eventId) || !safeInteger(raw.ts) ||
      (owns(raw, 'dur') && raw.dur !== undefined && !safeNonNegativeInteger(raw.dur)) ||
      (safeNonNegativeInteger(raw.dur) && !Number.isSafeInteger(raw.ts + raw.dur)) ||
      (owns(raw, 'source') && raw.source !== undefined && raw.source !== 'track_event_selection')) {
      throw new Error('analysis_run_selection_invalid');
    }
    const trackUri = canonicalString(raw.trackUri, 512, false);
    return {
      kind: 'track_event',
      ...(raw.source === 'track_event_selection' ? {source: raw.source} : {}),
      eventId: raw.eventId,
      ts: raw.ts,
      ...(raw.dur !== undefined ? {dur: raw.dur as number} : {}),
      ...(trackUri ? {trackUri} : {}),
    };
  }
  if (raw.kind !== 'area' || !exactKeys(raw,
    ['kind', 'source', 'startNs', 'endNs', 'durationNs', 'tracks', 'trackCount']) ||
    !safeNonNegativeInteger(raw.startNs) || !safeNonNegativeInteger(raw.endNs) || raw.endNs <= raw.startNs ||
    (owns(raw, 'durationNs') && raw.durationNs !== undefined &&
      (!safeNonNegativeInteger(raw.durationNs) || raw.durationNs > raw.endNs - raw.startNs)) ||
    (owns(raw, 'source') && raw.source !== undefined &&
      raw.source !== 'area_selection' && raw.source !== 'visible_window') ||
    (owns(raw, 'trackCount') && raw.trackCount !== undefined && !safeNonNegativeInteger(raw.trackCount))) {
    throw new Error('analysis_run_selection_invalid');
  }
  const tracks = denseArray(raw.tracks, 256);
  const normalizedTracks = tracks?.map(item => {
    const track = dataRecord(item, ['uri', 'utid', 'upid', 'cpu', 'kind']);
    if (!exactKeys(track, ['uri', 'utid', 'upid', 'cpu', 'kind']) ||
      ['utid', 'upid', 'cpu'].some(key => owns(track, key) && track[key] !== undefined && !safeNonNegativeInteger(track[key]))) {
      throw new Error('analysis_run_selection_invalid');
    }
    const uri = canonicalString(track.uri, 512, true)!;
    const kind = canonicalString(track.kind, 128, false);
    return {uri,
      ...(track.utid !== undefined ? {utid: track.utid as number} : {}),
      ...(track.upid !== undefined ? {upid: track.upid as number} : {}),
      ...(track.cpu !== undefined ? {cpu: track.cpu as number} : {}),
      ...(kind ? {kind} : {})};
  });
  return {kind: 'area',
    ...(raw.source === 'area_selection' || raw.source === 'visible_window' ? {source: raw.source} : {}),
    startNs: raw.startNs, endNs: raw.endNs,
    ...(raw.durationNs !== undefined ? {durationNs: raw.durationNs as number} : {}),
    ...(normalizedTracks ? {tracks: normalizedTracks} : {}),
    ...(raw.trackCount !== undefined ? {trackCount: raw.trackCount as number} : {})};
}

function freezeSelection<T extends AnalysisRunSelection>(selection: T): T {
  const copy = structuredClone(selection);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.values(value).forEach(visit);
    Object.freeze(value);
  };
  visit(copy);
  return copy;
}

export function captureAnalysisRunSelection(input: {
  selectionContext?: SelectionContext;
  traceId: string;
  referenceTraceId?: string;
  tracePairContext?: TracePairContext;
}): AnalysisRunSelection {
  if (input.selectionContext === undefined) return freezeSelection({present: false});
  const context = canonicalSelectionContext(input.selectionContext);
  const sideResolution = input.referenceTraceId === undefined && input.tracePairContext === undefined &&
    input.traceId.trim() && input.traceId === input.traceId.trim()
    ? {status: 'resolved' as const, traceSide: 'current' as const, traceId: input.traceId}
    : {status: 'unknown' as const};
  return freezeSelection({present: true, kind: context.kind, context, sideResolution});
}

/** Revalidates an already-canonical run selection without accepting a transformed value. */
export function validateAnalysisRunSelection(selection: AnalysisRunSelection): AnalysisRunSelection {
  const raw = dataRecord(selection, ['present', 'kind', 'context', 'sideResolution']);
  if (raw.present === false) {
    if (!exactKeys(raw, ['present'])) throw new Error('analysis_run_selection_invalid');
    return freezeSelection({present: false});
  }
  if (raw.present !== true || !exactKeys(raw, ['present', 'kind', 'context', 'sideResolution'])) {
    throw new Error('analysis_run_selection_invalid');
  }
  const context = canonicalSelectionContext(raw.context as SelectionContext);
  if (raw.kind !== context.kind || !sameOwnData(context, raw.context)) throw new Error('analysis_run_selection_invalid');
  const resolution = dataRecord(raw.sideResolution, ['status', 'traceSide', 'traceId']);
  if (resolution.status === 'unknown') {
    if (!exactKeys(resolution, ['status'])) throw new Error('analysis_run_selection_invalid');
    return freezeSelection({present: true, kind: context.kind, context, sideResolution: {status: 'unknown'}});
  }
  if (resolution.status !== 'resolved' || !exactKeys(resolution, ['status', 'traceSide', 'traceId']) ||
    resolution.traceSide !== 'current' || typeof resolution.traceId !== 'string' ||
    !resolution.traceId.trim() || resolution.traceId !== resolution.traceId.trim()) {
    throw new Error('analysis_run_selection_invalid');
  }
  return freezeSelection({present: true, kind: context.kind, context,
    sideResolution: {status: 'resolved', traceSide: 'current', traceId: resolution.traceId}});
}

export interface CreateAnalysisRunSpecInput {
  turnIntent?: AnalysisTurnIntent;
  query: string;
  sessionId: string;
  traceId: string;
  options?: AnalysisOptions;
  runtimeSelection: RuntimeSelection<string>;
  engineCapabilities?: EngineCapabilities;
  sceneType: SceneType;
  outputLanguage: OutputLanguage;
  previousTurns?: ConversationTurn[];
  history?: readonly AnalysisHistoryTurn[];
  resolvedMode?: QueryComplexity;
  /** Complete provider configuration selected for this run, independent of budget. */
  resolvedModel?: string;
  budget?: RuntimeBudgetInputs;
}

function compactAuthorizationIds(ids: string[] | undefined, label: string, maxItems: number): string[] {
  const compacted = ids ?? [];
  if (compacted.length > maxItems) {
    throw new Error(`${label} exceeds the maximum of ${maxItems} unique ids`);
  }
  return compacted;
}

function resolveEngineCapabilities(input: CreateAnalysisRunSpecInput): EngineCapabilities {
  const capabilities = input.engineCapabilities
    ?? getProductionEngineCapabilities(input.runtimeSelection.kind);
  if (capabilities.kind !== input.runtimeSelection.kind) {
    throw new Error(
      `Runtime capability mismatch: ${input.runtimeSelection.kind} != ${capabilities.kind}`,
    );
  }
  return capabilities;
}

export function canonicalRuntimeKind(value: string): AgentRuntimeKind {
  if (isProductionAgentRuntimeKind(value)) return value;
  if (value === EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND) {
    return PI_AGENT_CORE_RUNTIME_KIND;
  }
  if (value === EXPERIMENTAL_OPENCODE_RUNTIME_KIND) {
    return OPENCODE_RUNTIME_KIND;
  }
  throw new Error(`Unsupported production analysis runtime: ${value}`);
}

export function createAnalysisRunSpec(input: CreateAnalysisRunSpecInput): AnalysisRunSpec {
  const options = input.options ?? {};
  const engineCapabilities = resolveEngineCapabilities(input);
  // The effective selection, then the backend's feature switch on its own.
  const selection = effectiveAnalysisSelection(options);
  const codeAwareMode = normalizeCodeAwareMode(selection.codeAwareMode);
  const codebaseIds = compactAuthorizationIds(
    codeAwareMode === 'off' ? undefined : selection.codebaseIds,
    'codebaseIds',
    MAX_CODEBASE_IDS_PER_ANALYSIS,
  );
  const knowledgeSourceIds = compactAuthorizationIds(
    selection.knowledgeSourceIds,
    'knowledgeSourceIds',
    MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS,
  );
  const providerScope = providerScopeFromAnalysisOptions(options);
  const knowledgeScope = knowledgeScopeFromAnalysisOptions(options);
  const classifierInput = buildComplexityClassifierInput({
    query: input.query,
    sceneType: input.sceneType,
    selectionContext: options.selectionContext,
    hasReferenceTrace: !!options.referenceTraceId,
    previousTurns: input.previousTurns ?? [],
    history: input.history,
    requestedMode: options.analysisMode ?? 'auto',
  });
  const traceContextPrompt = formatTraceContext(options.traceContext, input.outputLanguage);
  const runtimeKind = canonicalRuntimeKind(input.runtimeSelection.kind);
  const actualModel = input.resolvedModel ?? (input.resolvedMode === 'quick'
    ? input.budget?.lightModel ?? input.budget?.model
    : input.budget?.model);
  const sink = resolveRunManifestAttributionSink(
    options.runManifestAttributionSink,
    currentRunManifestAttributionSink(),
  );
  sink?.recordScene({sceneType: input.sceneType});
  sink?.recordRuntime({
    runtime: runtimeKind,
    providerId: options.providerId ?? null,
    ...(actualModel ? {model: actualModel} : {}),
    outputLanguage: input.outputLanguage,
  });
  sink?.recordMode({
    requested: options.analysisMode ?? 'auto',
    resolved: input.resolvedMode === 'quick' ? 'quick' : input.resolvedMode === 'full' ? 'full' : undefined,
    capabilityFlags: [
      ...(engineCapabilities.production ? ['production'] : []),
      ...(engineCapabilities.publicRuntime ? ['public_runtime'] : []),
      ...(engineCapabilities.promptCache.systemPromptDynamicBoundary
        ? ['system_prompt_dynamic_boundary']
        : []),
    ],
  });
  const adaptiveRouting = input.turnIntent && input.resolvedMode
    ? buildAdaptiveRoutingForTurnIntent({
      options,
      resolvedMode: input.resolvedMode,
      turnIntent: input.turnIntent,
    })
    : undefined;
  if (adaptiveRouting) {
    try {
      sink?.recordAdaptiveRouting?.(adaptiveRouting);
    } catch {
      // The shadow receipt is telemetry; it must never fail the run.
    }
  }

  return {
    ...(input.turnIntent ? {turnIntent: input.turnIntent} : {}),
    identity: {
      sessionId: input.sessionId,
      traceId: input.traceId,
      referenceTraceId: options.referenceTraceId,
    },
    query: {
      text: input.query,
    },
    runtime: {
      kind: runtimeKind,
      selection: input.runtimeSelection,
      capabilities: engineCapabilities,
      ...(actualModel ? {actualModel} : {}),
    },
    scopes: {
      provider: providerScope,
      knowledge: knowledgeScope,
      providerId: options.providerId,
    },
    outputLanguage: input.outputLanguage,
    scene: {
      type: input.sceneType,
    },
    mode: {
      requested: options.analysisMode ?? 'auto',
      resolved: input.resolvedMode,
      classifierInput,
      ...(adaptiveRouting ? {adaptiveRouting} : {}),
    },
    traceContext: {
      datasetCount: options.traceContext?.length ?? 0,
      promptSection: traceContextPrompt,
    },
    selection: captureAnalysisRunSelection({selectionContext: options.selectionContext,
      traceId: input.traceId, referenceTraceId: options.referenceTraceId,
      tracePairContext: options.tracePairContext}),
    tools: {
      requestScope: {
        sessionId: input.sessionId,
        hasCodebaseAccess: codeAwareMode !== 'off' && codebaseIds.length > 0,
      },
      codeAwareMode,
      codebaseIds,
      knowledgeSourceIds,
    },
    budget: input.budget ?? {},
  };
}
