// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared persistence block used after each agent turn.
 *
 * Two call sites produce this pattern with identical semantics:
 *   - `routes/agentRoutes.ts:runAgentDrivenAnalysis` (HTTP path)
 *   - `cli-user/services/cliAnalyzeService.ts:persistTurnToBackend` (CLI path)
 *
 * Each one:
 *   1. Takes a unified snapshot from the orchestrator and
 *      stashes it on the session as `_lastSnapshot` so the report builder
 *      can read analysisNotes / analysisPlan / uncertaintyFlags.
 *   2. Writes the snapshot atomically via `saveSessionStateSnapshot`, or
 *      falls back to individual-field persistence if the
 *      orchestrator doesn't expose `takeSnapshot`.
 *   3. Appends the turn's user+assistant messages to the messages table
 *      so the web UI's history view renders them.
 *
 * Centralizing here closes the drift risk: any future schema change only
 * needs one update, and both call sites stay in sync automatically.
 */

import type { AnalyzeManagedSession } from '../assistant/application/agentAnalyzeSessionService';
import { SessionPersistenceService } from './sessionPersistenceService';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import { getDefaultCodebaseRegistry } from './codebase/defaultCodebaseServices';
import {activeCodebaseGeneration, isCodebaseKind} from './codebase/codebaseRegistry';
import { CodeLookupLedger } from './codebase/codeLookupLedger';
import type { DataEnvelope } from '../types/dataContract';
import type { SqlResultMessageBundle, SqlResultMessageEntry } from '../models/sessionSchema';
import type {KnowledgeScope} from './scopedKnowledgeStore';
import {getDefaultExternalKnowledgeSourceRegistry} from './externalKnowledgeSourceRegistry';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import {
  projectPrivateConclusion,
  projectPrivateDataEnvelopes,
  privateAnalysisQueryMessage,
  projectPrivateSessionStateSnapshot,
  projectPrivateTerminationMessage,
  sessionUsesPrivateKnowledge,
} from './security/privateAnalysisProjection';
import {
  getSessionBackgroundKnowledgeReferences,
} from './androidInternalsPack/sessionBackgroundKnowledgeRegistry';
import {sanitizeStoredTraceSummaryAttribution} from './traceSummaryAttribution';

const MAX_SQL_RESULTS_PER_MESSAGE = 5;
const MAX_SQL_RESULT_ENTRY_BYTES = 100 * 1024;
const MAX_TRUNCATED_CELL_CHARS = 2048;
const MAX_TRUNCATED_SQL_CHARS = 4096;
const MAX_SAFE_CODEBASE_DISPLAY_NAME = 120;

function safeCodebaseDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('://')) {
    return undefined;
  }
  return trimmed.slice(0, MAX_SAFE_CODEBASE_DISPLAY_NAME);
}

type PersistableSqlEnvelope = DataEnvelope & {
  sql?: string;
  traceId?: string;
  traceSide?: string;
  paneSide?: string;
  stdlibInjectedModules?: string[];
};

function buildCodebaseSnapshot(
  codebaseIds: string[] | undefined,
  scope?: KnowledgeScope,
) {
  if (!codebaseIds || codebaseIds.length === 0) return undefined;
  const registry = getDefaultCodebaseRegistry();
  return codebaseIds
    .map(id => registry.get(id, scope))
    .filter(Boolean)
    .map(ref => ({
      codebaseId: ref!.codebaseId,
      ...(safeCodebaseDisplayName(ref!.displayName)
        ? {displayName: safeCodebaseDisplayName(ref!.displayName)}
        : {}),
      ...(isCodebaseKind(ref!.kind) ? {kind: ref!.kind} : {}),
      indexGeneration: ref!.indexGeneration,
      activeGeneration: activeCodebaseGeneration(ref!),
      contentFingerprint: ref!.contentFingerprint,
      indexedRevision: ref!.indexedRevision,
      indexedDirty: ref!.indexedDirty,
      commitProvenance: ref!.commitProvenance,
      consentHash: ref!.consent.consentHash,
    }));
}

