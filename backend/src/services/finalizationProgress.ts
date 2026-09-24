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
 */
export type FinalizationProgressEvent =
  | {readonly stage: 'final_review_started'; readonly deadlineAt: number}
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
    const minutes = Math.max(1, Math.ceil((event.deadlineAt - now) / 60_000));
    return {type: 'progress', timestamp: now, content: {
      phase: 'final_review', stage: 'started', deadlineAt: event.deadlineAt,
      message: localize(language,
        `正在复核结论正文与其声明是否一致（最长约 ${minutes} 分钟）`,
        `Reviewing the answer against its declared claims (up to about ${minutes} min)`),
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
