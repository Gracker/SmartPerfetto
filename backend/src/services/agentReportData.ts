// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared builder for `AgentDrivenReportData`, the input shape consumed by
 * `HTMLReportGenerator.generateAgentDrivenHTML`.
 *
 * Two call sites produce this object with near-identical logic:
 *   - `routes/agentRoutes.ts:runAgentDrivenAnalysis` (HTTP path)
 *   - `cli-user/services/cliAnalyzeService.ts:buildReportHtml` (CLI path)
 *
 * Centralizing here avoids drift — any future field added to the generator
 * only needs one update, not two — and lets the CLI drop its `as any`
 * escape hatch since the builder emits the exact typed shape.
 */

import type { Finding } from '../agent/types';
import type { AgentDrivenReportData } from './htmlReportGenerator';
import type { AnalyzeManagedSession } from '../assistant/application/agentAnalyzeSessionService';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import { getTraceProcessorService } from './traceProcessorService';

/**
 * The subset of `AnalysisResult` the builder reads. Stated explicitly so
 * callers can pass either the raw `AnalysisResult` (CLI) or a normalized
 * `resultForClient` (HTTP, where `conclusion`/`conclusionContract` have
 * been run through post-processors).
 */
interface ReportResultLike {
  sessionId: string;
  success: boolean;
  findings: Finding[];
  hypotheses: AgentDrivenReportData['hypotheses'];
  conclusion: string;
  conclusionContract?: unknown;
  confidence: number;
  rounds: number;
  totalDurationMs: number;
  partial?: boolean;
  terminationReason?: string;
  terminationMessage?: string;
}

export interface BuildAgentReportDataInput {
  session: AnalyzeManagedSession;
  result: ReportResultLike;
}

export function buildAgentDrivenReportData(
  input: BuildAgentReportDataInput,
): AgentDrivenReportData {
  const { session, result } = input;

  // Cumulative findings: dedup across all persisted turns. `session.result`
  // only carries the current turn's findings, but multi-turn reports need
  // the full picture to stay consistent with the timeline section.
  let cumulativeResult: ReportResultLike = result;
  try {
    const ctx = sessionContextManager.get(session.sessionId, session.traceId);
    if (ctx) {
      const allTurns = ctx.getAllTurns();
      if (allTurns.length > 1) {
        const allFindings = allTurns.flatMap((t) => t.findings || []);
        const seen = new Set<string>();
        const deduped = allFindings.filter((f) => {
          if (seen.has(f.id)) return false;
          seen.add(f.id);
          return true;
        });
        cumulativeResult = { ...result, findings: deduped };
      }
    }
  } catch {
    // Fallback to current turn only — non-fatal.
  }

  // Empty-conclusion recovery: rare SDK result-message drops leave an empty
  // string even though tokens streamed fine. Use conclusionHistory's latest
  // as a last-resort source of truth.
  if (!cumulativeResult.conclusion || !cumulativeResult.conclusion.trim()) {
    const lastCH = session.conclusionHistory?.length
      ? session.conclusionHistory[session.conclusionHistory.length - 1]
      : null;
    if (lastCH?.conclusion) {
      console.warn('[ReportData] Conclusion empty in result — recovered from conclusionHistory');
      cumulativeResult = { ...cumulativeResult, conclusion: lastCH.conclusion };
    }
  }

  const traceInfo = getTraceProcessorService().getTrace(session.traceId);
  const traceStartNs = traceInfo?.metadata?.startTime;
  const snapshot = (session as { _lastSnapshot?: {
    analysisNotes?: unknown[];
    analysisPlan?: unknown;
    uncertaintyFlags?: unknown[];
  } })._lastSnapshot;

  return {
    traceId: session.traceId,
    query: session.query,
    traceStartNs:
      traceStartNs !== undefined && traceStartNs !== null ? String(traceStartNs) : undefined,
    result: cumulativeResult as AgentDrivenReportData['result'],
    hypotheses: session.hypotheses as AgentDrivenReportData['hypotheses'],
    dialogue: session.agentDialogue as AgentDrivenReportData['dialogue'],
    conversationTimeline: session.conversationSteps as AgentDrivenReportData['conversationTimeline'],
    dataEnvelopes: session.dataEnvelopes as AgentDrivenReportData['dataEnvelopes'],
    agentResponses: session.agentResponses as AgentDrivenReportData['agentResponses'],
    timestamp: Date.now(),
    conversationTurns: session.runSequence || 1,
    queryHistory: session.queryHistory || [],
    conclusionHistory: session.conclusionHistory || [],
    // Snapshot-first — the HTTP route's persistence step stashes `_lastSnapshot`
    // on the session, the CLI's `persistTurnToBackend` does the same. Callers
    // that skip the snapshot step (tests, partial builds) fall through to
    // the orchestrator getters.
    analysisNotes: (snapshot?.analysisNotes as AgentDrivenReportData['analysisNotes'])
      ?? (typeof session.orchestrator.getSessionNotes === 'function'
        ? session.orchestrator.getSessionNotes(session.sessionId) : []),
    analysisPlan: (snapshot?.analysisPlan as AgentDrivenReportData['analysisPlan'])
      ?? (typeof session.orchestrator.getSessionPlan === 'function'
        ? session.orchestrator.getSessionPlan(session.sessionId) : null),
    uncertaintyFlags: (snapshot?.uncertaintyFlags as AgentDrivenReportData['uncertaintyFlags'])
      ?? (typeof session.orchestrator.getSessionUncertaintyFlags === 'function'
        ? session.orchestrator.getSessionUncertaintyFlags(session.sessionId) : []),
  };
}
