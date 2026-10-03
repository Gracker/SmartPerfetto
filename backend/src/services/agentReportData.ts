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

import {projectSceneTimelineForClient} from '../agent/scene/sceneTimelineProjection';
import type { Finding } from '../agent/types';
import type {AnalysisResult, IOrchestrator} from '../agent/core/orchestratorTypes';
import type { AgentDrivenReportData } from './htmlReportGenerator';
import type { AnalyzeManagedSession } from '../assistant/application/agentAnalyzeSessionService';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import { getTraceProcessorService } from './traceProcessorService';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import {
  projectOwnerAnalysisResult,
  projectOwnerDataEnvelopes,
  projectOwnerHypotheses,
  projectOwnerStructuredValue,
  projectOwnerQuestion,
} from './security/privateAnalysisProjection';
import type {SessionStateSnapshot} from '../agentv3/sessionStateSnapshot';
import {isCodebaseKind} from './codebase/codebaseRegistry';
import {
  projectSafeSourceProvenance,
  type SafeSourceProvenanceProjection,
} from './codebase/sourceClaimVerifier';
import type {SourceUseDecisionV1} from './codebase/sourceUseDecision';
import {safeCodebaseDisplayName} from './codebase/selectedCodebaseCapabilities';
import {
  privateContextRestrictsAudience,
  type AnalysisPrivateContextMarker,
} from './security/analysisPrivateContext';

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

