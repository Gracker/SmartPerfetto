// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';

import type { AgentRuntimeAnalysisResult } from '../../../agent';
import {
  finalizeAgentDrivenSession,
  type FinalizeAgentDrivenSessionDeps,
} from '../finalizeAgentDrivenSession';

type TestSessionStatus =
  | 'pending'
  | 'running'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'quota_exceeded';

interface TestSession {
  result?: AgentRuntimeAnalysisResult;
  hypotheses: AgentRuntimeAnalysisResult['hypotheses'];
  conclusionHistory: Array<{
    turn: number;
    conclusion: string;
    confidence: number;
    timestamp: number;
  }>;
  runSequence?: number;
  activeRun?: { runId?: string; requestId?: string; sequence?: number };
  lastRun?: { runId?: string; requestId?: string; sequence?: number };
  status: TestSessionStatus;
  sseClients: Array<{ id: string }>;
  logger: {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    close: jest.Mock;
  };
  completedAnalysisFinalArtifacts?: unknown;
  completedAnalysisSseEvents?: unknown;
  completedAnalysisSseEventsQualityGateVersion?: number;
  completedAnalysisFinalArtifactsByRunId?: Record<string, unknown>;
  completedAnalysisSseEventsByRunId?: Record<string, unknown>;
}

function createResult(): AgentRuntimeAnalysisResult {
  return {
    sessionId: 'session-a',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: '收到。',
    confidence: 1,
    rounds: 0,
    totalDurationMs: 12,
  };
}

function createSession(): TestSession {
  return {
    hypotheses: [],
    conclusionHistory: [],
    runSequence: 1,
    activeRun: {
      runId: 'run-current',
      requestId: 'request-current',
      sequence: 1,
    },
    status: 'running',
    sseClients: [],
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      close: jest.fn(),
    },
    completedAnalysisFinalArtifacts: { reportUrl: '/api/reports/old-global' },
    completedAnalysisSseEvents: [{ eventType: 'analysis_completed' }],
    completedAnalysisSseEventsQualityGateVersion: 1,
    completedAnalysisFinalArtifactsByRunId: {
      'run-current': { reportUrl: '/api/reports/old-current' },
      'run-other': { reportUrl: '/api/reports/old-other' },
    },
    completedAnalysisSseEventsByRunId: {
      'run-current': { events: ['old-current'] },
      'run-other': { events: ['old-other'] },
    },
  };
}

function createEnsureCompletedAnalysisSseEventsMock() {
  return jest.fn((
    _targetSession: TestSession,
    _runId?: string,
  ): unknown[] => []);
}

function createFinalizeDeps(
  ensureCompletedAnalysisSseEvents = createEnsureCompletedAnalysisSseEventsMock(),
): FinalizeAgentDrivenSessionDeps<TestSession> {
  return {
    applyFinalResultQualityGate: () => null,
    isRunCurrent: () => true,
    broadcast: () => undefined,
    buildConversationStepUpdate: () => null,
    appendConversationStep: () => undefined,
    annotateLatestCompletedTurn: () => undefined,
    terminalRunStatusForResult: () => 'completed',
    markSessionRunStatus: (targetSession, status) => {
      targetSession.status = status === 'quota_exceeded' ? 'quota_exceeded' : 'completed';
    },
    persistAgentTurn: () => undefined,
    ensureCompletedAnalysisSseEvents,
    sendAgentDrivenResult: () => undefined,
  };
}

