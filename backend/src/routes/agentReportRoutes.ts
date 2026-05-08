// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { requireRequestContext } from '../middleware/auth';
import { isOwnedByContext, sendResourceNotFound } from '../services/resourceOwnership';

interface AgentReportRoutesDeps {
  getSession: (sessionId: string) => any;
  recoverResultForSessionIfNeeded: (sessionId: string, session: any) => any;
  normalizeNarrativeForClient: (narrative: string) => string;
  buildClientFindings: (findings: any[], scenes: any[]) => any[];
  buildSessionResultContract: (session: any, clientFindings: any[]) => unknown;
}

export function registerAgentReportRoutes(
  router: express.Router,
  deps: AgentReportRoutesDeps
): void {
  router.get('/:sessionId/report', (req, res) => {
    const { sessionId } = req.params;

    const session = deps.getSession(sessionId);
    if (!session || !isOwnedByContext(session, requireRequestContext(req))) {
      return sendResourceNotFound(res, 'Session not found');
    }

    if (session.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Session is not completed yet',
        status: session.status,
      });
    }

    const result = deps.recoverResultForSessionIfNeeded(sessionId, session);
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'No completed turn result available for this session',
        hint: `Use /api/agent/v1/${sessionId}/turns to inspect historical turns`,
      });
    }

    const conclusion = deps.normalizeNarrativeForClient(result.conclusion);
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const clientFindings = deps.buildClientFindings(findings, session.scenes || []);
    const resultContract = deps.buildSessionResultContract(session, clientFindings);
    const hypotheses = Array.isArray(result.hypotheses) ? result.hypotheses : [];
    const conversationTimeline = Array.isArray(session.conversationSteps)
      ? session.conversationSteps
      : [];

    // Use snapshot as single source of truth for agentv3-specific state.
    // Falls back to live getters for active sessions where snapshot hasn't been taken yet.
    const snapshot = SessionPersistenceService.getInstance().loadSessionStateSnapshot(sessionId);
    const analysisNotes = snapshot?.analysisNotes
      ?? (typeof session.orchestrator?.getSessionNotes === 'function'
        ? session.orchestrator.getSessionNotes(sessionId) : []);
    const analysisPlan = snapshot?.analysisPlan
      ?? (typeof session.orchestrator?.getSessionPlan === 'function'
        ? session.orchestrator.getSessionPlan(sessionId) : null);
    const uncertaintyFlags = snapshot?.uncertaintyFlags
      ?? (typeof session.orchestrator?.getSessionUncertaintyFlags === 'function'
        ? session.orchestrator.getSessionUncertaintyFlags(sessionId) : []);

    const report = {
      sessionId,
      traceId: session.traceId,
      query: session.query,
      createdAt: session.createdAt,
      completedAt: Date.now(),
      summary: {
        conclusion,
        confidence: result.confidence,
        totalDurationMs: result.totalDurationMs,
        rounds: result.rounds,
      },
      findings: findings.map((f: any) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        title: f.title,
        description: f.description,
      })),
      hypotheses: hypotheses.map((h: any) => ({
        id: h.id,
        description: h.description,
        status: h.status,
        confidence: h.confidence,
      })),
      conversationTimeline: conversationTimeline.map((step: any) => ({
        eventId: step.eventId,
        ordinal: step.ordinal,
        phase: step.phase,
        role: step.role,
        text: step.text,
        timestamp: step.timestamp,
        sourceEventType: step.sourceEventType,
      })),
      queryHistory: session.queryHistory || [],
      conclusionHistory: session.conclusionHistory || [],
      analysisNotes,
      analysisPlan,
      uncertaintyFlags,
      resultContract,
      logFile: session.logger.getLogFilePath(),
    };

    return res.json({
      success: true,
      report,
    });
  });
}