function safeSourceContext(
  snapshot: Pick<SessionStateSnapshot, 'codebaseSnapshot' | 'codeLookupSummary'> | undefined,
  provenance?: SafeSourceProvenanceProjection,
): AgentReportSourceContext | undefined {
  const descriptors = (snapshot?.codebaseSnapshot ?? [])
    .map(item => {
      const codebaseId = safeReportSourceId(item.codebaseId);
      if (!codebaseId) return undefined;
      const displayName = safeCodebaseDisplayName(item.displayName, MAX_REPORT_SOURCE_DISPLAY_NAME);
      const kind = isCodebaseKind(item.kind) ? item.kind : undefined;
      return {
        codebaseId,
        ...(displayName ? {displayName} : {}),
        ...(kind ? {kind} : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const descriptorById = new Map(descriptors.map(item => [item.codebaseId, item]));
  const selected = provenance
    ? provenance.sourceUseDecision.selectedCodebaseIds.map(
        codebaseId => descriptorById.get(codebaseId) ?? {codebaseId},
      )
    : descriptors;
  if (selected.length === 0) return undefined;
  const selectedIds = new Set(selected.map(item => item.codebaseId));
  const lookupCount = Math.max(
    0,
    Math.min(1_000_000, Math.floor(snapshot?.codeLookupSummary?.lookupCount || 0)),
  );
  const queriedCodebaseIds = (provenance?.sourceUseDecision.queriedCodebaseIds ??
    snapshot?.codeLookupSummary?.referencedCodebaseIds ?? [])
    .map(safeReportSourceId)
    .filter((id): id is string => typeof id === 'string' && selectedIds.has(id))
    .sort();
  const usedCodebaseIds = (provenance?.sourceUseDecision.usedCodebaseIds ??
    snapshot?.codeLookupSummary?.usedCodebaseIds ?? [])
    .map(safeReportSourceId)
    .filter((id): id is string => typeof id === 'string' && selectedIds.has(id))
    .sort();
  return {
    selected,
    lookupCount,
    queriedCodebaseIds,
    usedCodebaseIds,
    ...(provenance ?? {}),
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
  sceneTimeline?: AnalysisResult['sceneTimeline'];
  sceneReport?: AnalysisResult['sceneReport'];
  turnIntent?: AgentDrivenReportData['result']['turnIntent'];
  completion?: AgentDrivenReportData['result']['completion'];
  outputOrigin?: AgentDrivenReportData['result']['outputOrigin'];
  runtimeAppendix?: AgentDrivenReportData['result']['runtimeAppendix'];
  reportAssessment?: AgentDrivenReportData['result']['reportAssessment'];
  investigationAssessment?: AgentDrivenReportData['result']['investigationAssessment'];
  deliveryAssurance?: AgentDrivenReportData['result']['deliveryAssurance'];
  conclusionContract?: unknown;
  sourceUseDecision?: SourceUseDecisionV1;
  sourceClaimVerificationResult?: AgentDrivenReportData['result']['sourceClaimVerificationResult'];
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
  /** Optional server origin for downloaded HTML's authenticated detail links. */
  backendBaseUrl?: string;
  /** The reported run's own marker, fixed at admission. */
  privateContext: AnalysisPrivateContextMarker;
}

type ReportSessionState = Required<Pick<AgentDrivenReportData, 'queryHistory' | 'conclusionHistory' |
  'conversationTimeline' | 'dialogue' | 'analysisNotes' | 'analysisPlan' | 'uncertaintyFlags'>>;
type ReportSnapshotState = Partial<Pick<SessionStateSnapshot, 'analysisNotes' | 'analysisPlan' | 'uncertaintyFlags'>>;

/**
 * The session state a report shows, shared by the HTML builder and the report
 * route: questions, conclusions, timeline, plan, notes and uncertainty flags.
 * A public run reads its snapshot first. A private run's snapshot has none of
 * the runtime state, since every runtime drops it before the product persists
 * the snapshot, so its creator's report reads the live runtime state; all of
 * it passes the owner projection.
 */
export function projectReportSessionState(input: {
  session: {
    sessionId: string;
    queryHistory?: ReportSessionState['queryHistory'];
    conclusionHistory?: ReportSessionState['conclusionHistory'];
    conversationSteps?: ReportSessionState['conversationTimeline'];
    agentDialogue?: ReportSessionState['dialogue'];
    orchestrator?: Pick<IOrchestrator, 'getSessionNotes' | 'getSessionPlan' | 'getSessionUncertaintyFlags'>;
  };
  privateKnowledge: boolean;
  loadSnapshot?: () => ReportSnapshotState | null | undefined;
}): ReportSessionState {
  const {session: {sessionId, orchestrator, ...session}, privateKnowledge} = input;
  const snapshot = privateKnowledge ? undefined : input.loadSnapshot?.();
  const state: ReportSessionState = {
    queryHistory: session.queryHistory ?? [],
    conclusionHistory: session.conclusionHistory ?? [],
    conversationTimeline: Array.isArray(session.conversationSteps) ? session.conversationSteps : [],
    dialogue: session.agentDialogue ?? [],
    analysisNotes: snapshot?.analysisNotes ?? orchestrator?.getSessionNotes?.(sessionId) ?? [],
    analysisPlan: snapshot?.analysisPlan ?? orchestrator?.getSessionPlan?.(sessionId) ?? null,
    uncertaintyFlags: snapshot?.uncertaintyFlags ?? orchestrator?.getSessionUncertaintyFlags?.(sessionId) ?? [],
  };
  return privateKnowledge ? projectOwnerStructuredValue(sessionId, state) : state;
}

export function buildAgentDrivenReportData(
  input: BuildAgentReportDataInput,
): AgentDrivenReportData {
  const { session, result } = input;
  const hasActualSourceUseDecision = Object.prototype.hasOwnProperty.call(
    result,
    'sourceUseDecision',
  );
  const privateKnowledge = privateContextRestrictsAudience(input.privateContext);
  const outputLanguage = session.outputLanguage
    ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);

  // Cumulative findings: dedup across all persisted turns. `session.result`
  // only carries the current turn's findings, but multi-turn reports need
  // the full picture to stay consistent with the timeline section.
  let cumulativeResult: ReportResultLike = result;
  try {
    const allTurns = sessionContextManager.get(session.sessionId, session.traceId)?.getAllTurns() ?? [];
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
  } catch {
    // Fallback to current turn only — non-fatal.
  }
  if (privateKnowledge) {
    cumulativeResult = projectOwnerAnalysisResult(
      session.sessionId,
      cumulativeResult as AnalysisResult,
      outputLanguage,
    );
  }

  const traceInfo = getTraceProcessorService().getTrace(session.traceId);
  const traceStartNs = traceInfo?.metadata?.startTime;
  // persistAgentTurn (HTTP and CLI) stashes the run's snapshot on the session.
  const snapshot = (session as {_lastSnapshot?: Partial<Pick<SessionStateSnapshot, 'analysisNotes' | 'analysisPlan' |
    'uncertaintyFlags' | 'comparisonReportSection' | 'backgroundKnowledgeReferences' | 'codebaseSnapshot' |
    'codeLookupSummary'>>})._lastSnapshot;
  const hypotheses = privateKnowledge
    ? projectOwnerHypotheses(session.sessionId, session.hypotheses as any[])
    : session.hypotheses;
  const sourceProvenance = projectSafeSourceProvenance({
    conclusionContract: cumulativeResult.conclusionContract,
    sourceClaimVerificationResult: cumulativeResult.sourceClaimVerificationResult,
    ...(hasActualSourceUseDecision
      ? {actualSourceUseDecision: result.sourceUseDecision}
      : {}),
  });

  return {
    traceId: session.traceId,
    query: projectOwnerQuestion(privateKnowledge, session.sessionId, session.query),
    outputLanguage,
    traceStartNs:
      traceStartNs !== undefined && traceStartNs !== null ? String(traceStartNs) : undefined,
    result: {...cumulativeResult,
      ...(cumulativeResult.sceneTimeline
        ? {sceneTimeline: projectSceneTimelineForClient(cumulativeResult.sceneTimeline)} : {}),
    } as AgentDrivenReportData['result'],
    ...(input.backendBaseUrl ? {backendBaseUrl: input.backendBaseUrl} : {}),
    hypotheses: hypotheses as AgentDrivenReportData['hypotheses'],
    ...projectReportSessionState({session, privateKnowledge, loadSnapshot: () => snapshot}),
    dataEnvelopes: (privateKnowledge
      ? projectOwnerDataEnvelopes(session.sessionId, session.dataEnvelopes as any[])
      : session.dataEnvelopes) as AgentDrivenReportData['dataEnvelopes'],
    timestamp: Date.now(),
    conversationTurns: session.runSequence || 1,
    ...(privateKnowledge ? {privateContext: true} : {}),
    comparisonReportSection: privateKnowledge
      ? projectOwnerStructuredValue(
          session.sessionId,
          snapshot?.comparisonReportSection ?? session.comparisonReportSection,
        )
      : snapshot?.comparisonReportSection ?? session.comparisonReportSection,
    backgroundKnowledgeReferences: snapshot?.backgroundKnowledgeReferences,
    sourceContext: safeSourceContext(snapshot, sourceProvenance),
  };
}
