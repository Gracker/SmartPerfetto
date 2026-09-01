// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import type {IOrchestrator} from '../../../agent/core/orchestratorTypes';
import {
  analysisSourceSupplementRuntimeSessionId,
  cancelAnalysisSourceSupplement,
  runAnalysisSourceSupplement,
} from '../analysisSourceSupplement';

function createOrchestrator() {
  const emitter = new EventEmitter();
  const analyze = jest.fn().mockResolvedValue({
    sessionId: 'runtime-source',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: 'Foo.kt:L10-L20 implements the traced path.',
    confidence: 0.8,
    rounds: 3,
    totalDurationMs: 100,
  });
  const cleanupSession = jest.fn();
  const abortSession = jest.fn();
  return {
    analyze,
    cleanupSession,
    abortSession,
    orchestrator: Object.assign(emitter, {
      analyze,
      cleanupSession,
      abortSession,
      reset: jest.fn(),
    }) as unknown as IOrchestrator,
  };
}

describe('analysis source supplement', () => {
  it('runs in a separate source-only runtime session without policy budgets', async () => {
    const fixture = createOrchestrator();
    const outcome = await runAnalysisSourceSupplement({
      orchestrator: fixture.orchestrator,
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
      question: '完整审查源码',
      primaryConclusion: 'Trace primary conclusion.',
      analysisOptions: {
        codeAwareMode: 'provider_send',
        codebaseIds: ['app'],
        knowledgeSourceIds: ['wiki'],
        analysisContextFingerprint: 'authorization',
      },
    });

    expect(outcome.message).toContain('Foo.kt:L10-L20');
    expect(fixture.analyze).toHaveBeenCalledWith(
      expect.stringContaining('Trace primary conclusion.'),
      analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'),
      'trace-a',
      expect.objectContaining({
        analysisMode: 'fast',
        sourceUsePolicy: {phase: 'deep_enrichment'},
        codeAwareMode: 'provider_send',
        codebaseIds: ['app'],
        knowledgeSourceIds: undefined,
      }),
    );
    expect(fixture.cleanupSession).toHaveBeenCalledWith(
      analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'),
    );
  });

  it('aborts and cleans only the detached source runtime session', async () => {
    const fixture = createOrchestrator();
    await cancelAnalysisSourceSupplement(fixture.orchestrator, 'session-a', 'run-a');
    const runtimeSessionId = analysisSourceSupplementRuntimeSessionId('session-a', 'run-a');
    expect(fixture.abortSession).toHaveBeenCalledWith(runtimeSessionId);
    expect(fixture.cleanupSession).toHaveBeenCalledWith(runtimeSessionId);
  });
});
