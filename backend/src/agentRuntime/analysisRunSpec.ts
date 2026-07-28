// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AnalysisOptions } from '../agent/core/orchestratorTypes';
import type { ConversationTurn } from '../agent/types';
import { buildComplexityClassifierInput } from '../agentv3/queryComplexityContext';
import type { SceneType } from '../agentv3/sceneClassifier';
import type { ComplexityClassifierInput, QueryComplexity, SelectionContext } from '../agentv3/types';
import type { OutputLanguage } from '../agentv3/outputLanguage';
import {
  MAX_CODEBASE_IDS_PER_ANALYSIS,
  MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS,
  normalizeCodeAwareMode,
  type CodeAwareMode,
} from '../services/codebase/codeAwareFeature';
import type { KnowledgeScope } from '../services/scopedKnowledgeStore';
import type { ProviderScope } from '../services/providerManager';
import type { RuntimeSelection } from './runtimeSelection';
import type { EngineCapabilities } from './runtimeDescriptorTypes';
import { getProductionEngineCapabilities } from './runtimeDescriptors';
import {
  buildRuntimeSessionMapKey,
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
  verifierTimeoutMs?: number;
}

export interface AnalysisRunSpec {
  identity: {
    sessionId: string;
    traceId: string;
    referenceTraceId?: string;
    sessionMapKey: string;
  };
  query: {
    text: string;
  };
  runtime: {
    kind: AgentRuntimeKind;
    selection: RuntimeSelection<string>;
    capabilities: EngineCapabilities;
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
  };
  traceContext: {
    datasetCount: number;
    promptSection: string;
  };
  selection: {
    present: boolean;
    kind?: SelectionContext['kind'];
    context?: SelectionContext;
  };
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

export interface CreateAnalysisRunSpecInput {
  query: string;
  sessionId: string;
  traceId: string;
  options?: AnalysisOptions;
  runtimeSelection: RuntimeSelection<string>;
  engineCapabilities?: EngineCapabilities;
  sceneType: SceneType;
  outputLanguage: OutputLanguage;
  previousTurns?: ConversationTurn[];
  resolvedMode?: QueryComplexity;
  budget?: RuntimeBudgetInputs;
}

function compactAuthorizationIds(ids: string[] | undefined, label: string, maxItems: number): string[] {
  const compacted = Array.from(new Set(ids ?? [])).filter(Boolean);
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

function canonicalRuntimeKind(value: string): AgentRuntimeKind {
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
  const codeAwareMode = normalizeCodeAwareMode(options.codeAwareMode);
  const codebaseIds = compactAuthorizationIds(
    options.codebaseIds,
    'codebaseIds',
    MAX_CODEBASE_IDS_PER_ANALYSIS,
  );
  const knowledgeSourceIds = compactAuthorizationIds(
    options.knowledgeSourceIds,
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
  });
  const traceContextPrompt = formatTraceContext(options.traceContext, input.outputLanguage);
  const runtimeKind = canonicalRuntimeKind(input.runtimeSelection.kind);
  const sink = resolveRunManifestAttributionSink(
    options.runManifestAttributionSink,
    currentRunManifestAttributionSink(),
  );
  sink?.recordScene({sceneType: input.sceneType});
  sink?.recordRuntime({
    runtime: runtimeKind,
    providerId: options.providerId ?? null,
    ...(input.budget?.model ? {model: input.budget.model} : {}),
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

  return {
    identity: {
      sessionId: input.sessionId,
      traceId: input.traceId,
      referenceTraceId: options.referenceTraceId,
      sessionMapKey: buildRuntimeSessionMapKey(input.sessionId, options.referenceTraceId),
    },
    query: {
      text: input.query,
    },
    runtime: {
      kind: runtimeKind,
      selection: input.runtimeSelection,
      capabilities: engineCapabilities,
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
    },
    traceContext: {
      datasetCount: options.traceContext?.length ?? 0,
      promptSection: traceContextPrompt,
    },
    selection: {
      present: !!options.selectionContext,
      kind: options.selectionContext?.kind,
      context: options.selectionContext,
    },
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
