// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {StreamingUpdate} from '../agent/types';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {claimVerificationNotCheckedExplanation} from './analysisInvestigationPresentation';
import type {FinalSemanticAssessment} from './finalSemanticAssessment';

/**
 * The one no-tool semantic review can take minutes after the answer finished
 * streaming. These two events say that it started (and its deadline) and how it
 * ended. They carry no provider text and no byte or token counts.
 * `answerReadable` is true when the surface already received the provisional
 * answer, so the line tells the reader the text is final and only the verdict waits.
 */
export type FinalizationProgressEvent =
  | {readonly stage: 'final_review_started'; readonly deadlineAt: number; readonly answerReadable?: boolean}
  | {readonly stage: 'final_review_finished'; readonly status: FinalSemanticAssessment['status'];
    readonly reason?: FinalSemanticAssessment['reason']};

export type FinalizationProgressObserver = (event: FinalizationProgressEvent) => void;

/** Live progress projection shared by the Web SSE stream, the CLI stream and conversations. */
export function finalReviewProgressUpdate(
  event: FinalizationProgressEvent,
  language: OutputLanguage,
  now = Date.now(),
): StreamingUpdate {
  if (event.stage === 'final_review_started') {
    // The deadline is the run's hard budget, not an estimate; it stays in the
    // payload for clients but is not read out as an expected wait.
    return {type: 'progress', timestamp: now, content: {
      phase: 'final_review', stage: 'started', deadlineAt: event.deadlineAt,
      ...(event.answerReadable ? {answerReadable: true} : {}),
      message: event.answerReadable
        ? localize(language, '结论已可阅读，正在核验结论与其声明是否一致',
          'The answer is ready to read; checking it against its declared claims')
        : localize(language, '正在核验结论与其声明是否一致',
          'Checking the answer against its declared claims'),
    }};
  }
  const explanation = claimVerificationNotCheckedExplanation({notCheckedReason: event.reason}, language);
  const message = event.status === 'checked'
    ? localize(language, '结论复核已完成', 'Final review completed')
    : event.status === 'coverage_incomplete'
      ? localize(language, `结论复核已完成，但覆盖不完整${explanation ? `：${explanation}` : ''}`,
        `Final review completed with incomplete coverage${explanation ? `: ${explanation}` : ''}`)
      : localize(language, `结论复核未完成${explanation ? `：${explanation}` : ''}`,
        `Final review did not complete${explanation ? `: ${explanation}` : ''}`);
  return {type: 'progress', timestamp: now, content: {
    phase: 'final_review', stage: 'finished', outcome: event.status,
    ...(event.reason ? {reason: event.reason} : {}), message,
  }};
}
