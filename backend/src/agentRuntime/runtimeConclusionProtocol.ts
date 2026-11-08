// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {stripMachineSegments} from '../agent/core/conclusionContract';
import type {AnalysisTurnIntent} from './analysisTurnIntent';
import type {VerificationIssue} from '../agentv3/types';

function projectTurnIntentForDelivery(intent: AnalysisTurnIntent) {
  return {
    schemaVersion: 1 as const,
    status: intent.status,
    taskKind: intent.taskKind,
    sceneId: intent.sceneId,
    scope: intent.scope,
    deliverable: intent.deliverable,
    evidenceAccess: intent.evidenceAccess,
  };
}

/** Shared structured delivery issue projection; model prose never changes controller decisions. */
export function projectRuntimeCorrectionContext(issues: readonly VerificationIssue[]) {
  const errors = issues.filter(issue => issue.severity === 'error');
  return {
    recoveryKinds: [...new Set(errors.flatMap(issue => issue.recoveryKind ? [issue.recoveryKind] : []))],
    issues: issues.map(({type, severity, message, recoveryKind}) => ({type, severity, message, recoveryKind})),
  };
}

/** Full-answer delivery: one tool-free call that replaces the unfinished candidate with a complete body. */
export function buildNativeOutputCompletionPrompt(input: {
  candidate: string;
  intent: AnalysisTurnIntent;
  issues: readonly VerificationIssue[];
  outputLanguage: OutputLanguage;
}): string {
  const data = JSON.stringify({schemaVersion: 1, kind: 'original_native_candidate', body: input.candidate})
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return renderRequiredLocalizedStrategyTemplate('prompt-native-output-completion', input.outputLanguage, {
    original_candidate_json: data,
    correction_context: JSON.stringify(projectRuntimeCorrectionContext(input.issues)),
    turn_intent: JSON.stringify(projectTurnIntentForDelivery(input.intent)),
  });
}

/** Whether a candidate carries an answer body; a stray machine segment alone is not one. Nothing is parsed. */
export function candidateHasAnswerBody(candidate: string): boolean {
  return stripMachineSegments(candidate).trim().length > 0;
}
