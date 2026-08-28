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
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import {
  privateAnalysisQueryMessage,
  projectPrivateAnalysisResult,
  projectPrivateDataEnvelopes,
  projectPrivateHypotheses,
  projectPrivateStructuredValue,
  sessionUsesPrivateKnowledge,
} from './security/privateAnalysisProjection';
import type {SessionStateSnapshot} from '../agentv3/sessionStateSnapshot';
import {isCodebaseKind} from './codebase/codebaseRegistry';

type AgentReportSourceContext = AgentDrivenReportData['sourceContext'];
const MAX_REPORT_SOURCE_ID = 160;
const MAX_REPORT_SOURCE_DISPLAY_NAME = 120;

function safeReportSourceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_REPORT_SOURCE_ID ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('://') ||
    /[\s\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function safeReportSourceDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (
    !trimmed ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('://')
  ) {
    return undefined;
  }
  return trimmed.slice(0, MAX_REPORT_SOURCE_DISPLAY_NAME);
}

function safeSourceContext(
  snapshot: Pick<SessionStateSnapshot, 'codebaseSnapshot' | 'codeLookupSummary'> | undefined,
): AgentReportSourceContext | undefined {
  if (!snapshot?.codebaseSnapshot?.length) return undefined;
  const selected = snapshot.codebaseSnapshot
    .map(item => {
      const codebaseId = safeReportSourceId(item.codebaseId);
      if (!codebaseId) return undefined;
      const displayName = safeReportSourceDisplayName(item.displayName);
      const kind = isCodebaseKind(item.kind) ? item.kind : undefined;
      return {
        codebaseId,
        ...(displayName ? {displayName} : {}),
        ...(kind ? {kind} : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (selected.length === 0) return undefined;
  const selectedIds = new Set(selected.map(item => item.codebaseId));
  const lookupCount = Math.max(
    0,
    Math.min(1_000_000, Math.floor(snapshot.codeLookupSummary?.lookupCount || 0)),
  );
  const queriedCodebaseIds = (snapshot.codeLookupSummary?.referencedCodebaseIds ?? [])
    .map(safeReportSourceId)
    .filter((id): id is string => typeof id === 'string' && selectedIds.has(id))
    .sort();
  const usedCodebaseIds = (snapshot.codeLookupSummary?.usedCodebaseIds ?? [])
    .map(safeReportSourceId)
    .filter((id): id is string => typeof id === 'string' && selectedIds.has(id))
    .sort();
  return {
    selected,
    lookupCount,
    queriedCodebaseIds,
    usedCodebaseIds,
  };
}

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
  claimSupport?: AgentDrivenReportData['result']['claimSupport'];
  claimVerificationResult?: AgentDrivenReportData['result']['claimVerificationResult'];
  identityResolutions?: AgentDrivenReportData['result']['identityResolutions'];
  confidence: number;
  rounds: number;
  totalDurationMs: number;
  partial?: boolean;
  terminationReason?: string;
  terminationMessage?: string;
  analysisReceipt?: AgentDrivenReportData['result']['analysisReceipt'];
  uiActionProposals?: AgentDrivenReportData['result']['uiActionProposals'];
}

export interface BuildAgentReportDataInput {
  session: AnalyzeManagedSession;
  result: ReportResultLike;
}

export function buildAgentDrivenReportData(
  input: BuildAgentReportDataInput,
): AgentDrivenReportData {
  const { session, result } = input;
  const privateKnowledge = sessionUsesPrivateKnowledge(session);
  const outputLanguage = session.outputLanguage
    ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);

  // Cumulative findings: dedup across all persisted turns. `session.result`
  // only carries the current turn's findings, but multi-turn reports need
  // the full picture to stay consistent with the timeline section.
  let cumulativeResult: ReportResultLike = privateKnowledge
    ? projectPrivateAnalysisResult(
        session.sessionId,
        result as import('../agent/core/orchestratorTypes').AnalysisResult,
        outputLanguage,
      )
    : result;
  try {
    const ctx = sessionContextManager.get(session.sessionId, session.traceId);
    if (ctx && !privateKnowledge) {
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
  if (!privateKnowledge && (!cumulativeResult.conclusion || !cumulativeResult.conclusion.trim())) {
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
    comparisonReportSection?: AgentDrivenReportData['comparisonReportSection'];
    backgroundKnowledgeReferences?: AgentDrivenReportData['backgroundKnowledgeReferences'];
    codebaseSnapshot?: SessionStateSnapshot['codebaseSnapshot'];
    codeLookupSummary?: SessionStateSnapshot['codeLookupSummary'];
  } })._lastSnapshot;
  const hypotheses = privateKnowledge
    ? projectPrivateHypotheses(session.sessionId, session.hypotheses as any[])
    : session.hypotheses;

  return {
    traceId: session.traceId,
    query: privateKnowledge ? privateAnalysisQueryMessage(outputLanguage) : session.query,
    outputLanguage,
    traceStartNs:
      traceStartNs !== undefined && traceStartNs !== null ? String(traceStartNs) : undefined,
    result: cumulativeResult as AgentDrivenReportData['result'],
    hypotheses: hypotheses as AgentDrivenReportData['hypotheses'],
    dialogue: privateKnowledge ? [] : session.agentDialogue as AgentDrivenReportData['dialogue'],
    conversationTimeline: privateKnowledge
      ? []
      : session.conversationSteps as AgentDrivenReportData['conversationTimeline'],
    dataEnvelopes: (privateKnowledge
      ? projectPrivateDataEnvelopes(session.sessionId, session.dataEnvelopes as any[])
      : session.dataEnvelopes) as AgentDrivenReportData['dataEnvelopes'],
    agentResponses: privateKnowledge ? [] : session.agentResponses as AgentDrivenReportData['agentResponses'],
    timestamp: Date.now(),
    conversationTurns: session.runSequence || 1,
    queryHistory: privateKnowledge ? [] : session.queryHistory || [],
    conclusionHistory: privateKnowledge ? [] : session.conclusionHistory || [],
    // Snapshot-first — the HTTP route's persistence step stashes `_lastSnapshot`
    // on the session, the CLI's `persistTurnToBackend` does the same. Callers
    // that skip the snapshot step (tests, partial builds) fall through to
    // the orchestrator getters.
    analysisNotes: privateKnowledge ? [] : (snapshot?.analysisNotes as AgentDrivenReportData['analysisNotes'])
      ?? (typeof session.orchestrator.getSessionNotes === 'function'
        ? session.orchestrator.getSessionNotes(session.sessionId) : []),
    analysisPlan: privateKnowledge ? null : (snapshot?.analysisPlan as AgentDrivenReportData['analysisPlan'])
      ?? (typeof session.orchestrator.getSessionPlan === 'function'
        ? session.orchestrator.getSessionPlan(session.sessionId) : null),
    uncertaintyFlags: privateKnowledge ? [] : (snapshot?.uncertaintyFlags as AgentDrivenReportData['uncertaintyFlags'])
      ?? (typeof session.orchestrator.getSessionUncertaintyFlags === 'function'
        ? session.orchestrator.getSessionUncertaintyFlags(session.sessionId) : []),
    comparisonReportSection: privateKnowledge
      ? projectPrivateStructuredValue(
          session.sessionId,
          snapshot?.comparisonReportSection ?? session.comparisonReportSection,
        )
      : snapshot?.comparisonReportSection ?? session.comparisonReportSection,
    backgroundKnowledgeReferences: snapshot?.backgroundKnowledgeReferences,
    sourceContext: safeSourceContext(snapshot),
  };
}