describe('finalizeAgentDrivenSession completed-cache invalidation', () => {
  it('clears stale global completed caches when a run-scoped result finalizes', () => {
    const session = createSession();
    const ensureCompletedAnalysisSseEvents = createEnsureCompletedAnalysisSseEventsMock();

    finalizeAgentDrivenSession({
      sessionId: 'session-a',
      query: '谢谢',
      traceId: 'trace-a',
      session,
      result: createResult(),
      runId: 'run-current',
      logComponent: 'test',
    }, createFinalizeDeps(ensureCompletedAnalysisSseEvents));

    expect(session.completedAnalysisFinalArtifacts).toBeUndefined();
    expect(session.completedAnalysisSseEvents).toBeUndefined();
    expect(session.completedAnalysisSseEventsQualityGateVersion).toBeUndefined();
    expect(session.completedAnalysisFinalArtifactsByRunId).not.toHaveProperty('run-current');
    expect(session.completedAnalysisSseEventsByRunId).not.toHaveProperty('run-current');
    expect(session.completedAnalysisFinalArtifactsByRunId).toHaveProperty('run-other');
    expect(session.completedAnalysisSseEventsByRunId).toHaveProperty('run-other');
    expect(ensureCompletedAnalysisSseEvents).toHaveBeenCalledWith(session, 'run-current');
  });

  it('clears current run completed caches when finalization derives the run id from the session', () => {
    const session = createSession();
    const ensureCompletedAnalysisSseEvents = createEnsureCompletedAnalysisSseEventsMock();

    finalizeAgentDrivenSession({
      sessionId: 'session-a',
      query: '谢谢',
      traceId: 'trace-a',
      session,
      result: createResult(),
      logComponent: 'test',
    }, createFinalizeDeps(ensureCompletedAnalysisSseEvents));

    expect(session.completedAnalysisFinalArtifacts).toBeUndefined();
    expect(session.completedAnalysisSseEvents).toBeUndefined();
    expect(session.completedAnalysisFinalArtifactsByRunId).not.toHaveProperty('run-current');
    expect(session.completedAnalysisSseEventsByRunId).not.toHaveProperty('run-current');
    expect(session.completedAnalysisFinalArtifactsByRunId).toHaveProperty('run-other');
    expect(session.completedAnalysisSseEventsByRunId).toHaveProperty('run-other');
    expect(ensureCompletedAnalysisSseEvents).toHaveBeenCalledWith(session, 'run-current');
  });

  it('records conclusion history after final quality gate mutations', () => {
    const session = createSession();
    const result = createResult();
    const deps = createFinalizeDeps();
    deps.applyFinalResultQualityGate = jest.fn((input: {
      result: AgentRuntimeAnalysisResult;
      query: string;
    }) => {
      const targetResult = input.result;
      targetResult.confidence = 0.55;
      targetResult.partial = true;
      targetResult.terminationMessage = 'quality gate downgraded the result';
      return { code: 'sparse_unverified_conclusion', message: 'quality gate' };
    });

    finalizeAgentDrivenSession({
      sessionId: 'session-a',
      query: '分析一下',
      traceId: 'trace-a',
      session,
      result,
      runId: 'run-current',
      logComponent: 'test',
    }, deps);

    expect(session.result?.confidence).toBe(0.55);
    expect(session.conclusionHistory[0]).toMatchObject({
      conclusion: '收到。',
      confidence: 0.55,
    });
  });

  it('passes the resolved scene through the final quality gate', () => {
    const session = createSession();
    const result = createResult();
    const deps = createFinalizeDeps();
    deps.applyFinalResultQualityGate = jest.fn(() => null);

    finalizeAgentDrivenSession({
      sessionId: 'session-a',
      query: '检查是否存在 ANR',
      traceId: 'trace-a',
      sceneType: 'anr',
      session,
      result,
      runId: 'run-current',
      logComponent: 'test',
    }, deps);

    expect(deps.applyFinalResultQualityGate).toHaveBeenCalledWith({
      result,
      query: '检查是否存在 ANR',
      sceneType: 'anr',
    });
  });

  it('completes deterministic comparison identity before final quality gating', () => {
    const session = createSession();
    const result = createResult();
    result.conclusion = '# 双 Trace 对比分析报告\n\n## 综合结论\n\n左侧明显慢于右侧。';
    const deps = createFinalizeDeps();
    deps.applyFinalResultQualityGate = jest.fn(() => null);

    finalizeAgentDrivenSession({
      sessionId: 'session-a',
      query: '对比两个 trace',
      traceId: 'trace-a',
      session,
      result,
      runId: 'run-current',
      logComponent: 'test',
      outputLanguage: 'zh-CN',
      comparisonIdentity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
    }, deps);

    expect(result.conclusion).toContain('`com.example.heavy`');
    expect(result.conclusion).toContain('`com.example.demo`');
    expect(deps.applyFinalResultQualityGate).toHaveBeenCalledWith({
      result,
      query: '对比两个 trace',
      sceneType: undefined,
      comparisonIdentity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
    });
    expect(session.conclusionHistory[0]?.conclusion).toBe(result.conclusion);
  });

  it('finalizes and sends a timeout-partial result through the terminal SSE path', () => {
    const session = createSession();
    session.sseClients.push({id: 'client-a'});
    const result: AgentRuntimeAnalysisResult = {
      ...createResult(),
      partial: true,
      terminationReason: 'timeout',
      terminationMessage: 'Provider stream idle timeout',
    };
    const deps = createFinalizeDeps();
    deps.ensureCompletedAnalysisSseEvents = jest.fn((targetSession: TestSession) => {
      const events = [
        {eventType: 'analysis_completed'},
        {eventType: 'end'},
      ];
      targetSession.completedAnalysisSseEvents = events;
      return events;
    });
    deps.sendAgentDrivenResult = jest.fn((_client: unknown, targetSession: TestSession) => {
      expect(targetSession.completedAnalysisSseEvents).toEqual([
        {eventType: 'analysis_completed'},
        {eventType: 'end'},
      ]);
    });

    finalizeAgentDrivenSession({
      sessionId: 'session-a',
      query: '分析一下',
      traceId: 'trace-a',
      session,
      result,
      runId: 'run-current',
      logComponent: 'test',
    }, deps);

    expect(session.status).toBe('completed');
    expect(session.result).toMatchObject({partial: true, terminationReason: 'timeout'});
    expect(deps.ensureCompletedAnalysisSseEvents).toHaveBeenCalledWith(session, 'run-current');
    expect(deps.sendAgentDrivenResult).toHaveBeenCalledWith(
      {id: 'client-a'},
      session,
      'run-current',
    );
  });
});
