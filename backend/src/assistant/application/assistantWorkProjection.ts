// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AssistantWorkSummary} from '../contracts/assistantWorkContract';

/** A read model of supplied facts, not an execution or verification state machine. */
export function projectAssistantWork(input: {
  sessionId: string; runId?: string; status: string; live: boolean;
  startedAt?: number; completedAt?: number; interrupted?: boolean;
  provisionalDelivered?: boolean; hasResult?: boolean;
  outcomeKind?: string; activity?: AssistantWorkSummary['activity']; captureActivity?: AssistantWorkSummary['captureActivity'];
}): AssistantWorkSummary {
  const inputReason = input.outcomeKind === 'needs_user_input' ? 'question'
    : input.outcomeKind === 'recommend_full' ? 'full_analysis' : undefined;
  const phase = input.interrupted ? 'interrupted'
    : input.status === 'running' || input.status === 'pending'
      ? input.live ? input.provisionalDelivered ? 'reviewing' : 'running' : 'unknown'
      : input.status === 'cancelled' ? 'cancelled'
      : input.status === 'failed' || input.status === 'quota_exceeded' ? 'failed'
      : inputReason || input.status === 'awaiting_user' ? 'needs_input'
      : input.status === 'completed' ? input.hasResult ? 'ready' : 'finished' : 'unknown';
  return {sessionId: input.sessionId, ...(input.runId ? {runId: input.runId} : {}), phase,
    ...(input.startedAt !== undefined ? {startedAt: input.startedAt} : {}),
    ...(input.completedAt !== undefined ? {completedAt: input.completedAt} : {}),
    hasResult: input.hasResult === true,
    ...(inputReason ? {inputReason} : {}), ...(input.activity ? {activity: input.activity} : {}),
    ...(input.captureActivity ? {captureActivity: input.captureActivity} : {})};
}

/** A readable artifact can coexist with running, failed or waiting execution. */
export function withAssistantWorkResult(work: AssistantWorkSummary, available: boolean): AssistantWorkSummary {
  const hasResult = work.hasResult || available;
  return {...work, hasResult, phase: work.phase === 'finished' && hasResult ? 'ready' : work.phase};
}
