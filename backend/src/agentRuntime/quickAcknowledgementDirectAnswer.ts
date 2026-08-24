// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import type {
  AnalysisResult,
  QuickRunRequestedMode,
  QuickRunTurnBudget,
} from '../agent/core/orchestratorTypes';
import type { QuickDirectAnswerBase } from './quickDirectAnswerContract';
import type {AdaptiveRoutingReceiptV1} from '../types/adaptiveRouting';
import { buildQuickRunReceipt } from './quickBudget';

export interface QuickAcknowledgementDirectAnswer extends QuickDirectAnswerBase {}

export function buildQuickAcknowledgementDirectAnswer(input: {
  outputLanguage?: OutputLanguage;
} = {}): QuickAcknowledgementDirectAnswer {
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  return {
    conclusion: localize(
      outputLanguage,
      '收到。',
      'Got it.',
    ),
    confidence: 1,
  };
}

export function buildQuickAcknowledgementAnalysisResult(input: {
  sessionId: string;
  outputLanguage?: OutputLanguage;
  requestedMode: QuickRunRequestedMode;
  budget: QuickRunTurnBudget;
  elapsedMs: number;
  frontendPrequeryInjected: number;
  conversationTurns: number;
  adaptiveRouting?: AdaptiveRoutingReceiptV1;
}): AnalysisResult {
  const directAnswer = buildQuickAcknowledgementDirectAnswer({
    outputLanguage: input.outputLanguage,
  });
  return {
    sessionId: input.sessionId,
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: directAnswer.conclusion,
    confidence: directAnswer.confidence,
    rounds: 0,
    totalDurationMs: input.elapsedMs,
    quickRun: buildQuickRunReceipt({
      requestedMode: input.requestedMode,
      budget: input.budget,
      actualTurns: 0,
      elapsedMs: input.elapsedMs,
      stopReason: 'answered',
      evidence: {
        frontendPrequeryInjected: input.frontendPrequeryInjected,
      },
      contextInjected: {
        conversationTurns: input.conversationTurns,
      },
      adaptiveRouting: input.adaptiveRouting,
    }),
  };
}
