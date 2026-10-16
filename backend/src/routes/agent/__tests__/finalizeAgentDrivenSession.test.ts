// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';

import type { AgentRuntimeAnalysisResult } from '../../../agent';
import {
  finalizeAgentDrivenSession,
  type FinalizeAgentDrivenSessionDeps,
} from '../finalizeAgentDrivenSession';
import {NO_PRIVATE_CONTEXT} from '../../../services/security/analysisPrivateContext';

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
    refreshPersistedAgentSnapshot: () => undefined,
    runPrivateContext: () => NO_PRIVATE_CONTEXT,
    ensureCompletedAnalysisSseEvents,
    sendAgentDrivenResult: () => undefined,
  };
}

describe('finalizeAgentDrivenSession completed-cache invalidation', () => {
  it('persists once before artifact generation and refreshes the snapshot afterward', () => {
    const session = createSession();
    const order: string[] = [];
    const deps = createFinalizeDeps(jest.fn(() => {
      order.push('artifacts');
      session.result!.analysisReceipt = {schemaVersion: 2, runManifestId: 'manifest-final'} as any;
      return [];
    }));
    deps.persistAgentTurn = jest.fn(() => order.push('initial-persist'));
    deps.refreshPersistedAgentSnapshot = jest.fn(() => order.push('snapshot-refresh'));

    finalizeAgentDrivenSession({
      sessionId: 'session-a', query: 'analyze', traceId: 'trace-a', session,
      result: createResult(), runId: 'run-current', logComponent: 'test',
    }, deps);

    expect(order).toEqual(['initial-persist', 'artifacts', 'snapshot-refresh']);
    expect(deps.persistAgentTurn).toHaveBeenCalledTimes(1);
    expect(deps.refreshPersistedAgentSnapshot).toHaveBeenCalledTimes(1);
    expect(session.result?.analysisReceipt).toEqual(expect.objectContaining({runManifestId: 'manifest-final'}));
  });

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

  it('commits supplied quality state and the complete final result without another gate', () => {
    const session = createSession();
    const result = {...createResult(), conclusion: 'original\r\nbody', confidence: 0.55,
      partial: true, terminationMessage: 'verified quality issue'};
    const deps = createFinalizeDeps();
    deps.broadcast = jest.fn();
    deps.persistAgentTurn = jest.fn();
    deps.refreshPersistedAgentSnapshot = jest.fn();
    finalizeAgentDrivenSession({sessionId: 'session-a', query: 'analysis', traceId: 'trace-a',
      session, result, runId: 'run-current', logComponent: 'test',
      qualityIssue: {code: 'sparse_unverified_conclusion', message: 'quality issue'},
    }, deps);
    expect(session.result).toBe(result);
    expect(session.conclusionHistory[0]).toMatchObject({conclusion: 'original\r\nbody', confidence: 0.55});
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
    expect(deps.persistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({result}));
    expect(deps.refreshPersistedAgentSnapshot).toHaveBeenCalledWith(expect.objectContaining({result}));
  });

  it('preserves finalized comparison prose without adding package names', () => {
    const session = createSession();
    const result = {...createResult(), conclusion: 'Left trace is slower.\r\n'};
    finalizeAgentDrivenSession({sessionId: 'session-a', query: 'compare com.a and com.b', traceId: 'trace-a',
      session, result, runId: 'run-current', logComponent: 'test'}, createFinalizeDeps());
    expect(result.conclusion).toBe('Left trace is slower.\r\n');
    expect(session.conclusionHistory[0]?.conclusion).toBe(result.conclusion);
  });

  it('rechecks ownership after a callback and stops before history, persistence or delivery', () => {
    const session = createSession();
    const result = createResult();
    const deps = createFinalizeDeps();
    let current = true;
    deps.isRunCurrent = () => current;
    deps.broadcast = () => {current = false;};
    deps.annotateLatestCompletedTurn = jest.fn();
    deps.persistAgentTurn = jest.fn();
    deps.sendAgentDrivenResult = jest.fn();
    expect(() => finalizeAgentDrivenSession({sessionId: 'session-a', query: 'analysis', traceId: 'trace-a',
      session, result, runId: 'run-current', logComponent: 'test',
      qualityIssue: {code: 'sparse_unverified_conclusion', message: 'quality issue'},
    }, deps)).toThrow('analysis_run_superseded');
    expect(session.conclusionHistory).toEqual([]);
    expect(deps.annotateLatestCompletedTurn).not.toHaveBeenCalled();
    expect(deps.persistAgentTurn).not.toHaveBeenCalled();
    expect(deps.sendAgentDrivenResult).not.toHaveBeenCalled();
  });

  it('rejects revoked authorization before assigning the final result', () => {
    const session = createSession();
    const deps = createFinalizeDeps();
    deps.persistAgentTurn = jest.fn();
    expect(() => finalizeAgentDrivenSession({sessionId: 'session-a', query: 'analysis', traceId: 'trace-a',
      session, result: createResult(), runId: 'run-current', logComponent: 'test',
      assertCurrent: () => {throw new Error('authorization_revoked');},
    }, deps)).toThrow('authorization_revoked');
    expect(session.result).toBeUndefined();
    expect(deps.persistAgentTurn).not.toHaveBeenCalled();
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
