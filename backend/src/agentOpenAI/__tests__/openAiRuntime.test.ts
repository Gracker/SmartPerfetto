// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { OpenAIRuntime } from '../openAiRuntime';
import type { AnalysisPlanV3, PlanPhase } from '../../agentv3/types';

function phase(id: string, status: PlanPhase['status']): PlanPhase {
  const p: PlanPhase = {
    id,
    name: `Phase ${id}`,
    goal: `Goal ${id}`,
    expectedTools: ['invoke_skill'],
    status,
  };
  if (status === 'completed' || status === 'skipped') {
    p.summary = `Evidence summary for ${id}`;
  }
  return p;
}

function plan(phases: PlanPhase[]): AnalysisPlanV3 {
  return {
    phases,
    successCriteria: 'Complete every phase before final answer',
    submittedAt: Date.now(),
    toolCallLog: [],
  };
}

describe('OpenAIRuntime plan completion guard', () => {
  it('treats full-mode runs as incomplete until every plan phase is closed', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: false,
      pendingPhases: [],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'pending'), phase('p3', 'in_progress')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [
        expect.objectContaining({ id: 'p2' }),
        expect.objectContaining({ id: 'p3' }),
      ],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    });
  });

  it('does not require a plan in quick mode', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    expect(runtime.getPlanCompletionStatus('s1', true)).toMatchObject({
      complete: true,
      hasPlan: false,
      pendingPhases: [],
    });
  });

  it('does not treat closed phases with weak summaries as complete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const weak = phase('p1', 'completed');
    weak.summary = 'done';

    runtime.sessionPlans.set('s1', {
      current: plan([weak]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [expect.objectContaining({ id: 'p1' })],
    });
  });

  it('only allows deterministic stream finalization after full-mode plan completion with an answer', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'in_progress')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(false);

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, '')).toBe(false);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', true, 'final text')).toBe(false);
  });
});