function buildKnowledgeSourceSnapshot(
  sourceIds: string[] | undefined,
  scope?: KnowledgeScope,
) {
  if (!sourceIds || sourceIds.length === 0) return undefined;
  const registry = getDefaultExternalKnowledgeSourceRegistry();
  return sourceIds
    .map(sourceId => registry.get(sourceId, scope ?? {}))
    .filter(Boolean)
    .map(source => ({
      sourceId: source!.sourceId,
      indexGeneration: source!.indexGeneration,
      activeGeneration: source!.activeGeneration,
      contentFingerprint: source!.contentFingerprint,
      revision: source!.revision,
    }));
}

export interface PersistAgentTurnInput {
  session: AnalyzeManagedSession;
  sessionId: string;
  traceId: string;
  query: string;
  result: {
    conclusion: string;
    totalDurationMs: number;
    partial?: boolean;
    terminationMessage?: string;
    analysisReceipt?: import('../types/dataContract').AnalysisReceipt;
  };
  /** Optional structured logger (HTTP route provides SessionLogger; CLI
   *  currently doesn't wire one through — `console` fallback is fine). */
  logger?: {
    info: (component: string, message: string, data?: unknown) => void;
    warn: (component: string, message: string, data?: unknown) => void;
  };
  /** Log component name. HTTP route passes 'AgentDrivenAnalysis' to preserve
   *  existing log-based alerts keyed on that component; CLI defaults to
   *  logComponent so CLI-only log stream is self-identifying. */
  logComponent?: string;
}

function buildPersistedAssistantMessage(result: PersistAgentTurnInput['result']): string {
  const conclusion = result.conclusion || '';
  if (result.partial !== true) return conclusion.substring(0, 10000);
  const warning = [
    '> **结果完整性提示**',
    `> ${result.terminationMessage || '本次分析结果已标记为 partial，结论可能不完整。'}`,
    '',
  ].join('\n');
  return `${warning}${conclusion}`.substring(0, 10000);
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function compactValueForSqlPreview(value: unknown): unknown {
  if (typeof value === 'string') return truncateString(value, MAX_TRUNCATED_CELL_CHARS);
  if (Array.isArray(value)) return value.map(compactValueForSqlPreview);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, compactValueForSqlPreview(nested)]),
    );
  }
  return value;
}

function compactSqlDataForPreview(data: unknown): unknown {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const candidate = data as {columns?: unknown; rows?: unknown};
    if (Array.isArray(candidate.rows)) {
      return {
        columns: Array.isArray(candidate.columns) ? candidate.columns : undefined,
        rowCount: candidate.rows.length,
        rowsPreview: candidate.rows.slice(0, 3).map(compactValueForSqlPreview),
      };
    }
  }
  return {preview: truncateString(JSON.stringify(data), MAX_TRUNCATED_CELL_CHARS)};
}

function hasSqlTablePayload(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const candidate = data as {columns?: unknown; rows?: unknown};
  return Array.isArray(candidate.columns) && Array.isArray(candidate.rows);
}

function isSqlResultEnvelope(value: unknown): value is PersistableSqlEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as {meta?: {type?: unknown}; data?: unknown};
  if (envelope.meta?.type === 'sql_result') return true;
  return envelope.meta?.type === 'skill_result' && hasSqlTablePayload(envelope.data);
}

