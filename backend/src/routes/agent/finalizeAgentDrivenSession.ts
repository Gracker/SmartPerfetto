// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AgentRuntimeAnalysisResult,
  Hypothesis,
  StreamingUpdate,
} from '../../agent';
import type {AnalysisSourceActivation} from '../../services/codebase/analysisSourceActivationPolicy';
import type {FinalResultQualityIssue} from '../../services/finalResultQualityGate';
import {
  privateContextRestrictsAudience,
  type AnalysisPrivateContextMarker,
} from '../../services/security/analysisPrivateContext';

type SessionStatus = 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled' | 'quota_exceeded';

interface FinalizeSessionLike {
  result?: AgentRuntimeAnalysisResult;
  hypotheses: Hypothesis[];
  conclusionHistory: Array<{
    turn: number;
    conclusion: string;
    confidence: number;
    timestamp: number;
    sourceDerived?: boolean;
  }>;
  sourceActivation?: AnalysisSourceActivation;
  runSequence?: number;
  activeRun?: { runId?: string; requestId?: string; sequence?: number };
  lastRun?: { runId?: string; requestId?: string; sequence?: number };
  completedAnalysisFinalArtifacts?: unknown;
  completedAnalysisSseEvents?: unknown;
  completedAnalysisSseEventsQualityGateVersion?: unknown;
  completedAnalysisFinalArtifactsByRunId?: Record<string, unknown>;
  completedAnalysisSseEventsByRunId?: Record<string, unknown>;
  status: SessionStatus;
  sseClients: any[];
  logger: {
    info(component: string, message: string, meta?: Record<string, unknown>): void;
    warn(component: string, message: string, meta?: Record<string, unknown>): void;
    error(component: string, message: string, error?: unknown): void;
    close(): void;
  };
}

export interface FinalizeAgentDrivenSessionDeps<TSession extends FinalizeSessionLike> {
  isRunCurrent(session: TSession, runId?: string): boolean;
  broadcast(sessionId: string, update: StreamingUpdate, runId?: string): void;
  buildConversationStepUpdate(session: TSession, update: StreamingUpdate, runId?: string): StreamingUpdate | null;
  appendConversationStep(session: TSession, update: StreamingUpdate): void;
  annotateLatestCompletedTurn(sessionId: string, traceId: string, result: AgentRuntimeAnalysisResult): void;
  terminalRunStatusForResult(result: AgentRuntimeAnalysisResult): string;
  markSessionRunStatus(session: TSession, status: string, error?: string, runId?: string): void;
  persistAgentTurn(input: {
    session: any;
    sessionId: string;
    traceId: string;
    query: string;
    result: AgentRuntimeAnalysisResult;
    logger: TSession['logger'];
    logComponent: string;
    privateContext: AnalysisPrivateContextMarker;
  }): void;
  refreshPersistedAgentSnapshot(input: {
    session: any;
    sessionId: string;
    traceId: string;
    query: string;
    result: AgentRuntimeAnalysisResult;
    logger: TSession['logger'];
    logComponent: string;
    privateContext: AnalysisPrivateContextMarker;
  }): void;
  /** A run's own private-context marker, fixed at admission. */
  runPrivateContext(session: TSession, runId?: string): AnalysisPrivateContextMarker;
  ensureCompletedAnalysisSseEvents(session: TSession, runId?: string): unknown[];
  sendAgentDrivenResult(client: any, session: TSession, runId?: string): void;
}

function getCompletedResultRunId<TSession extends FinalizeSessionLike>(
  session: TSession,
  runId?: string,
): string | undefined {
  return runId ?? session.activeRun?.runId ?? session.lastRun?.runId;
}

