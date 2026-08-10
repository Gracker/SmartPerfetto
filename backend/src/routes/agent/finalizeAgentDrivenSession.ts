// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AgentRuntimeAnalysisResult,
  Hypothesis,
  StreamingUpdate,
} from '../../agent';

type SessionStatus = 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled' | 'quota_exceeded';

interface FinalizeSessionLike {
  result?: AgentRuntimeAnalysisResult;
  hypotheses: Hypothesis[];
  conclusionHistory: Array<{ turn: number; conclusion: string; confidence: number; timestamp: number }>;
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
  applyFinalResultQualityGate(input: {
    result: AgentRuntimeAnalysisResult;
    query: string;
    sceneType?: string;
  }): { code: string; message: string } | null | undefined;
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
    result: {
      conclusion: string;
      totalDurationMs: number;
      partial?: boolean;
      terminationMessage?: string;
    };
    logger: TSession['logger'];
    logComponent: string;
  }): void;
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
}, deps: FinalizeAgentDrivenSessionDeps<TSession>): void {
  const { sessionId, query, traceId, sceneType, session, result, runId } = input;
  const { logger } = session;
  const completedRunId = getCompletedResultRunId(session, runId);
  if (!deps.isRunCurrent(session, runId)) {
    logger.warn(input.logComponent, 'Skipping stale finalization', {
      sessionId,
      runId,
    });
    return;
  }

  session.result = result;
  if (completedRunId) {
    delete session.completedAnalysisFinalArtifactsByRunId?.[completedRunId];
    delete session.completedAnalysisSseEventsByRunId?.[completedRunId];
  }
  delete session.completedAnalysisFinalArtifacts;
  delete session.completedAnalysisSseEvents;
  delete session.completedAnalysisSseEventsQualityGateVersion;

  const finalQualityIssue = deps.applyFinalResultQualityGate({
    result,
    query,
    sceneType: sceneType ?? result.conclusionContract?.metadata?.sceneId,
  });
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
    const conversationStep = deps.buildConversationStepUpdate(session, update, runId);
    if (conversationStep) {
      deps.appendConversationStep(session, conversationStep);
      deps.broadcast(sessionId, conversationStep, runId);
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
    });
  }

  deps.annotateLatestCompletedTurn(sessionId, traceId, result);

  const terminalRunStatus = deps.terminalRunStatusForResult(result);
  session.status = terminalRunStatus === 'quota_exceeded'
    ? 'quota_exceeded'
    : result.success ? 'completed' : 'failed';
  deps.markSessionRunStatus(session, terminalRunStatus, undefined, runId);

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

  deps.persistAgentTurn({
    session,
    sessionId,
    traceId,
    query,
    result: {
      conclusion: result.conclusion,
      totalDurationMs: result.totalDurationMs,
      partial: result.partial,
      terminationMessage: result.terminationMessage,
    },
    logger,
    logComponent: input.logComponent,
  });

  deps.ensureCompletedAnalysisSseEvents(session, completedRunId);
  const clientCount = session.sseClients.length;
  session.sseClients.forEach((client, index) => {
    try {
      logger.info('AgentRoutes', `Sending finalized result to client ${index + 1}/${clientCount}`);
      deps.sendAgentDrivenResult(client, session, runId);
    } catch (e: any) {
      logger.error('AgentRoutes', `Error sending finalized result to client ${index + 1}`, e);
    }
  });
  logger.close();
}