function buildSqlResultEntry(envelope: PersistableSqlEnvelope): SqlResultMessageEntry {
  const entry: SqlResultMessageEntry = {
    title: envelope.display?.title ?? envelope.meta?.source,
    evidenceRefId: envelope.meta?.evidenceRefId,
    sourceToolCallId: envelope.meta?.sourceToolCallId,
    queryHash: envelope.meta?.queryHash,
    traceId: envelope.meta?.traceId ?? envelope.traceId,
    traceSide: envelope.meta?.traceSide ?? envelope.traceSide,
    paneSide: envelope.meta?.paneSide ?? envelope.paneSide,
    sql: typeof envelope.sql === 'string'
      ? truncateString(envelope.sql, MAX_TRUNCATED_SQL_CHARS)
      : undefined,
    data: envelope.data,
    display: envelope.display,
  };

  const originalBytes = utf8Bytes(entry);
  if (originalBytes <= MAX_SQL_RESULT_ENTRY_BYTES) return entry;

  return {
    title: entry.title,
    evidenceRefId: entry.evidenceRefId,
    sourceToolCallId: entry.sourceToolCallId,
    queryHash: entry.queryHash,
    traceId: entry.traceId,
    traceSide: entry.traceSide,
    paneSide: entry.paneSide,
    sql: entry.sql,
    data: compactSqlDataForPreview(envelope.data),
    display: entry.display,
    truncated: true,
    originalBytes,
    maxBytes: MAX_SQL_RESULT_ENTRY_BYTES,
  };
}

function buildAssistantSqlResult(envelopes: unknown): SqlResultMessageBundle | undefined {
  if (!Array.isArray(envelopes)) return undefined;
  const results = envelopes
    .filter(isSqlResultEnvelope)
    .slice(-MAX_SQL_RESULTS_PER_MESSAGE)
    .map(buildSqlResultEntry);
  if (results.length === 0) return undefined;
  return {
    schemaVersion: 'sql_result_message_v1',
    resultCount: results.length,
    results,
  };
}

