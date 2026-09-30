// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { requireRequestContext } from '../middleware/auth';
import { isOwnedByContext, sendResourceNotFound } from '../services/resourceOwnership';
import {copyAnalysisDeliveryFields} from '../services/security/analysisDeliveryProjection';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import {
  privateAnalysisQueryMessage,
  projectOwnerAnalysisResult,
  copyAnalysisResultForSnapshot,
  projectOwnerReportError,
  projectOwnerStructuredValue,
  projectOwnerTerminationMessage,
  projectPrivateTerminationReason,
} from '../services/security/privateAnalysisProjection';
import {sessionRunHasPrivateContext} from '../assistant/application/agentAnalyzeSessionService';

interface AgentReportRoutesDeps {
  getSession: (sessionId: string) => any;
  recoverResultForSessionIfNeeded: (sessionId: string, session: any) => any;
  buildClientFindings: (findings: any[], scenes: any[]) => any[];
  buildSessionResultContract: (session: any, clientFindings: any[]) => unknown;
  getCompletedPayload?: (session: any) => any;
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

    if (session.status !== 'completed' && session.status !== 'quota_exceeded' && !(session.status === 'failed' && session.result)) {
      return res.status(400).json({
        success: false,
        error: 'Session is not completed yet',
        status: session.status,
      });
    }

    const storedResult = deps.recoverResultForSessionIfNeeded(sessionId, session);
    if (!storedResult) {
      return res.status(404).json({
        success: false,
        error: 'No completed turn result available for this session',
        hint: `Use /api/agent/v1/${sessionId}/turns to inspect historical turns`,
      });
    }

    const completedPayload = deps.getCompletedPayload?.(session);
    const privateKnowledge = sessionRunHasPrivateContext(session);
    const outputLanguage = session.outputLanguage
      ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const result = privateKnowledge
      ? projectOwnerAnalysisResult(sessionId, storedResult, outputLanguage)
      : copyAnalysisResultForSnapshot(storedResult);
    const conclusion = result.conclusion;
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const rawClientFindings = deps.buildClientFindings(findings, session.scenes || []);
    const clientFindings = privateKnowledge
      ? projectOwnerStructuredValue(sessionId, rawClientFindings)
      : rawClientFindings;
    const rawResultContract = deps.buildSessionResultContract(session, rawClientFindings);
    const resultContract = privateKnowledge
      ? projectOwnerStructuredValue(sessionId, rawResultContract)
      : rawResultContract;
    const rawHypotheses = Array.isArray(result.hypotheses) ? result.hypotheses : [];
    const hypotheses = privateKnowledge
      ? projectOwnerStructuredValue(sessionId, rawHypotheses)
      : rawHypotheses;
    const conversationTimeline = Array.isArray(session.conversationSteps)
      ? session.conversationSteps
      : [];

    // Use snapshot as single source of truth for agentv3-specific state.
    // Falls back to live getters for active sessions where snapshot hasn't been taken yet.
    const snapshot = privateKnowledge
      ? undefined
      : SessionPersistenceService.getInstance().loadSessionStateSnapshot(sessionId);
    const analysisNotes = privateKnowledge ? [] : snapshot?.analysisNotes
      ?? (typeof session.orchestrator?.getSessionNotes === 'function'
        ? session.orchestrator.getSessionNotes(sessionId) : []);
    const analysisPlan = privateKnowledge ? null : snapshot?.analysisPlan
      ?? (typeof session.orchestrator?.getSessionPlan === 'function'
        ? session.orchestrator.getSessionPlan(sessionId) : null);
    const uncertaintyFlags = privateKnowledge ? [] : snapshot?.uncertaintyFlags
      ?? (typeof session.orchestrator?.getSessionUncertaintyFlags === 'function'
        ? session.orchestrator.getSessionUncertaintyFlags(sessionId) : []);
    const rawClaimSupport = result.claimSupport;
    const rawClaimVerification = result.claimVerificationResult;
    const rawIdentityResolutions = result.identityResolutions;
    const rawConclusionContract = result.conclusionContract;
    const rawUiActionProposals = completedPayload?.uiActionProposals || result.uiActionProposals || [];

    const report = {
      sessionId,
      traceId: session.traceId,
      query: privateKnowledge ? privateAnalysisQueryMessage(outputLanguage) : session.query,
      createdAt: session.createdAt,
      completedAt: Date.now(),
      ...copyAnalysisDeliveryFields(result),
      sourceUseDecision: result.sourceUseDecision,
      sourceClaimVerificationResult: result.sourceClaimVerificationResult,
      summary: {
        ...copyAnalysisDeliveryFields(result),
        success: result.success,
        conclusion,
        confidence: result.confidence,
        totalDurationMs: result.totalDurationMs,
        rounds: result.rounds,
        partial: result.partial,
        terminationReason: privateKnowledge
          ? projectPrivateTerminationReason(result.terminationReason)
          : result.terminationReason,
        terminationMessage: privateKnowledge
          ? projectOwnerTerminationMessage(result.terminationMessage, outputLanguage, result)
          : result.terminationMessage,
      },
      reportUrl: completedPayload?.finalArtifacts?.reportUrl,
      reportError: projectOwnerReportError(privateKnowledge, sessionId,
        completedPayload?.finalArtifacts?.reportError, outputLanguage),
      resultSnapshotId: completedPayload?.finalArtifacts?.resultSnapshotId,
      conclusionContract: rawConclusionContract,
      claimSupport: rawClaimSupport,
      claimVerificationResult: rawClaimVerification,
      identityResolutions: rawIdentityResolutions,
      uiActionProposals: privateKnowledge
        ? projectOwnerStructuredValue(sessionId, rawUiActionProposals)
        : rawUiActionProposals,
      findings: clientFindings.map((f: any) => ({
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
      conversationTimeline: (privateKnowledge ? projectOwnerStructuredValue(sessionId, conversationTimeline) : conversationTimeline).map((step: any) => ({
        eventId: step.eventId,
        ordinal: step.ordinal,
        phase: step.phase,
        role: step.role,
        text: step.text,
        timestamp: step.timestamp,
        sourceEventType: step.sourceEventType,
      })),
      queryHistory: privateKnowledge ? [] : session.queryHistory || [],
      conclusionHistory: privateKnowledge ? projectOwnerStructuredValue(sessionId, session.conclusionHistory || []) : session.conclusionHistory || [],
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