export function finalizeAgentDrivenSession<TSession extends FinalizeSessionLike>(input: {
  sessionId: string;
  query: string;
  traceId: string;
  sceneType?: string;
  session: TSession;
  result: AgentRuntimeAnalysisResult;
  runId?: string;
  logComponent: string;
  qualityIssue?: FinalResultQualityIssue;
  assertCurrent?: () => void;
}, deps: FinalizeAgentDrivenSessionDeps<TSession>): void {
  const {
    sessionId,
    query,
    traceId,
    session,
    result,
    runId,
  } = input;
  const { logger } = session;
  const completedRunId = getCompletedResultRunId(session, runId);
  const privateContext = deps.runPrivateContext(session, completedRunId);
  if (!deps.isRunCurrent(session, runId)) {
    logger.warn(input.logComponent, 'Skipping stale finalization', {
      sessionId,
      runId,
    });
    return;
  }

  const assertCurrent = () => {
    input.assertCurrent?.();
    if (!deps.isRunCurrent(session, runId)) throw new Error('analysis_run_superseded');
  };
  assertCurrent();
  session.result = result;
  if (completedRunId) {
    delete session.completedAnalysisFinalArtifactsByRunId?.[completedRunId];
    delete session.completedAnalysisSseEventsByRunId?.[completedRunId];
  }
  delete session.completedAnalysisFinalArtifacts;
  delete session.completedAnalysisSseEvents;
  delete session.completedAnalysisSseEventsQualityGateVersion;

  const finalQualityIssue = input.qualityIssue;
  if (finalQualityIssue) {
    const update: StreamingUpdate = {
      type: 'degraded',
      content: {
        module: 'agentRoutes',
        fallback: 'final_result_quality_gate',
        code: finalQualityIssue.code,
        partial: true,
        message: result.terminationMessage || finalQualityIssue.message,
      },
      timestamp: Date.now(),
    };
    deps.broadcast(sessionId, update, runId);
    assertCurrent();
    const conversationStep = deps.buildConversationStepUpdate(session, update, runId);
    assertCurrent();
    if (conversationStep) {
      deps.appendConversationStep(session, conversationStep);
      assertCurrent();
      deps.broadcast(sessionId, conversationStep, runId);
      assertCurrent();
    }
  }

  const existingIds = new Set(session.hypotheses.map(h => h.id));
  for (const h of result.hypotheses) {
    if (!existingIds.has(h.id)) {
      session.hypotheses.push(h);
      existingIds.add(h.id);
    } else {
      const idx = session.hypotheses.findIndex(existing => existing.id === h.id);
      if (idx >= 0) session.hypotheses[idx] = h;
    }
  }

  const currentTurn = session.runSequence || 1;
  if (!session.conclusionHistory) session.conclusionHistory = [];
  if (result.conclusion) {
    session.conclusionHistory.push({
      turn: currentTurn,
      conclusion: result.conclusion,
      confidence: result.confidence ?? 0,
      timestamp: Date.now(),
      sourceDerived: privateContextRestrictsAudience(privateContext) ? true : undefined,
    });
  }

  assertCurrent();
  deps.annotateLatestCompletedTurn(sessionId, traceId, result);
  assertCurrent();

  const terminalRunStatus = deps.terminalRunStatusForResult(result);
  assertCurrent();
  session.status = terminalRunStatus === 'quota_exceeded'
    ? 'quota_exceeded'
    : result.success ? 'completed' : 'failed';
  deps.markSessionRunStatus(session, terminalRunStatus, undefined, runId);
  assertCurrent();

  logger.info(input.logComponent, 'Agent-driven result finalized', {
    confidence: result.confidence,
    rounds: result.rounds,
    findingsCount: result.findings.length,
    hypothesesCount: result.hypotheses.length,
    claimSupportCount: result.claimSupport?.length || 0,
    claimVerifierStatus: result.claimVerificationResult?.status,
    partial: result.partial,
    terminationReason: result.terminationReason,
    runId: completedRunId,
    requestId: session.activeRun?.requestId || session.lastRun?.requestId,
    runSequence: session.activeRun?.sequence || session.lastRun?.sequence,
  });

  const persistenceInput = {
    session,
    sessionId,
    traceId,
    query,
    result,
    logger,
    logComponent: input.logComponent,
    privateContext,
  };
  assertCurrent();
  deps.persistAgentTurn(persistenceInput);
  assertCurrent();

  deps.ensureCompletedAnalysisSseEvents(session, completedRunId);
  assertCurrent();
  deps.refreshPersistedAgentSnapshot(persistenceInput);
  assertCurrent();
  const clientCount = session.sseClients.length;
  session.sseClients.forEach((client, index) => {
    assertCurrent();
    try {
      logger.info('AgentRoutes', `Sending finalized result to client ${index + 1}/${clientCount}`);
      assertCurrent();
      deps.sendAgentDrivenResult(client, session, runId);
    } catch (e: any) {
      logger.error('AgentRoutes', `Error sending finalized result to client ${index + 1}`, e);
    }
  });
  assertCurrent();
  logger.close();
}