function persistAgentState(input: PersistAgentTurnInput, appendTurnMessages: boolean): void {
  const { session, sessionId, traceId, query, result, logger } = input;
  const privateKnowledge = sessionUsesPrivateKnowledge(session);
  const outputLanguage = session.outputLanguage
    ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const logComponent = input.logComponent ?? 'AgentPersistence';
  const persistenceService = SessionPersistenceService.getInstance();
  const durableDataEnvelopes = privateKnowledge
    ? projectPrivateDataEnvelopes(sessionId, (session.dataEnvelopes || []) as DataEnvelope[])
    : (session.dataEnvelopes || []) as DataEnvelope[];
  const traceSummary = sanitizeStoredTraceSummaryAttribution(session.traceSummary);

  try {
    const sessionContext = sessionContextManager.get(sessionId, traceId);

      const rawSnapshot = typeof session.orchestrator.takeSnapshot === 'function'
        ? session.orchestrator.takeSnapshot(sessionId, traceId, {
          outputLanguage,
          referenceTraceId: session.referenceTraceId,
          comparisonSource: session.comparisonSource,
          comparisonReportSection: session.comparisonReportSection,
          ...(session.result?.analysisReceipt
            ? {analysisReceipt: session.result.analysisReceipt}
            : {}),
          ...(traceSummary ? {traceSummary} : {}),
          conversationSteps: session.conversationSteps || [],
          queryHistory: session.queryHistory || [],
          conclusionHistory: session.conclusionHistory || [],
          agentDialogue: session.agentDialogue || [],
          agentResponses: session.agentResponses || [],
          dataEnvelopes: durableDataEnvelopes,
          claimSupport: session.result?.claimSupport || (session as any).claimSupport,
          claimVerificationResult: session.result?.claimVerificationResult || (session as any).claimVerificationResult,
          identityResolutions: session.result?.identityResolutions || (session as any).identityResolutions,
          hypotheses: session.hypotheses || [],
            agentRuntimeProviderId: session.providerId,
            agentRuntimeProviderSnapshotHash: session.providerSnapshotHash,
            continuityBreaks: session.continuityBreaks,
            analysisContextFingerprint: session.analysisContextFingerprint,
            androidInternalsPackPin: (session as {
              androidInternalsPackPin?: import('./androidInternalsPack/types').AndroidInternalsPackIdentity;
            }).androidInternalsPackPin,
            backgroundKnowledgeReferences:
              getSessionBackgroundKnowledgeReferences(sessionId),
            lineage: session.lineage,
            codeAwareMode: (session as {codeAwareMode?: unknown}).codeAwareMode as any,
            codebaseIds: (session as {codebaseIds?: string[]}).codebaseIds,
            codebaseSnapshot: buildCodebaseSnapshot(
              (session as {codebaseIds?: string[]}).codebaseIds,
              {
                tenantId: session.tenantId,
                workspaceId: session.workspaceId,
                userId: session.userId,
              },
            ),
            knowledgeSourceIds: session.knowledgeSourceIds,
            knowledgeSourceSnapshot: buildKnowledgeSourceSnapshot(
              session.knowledgeSourceIds,
              {
                tenantId: session.tenantId,
                workspaceId: session.workspaceId,
                userId: session.userId,
              },
            ),
            codeLookupSummary: CodeLookupLedger.restore(
              sessionId,
              12_000,
              2,
              undefined,
              session.analysisContextFingerprint,
            ).toSnapshotSummary(),
            runSequence: session.runSequence || 0,
          activeRun: session.activeRun,
          lastRun: session.lastRun,
          conversationOrdinal: session.conversationOrdinal || 0,
        })
      : null;
    const snapshot = rawSnapshot && privateKnowledge
      ? projectPrivateSessionStateSnapshot(rawSnapshot)
      : rawSnapshot;

    // Stash snapshot EARLY — report builder reads `_lastSnapshot` for
    // analysisNotes / analysisPlan / uncertaintyFlags. Must happen before
    // any persistence I/O that could throw.
    if (snapshot) {
      (session as unknown as { _lastSnapshot: unknown })._lastSnapshot = snapshot;
    }

    if (snapshot) {
      const focusStoreSnapshot = !privateKnowledge && typeof session.orchestrator.getFocusStore === 'function'
        ? session.orchestrator.getFocusStore().serialize()
        : undefined;
      const traceAgentState = !privateKnowledge
        ? sessionContext?.getTraceAgentState() || undefined
        : undefined;

      const saved = persistenceService.saveSessionStateSnapshot(
        sessionId,
        snapshot,
        {
          ...(!privateKnowledge && sessionContext ? {sessionContext} : {}),
          focusStoreSnapshot,
          traceAgentState,
          clearPrivateContext: privateKnowledge,
          owner: {
            tenantId: session.tenantId,
            workspaceId: session.workspaceId,
            userId: session.userId,
          },
        },
      );
      if (saved && logger) {
        logger.info(logComponent, 'Session state snapshot persisted atomically', {
          sessionId,
          steps: snapshot.conversationSteps.length,
          envelopes: snapshot.dataEnvelopes.length,
          notes: snapshot.analysisNotes.length,
          ...(!privateKnowledge && sessionContext
            ? {entityStoreStats: sessionContext.getEntityStore().getStats()}
            : {}),
        });
      }
    } else if (sessionContext) {
      // Individual-field fallback for runtimes or older sessions that do not
      // expose a unified snapshot. Current SDK runtimes should normally take
      // the atomic snapshot path above.
      if (!persistenceService.getSession(sessionId)) {
        persistenceService.saveSession({
          id: sessionId,
          traceId,
          traceName: traceId,
          messages: [],
          createdAt: session.createdAt,
          updatedAt: Date.now(),
          metadata: {
            tenantId: session.tenantId,
            workspaceId: session.workspaceId,
            userId: session.userId,
            referenceTraceId: session.referenceTraceId,
            comparisonSource: session.comparisonSource,
          },
          question: privateKnowledge
            ? privateAnalysisQueryMessage(outputLanguage)
            : query,
        });
      }
      if (privateKnowledge) {
        persistenceService.clearPrivateSessionContextSnapshots(sessionId);
      } else {
        persistenceService.saveSessionContext(sessionId, sessionContext);
      }
      if (!privateKnowledge && typeof session.orchestrator.getCachedArchitecture === 'function') {
        const cachedArch = session.orchestrator.getCachedArchitecture(traceId);
        if (cachedArch) persistenceService.saveArchitectureSnapshot(sessionId, cachedArch);
      }
      if (!privateKnowledge && typeof session.orchestrator.getFocusStore === 'function') {
        persistenceService.saveFocusStore(sessionId, session.orchestrator.getFocusStore());
      }
      if (!privateKnowledge) {
        const traceAgentState = sessionContext.getTraceAgentState();
        if (traceAgentState) persistenceService.saveTraceAgentState(sessionId, traceAgentState);
      }
      persistenceService.saveRuntimeArrays(sessionId, {
        conversationSteps: privateKnowledge ? [] : session.conversationSteps || [],
        dataEnvelopes: durableDataEnvelopes,
        hypotheses: privateKnowledge ? [] : session.hypotheses || [],
        queryHistory: privateKnowledge ? [] : session.queryHistory || [],
        conclusionHistory: privateKnowledge ? [] : session.conclusionHistory || [],
      });
    }

    // Messages table is a separate SQLite table, always needed for the
    // web UI's history view — persist regardless of which branch above ran.
    if (appendTurnMessages && sessionContext) {
      try {
        const turnIndex = session.runSequence || 1;
        const sessionEnvelopes = durableDataEnvelopes;
        const snapshotEnvelopes = Array.isArray((snapshot as {dataEnvelopes?: unknown[]} | null)?.dataEnvelopes)
          ? (snapshot as {dataEnvelopes: unknown[]}).dataEnvelopes
          : [];
        const assistantSqlResult = buildAssistantSqlResult(
          sessionEnvelopes.some(isSqlResultEnvelope) ? sessionEnvelopes : snapshotEnvelopes,
        );
        const now = Date.now();
        const messages = [
          {
            id: `msg-${sessionId}-turn${turnIndex}-user`,
            role: 'user',
            content: privateKnowledge
              ? privateAnalysisQueryMessage(outputLanguage)
              : query,
            timestamp: now - (result.totalDurationMs || 0),
          },
          {
            id: `msg-${sessionId}-turn${turnIndex}-assistant`,
            role: 'assistant',
            content: privateKnowledge
              ? buildPersistedAssistantMessage({
                  ...result,
                  conclusion: projectPrivateConclusion({
                    sessionId,
                    conclusion: result.conclusion,
                    success: session.result?.success !== false,
                    language: outputLanguage,
                  }),
                  terminationMessage: projectPrivateTerminationMessage(
                    result.terminationMessage,
                    outputLanguage,
                  ),
                })
              : buildPersistedAssistantMessage(result),
            timestamp: now,
            sqlResult: assistantSqlResult,
          },
        ];
        persistenceService.appendMessages(sessionId, messages);
        if (assistantSqlResult) {
          sessionContext.hydrateRecentSqlResultsFromMessages([messages[1]]);
        }
      } catch (msgErr) {
        logger?.warn(logComponent, 'Failed to persist turn messages', {
          error: (msgErr as Error).message,
        });
      }
    }
  } catch (err) {
    // Don't fail the analysis if persistence fails — just log. Preserving
    // the snapshot on the session (done above the try boundary) is more
    // important than the SQLite write succeeding.
    const message = (err as Error).message;
    if (logger) {
      logger.warn(logComponent, 'Failed to persist session state', { error: message });
    } else {
      console.warn(`[AgentPersistence] Failed to persist session ${sessionId} to SQLite: ${message}`);
    }
  }
}

export function persistAgentTurn(input: PersistAgentTurnInput): void {
  persistAgentState(input, true);
}

export function refreshPersistedAgentSnapshot(input: PersistAgentTurnInput): void {
  persistAgentState(input, false);
}
