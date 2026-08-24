// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AnalysisOptions,
  AnalysisResult,
  QuickRunContextInjectedCounts,
  QuickRunTurnBudget,
} from '../agent/core/orchestratorTypes';
import type { ConversationTurn, StreamingUpdate } from '../agent/types';
import type { SceneType } from '../agentv3/sceneClassifier';
import {
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import { applyFinalResultQualityGate } from '../services/finalResultQualityGate';
import type { AnalysisRunSpec } from './analysisRunSpec';
import { buildQuickAcknowledgementAnalysisResult } from './quickAcknowledgementDirectAnswer';
import type {
  RuntimeQuickEvidenceCounts,
  RuntimeQuickEvidenceDirectAnswer,
} from './quickEvidenceDirectAnswer';
import {
  buildQuickRunReceipt,
  shouldMarkQuickRunTriage,
} from './quickBudget';
import {
  currentRunManifestAttributionSink,
  resolveRunManifestAttributionSink,
} from '../services/selfEvolution/runManifestLifecycle';

type EmitUpdate = (update: StreamingUpdate) => void;

function recordDirectRuntimeModel(input: {
  options: AnalysisOptions;
  analysisRunSpec: AnalysisRunSpec;
  model: 'runtime-pre-evidence' | 'runtime-acknowledgement';
}): void {
  const sink = resolveRunManifestAttributionSink(
    input.options.runManifestAttributionSink,
    currentRunManifestAttributionSink(),
  );
  sink?.recordRuntime({
    runtime: input.analysisRunSpec.runtime.kind,
    providerId: input.analysisRunSpec.scopes.providerId ?? null,
    model: input.model,
    outputLanguage: input.analysisRunSpec.outputLanguage,
  });
  input.analysisRunSpec.runtime.actualModel = input.model;
}

export function countCompletedQuickConversationTurns(
  turns: ReadonlyArray<Pick<ConversationTurn, 'completed'>>,
): number {
  return turns.filter(turn => turn.completed).slice(-3).length;
}

export function buildQuickDirectEvidenceAnalysisResult(input: {
  query: string;
  sessionId: string;
  options: AnalysisOptions;
  startedAt: number;
  analysisRunSpec: AnalysisRunSpec;
  budget: QuickRunTurnBudget;
  directAnswer: RuntimeQuickEvidenceDirectAnswer;
  evidenceCounts: RuntimeQuickEvidenceCounts;
  previousTurns: ReadonlyArray<Pick<ConversationTurn, 'completed'>>;
  hypotheses?: AnalysisResult['hypotheses'];
  contextInjected?: Partial<Omit<QuickRunContextInjectedCounts, 'conversationTurns'>>;
}): AnalysisResult {
  recordDirectRuntimeModel({
    options: input.options,
    analysisRunSpec: input.analysisRunSpec,
    model: 'runtime-pre-evidence',
  });
  const elapsedMs = Date.now() - input.startedAt;
  return {
    sessionId: input.sessionId,
    success: true,
    findings: [],
    hypotheses: input.hypotheses ?? [],
    conclusion: input.directAnswer.conclusion,
    conclusionContract: input.directAnswer.conclusionContract,
    confidence: input.directAnswer.confidence,
    rounds: 0,
    totalDurationMs: elapsedMs,
    quickRun: buildQuickRunReceipt({
      requestedMode: input.options.analysisMode ?? 'auto',
      profile: shouldMarkQuickRunTriage(input.query) ? 'triage' : undefined,
      budget: input.budget,
      actualTurns: 0,
      elapsedMs,
      stopReason: 'answered',
      evidence: {
        frontendPrequeryInjected: input.analysisRunSpec.traceContext.datasetCount,
        currentRunDataEnvelopes: input.evidenceCounts.currentRunDataEnvelopes,
        citedEvidenceRefs: input.evidenceCounts.citedEvidenceRefs,
      },
      contextInjected: {
        conversationTurns: countCompletedQuickConversationTurns(input.previousTurns),
        ...(input.contextInjected ?? {}),
      },
      adaptiveRouting: input.analysisRunSpec.mode.adaptiveRouting,
    }),
  };
}

export function buildQuickDirectAcknowledgementAnalysisResult(input: {
  sessionId: string;
  options: AnalysisOptions;
  outputLanguage: OutputLanguage;
  startedAt: number;
  analysisRunSpec: AnalysisRunSpec;
  budget: QuickRunTurnBudget;
  previousTurns: ReadonlyArray<Pick<ConversationTurn, 'completed'>>;
}): AnalysisResult {
  recordDirectRuntimeModel({
    options: input.options,
    analysisRunSpec: input.analysisRunSpec,
    model: 'runtime-acknowledgement',
  });
  return buildQuickAcknowledgementAnalysisResult({
    sessionId: input.sessionId,
    outputLanguage: input.outputLanguage,
    requestedMode: input.options.analysisMode ?? 'auto',
    budget: input.budget,
    elapsedMs: Date.now() - input.startedAt,
    frontendPrequeryInjected: input.analysisRunSpec.traceContext.datasetCount,
    conversationTurns: countCompletedQuickConversationTurns(input.previousTurns),
    adaptiveRouting: input.analysisRunSpec.mode.adaptiveRouting,
  });
}

export function emitQuickDirectQualityGateIssue(input: {
  emitUpdate: EmitUpdate;
  module: string;
  result: AnalysisResult;
  query: string;
  sceneType: SceneType;
}): void {
  const gateIssue = applyFinalResultQualityGate({
    result: input.result,
    query: input.query,
    sceneType: input.sceneType,
  });
  if (!gateIssue) return;
  input.emitUpdate({
    type: 'degraded',
    content: {
      module: input.module,
      fallback: gateIssue.code,
      partial: true,
      message: gateIssue.message,
    },
    timestamp: Date.now(),
  });
}

export function emitQuickDirectAnswerEvents(input: {
  emitUpdate: EmitUpdate;
  result: AnalysisResult;
  startedAt: number;
  outputLanguage: OutputLanguage;
  runtime: string;
  model: 'runtime-pre-evidence' | 'runtime-acknowledgement';
}): void {
  const acknowledgement = input.model === 'runtime-acknowledgement';
  input.emitUpdate({
    type: 'progress',
    content: {
      phase: 'answering',
      message: acknowledgement
        ? localize(
          input.outputLanguage,
          '已直接处理确认类 follow-up。',
          'Handled the acknowledgement follow-up directly.',
        )
        : localize(
          input.outputLanguage,
          '已用运行时结构化预证据直接回答。',
          'Answered directly from runtime structured pre-evidence.',
        ),
      runtime: input.runtime,
      model: input.model,
    },
    timestamp: Date.now(),
  });
  input.emitUpdate({
    type: 'conclusion',
    content: {
      conclusion: input.result.conclusion,
      durationMs: Date.now() - input.startedAt,
      turns: 0,
    },
    timestamp: Date.now(),
  });
  input.emitUpdate({
    type: 'answer_token',
    content: { done: true, totalChars: input.result.conclusion.length },
    timestamp: Date.now(),
  });
}
