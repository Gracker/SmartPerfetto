// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {snapshotSceneCoverageRegistry} from '../../../agent/scene/sceneCoveragePlan';
import { EventEmitter } from 'events';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {createAnalysisTurnIntentResolver, type AnalysisTurnIntent} from '../../analysisTurnIntent';
import {resolveRuntimeTurnPolicy, usesLightweightToolCatalog, type RuntimeTurnPolicy} from '../../runtimeTurnPolicy';
import {createRuntimeTurnCloseoutTape, resolveRuntimeTurnBudget} from '../../runtimeTurnCloseout';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  nativeDeclarationBodyCanFitOutput,
  requestNativeDeclarationCompletion,
  INVALID_NATIVE_DECLARATION,
} from '../../runtimeConclusionProtocol';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext} from '../../analysisHistory';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import type {RuntimeToolObserver} from '../../runtimeToolObserver';
import {runClaudeIntentTransport} from './claudeIntentTransport';
import {reportReviewUsesRemainingBudget, attachFinalizationContext, type RuntimeFinalizationContextInput} from '../../analysisFinalizationContext';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity, type AnalysisCompletion, type AnalysisOutputOrigin, type AnalysisDeliveryContext} from '../../../types/analysisDelivery';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import * as fs from 'fs';
import * as path from 'path';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import {
  commitEvaluationExposureSince,
  currentEvaluationInjectionContract,
} from '../../../services/selfEvolution/evaluationInjectionContext';
import {
  recordEvaluationTokenDeltaIfPresent,
} from '../../../services/selfEvolution/evaluationRuntimeHooks';
import type { TraceProcessorService } from '../../../services/traceProcessorService';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
import {resolveEffectiveSkillRegistryForRuntime} from '../../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import { getSkillAnalysisAdapter } from '../../../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import { sessionContextManager } from '../../../agent/context/enhancedSessionContext';
import type { StreamingUpdate, Finding } from '../../../agent/types';
import type { Hypothesis as ProtocolHypothesis } from '../../../agent/types/agentProtocol';
import type { AnalysisResult, AnalysisOptions, IOrchestrator } from '../../../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../../../agent/detectors/types';

import { createClaudeMcpServer, loadLearnedSqlFixPairs, MCP_NAME_PREFIX } from '../../../agentv3/claudeMcpServer';
import {
  buildSystemPromptParts,
} from '../../../agentv3/claudeSystemPrompt';
import {
  createSseBridge,
  extractSdkToolResultBlocks,
  isSdkToolResultFailure,
  stringifySdkToolResult,
} from './claudeSseBridge';
import {
  buildMaxTurnsTerminationMessage,
  capPartialConfidence,
  isSdkMaxTurnsSubtype,
  MAX_TURNS_TERMINATION_REASON,
  estimateAnalysisConfidence,
} from '../../../agentv3/analysisTermination';
import { extractFindingsFromText, extractFindingsFromSkillResult, mergeFindings } from '../../../agentv3/claudeFindingExtractor';
import {
  createQuickConfig,
  createSdkEnv,
  explainClaudeRuntimeError,
  getCredentialSourceHint,
  getSdkBinaryOption,
  hasConfiguredClaudeEffortOverride,
  isClaudeQuotaError,
  loadClaudeConfig,
  resolveClaudeSdkPermissionOptions,
  resolveEffort,
  resolveRuntimeConfig,
  type ClaudeAgentConfig,
} from './claudeConfig';
import type { FocusAppDetectionResult } from '../../../agentv3/focusAppDetector';
import { formatFocusAppTargetProgress, resolveFocusAppTarget } from '../../focusAppTarget';
import type {SceneType} from '../../../agentv3/sceneClassifier';
import { buildComplexityClassifierInput } from '../../../agentv3/queryComplexityContext';
import { buildAgentDefinitions } from './claudeAgentDefinitions';
import { getExtendedKnowledgeBase } from '../../../services/sqlKnowledgeBase';
import {
  analysisContextMemoryPartitionKey,
  analysisContextUsesPrivateKnowledge,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../../../services/resolvedAnalysisContext';
import type { AnalysisNote, AnalysisPlanV3, ClaudeAnalysisContext, FailedApproach, Hypothesis, UncertaintyFlag } from '../../../agentv3/types';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {resolveRuntimeEvidenceStore} from '../../runtimeEvidenceContext';
import {activateSceneRuntime, resolveSceneProductScope} from '../../../agent/scene/sceneRuntimeBinding';
import type {ScenePacingInputs} from '../../../agent/scene/sceneProposalPacing';
import {
  recordPlanOrPrePlanToolCall,
  resetPrePlanToolCallsForNewRun,
  readToolResultFacts,
} from '../../../agentv3/planToolCallRecorder';
import { buildRecoveryNote } from '../../../agentv3/recoveryNoteBuilder';
import { evaluateThreshold as evaluateContextThreshold } from '../../../agentv3/contextTokenMeter';
import {
  createClaudeSnapshotEngineState,
  getClaudeSnapshotEngineState,
  projectSessionFieldsForDurableSnapshot,
  sessionFieldsUsePrivateKnowledge,
  type SessionStateSnapshot,
  type SessionFieldsForSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import { AgentMetricsCollector, persistSessionMetrics } from '../../../agentv3/agentMetrics';
import {
  extractTraceFeatures,
  saveNegativePattern,
  buildPatternContextSection,
  buildNegativePatternSection,
} from '../../../agentv3/analysisPatternMemory';
import {
  createCodeAwareStreamingTextProjection,
  sanitizeOwnerCodeAwareStructuredTextWithReceipt,
} from '../../../services/security/codeAwareOutputRegistry';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import {extractSourceLookupCodeReferences} from '../../../services/codebase/sourceLookupTools';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../../services/codebase/sourceClaimVerifier';
import {diagnosticLogIdentity} from '../../../utils/logger';
import { runSnapshots } from '../../../agentv3/selfImprove/strategyFingerprint';
import {verifyConclusion, generateCorrectionPrompt} from './claudeVerifier';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import { backendLogPath } from '../../../runtimePaths';
import {applyFinalResultQualityGate} from '../../../services/finalResultQualityGate';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import { getProductionEngineCapabilities } from '../../runtimeDescriptors';
import type { EngineCapabilities } from '../../runtimeDescriptorTypes';
import {
  createDeadlineRuntimeTimeout,
  createProgressAwareRunDeadline,
  createResettableRuntimeTimeout,
  resolveFullRequestTimeoutMs,
  summarizeExternalToolResult,
  type ProgressAwareRunDeadline,
  type RuntimeTimeoutKind,
} from '../../runtimeLimits';
import {
  buildRuntimeTracePairComparisonContext,
  buildRuntimeTracePairIdentityContext,
  detectRunFocusApps,
} from '../../runtimePromptContext';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import { CLAUDE_AGENT_RUNTIME_KIND } from '../../runtimeKinds';

/** SDK terminal facts belong to one attempt, independently of answer wording. */
function claudeTerminalState(message: unknown): Pick<AnalysisCompletion, 'status' | 'reason' | 'sdkFinishReason'> {
  if (!message || typeof message !== 'object') return {status: 'unknown'};
  const value = message as Record<string, unknown>;
  if (value.type !== 'result') return {status: 'unknown'};
  const finish = typeof value.stop_reason === 'string' ? {sdkFinishReason: value.stop_reason} : {};
  if (value.subtype === 'error_max_turns') return {...finish, status: 'incomplete', reason: 'turn_limit'};
  if (value.subtype === 'error_max_budget_usd') return {...finish, status: 'incomplete', reason: 'budget_limit'};
  if (value.stop_reason === 'max_tokens') return {...finish, status: 'incomplete', reason: 'output_limit'};
  if (value.subtype === 'success' && value.is_error === false &&
      (value.stop_reason == null || value.stop_reason === 'end_turn' || value.stop_reason === 'stop_sequence')) {
    return {...finish, status: 'completed'};
  }
  return {...finish, status: 'failed', reason: 'provider_error'};
}

function chooseClaudeConclusionText(input: {finalResult?: string; accumulatedAnswer: string}): string {
  // A terminal body is authoritative even when short or empty. A missing body
  // may preserve streamed prose, whose completion remains unknown.
  return (input.finalResult === undefined ? input.accumulatedAnswer : input.finalResult).trim();
}

import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import { localize, type OutputLanguage } from '../../../agentv3/outputLanguage';
import { planPhaseUpdatedContent } from '../../../agentv3/planPhaseEvents';
import { isPolicyRefusalResult } from '../../../agentv3/toolNarration';
import {
  deleteClaudeSessionMapRuntimeSnapshots,
  loadClaudeSessionMapFromRuntimeSnapshots,
  saveClaudeSessionMapToRuntimeSnapshots,
  type ClaudeSessionMapRuntimeEntry,
} from '../../../services/runtimeSnapshotStore';
import {
  enterpriseDbWritesEnabled,
  legacyFilesystemReadAuthorityEnabled,
  legacyFilesystemWritesEnabled,
} from '../../../services/enterpriseMigration';
import {
  SDK_SESSION_FRESHNESS_MS,
  buildQuickRunReceipt,
  buildEntityContext,
  buildQuickConversationContext,
  buildRuntimeSessionMapKey,
  captureSkillDisplayEntities,
  createRuntimeSkillNotesBudget,
  getLruCacheEntry,
  isFreshRuntimeEntry,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
  quickStopReasonFromTermination,
  resolveQuickTurnBudget,
  setLruCacheEntry,
  toProtocolHypothesis as toRuntimeProtocolHypothesis,
} from '../../runtimeCommon';
import {
  createAnalysisRunSpec,
  type AnalysisRunSpec,
} from '../../analysisRunSpec';
import type { RuntimeSelection } from '../../runtimeSelection';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';

const SESSION_MAP_FILE = backendLogPath('claude_session_map.json');
/** Max age for session map entries before pruning (24 hours). */
const SESSION_MAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SessionMapEntry {
  sdkSessionId: string;
  updatedAt: number;
  mode?: 'full';
}

function enterpriseSessionMapDbWritesEnabled(): boolean {
  return enterpriseDbWritesEnabled();
}

function legacySessionMapWritesEnabled(): boolean {
  return legacyFilesystemWritesEnabled();
}

function loadPersistedSessionMap(): Map<string, SessionMapEntry> {
  try {
    if (fs.existsSync(SESSION_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const map = new Map<string, SessionMapEntry>();
      for (const [key, value] of Object.entries(data)) {
        // Migration: old format stored plain string, new format stores {sdkSessionId, updatedAt}
        if (typeof value === 'string') {
          map.set(key, { sdkSessionId: value, updatedAt: Date.now() });
        } else if (value && typeof value === 'object') {
          const entry = value as Partial<SessionMapEntry>;
          if (typeof entry.sdkSessionId !== 'string') continue;
          const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : Date.now();
          const mode = entry.mode === 'full' ? entry.mode : undefined;
          map.set(key, { sdkSessionId: entry.sdkSessionId, updatedAt, ...(mode ? { mode } : {}) });
        }
      }
      return map;
    }
  } catch {
    // Ignore — start with empty map
  }
  return new Map();
}

function loadSessionMapForCurrentMode(): Map<string, SessionMapEntry> {
  if (legacyFilesystemReadAuthorityEnabled()) {
    return loadPersistedSessionMap();
  }

  try {
    return loadClaudeSessionMapFromRuntimeSnapshots(SESSION_MAP_MAX_AGE_MS);
  } catch (err) {
    console.warn('[ClaudeRuntime] Failed to load runtime_snapshots session map:', diagnosticLogIdentity((err as Error).message));
  }
  return new Map();
}

/**
 * Debounce timer for session map persistence — avoids blocking event loop on every SDK message.
 * P2-1: Use a Map keyed by the Map reference to support multiple ClaudeRuntime instances.
 */
const saveTimers = new WeakMap<Map<string, SessionMapEntry>, ReturnType<typeof setTimeout>>();
const SAVE_DEBOUNCE_MS = 2000;
const TEXT_ONLY_CORRECTION_TIMEOUT_MS = 120_000;

function savePersistedSessionMap(map: Map<string, SessionMapEntry>): void {
  const existing = saveTimers.get(map);
  if (existing) clearTimeout(existing);
  saveTimers.set(map, setTimeout(() => {
    saveTimers.delete(map);
    savePersistedSessionMapSync(map);
  }, SAVE_DEBOUNCE_MS));
}

/** Immediate save — used by debounce timer and for critical operations (session removal). */
function savePersistedSessionMapSync(map: Map<string, SessionMapEntry>): void {
  try {
    const dir = path.dirname(SESSION_MAP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Prune stale entries before saving
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now - entry.updatedAt > SESSION_MAP_MAX_AGE_MS) {
        map.delete(key);
      }
    }

    const tmpFile = SESSION_MAP_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(Object.fromEntries(map)));
    fs.renameSync(tmpFile, SESSION_MAP_FILE);
  } catch (err) {
    console.warn('[ClaudeRuntime] Failed to persist session map:', diagnosticLogIdentity((err as Error).message));
  }
}

// Notes persistence now handled by unified SessionStateSnapshot — no separate disk I/O.
// The old logs/session_notes/ directory is no longer written to.

// P2-G1: ALLOWED_TOOLS is now auto-derived from createClaudeMcpServer() return value.
// No longer hardcoded — adding a new MCP tool automatically includes it.

/** Check if an error is retryable (API overload/server errors). */
function isRetryableError(err: Error): boolean {
  const failure = err as Error & {status?: unknown; code?: unknown};
  return failure.status === 429 || failure.status === 500 || failure.status === 503 || failure.status === 529
    || failure.code === 'ECONNRESET' || failure.code === 'ETIMEDOUT';
}

function getSdkResultErrorMessage(msg: any): string | undefined {
  if (!msg || msg.type !== 'result') return undefined;
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown';
  if (subtype === 'success' || isSdkMaxTurnsSubtype(subtype)) return undefined;

  const errors = Array.isArray(msg.errors)
    ? msg.errors.map(formatSdkError).filter(Boolean)
    : [];
  return `Claude analysis error (${subtype}): ${errors.join('; ') || 'Unknown error'}`;
}

function formatSdkError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') return maybeMessage;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function isMissingSdkConversationError(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

function isFreshFullSdkSessionEntry(entry: SessionMapEntry | undefined, now = Date.now()): entry is SessionMapEntry & { mode: 'full' } {
  return !!entry
    && entry.mode === 'full'
    && isFreshRuntimeEntry(entry, SDK_SESSION_FRESHNESS_MS, now);
}

type ClaudeSdkSystemPrompt = string | string[];

function supportsSystemPromptDynamicBoundary(capabilities: EngineCapabilities): boolean {
  return capabilities.promptCache.systemPromptDynamicBoundary;
}

function buildClaudeSdkSystemPrompt(
  parts: Pick<ReturnType<typeof buildSystemPromptParts>, 'fullPrompt' | 'stablePrefix' | 'volatileSuffix'>,
  capabilities: EngineCapabilities,
): ClaudeSdkSystemPrompt {
  if (!supportsSystemPromptDynamicBoundary(capabilities)) {
    return parts.fullPrompt;
  }

  const stablePrefix = parts.stablePrefix.trim();
  if (!stablePrefix) {
    return parts.fullPrompt;
  }

  const blocks = [
    stablePrefix,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  ];
  const volatileSuffix = parts.volatileSuffix.trim();
  if (volatileSuffix) {
    blocks.push(volatileSuffix);
  }
  return blocks;
}

function projectClaudeToolResultForPlan(toolName: string, result: unknown): string {
  return summarizeExternalToolResult(projectToolResultForExternalSurface(toolName, result));
}

function buildClaudeSdkToolOptions(
  allowedTools: readonly string[],
  agents?: Record<string, unknown>,
): {tools: string[]; allowedTools: string[]} {
  const hasSubAgents = agents !== undefined && Object.keys(agents).length > 0;
  if (!hasSubAgents) {
    return {tools: [], allowedTools: [...allowedTools]};
  }
  return {
    tools: ['Agent'],
    allowedTools: allowedTools.includes('Agent')
      ? [...allowedTools]
      : [...allowedTools, 'Agent'],
  };
}

export const __testing = {
  getSdkResultErrorMessage, isMissingSdkConversationError, isFreshFullSdkSessionEntry,
  buildClaudeSdkSystemPrompt, buildQuickConversationContext, chooseClaudeConclusionText,
  claudeTerminalState, isRetryableError, projectClaudeToolResultForPlan, buildClaudeSdkToolOptions,
};

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handle returned by sdkQueryWithRetry. `stream` is the (retry-wrapped)
 * async iterable of SDK messages; `close()` aborts the underlying SDK
 * subprocess and any in-flight MCP tool calls.
 *
 * Callers MUST invoke `close()` (typically from a timeout handler and as a
 * `finally` safety net) to prevent zombie MCP tool executions from running
 * after the session has been torn down.
 */
interface SdkQueryHandle {
  stream: ReturnType<typeof sdkQuery>;
  close: () => void;
}

interface RuntimeAbortHandle {
  abort(): void;
}

interface SdkQueryRuntimeReceiptState {
  sdkStartRecorded: boolean;
}

/**
 * Wrap sdkQuery with exponential backoff retry for transient API errors
 * and expose a `close()` handle so timeout/abort paths can terminate the
 * SDK subprocess instead of just breaking out of the `for await` loop.
 *
 * Without `close()`, a consumer that `break`s out of the iterator leaves
 * the SDK free to continue executing queued MCP tool calls (e.g.
 * `execute_sql`). Those "ghost" calls hit trace_processor after the
 * session logger has closed, producing orphan errors no one handles.
 */
/** Only initialization without usage is known to precede model/tool work. */
function sdkAttemptHasObservedWork(message: unknown): boolean {
  if (!message || typeof message !== 'object') return true;
  const value = message as Record<string, unknown>;
  const hasUsage = (candidate: unknown): boolean => candidate !== null && typeof candidate === 'object'
    && Object.values(candidate as Record<string, unknown>).some(value =>
      typeof value === 'number' ? value > 0 : hasUsage(value));
  const hasReportedWork = (typeof value.num_turns === 'number' && value.num_turns > 0)
    || (typeof value.total_cost_usd === 'number' && value.total_cost_usd > 0)
    || hasUsage(value.usage) || hasUsage(value.modelUsage);
  if (value.type === 'system' && value.subtype === 'init') return hasReportedWork;
  if (value.type === 'result') return value.subtype === 'success' || hasReportedWork;
  // Partial model events, assistant messages, tool progress/results and unknown
  // events cannot establish that replaying this attempt consumes no work.
  return true;
}

function sdkQueryWithRetry(
  params: Parameters<typeof sdkQuery>[0],
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    emitUpdate?: (update: StreamingUpdate) => void;
    outputLanguage?: import('../../../agentv3/outputLanguage').OutputLanguage;
    runtimePerformance?: RuntimePerformanceRun;
    signal?: AbortSignal;
    recordSdkStartPhase?: boolean;
    runtimeReceiptState?: SdkQueryRuntimeReceiptState;
    onAttempt?: () => void;
  } = {},
): SdkQueryHandle {
  const {
    maxRetries = 2,
    baseDelayMs = 2000,
    emitUpdate,
    outputLanguage = loadClaudeConfig().outputLanguage,
    runtimePerformance,
    signal,
    recordSdkStartPhase = false,
    runtimeReceiptState,
  } = options;
  const queryOptions = params.options ?? {};
  const binaryOpt = getSdkBinaryOption(queryOptions.env);
  const mergedParams = binaryOpt.pathToClaudeCodeExecutable
    ? { ...params, options: { ...queryOptions, ...binaryOpt } }
    : params;

  // Tracks the Query instance currently being iterated so `close()` can
  // forward termination to the underlying SDK subprocess across retries.
  let currentQuery: ReturnType<typeof sdkQuery> | undefined;
  let closed = false;
  const localRuntimeReceiptState = runtimeReceiptState ?? {sdkStartRecorded: false};
  let activeAttemptEnd: ((outcome: RuntimePerformanceOutcome) => void) | undefined;

  // We can't directly retry an async iterable, so we use a generator wrapper.
  // On the first call to next(), we attempt sdkQuery. If it throws, we retry.
  async function* retryableStream() {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (closed) return;
      signal?.throwIfAborted();
      let terminalResultObserved = false;
      let attemptWorkObserved = false;
      let attemptOutcome: RuntimePerformanceOutcome = 'ok';
      const sdkStartPhase = recordSdkStartPhase && !localRuntimeReceiptState.sdkStartRecorded
        ? runtimePerformance?.startPhase('sdk_start')
        : undefined;
      if (sdkStartPhase) {
        localRuntimeReceiptState.sdkStartRecorded = true;
      }
      const providerPhase = runtimePerformance?.startPhase('provider');
      let providerEnded = false;
      const endProviderPhase = (outcome: RuntimePerformanceOutcome) => {
        if (providerEnded) return;
        providerEnded = true;
        providerPhase?.end(outcome);
        if (activeAttemptEnd === endProviderPhase) {
          activeAttemptEnd = undefined;
        }
      };
      activeAttemptEnd = endProviderPhase;
      try {
        if (currentEvaluationInjectionContract()) {
          commitEvaluationExposureSince(0, 'sdk_handoff_observed');
        }
        options.onAttempt?.();
        currentQuery = sdkQuery(mergedParams);
        sdkStartPhase?.end(closed || signal?.aborted ? 'cancelled' : 'ok');
        // Yield all messages from the stream
        for await (const msg of currentQuery) {
          if (closed) {
            endProviderPhase('cancelled');
            return;
          }
          attemptWorkObserved ||= sdkAttemptHasObservedWork(msg);
          if ((msg as any)?.type === 'result') {
            terminalResultObserved = true;
            const terminal = claudeTerminalState(msg);
            if (terminal.status === 'failed') attemptOutcome = 'error';
            endProviderPhase(attemptOutcome);
          }
          yield msg;
        }
        endProviderPhase(closed || signal?.aborted ? 'cancelled' : attemptOutcome);
        return; // Success — exit generator
      } catch (err) {
        lastErr = err as Error;
        if (terminalResultObserved) {
          sdkStartPhase?.end(closed || signal?.aborted ? 'cancelled' : 'ok');
          endProviderPhase('ok');
          console.warn(
            '[ClaudeRuntime] Ignoring SDK iterator cleanup error after terminal result:',
            diagnosticLogIdentity(lastErr.message),
          );
          return;
        }
        const outcome = runtimeOutcomeFromError(lastErr, signal);
        sdkStartPhase?.end(outcome);
        endProviderPhase(outcome);
        // If the caller invoked close(), treat the resulting error as
        // intentional termination rather than a retryable failure.
        if (closed) return;
        if (!attemptWorkObserved && isRetryableError(lastErr) && attempt < maxRetries) {
          try { currentQuery?.close(); } catch { /* Preserve the original provider failure. */ }
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.warn(
            `[ClaudeRuntime] API error (attempt ${attempt + 1}/${maxRetries + 1}): ` +
            `${diagnosticLogIdentity(lastErr.message)}. Retrying in ${delay}ms...`,
          );
          emitUpdate?.({
            type: 'progress',
            content: {
              phase: 'starting',
              message: localize(
                outputLanguage,
                `API 暂时不可用，${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${maxRetries})...`,
                `API is temporarily unavailable. Retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${maxRetries})...`,
              ),
            },
            timestamp: Date.now(),
          });
          await sleep(delay);
          continue;
        }
        throw lastErr; // Non-retryable or max retries exceeded
      }
    }
    if (lastErr) throw lastErr;
  }

  return {
    stream: retryableStream() as ReturnType<typeof sdkQuery>,
    close: () => {
      if (closed) return; // Idempotent — safe to call from timeout handler AND finally.
      closed = true;
      activeAttemptEnd?.('cancelled');
      try {
        currentQuery?.close();
      } catch (err) {
        console.warn('[ClaudeRuntime] sdkQueryWithRetry close() failed (non-fatal):', diagnosticLogIdentity((err as Error).message));
      }
    },
  };
}

/**
 * Claude Agent SDK runtime for SmartPerfetto.
 * Claude SDK orchestrator implementation behind the shared IOrchestrator contract.
 * Implements the same EventEmitter + analyze() interface as AgentRuntime.
 */
export class ClaudeRuntime extends EventEmitter implements IOrchestrator {
  private traceProcessorService: TraceProcessorService;
  private config: ClaudeAgentConfig;
  private sessionMap: Map<string, SessionMapEntry>;
  /** Cache architecture detection results per traceId (deterministic per trace). */
  private architectureCache: Map<string, ArchitectureInfo> = new Map();
  /** Cache vendor detection results per traceId (deterministic per trace). */
  private vendorCache: Map<string, string> = new Map();
  /** Per-session artifact stores — persist across turns within a session. */
  private artifactStores: Map<string, ArtifactStore> = new Map();
  /** Per-session analysis notes — persist across turns within a session. */
  private sessionNotes: Map<string, AnalysisNote[]> = new Map();
  /** Per-session SQL error tracking for error-fix pair learning. */
  private sessionSqlErrors: Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number }>> = new Map();
  private sessionSqlErrorPartitions: Map<string, string> = new Map();
  /** Per-session analysis plans for plan adherence tracking. */
  private sessionPlans: Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }> = new Map();
  /** Per-session hypotheses for hypothesis-verify cycle (P0-G4). */
  private sessionHypotheses: Map<string, Hypothesis[]> = new Map();
  /** Per-session uncertainty flags for non-blocking human interaction (P1-G1). */
  private sessionUncertaintyFlags: Map<string, UncertaintyFlag[]> = new Map();
  /** Guard against concurrent analyze() calls for the same session. */
  private activeAnalyses: Set<string> = new Set();
  /** In-flight SDK subprocess handles keyed by SmartPerfetto session. */
  private readonly activeAbortHandles: Map<string, Set<RuntimeAbortHandle>> = new Map();
  private readonly executionGuard = new RuntimeExecutionGuard();
  private readonly runtimeSelection: RuntimeSelection;
  private readonly runtimeCapabilities: EngineCapabilities;

  constructor(
    traceProcessorService: TraceProcessorService,
    config?: Partial<ClaudeAgentConfig>,
    runtimeSelection: RuntimeSelection = { kind: 'claude-agent-sdk', source: 'default' },
  ) {
    super();
    this.traceProcessorService = traceProcessorService;
    this.config = loadClaudeConfig(config);
    this.runtimeSelection = runtimeSelection;
    this.runtimeCapabilities = getProductionEngineCapabilities(runtimeSelection.kind);
    this.sessionMap = loadSessionMapForCurrentMode();
  }

  /** Restore a previously persisted SDK session mapping (e.g., after server restart). */
  restoreSessionMapping(smartPerfettoSessionId: string, sdkSessionId: string, referenceTraceId?: string): void {
    this.sessionMap.set(
      this.buildSessionMapKey(smartPerfettoSessionId, referenceTraceId),
      { sdkSessionId, updatedAt: Date.now(), mode: 'full' },
    );
  }

  /** Restore a cached architecture detection result (e.g., from session persistence). */
  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    setLruCacheEntry(this.architectureCache, traceId, architecture);
  }

  /** Get cached architecture for a traceId (used for persistence). */
  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return this.architectureCache.get(traceId);
  }

  /** Get SDK session ID for persistence. */
  getSdkSessionId(smartPerfettoSessionId: string, referenceTraceId?: string): string | undefined {
    const entry = this.sessionMap.get(this.buildSessionMapKey(smartPerfettoSessionId, referenceTraceId));
    return isFreshFullSdkSessionEntry(entry) ? entry.sdkSessionId : undefined;
  }

  private buildSessionMapKey(sessionId: string, referenceTraceId?: string): string {
    return buildRuntimeSessionMapKey(sessionId, referenceTraceId);
  }

  private persistSessionMapEntry(
    sessionId: string,
    traceId: string,
    sessionMapKey: string,
    entry: ClaudeSessionMapRuntimeEntry,
    options: AnalysisOptions,
  ): void {
    if (legacySessionMapWritesEnabled()) {
      savePersistedSessionMap(this.sessionMap);
    }

    if (!enterpriseSessionMapDbWritesEnabled()) return;

    if (!options.tenantId || !options.workspaceId) {
      console.warn('[ClaudeRuntime] Enterprise session map persistence skipped: missing tenant/workspace scope');
      return;
    }

    try {
      saveClaudeSessionMapToRuntimeSnapshots({
        tenantId: options.tenantId,
        workspaceId: options.workspaceId,
        userId: options.userId,
        sessionId,
        runId: options.runId,
        traceId,
      }, sessionMapKey, entry);
    } catch (err) {
      console.warn('[ClaudeRuntime] Failed to persist session map to runtime_snapshots:', diagnosticLogIdentity((err as Error).message));
    }
  }

  private rememberFullSdkSessionMapping(
    sessionId: string,
    traceId: string,
    sessionMapKey: string,
    sdkSessionId: string,
    options: AnalysisOptions,
  ): void {
    const entry = { sdkSessionId, updatedAt: Date.now(), mode: 'full' as const };
    this.sessionMap.set(sessionMapKey, entry);
    this.persistSessionMapEntry(sessionId, traceId, sessionMapKey, entry, options);
  }

  private removeSessionMapEntries(sessionId: string): void {
    const referencePrefix = `${sessionId}:ref:`;
    for (const key of [...this.sessionMap.keys()]) {
      if (key === sessionId || key.startsWith(referencePrefix)) {
        this.sessionMap.delete(key);
      }
    }
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    const executionLease = this.executionGuard.begin({
      runtime: CLAUDE_AGENT_RUNTIME_KIND,
      sessionId,
      referenceTraceId: options.referenceTraceId,
      runId: options.runId,
    });
    const runtimePerformance = createRuntimePerformanceRun(
      options.runManifestAttributionSink,
    );
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';

    const startTime = Date.now();
    const runActivity = {active: true};
    const allFindings: Finding[][] = [];
    let conclusionText = '';
    let sdkSessionId: string | undefined;
    let rounds = 0;
    const runId = options.runId ?? options.runManifestAttributionSink?.identity.runId ?? randomUUID();
    let turnIntent: AnalysisTurnIntent | undefined;
    let attemptNumber = 0;
    let acceptedAttemptId = `${runId}:main:0`;
    let acceptedOrigin: AnalysisOutputOrigin = 'runtime_fallback';
    let acceptedRawBody: string | undefined;
    const hasAcceptedSdkFinal = () => acceptedOrigin === 'sdk_final';
    let acceptedTerminal: Pick<AnalysisCompletion, 'status' | 'reason' | 'sdkFinishReason'> = {status: 'unknown'};
    const bindCandidate = (body: string): AnalysisCandidateIdentity => ({
      candidateRef: `${acceptedAttemptId}:answer`, runId, attemptId: acceptedAttemptId,
      conclusionFingerprint: analysisDeliveryFingerprint(body),
    });
    const completionFor = (body: string): AnalysisCompletion => ({
      schemaVersion: 1, runtimeKind: CLAUDE_AGENT_RUNTIME_KIND,
      ...bindCandidate(body), ...acceptedTerminal,
    });
    // Turns observed as they stream, kept at method scope so a cancelled run
    // can still say what it did. `rounds` is otherwise read once from the SDK's
    // terminal `num_turns`, and that message never arrives on a timeout — a
    // 1200s compare that dispatched 45 turns reported `rounds: 0`.
    let observedTurns = 0;
    let mainAttemptWorkObserved = false;
    const observedRunTurns = () => Math.max(rounds, observedTurns, mainAttemptWorkObserved ? 1 : 0);
    let outputLanguage = options.outputLanguage ?? this.config.outputLanguage;
    let sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'] | undefined;
    let resolvedQuickBudget: ReturnType<typeof resolveQuickTurnBudget> | undefined;
    const attachQuickReceipt = (result: AnalysisResult) => {
      if (!resolvedQuickBudget) return;
      result.quickRun = buildQuickRunReceipt({
        requestedMode: options.analysisMode ?? 'auto', turnIntent, budget: resolvedQuickBudget,
        actualTurns: observedRunTurns(), elapsedMs: Date.now() - startTime,
        stopReason: quickStopReasonFromTermination({partial: result.partial === true || !result.success,
          terminationReason: result.terminationReason, actualTurns: observedRunTurns(),
          targetTurns: resolvedQuickBudget.targetTurns, hardCapTurns: resolvedQuickBudget.hardCapTurns}),
      });
    };
    let finalizationSetup: {
      input: Omit<RuntimeFinalizationContextInput, 'deliveryContext' | 'sourceUse' | 'evidenceReadView' | 'protocolProjection'>;
      ownerKey: string;
    } | undefined;
    // One run deadline for every run. Scene dispatch may extend it on progress, like the OpenAI
    // runtime, so a slow but producing scene run is not cut before it commits its timeline; other
    // runs set max = base, which leaves both reserves at zero and the deadline fixed.
    let runDeadline: ProgressAwareRunDeadline | undefined;
    let closeoutDeadlineAt: number | undefined;
    const attachAcceptedFinalization = (result: AnalysisResult, deliveryContext: AnalysisDeliveryContext, allowSemantic: boolean,
      protocolProjection?: RuntimeFinalizationContextInput['protocolProjection']) => {
      if (!finalizationSetup || attemptNumber === 0 ||
          (!hasAcceptedSdkFinal() && !acceptedRawBody?.trim())) return;
      const store = this.artifactStores.get(sessionId);
      const identity = finalizationSetup.input.traceIdentity;
      const allowedTraces = [
        ...(identity.currentTraceId ? [{traceId: identity.currentTraceId, traceSide: 'current' as const}] : []),
        ...(identity.referenceTraceId ? [{traceId: identity.referenceTraceId, traceSide: 'reference' as const}] : []),
      ];
      const semanticCall = allowSemantic && result.completion?.status === 'completed' &&
        result.outputOrigin === 'sdk_final' && result.conclusion.trim().length > 0;
      const intent = finalizationSetup.input.turnIntent;
      attachFinalizationContext(result, {
        ...finalizationSetup.input, deliveryContext, protocolProjection,
        ...(runDeadline ? {deadlineMs: runDeadline.finalizationDeadlineAt(Date.now(), closeoutDeadlineAt, {
          useRemainingBudget: reportReviewUsesRemainingBudget({semanticCall, turnIntent: intent, result})})} : {}),
        sourceUse: sourceUse?.getSourceUseDecision(),
        sourceScope: sourceUse?.getSourceExecutionScope?.(),
        evidenceReadView: store?.createEvidenceReadView({allowedTraces, ownerKey: finalizationSetup.ownerKey,
          currentRunId: finalizationSetup.input.runId}),
        dispatchText: semanticCall ? finalizationSetup.input.dispatchText : undefined,
      });
    };
    const projectAcceptedCandidate = (rawBody: string, failed = false) => {
      acceptedRawBody = rawBody;
      const completion = completionFor(rawBody);
      const findings = extractFindingsFromText(rawBody);
      // Empty native output remains empty and unsuccessful before any guard can
      // substitute a user-facing explanation for private content.
      const partial = failed || rawBody.trim().length === 0 || completion.status !== 'completed';
      const projection = finalizeOwnerSourceAwareAnalysisResultWithProjection({
        sessionId,
        success: !failed && rawBody.trim().length > 0 &&
          (completion.status === 'completed' || completion.status === 'incomplete'),
        findings, hypotheses: (this.sessionHypotheses.get(sessionId) ?? []).map(h => this.toProtocolHypothesis(h)),
        conclusion: rawBody, confidence: estimateAnalysisConfidence({findings, partial}),
        rounds: observedRunTurns(), totalDurationMs: Date.now() - startTime,
        partial: partial || undefined, turnIntent, completion, outputOrigin: acceptedOrigin,
      }, sourceUse, {
        context: {entry: 'runtime_draft', acceptedCandidate: bindCandidate(rawBody), completion,
          outputOrigin: acceptedOrigin, turnIntent},
      });
      if (!projection.deliveryContext || projection.deliveryContext.entry === 'historical_restore') {
        throw new Error('Current Claude candidate projection did not return a current delivery context');
      }
      return {...projection, deliveryContext: projection.deliveryContext};
    };
    const metricsCollector = new AgentMetricsCollector(sessionId);
    let interruptionRecoveryState: {
      streamStarted: boolean;
      getAccumulatedAnswer: () => string;
      flushPendingAnswer: () => void;
      dispose: () => void;
      getPlan: () => AnalysisPlanV3 | null;
    } | undefined;

    try {
      executionLease.throwIfAborted();
      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const previousTurns = sessionContext.getAllTurns?.() || [];
      const authorizationScope = resolveKnowledgeScope(options);
      const authorizationFingerprint = options.analysisContextFingerprint ??
        buildAnalysisContextAuthorizationFingerprint(options, authorizationScope);
      const assertAuthorized = () => {
        executionLease.throwIfAborted();
        assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
      };
      const analysisHistoryReader = createRuntimeAnalysisHistoryReader({
        options, sessionId, traceId,
        getTurns: () => sessionContext.getAnalysisHistory(),
        assertActive: assertAuthorized,
      });
      const providerScope = providerScopeFromAnalysisOptions(options);
      const configured = resolveRuntimeConfig(this.config, options.providerId, providerScope);
      const resolvedConfig = options.outputLanguage ? {...configured, outputLanguage: options.outputLanguage} : configured;
      outputLanguage = resolvedConfig.outputLanguage;
      const sdkEnv = createSdkEnv(options.providerId, providerScope);
      const intentResolver = createAnalysisTurnIntentResolver({
        productRun: {options, runId, sessionId, traceId},
        context: buildComplexityClassifierInput({
          query, sceneType: 'general', selectionContext: options.selectionContext,
          hasReferenceTrace: !!options.referenceTraceId, previousTurns: [],
          history: analysisHistoryReader.getTurns(),
          requestedMode: options.analysisMode ?? 'auto',
        }),
        signal: executionLease.signal,
        deadlineMs: Date.now() + resolvedConfig.classifierTimeoutMs,
        dispatch: input => runClaudeIntentTransport({
          ...input, config: resolvedConfig, sdkEnv,
          sdkBinaryOptions: getSdkBinaryOption(sdkEnv),
          loadSdk: async () => ({query: sdkQuery}),
        }),
      });
      turnIntent = await intentResolver.resolve();
      executionLease.throwIfAborted();
      const resolvedPolicy = resolveRuntimeTurnPolicy(turnIntent, options.analysisMode ?? 'auto');
      const turnPolicy = options.assistantSurface === 'conversation' && options.conversationTraceAttached !== true
        ? {...resolvedPolicy, allowAutomaticPrefetch: false, preflight: 'none' as const} : resolvedPolicy;
      const quickBudgetConfig = createQuickConfig(resolvedConfig, sdkEnv);
      // A failed light-model classifier must not send the main answer back to
      // that same unavailable model. Provider identity remains pinned.
      const runtimeConfig = turnPolicy.budgetMode === 'quick' ? {
        ...quickBudgetConfig,
        model: turnIntent.status === 'unavailable' ? resolvedConfig.model : quickBudgetConfig.model,
        enableVerification: resolvedConfig.enableVerification,
        enableSubAgents: resolvedConfig.enableSubAgents,
      } : resolvedConfig;
      resolvedQuickBudget = turnPolicy.budgetMode === 'quick' ? resolveQuickTurnBudget({
        env: sdkEnv, hardCapTurns: runtimeConfig.maxTurns,
        targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS', 'CLAUDE_QUICK_TARGET_TURNS'],
        hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS', 'CLAUDE_QUICK_MAX_TURNS'], enforcement: 'turn_cap',
      }) : undefined;
      const turnBudget = resolveRuntimeTurnBudget(runtimeConfig.maxTurns);
      const closeoutTape = createRuntimeTurnCloseoutTape();
      const acquisition = {open: true};
      const sceneType = turnIntent.sceneId;
      runSnapshots.capture(sessionId, sceneType, intentResolver.strategyRegistry);
      const analysisRunSpec = createAnalysisRunSpec({
        query, sessionId, traceId, options, runtimeSelection: this.runtimeSelection,
        sceneType, outputLanguage, previousTurns: [], history: analysisHistoryReader.getTurns(),
        resolvedMode: turnPolicy.budgetMode,
        resolvedModel: runtimeConfig.model, turnIntent,
        budget: {
          model: runtimeConfig.model, lightModel: runtimeConfig.lightModel,
          maxTurns: runtimeConfig.maxTurns, maxBudgetUsd: runtimeConfig.maxBudgetUsd,
          fullPathPerTurnMs: runtimeConfig.fullPathPerTurnMs, quickPathPerTurnMs: runtimeConfig.quickPathPerTurnMs,
          classifierTimeoutMs: runtimeConfig.classifierTimeoutMs, verifierTimeoutMs: runtimeConfig.verifierTimeoutMs,
        },
      });
      metricsCollector.recordAnalysisMode(options.analysisMode ?? 'auto',
        options.analysisMode === 'fast' || options.analysisMode === 'full' ? 'user_explicit' : 'ai');
      runtimePerformance.finishClassification(turnIntent.status === 'resolved' ? 'ok' : 'error');
      const quickBudgetMode = turnPolicy.budgetMode === 'quick';
      const requestPerTurnMs = quickBudgetMode ? runtimeConfig.quickPathPerTurnMs : runtimeConfig.fullPathPerTurnMs;
      const requestBudgetMs = quickBudgetMode ? requestPerTurnMs * runtimeConfig.maxTurns
        : resolveFullRequestTimeoutMs(requestPerTurnMs, runtimeConfig.maxTurns, runtimeConfig.fullRequestTimeoutMs);
      const deadline = runDeadline = createProgressAwareRunDeadline({baseBudgetMs: requestBudgetMs, perTurnMs: requestPerTurnMs,
        maxRunMs: resolveSceneProductScope(options, {runId, sessionId, traceId}) ? runtimeConfig.maxRunTimeoutMs : requestBudgetMs});
      const extensible = deadline.hardDeadlineAt > deadline.startedAt + deadline.baseBudgetMs;
      // Latest end of any model call, keeping the finalization reserve after it.
      const requestDeadline = deadline.hardDeadlineAt - deadline.finalizationReserveMs;
      const finalizationEnv = Object.freeze({...sdkEnv});
      const finalizationModel = resolvedConfig.model;
      const finalizationBinaryOptions = Object.freeze({...getSdkBinaryOption(finalizationEnv)});
      finalizationSetup = {
        ownerKey: analysisDeliveryFingerprint({runId, sessionId,
          analysisContextFingerprint: options.analysisContextFingerprint,
          scopes: analysisRunSpec.scopes, authorizedTools: analysisRunSpec.tools}),
        input: {
          runId, sessionId, deadlineMs: requestDeadline, turnIntent,
          selection: analysisRunSpec.selection,
          providerQuery: {text: analysisRunSpec.query.text, analysisContextFingerprint: options.analysisContextFingerprint},
          strategyRegistry: intentResolver.strategyRegistry,
          traceIdentity: {
            currentTraceId: options.assistantSurface === 'conversation' && options.conversationTraceAttached !== true
              ? undefined : traceId,
            referenceTraceId: options.referenceTraceId,
          },
          dispatchText: async input => {
            const directory = await fs.promises.mkdtemp(path.join(tmpdir(), 'smartperfetto-claude-review-'));
            try {
              return await runClaudeIntentTransport({...input,
                config: {lightModel: finalizationModel, cwd: directory}, sdkEnv: finalizationEnv,
                sdkBinaryOptions: finalizationBinaryOptions, loadSdk: async () => ({query: sdkQuery})});
            } finally {
              await fs.promises.rm(directory, {recursive: true, force: true});
            }
          },
        },
      };
      const focusResult = await detectRunFocusApps({
        traceProcessorService: this.traceProcessorService, traceId, preflight: turnPolicy.preflight,
        selectionContext: options.selectionContext,
        measure: async detect => {
          const phase = runtimePerformance.startPhase('focus');
          try {
            const result = await detect();
            phase.end(executionLease.signal.aborted ? 'cancelled' : 'ok');
            return result;
          } catch (error) {
            phase.end(runtimeOutcomeFromError(error, executionLease.signal));
            return undefined;
          }
        },
      });
      executionLease.throwIfAborted();

      const ctx = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        focusResult,
        sessionContext,
        previousTurns,
        sceneType,
        runtimeConfig,
        analysisRunSpec,
        executionLease,
        runtimePerformance,
        turnIntent, turnPolicy, strategyRegistry: intentResolver.strategyRegistry, runActivity,
        toolObserver: event => {
          if (event.phase === 'completed') deadline.recordProgress();
          return closeoutTape.observe(event);
        },
        analysisHistoryReader, acquisition,
        sceneDeadlineMs: deadline.hardDeadlineAt, scenePacing: deadline,
      });
      sourceUse = ctx.sourceUse;
      executionLease.throwIfAborted();

      const {
        handleMessage: bridge,
        getAccumulatedAnswer,
        flushPendingAnswer,
        dispose: disposeBridge,
      } = createSseBridge((update: StreamingUpdate) => {
        if (!runActivity.active || executionLease.signal.aborted) return;
        const normalizedUpdate = update.type === 'error' && typeof update.content?.message === 'string'
          ? {...update, content: {...update.content,
              message: sanitizeOwnerCodeAwareStructuredTextWithReceipt(sessionId, update.content.message).text}}
          : update;
        if (normalizedUpdate.type === 'answer_token' || normalizedUpdate.type === 'thought') {
          runtimePerformance.recordFirstOutput();
        }
        this.emitUpdate(normalizedUpdate);
        if (normalizedUpdate.type === 'agent_response' && normalizedUpdate.content?.result) {
          try {
            const parsed = typeof normalizedUpdate.content.result === 'string'
              ? JSON.parse(normalizedUpdate.content.result)
              : normalizedUpdate.content.result;
            if (parsed?.success && parsed?.skillId) {
              allFindings.push(extractFindingsFromSkillResult(parsed));
            }
            if (parsed?.success && parsed?.displayResults) {
              this.captureEntitiesFromSkillDisplayResults(parsed.displayResults, ctx.entityStore);
            }
          } catch {
            // Not a skill result — ignore
          }
        }
      }, outputLanguage, {
        tracePairContext: ctx.analysisContextForRebuild.comparison?.tracePairContext,
      }, ((options.codeAwareMode && options.codeAwareMode !== 'off') || options.knowledgeSourceIds?.length)
        ? createCodeAwareStreamingTextProjection(sessionId, 'claude-full-answer', 'owner')
        : undefined);
      // The bridge accumulates native text before applying the public stream projection.
      let attemptStreamOffset = 0;
      const getAttemptAnswer = () => getAccumulatedAnswer().slice(attemptStreamOffset);
      interruptionRecoveryState = {
        streamStarted: false,
        getAccumulatedAnswer: getAttemptAnswer,
        flushPendingAnswer,
        dispose: disposeBridge,
        getPlan: () => ctx.analysisPlan.current,
      };

      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            outputLanguage,
            `使用 ${runtimeConfig.model} 开始分析 (effort: ${ctx.effectiveEffort})...`,
            `Starting analysis with ${runtimeConfig.model} (effort: ${ctx.effectiveEffort})...`,
          ),
        },
        timestamp: Date.now(),
      });

      // Each logical turn receives only product-owned, bounded history.
      const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
      let finalResult: string | undefined;
      let mainCostUsd: number | undefined;
      let terminationReason: AnalysisResult['terminationReason'];
      let terminationMessage: string | undefined;
      let sdkStreamErrorMessage: string | undefined;
      let timedOut = false;
      const timeoutState: {kind: RuntimeTimeoutKind} = {kind: 'request'};
      const isStreamIdleTimeout = () => (timeoutState.kind as RuntimeTimeoutKind) === 'stream_idle';
      const failedApproaches: FailedApproach[] = [];
      let sdkCompactDetected = false;
      const sdkRuntimeReceiptState: SdkQueryRuntimeReceiptState = {sdkStartRecorded: false};
      {
        executionLease.throwIfAborted();
        sdkStreamErrorMessage = undefined;
        finalResult = undefined;
        terminationReason = undefined;
        terminationMessage = undefined;
        timedOut = false;
        timeoutState.kind = 'request';
        let effectivePrompt = query;
        const historyContext = renderAnalysisHistoryContext(analysisHistoryReader.getTurns(), {outputLanguage});
        if (historyContext) effectivePrompt = `${historyContext}\n\n${effectivePrompt}`;
        // Prepend pre-queried trace data so the AI has all context without spending turns on SQL
        if (ctx.analysisRunSpec?.traceContext.promptSection) {
          const traceSection = ctx.analysisRunSpec.traceContext.promptSection;
          effectivePrompt = `${traceSection}\n\n${effectivePrompt}`;
        }

        assertAuthorized();
        if (Date.now() >= requestDeadline) {
          acceptedTerminal = {status: 'incomplete', reason: 'timeout'};
          throw new Error('Claude request budget expired before SDK dispatch');
        }
        const { stream, close: closeSdk } = sdkQueryWithRetry({
            prompt: effectivePrompt,
            options: {
              model: runtimeConfig.model,
              maxTurns: turnBudget.acquisitionTurns,
              systemPrompt: ctx.sdkSystemPrompt,
              mcpServers: { smartperfetto: ctx.mcpServer },
              includePartialMessages: true,
              settingSources: [],
              ...buildClaudeSdkToolOptions(ctx.allowedTools, ctx.agents),
              ...resolveClaudeSdkPermissionOptions(),
              cwd: runtimeConfig.cwd,
              effort: ctx.effectiveEffort,
              env: sdkEnv,
              persistSession: !privateAnalysisContext,
              stderr: (data: string) => {
                console.warn(
                  `[ClaudeRuntime] SDK stderr [${sessionId}]: ${diagnosticLogIdentity(data.trimEnd())}`,
                );
              },
              ...(runtimeConfig.maxBudgetUsd ? { maxBudgetUsd: runtimeConfig.maxBudgetUsd } : {}),
              ...(ctx.agents ? { agents: ctx.agents } : {}),
            },
        }, {
            emitUpdate: (update) => this.emitUpdate(update),
            outputLanguage: outputLanguage,
          runtimePerformance,
          signal: executionLease.signal,
          recordSdkStartPhase: true,
          runtimeReceiptState: sdkRuntimeReceiptState,
          onAttempt: () => {
            assertAuthorized();
            flushPendingAnswer();
            attemptStreamOffset = getAccumulatedAnswer().length;
            acceptedRawBody = undefined;
            acceptedAttemptId = `${runId}:main:${++attemptNumber}`;
            acceptedTerminal = {status: 'unknown'};
            acceptedOrigin = 'assistant_stream';
            acquisition.open = true;
            mainAttemptWorkObserved = false;
            sdkSessionId = undefined;
          },
        });
      const unregisterSdkAbortHandle = this.registerAbortHandle(sessionId, { abort: closeSdk });

      // Safety timeout with stream cancellation via Promise.race.
      // Per-turn budget is env-configurable (CLAUDE_FULL_PER_TURN_MS, default 60s) so slower
      // LLMs (DeepSeek / Ollama / GLM) have room per turn without false timeouts.
      // Scrolling deep-drill (hypothesis + SQL + knowledge + conclusion) still needs ~6-8 min.
      const timeoutMs = Math.max(1, requestDeadline - Date.now());
      // Sub-agent timeout tracking — stop tasks that exceed subAgentTimeoutMs
      const activeSubAgentTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
      const subAgentTimeoutMs = runtimeConfig.subAgentTimeoutMs;

      // P2-1: Turn-level autonomy watchdog — detect repetitive tool failures
      // P1-G2: Per-tool tracking — each tool gets its own failure tracking
      const toolCallHistory: Array<{
        id?: string;
        name: string;
        success: boolean;
        /**
         * The call was refused by policy rather than broken. Still a failure
         * for the model to react to, but not evidence that anything is
         * malfunctioning.
         */
        policyRefusal?: boolean;
        completed?: boolean;
        startTime?: number;
        input?: unknown;
      }> = [];
      const dispatchedToolCallIds = new Set<string>();
      const MAX_TOOL_CALL_HISTORY = 100;
      const WATCHDOG_WINDOW = 3; // consecutive same-tool failures to trigger warning
      const watchdogFiredTools = new Set<string>(); // tracks which tools have triggered warnings

      // P0-G16: Circuit breaker — overall tool call failure rate monitoring
      let circuitBreakerFires = 0;
      const MAX_CIRCUIT_BREAKER_FIRES = 2;
      const CIRCUIT_BREAKER_WINDOW = 5;
      const CIRCUIT_BREAKER_THRESHOLD = 0.6; // 60% failure rate
      let lastCircuitBreakerFireIdx = -Infinity;

      // P1: Negative memory — collect failed approaches for cross-session learning
      /** Track whether SDK auto-compact has fired during this turn.
       *  When true, the SDK has summarized prior conversation history,
       *  potentially losing early-turn details. We log this for diagnostics. */
      sdkCompactDetected = false;

      // ── Per-turn metrics collection ──
      // Turn boundary: assistant message = start, next assistant message = end of previous turn.
      // Usage is attributed to the turn that triggered the API call.
      interface TurnMetrics {
        turnIndex: number;
        startMs: number;
        durationMs?: number;
        firstTokenLatencyMs?: number;
        toolCalls: string[];
        toolResultPayloadBytes: number;
        hasExtendedThinking: boolean;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      }
      const turnMetricsList: TurnMetrics[] = [];
      let currentTurnMetrics: TurnMetrics | null = null;
      let turnCounter = 0;
      let firstTokenReceived = false;

      function recordAuthoritativeEvaluationUsage(
        usage: Record<string, unknown> | undefined,
      ): void {
        if (usage) recordEvaluationTokenDeltaIfPresent(usage);
      }

      // Phase 3-3 of v2.1 (monitor-only): track when the running conversation
      // crosses the pre-rot threshold so prod can quantify how often we *would*
      // have benefited from an interrupt+resume cycle. The actual interrupt+
      // resume orchestration is intentionally not wired yet. Disable by setting
      // `CLAUDE_PRECOMPACT_WARN_ENABLED=false`.
      let preCompactWarned = false;
      const preCompactWarnEnabled = process.env.CLAUDE_PRECOMPACT_WARN_ENABLED !== 'false';

      function checkContextPressure(): void {
        if (!preCompactWarnEnabled || preCompactWarned) return;
        const cumulativeUncached = turnMetricsList.reduce((acc, t) => acc + (t.inputTokens ?? 0), 0);
        const cumulativeCacheCreation = turnMetricsList.reduce((acc, t) => acc + (t.cacheCreationTokens ?? 0), 0);
        const cumulativePayloadBytes = turnMetricsList.reduce((acc, t) => acc + t.toolResultPayloadBytes, 0);
        const decision = evaluateContextThreshold({
          uncachedInputTokens: cumulativeUncached,
          cacheCreationInputTokens: cumulativeCacheCreation,
          recentToolPayloadBytes: cumulativePayloadBytes,
        });
        if (decision.shouldPrecompact) {
          preCompactWarned = true;
          console.warn(
            `[ClaudeRuntime] Session ${sessionId}: pre-rot threshold crossed ` +
            `(pressure=${decision.pressureTokens} / ${decision.thresholdTokens} tokens, ratio=${decision.pressureRatio.toFixed(2)}). ` +
            `Phase 3-3 will eventually interrupt+resume here; for now we only log.`,
          );
        }
      }

      function findToolCallForResult(toolUseId?: string): typeof toolCallHistory[number] | undefined {
        if (toolUseId) return toolCallHistory.find(call => call.id === toolUseId);
        const pending = toolCallHistory.filter(call => !call.completed);
        return pending.length === 1 ? pending[0] : undefined;
      }

      function finalizeTurnMetrics(): void {
        if (currentTurnMetrics) {
          currentTurnMetrics.durationMs = Date.now() - currentTurnMetrics.startMs;
          turnMetricsList.push(currentTurnMetrics);
          checkContextPressure();
        }
      }

      const processStream = async () => {
        for await (const msg of stream) {
          executionLease.throwIfAborted();
          if (timedOut) break;
          providerIdleTimeout.reset();
          // Provider output, not bookkeeping, may extend a scene deadline that arrives mid-stream.
          if ((msg as any).type === 'stream_event' || (msg as any).type === 'assistant') deadline.recordOutput();
          if (interruptionRecoveryState) interruptionRecoveryState.streamStarted = true;
          mainAttemptWorkObserved ||= sdkAttemptHasObservedWork(msg);

          // Detect SDK auto-compact boundary — conversation history was summarized
          if ((msg as any).type === 'system' && (msg as any).subtype === 'compact_boundary') {
            sdkCompactDetected = true;
            console.warn(`[ClaudeRuntime] SDK auto-compact detected for session ${sessionId} — prior turns summarized`);
          }

          if (!privateAnalysisContext && msg.session_id && !sdkSessionId) {
            sdkSessionId = msg.session_id;
            this.rememberFullSdkSessionMapping(sessionId, traceId, ctx.sessionMapKey, sdkSessionId, options);
          }

          const sdkResultError = getSdkResultErrorMessage(msg);
          if (sdkResultError && !isSdkMaxTurnsSubtype((msg as any).subtype)) {
            sdkStreamErrorMessage = sdkResultError;
          }

          // Track sub-agent lifecycle for per-agent timeouts
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_started') {
            const taskId = (msg as any).task_id;
            if (taskId && subAgentTimeoutMs > 0) {
              const timer = setTimeout(() => {
                console.warn(`[ClaudeRuntime] Sub-agent timeout: stopping task ${taskId} after ${subAgentTimeoutMs / 1000}s`);
                activeSubAgentTimers.delete(taskId);
                if (typeof (stream as any).stopTask === 'function') {
                  (stream as any).stopTask(taskId).catch((err: Error) => {
                    console.warn(`[ClaudeRuntime] Failed to stop sub-agent task ${taskId}:`, diagnosticLogIdentity(err.message));
                  });
                }
                // P1-6: Record timeout as a finding so it's reflected in confidence
                allFindings.push([{
                  id: `sub-agent-timeout-${taskId}`,
                  title: localize(outputLanguage, '子代理超时', 'Sub-agent timeout'),
                  severity: 'medium' as const,
                  category: 'sub-agent',
                  description: localize(
                    outputLanguage,
                    `子代理 ${taskId} 超时 (${subAgentTimeoutMs / 1000}s)，分析可能不完整`,
                    `Sub-agent ${taskId} timed out (${subAgentTimeoutMs / 1000}s); the analysis may be incomplete`,
                  ),
                  confidence: 0.3,
                }]);
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'analyzing',
                    message: localize(
                      outputLanguage,
                      `子代理超时 (${subAgentTimeoutMs / 1000}s)，已停止`,
                      `Sub-agent timed out (${subAgentTimeoutMs / 1000}s) and was stopped`,
                    ),
                  },
                  timestamp: Date.now(),
                });
              }, subAgentTimeoutMs);
              activeSubAgentTimers.set(taskId, timer);
            }
          }
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_notification') {
            const taskId = (msg as any).task_id;
            if (taskId) {
              const timer = activeSubAgentTimers.get(taskId);
              if (timer) {
                clearTimeout(timer);
                activeSubAgentTimers.delete(taskId);
              }
            }
            // P1-5: Extract findings from sub-agent completion summaries.
            // Without this, sub-agent evidence is only in the conclusion text
            // and not merged into allFindings for confidence estimation.
            const summary = (msg as any).summary || '';
            const status = (msg as any).status || 'completed';
            if (status === 'completed' && summary) {
              allFindings.push(extractFindingsFromText(summary));
            }
          }

          // Bridge SDK messages to SSE events
          try {
            bridge(msg);
          } catch (bridgeErr) {
            console.warn('[ClaudeRuntime] SSE bridge error (non-fatal):', diagnosticLogIdentity((bridgeErr as Error).message));
          }

          if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
            const assistantText = (msg as any).message.content
              .map((block: any) => typeof block?.text === 'string' ? block.text : '')
              .filter(Boolean)
              .join('\n')
              .trim();
            if (assistantText) {
              runtimePerformance.recordFirstOutput();
            }
          }

          // ── Per-turn metrics: track stream_event signals ──
          if (msg.type === 'stream_event' && currentTurnMetrics) {
            const event = (msg as any).event;
            // First token latency
            if (!firstTokenReceived &&
                event?.type === 'content_block_delta' &&
                (event.delta?.type === 'text_delta' || event.delta?.type === 'tool_use')) {
              firstTokenReceived = true;
              currentTurnMetrics.firstTokenLatencyMs = Date.now() - currentTurnMetrics.startMs;
            }
            // Extended thinking detection
            if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
              currentTurnMetrics.hasExtendedThinking = true;
            }
          }

          // assistant message = new turn starts; finalize previous turn + watchdog tracking
          if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
            finalizeTurnMetrics();
            turnCounter++;
            observedTurns++;
            firstTokenReceived = false;
            const toolNames: string[] = [];
            for (const block of (msg as any).message.content) {
              if (block.type === 'tool_use') {
                if (typeof block.id === 'string' && block.id.trim() && block.id !== 'unknown') {
                  if (dispatchedToolCallIds.has(block.id)) continue;
                  dispatchedToolCallIds.add(block.id);
                }
                toolNames.push(block.name.replace(MCP_NAME_PREFIX, ''));
                // P2-1: Watchdog — track tool calls for repetitive failure detection
                toolCallHistory.push({
                  id: block.id,
                  name: block.name,
                  success: true,
                  startTime: Date.now(),
                  input: block.input,
                });
                if (toolCallHistory.length > MAX_TOOL_CALL_HISTORY) {
                  toolCallHistory.shift();
                  if (Number.isFinite(lastCircuitBreakerFireIdx)) {
                    lastCircuitBreakerFireIdx--;
                  }
                }
              }
            }
            currentTurnMetrics = {
              turnIndex: turnCounter,
              startMs: Date.now(),
              toolCalls: toolNames,
              toolResultPayloadBytes: 0,
              hasExtendedThinking: false,
            };
          }

          if (msg.type === 'user' && ((msg as any).tool_use_result !== undefined || extractSdkToolResultBlocks(msg).length > 0)) {
            const resultBlocks = extractSdkToolResultBlocks(msg);
            const observedResults = resultBlocks.length > 0
              ? resultBlocks
              : [{ result: (msg as any).tool_use_result, isError: undefined, toolUseId: undefined }];

            for (const observed of observedResults) {
              const resultStr = stringifySdkToolResult(observed.result);
              // Per-turn metrics: track tool result payload size
              if (currentTurnMetrics) {
                currentTurnMetrics.toolResultPayloadBytes += Buffer.byteLength(resultStr, 'utf-8');
              }
              const isFailed = isSdkToolResultFailure(observed.result, observed.isError);
              const refusedByPolicy = isFailed && isPolicyRefusalResult(observed.result);
              const matchedTool = findToolCallForResult(observed.toolUseId);
              if (!matchedTool || matchedTool.completed) continue;
              if (matchedTool) {
                matchedTool.success = !isFailed;
                matchedTool.policyRefusal = refusedByPolicy;
                matchedTool.completed = true;
                // Record tool execution in metrics collector (stream-observed timing)
                const toolName = matchedTool.name.replace(MCP_NAME_PREFIX, '');
                const durationMs = matchedTool.startTime ? Date.now() - matchedTool.startTime : 0;
                metricsCollector.recordToolFromStream(toolName, durationMs, !isFailed);
              }
              // Check for consecutive same-tool failures (P1-G2: per-tool tracking)
              if (toolCallHistory.length >= WATCHDOG_WINDOW) {
                const recent = toolCallHistory.slice(-WATCHDOG_WINDOW);
                const allSameTool = recent.every(t => t.name === recent[0].name);
                const allFailed = recent.every(t => !t.success);
                const toolName = recent[0].name.replace(MCP_NAME_PREFIX, '');
                if (allSameTool && allFailed && !watchdogFiredTools.has(toolName)) {
                  watchdogFiredTools.add(toolName);
                  console.warn(`[ClaudeRuntime] Watchdog: ${WATCHDOG_WINDOW} consecutive failures for ${toolName}`);
                  // A refused call already says what to do instead; switching queries cannot satisfy it,
                  // and it is not a failed approach worth remembering.
                  const refused = recent.every(t => t.policyRefusal);
                  // P1-2: Inject warning into next MCP tool result (Claude reads this).
                  ctx.watchdogWarning.current = refused
                    ? localize(
                      outputLanguage,
                      `${toolName} 已连续 ${WATCHDOG_WINDOW} 次被拒绝。请按返回结果中的 action_required 和诊断处理，不要重复同样的调用。`,
                      `${toolName} was refused ${WATCHDOG_WINDOW} times in a row. Follow the returned action_required and diagnostics instead of repeating the same call.`,
                    )
                    : localize(
                      outputLanguage,
                      `${toolName} 已连续失败 ${WATCHDOG_WINDOW} 次。请切换分析策略：尝试不同的 SQL 查询、使用其他 skill、或调整参数。不要重复相同的失败操作。`,
                      `${toolName} has failed ${WATCHDOG_WINDOW} times in a row. Switch analysis strategy: try a different SQL query, use another skill, or adjust parameters. Do not repeat the same failed action.`,
                    );
                  // P1: Record for negative memory
                  if (!refused) failedApproaches.push({
                    type: 'tool_failure',
                    approach: `连续调用 ${toolName} ${WATCHDOG_WINDOW} 次均失败`,
                    reason: '同一工具重复失败，需要切换策略',
                  });
                  this.emitUpdate({
                    type: 'progress',
                    content: {
                      phase: 'analyzing',
                      message: refused
                        ? localize(outputLanguage, `⚠ ${toolName} 连续 ${WATCHDOG_WINDOW} 次被拒绝，已提示按拒绝原因处理`,
                          `⚠ ${toolName} was refused ${WATCHDOG_WINDOW} times in a row; pointed the model at the refusal reason`)
                        : localize(
                          outputLanguage,
                          `⚠ 检测到 ${toolName} 连续 ${WATCHDOG_WINDOW} 次失败，已注入策略切换指令`,
                          `⚠ Detected ${WATCHDOG_WINDOW} consecutive failures for ${toolName}; injected a strategy-switch instruction`,
                        ),
                    },
                    timestamp: Date.now(),
                  });
                }
              }
              // Track tool call for plan adherence with phase matching (P0-1 + P1-1)
              // P1-G5: Best-fit phase-tool matching — search all eligible phases, not just first
              if (matchedTool) {
                const codeReferences = extractSourceLookupCodeReferences(
                  matchedTool.name,
                  observed.result,
                );
                recordPlanOrPrePlanToolCall(ctx.analysisPlan, {
                  toolName: matchedTool.name,
                  toolCallId: matchedTool.id,
                  onPhaseAutoCompleted: phase => this.emitUpdate({
                    type: 'plan_phase_updated',
                    content: planPhaseUpdatedContent({phaseId: phase.id, phaseName: phase.name, status: 'completed', summary: phase.summary, origin: 'auto'}),
                    timestamp: Date.now(),
                  }),
                  input: matchedTool.input,
                  returnedCodeReferences: codeReferences.length > 0,
                  returnedCodeReferenceHints: codeReferences,
                  // Read before truncation: planPhaseId and success sit after
                  // the body, so the projected/truncated text loses both.
                  resultFacts: {...readToolResultFacts(observed.result), ...(observed.isError === true ? {success: false} : {})},
                  resultText: projectClaudeToolResultForPlan(matchedTool.name, observed.result),
                });
              }

              // P0-G16: Circuit breaker — overall failure rate monitoring
              // Unlike watchdog (same-tool consecutive failures), this monitors aggregate health.
              // Fires when >60% of recent tool calls fail, regardless of which tools.
              // P1-G9: Circuit breaker can fire even with pending watchdog warning
              // (CB is higher priority — its "simplify scope" message overwrites per-tool warnings)
              if (circuitBreakerFires < MAX_CIRCUIT_BREAKER_FIRES
                  && toolCallHistory.length >= CIRCUIT_BREAKER_WINDOW
                  && toolCallHistory.length - lastCircuitBreakerFireIdx >= 3) {
                const recentWindow = toolCallHistory.slice(-CIRCUIT_BREAKER_WINDOW);
                // Policy refusals are excluded: this breaker asks "is anything
                // broken", and its remedy is to tell the model to simplify its
                // scope. Counting the system's own refusals here shrank the
                // model's room on the strength of decisions the system made.
                // The watchdog still sees them, because repeatedly retrying a
                // refused call is a loop worth interrupting.
                const recentWindow2 = recentWindow.filter(t => t.policyRefusal !== true);
                const failCount = recentWindow2.filter(t => !t.success).length;
                const failRate = recentWindow2.length > 0
                  ? failCount / recentWindow2.length
                  : 0;
                if (failRate >= CIRCUIT_BREAKER_THRESHOLD) {
                  circuitBreakerFires++;
                  lastCircuitBreakerFireIdx = toolCallHistory.length;
                  ctx.watchdogWarning.current = localize(
                    outputLanguage,
                    `⚠️ 分析断路器触发：最近 ${CIRCUIT_BREAKER_WINDOW} 次工具调用中 ${failCount} 次失败 (${(failRate * 100).toFixed(0)}%)。` +
                      '请：1) 简化分析范围，2) 使用更基础的查询，3) 如果数据不可用则基于已有证据出结论。不要继续尝试失败的操作。',
                    `⚠️ Analysis circuit breaker triggered: ${failCount} of the last ${CIRCUIT_BREAKER_WINDOW} tool calls failed (${(failRate * 100).toFixed(0)}%). ` +
                      'Simplify the scope, use more basic queries, and conclude from existing evidence if data is unavailable. Do not keep retrying failed actions.',
                  );
                  failedApproaches.push({
                    type: 'strategy_failure',
                    approach: `整体工具调用失败率过高 (${(failRate * 100).toFixed(0)}%)`,
                    reason: `最近 ${CIRCUIT_BREAKER_WINDOW} 次调用中 ${failCount} 次失败`,
                  });
                  this.emitUpdate({
                    type: 'progress',
                    content: {
                      phase: 'analyzing',
                      message: localize(
                        outputLanguage,
                        `⚠ 分析断路器触发：工具调用失败率 ${(failRate * 100).toFixed(0)}%，建议简化分析范围`,
                        `⚠ Analysis circuit breaker triggered: tool failure rate ${(failRate * 100).toFixed(0)}%; simplify the analysis scope`,
                      ),
                    },
                    timestamp: Date.now(),
                  });
                }
              }
            }
          }

          // Per-turn metrics: capture usage from stream_event message_delta (per API turn)
          if (msg.type === 'stream_event' && currentTurnMetrics) {
            const event = (msg as any).event;
            if (event?.type === 'message_delta' && event.usage) {
              currentTurnMetrics.outputTokens = event.usage.output_tokens;
            }
            if (event?.type === 'message_start' && event.message?.usage) {
              currentTurnMetrics.inputTokens = event.message.usage.input_tokens;
              currentTurnMetrics.cacheReadTokens = event.message.usage.cache_read_input_tokens;
              currentTurnMetrics.cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
            }
          }

          if (msg.type === 'result') {
            acquisition.open = false;
            // Finalize last turn metrics before stream ends
            finalizeTurnMetrics();
            currentTurnMetrics = null;

            const resultSubtype = (msg as any).subtype;
            const reportedCost = (msg as any).total_cost_usd;
            if (typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0) {
              mainCostUsd = reportedCost;
            }
            const reportedTurns = (msg as any).num_turns;
            if (typeof reportedTurns === 'number' && Number.isSafeInteger(reportedTurns) && reportedTurns >= 0) {
              rounds = reportedTurns;
            } else if (isSdkMaxTurnsSubtype(resultSubtype)) {
              rounds = turnBudget.acquisitionTurns;
            }
            acceptedTerminal = claudeTerminalState(msg);
            if (resultSubtype === 'success' && typeof (msg as any).result === 'string') {
              finalResult = (msg as any).result;
              acceptedRawBody = finalResult?.trim();
              acceptedOrigin = 'sdk_final';
            } else if (isSdkMaxTurnsSubtype(resultSubtype)) {
              terminationReason = MAX_TURNS_TERMINATION_REASON;
              terminationMessage = buildMaxTurnsTerminationMessage({
                mode: turnPolicy.budgetMode === 'quick' ? 'fast' : 'full',
                turns: rounds,
                maxTurns: runtimeConfig.maxTurns,
                outputLanguage: runtimeConfig.outputLanguage,
              });
            }
            // Record SDK token usage and prompt cache metrics
            metricsCollector.recordSdkUsage({
              usage: (msg as any).usage,
              modelUsage: (msg as any).modelUsage,
              total_cost_usd: (msg as any).total_cost_usd,
            });
            recordAuthoritativeEvaluationUsage((msg as any).usage);
            break;
          }
        }
        // Clean up any remaining sub-agent timers
        for (const timer of activeSubAgentTimers.values()) clearTimeout(timer);
        activeSubAgentTimers.clear();

        // Log per-turn metrics for performance analysis
        if (turnMetricsList.length > 0) {
          const summary = {
            totalTurns: turnMetricsList.length,
            totalDurationMs: turnMetricsList.reduce((s, t) => s + (t.durationMs || 0), 0),
            totalToolCalls: turnMetricsList.reduce((s, t) => s + t.toolCalls.length, 0),
            totalPayloadBytes: turnMetricsList.reduce((s, t) => s + t.toolResultPayloadBytes, 0),
            turns: turnMetricsList.map(t => ({
              turn: t.turnIndex,
              durationMs: t.durationMs,
              firstTokenMs: t.firstTokenLatencyMs,
              tools: t.toolCalls,
              payloadBytes: t.toolResultPayloadBytes,
              thinking: t.hasExtendedThinking,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              cacheReadTokens: t.cacheReadTokens,
              cacheCreationTokens: t.cacheCreationTokens,
            })),
          };
          console.log(`[ClaudeRuntime] Turn metrics [${sessionId}]:`, JSON.stringify(summary));
          metricsCollector.recordTurnMetrics(summary);
        }
      };

      const providerIdleTimeout = createResettableRuntimeTimeout({
        timeoutMs: runtimeConfig.streamIdleTimeoutMs,
        message: `Claude provider stream idle timeout after ${runtimeConfig.streamIdleTimeoutMs}ms`,
        onTimeout: () => {
          timedOut = true;
          timeoutState.kind = 'stream_idle';
          closeSdk();
        },
      });
      const onRequestTimeout = () => {
        timedOut = true;
        timeoutState.kind = 'request';
        // Forcefully terminate the SDK subprocess — without this, queued
        // MCP tool calls (e.g. execute_sql) keep executing in the background
        // after the session logger has closed, producing orphan SQL errors.
        closeSdk();
      };
      // The deadline follows returned tool results and streaming output where it may extend.
      const requestTimeout = createDeadlineRuntimeTimeout({
        deadlineAt: deadline.current,
        tryExtend: deadline.extendIfStreaming,
        message: now => `Analysis safety timeout after ${Math.round((now - deadline.startedAt) / 1000)}s`,
        onTimeout: onRequestTimeout,
      });

      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(executionLease.signal.reason ?? new Error('Claude run cancelled'));
        executionLease.signal.addEventListener('abort', onAbort, {once: true});
        if (executionLease.signal.aborted) onAbort();
      });
      try {
        await Promise.race([processStream(), requestTimeout.promise, providerIdleTimeout.promise, abortPromise]);
      } catch (err) {
        if (timedOut) {
          console.error('[ClaudeRuntime] Analysis safety timeout reached — SDK subprocess has been closed');
          this.emitUpdate({
            type: 'progress',
            content: {
              phase: 'concluding',
              message: localize(
                outputLanguage,
                '分析超时，正在保留已收到的部分输出。',
                'Analysis timed out. Preserving the output received so far.',
              ),
            },
            timestamp: Date.now(),
          });
        } else {
          throw err;
        }
      } finally {
        if (onAbort) executionLease.signal.removeEventListener('abort', onAbort);
        requestTimeout.clear();
        providerIdleTimeout.clear();
        for (const timer of activeSubAgentTimers.values()) clearTimeout(timer);
        activeSubAgentTimers.clear();
        closeSdk();
        unregisterSdkAbortHandle();
      }

      if (timedOut) {
        terminationReason = 'timeout';
        acceptedTerminal = {status: 'incomplete', reason: 'timeout'};
        const elapsedSeconds = Math.round((Date.now() - deadline.startedAt) / 1000);
        terminationMessage = isStreamIdleTimeout()
          ? localize(
            outputLanguage,
            `AI provider 连续 ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} 秒没有流事件，已取消并保留部分结果。`,
            `The AI provider emitted no stream events for ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} seconds; the run was cancelled and partial results were preserved.`,
          )
          : extensible
            ? localize(
              outputLanguage,
              `场景还原在 ${elapsedSeconds} 秒后没有新的工具进展，已取消并保留部分结果。`,
              `Scene reconstruction made no further tool progress after ${elapsedSeconds} seconds; the run was cancelled and partial results were preserved.`,
            )
            : localize(
              outputLanguage,
              `完整分析超过 ${Math.round(timeoutMs / 1000)} 秒硬上限，已取消并保留部分结果。`,
              `Full analysis exceeded the ${Math.round(timeoutMs / 1000)} second hard limit; the run was cancelled and partial results were preserved.`,
            );
        flushPendingAnswer();
        this.emitUpdate({type: 'degraded', content: {
          module: 'claudeRuntime', fallback: 'partial_result_after_timeout',
          message: terminationMessage, partial: true, terminationReason: 'timeout',
          timeoutKind: timeoutState.kind, turns: observedRunTurns(), maxTurns: runtimeConfig.maxTurns,
        }, timestamp: Date.now()});
      }

      if (sdkStreamErrorMessage && !timedOut) {
        throw new Error(sdkStreamErrorMessage);
      }
      }

      acquisition.open = false;
      executionLease.throwIfAborted();
      flushPendingAnswer();
      conclusionText = chooseClaudeConclusionText({finalResult, accumulatedAnswer: getAttemptAnswer()});
      const remainingBudgetUsd = runtimeConfig.maxBudgetUsd === undefined ? undefined
        : mainCostUsd === undefined ? 0 : runtimeConfig.maxBudgetUsd - mainCostUsd;
      if (acceptedTerminal.reason === 'turn_limit' && turnBudget.deliveryTurns > 0 &&
          (remainingBudgetUsd === undefined || remainingBudgetUsd > 0) &&
          observedRunTurns() < turnBudget.totalTurns && Date.now() < requestDeadline) {
        const prompt = closeoutTape.buildPrompt({query, outputLanguage,
          priorConclusion: sanitizeOwnerCodeAwareStructuredTextWithReceipt(sessionId, conclusionText).text});
        if (prompt) {
          // This is the reserved delivery attempt, including failed dispatches.
          rounds = observedRunTurns() + 1;
          let directory: string | undefined;
          try {
            directory = await fs.promises.mkdtemp(path.join(tmpdir(), 'smartperfetto-claude-closeout-'));
            assertAuthorized();
            closeoutDeadlineAt = deadline.deliveryReserveMs > 0 ? Date.now() + deadline.deliveryWindowMs() : undefined;
            const summary = await runClaudeIntentTransport({
              prompt, systemPrompt: ctx.systemPrompt, signal: executionLease.signal,
              deadlineMs: closeoutDeadlineAt ?? requestDeadline, outputByteLimit: 128 * 1024,
              config: {lightModel: runtimeConfig.model, cwd: directory},
              sdkEnv: finalizationEnv, sdkBinaryOptions: finalizationBinaryOptions,
              loadSdk: async () => ({query: input => {
                assertAuthorized();
                return sdkQuery({...input, options: {
                  ...input.options, ...(remainingBudgetUsd === undefined ? {} : {maxBudgetUsd: remainingBudgetUsd}),
                }});
              }}),
            });
            assertAuthorized();
            if (summary.status === 'ok' && summary.text.trim()) {
              conclusionText = summary.text.trim();
              acceptedAttemptId = `${runId}:turn-closeout:1`;
              acceptedOrigin = 'sdk_final';
              // Acquiring evidence stopped at the cap even when delivery succeeds.
              acceptedTerminal = {status: 'incomplete', reason: 'turn_limit',
                ...(summary.finishReason ? {sdkFinishReason: summary.finishReason} : {})};
            }
          } catch {
            executionLease.throwIfAborted();
            // Failed delivery retains the original answer and the cap receipt.
          } finally {
            if (directory) await fs.promises.rm(directory, {recursive: true, force: true}).catch(() => undefined);
          }
        }
      }
      if (acceptedTerminal.reason === 'turn_limit') {
        terminationMessage = buildMaxTurnsTerminationMessage({mode: turnPolicy.budgetMode === 'quick' ? 'fast' : 'full',
          turns: observedRunTurns(), maxTurns: runtimeConfig.maxTurns, outputLanguage});
      }
      if (!hasAcceptedSdkFinal() && acceptedTerminal.status === 'completed') {
        acceptedTerminal = {status: 'unknown'};
      }
      let projectedCandidate = projectAcceptedCandidate(conclusionText);
      conclusionText = projectedCandidate.result.conclusion;
      let mergedFindings = projectedCandidate.result.findings;

      // Log compaction for diagnostics — helps debug cases where Claude seems to lose context
      if (sdkCompactDetected) {
        console.warn(`[ClaudeRuntime] Session ${sessionId}: analysis completed after SDK auto-compact. Findings count: ${mergedFindings.length}`);
        // P1-C1: Write a structured compact recovery note so the next turn's system prompt
        // carries plan progress + findings + entity context that may have been lost.
        // Phase 3-2: also preserves the last N raw tool calls as structured digests
        // so the post-compact agent knows what it was just doing.
        const sessionNotes = this.sessionNotes.get(sessionId);
        if (sessionNotes) {
          const note = buildRecoveryNote({
            plan: ctx.analysisPlan.current ?? undefined,
            findings: mergedFindings,
            recentToolCalls: ctx.analysisPlan.current?.toolCallLog ?? [],
            entitySnapshot: this.buildEntityContext(ctx.entityStore),
          });

          sessionNotes.push({
            section: 'next_step',
            content: note.text,
            priority: 'high',
            timestamp: Date.now(),
          });
          if (sessionNotes.length > 20) sessionNotes.shift();

          console.log(`[ClaudeRuntime] Compact recovery note: ${note.sectionsIncluded.length} sections, ${note.usedChars} chars (${note.sectionsIncluded.join('/')})`);
        }
      }

      let verificationDegradedMessage: string | undefined;
      // Both budgets verify submitted plans and actual evidence. Semantic final
      // coverage is owned by the shared async finalizer, not this runtime loop.
      try {
        const verification = await verifyConclusion(mergedFindings, conclusionText, {
          emitUpdate: update => this.emitUpdate(update), enableLLM: false,
          plan: ctx.analysisPlan.current, hypotheses: ctx.hypotheses, sceneType,
          lightModel: runtimeConfig.lightModel, verifierTimeoutMs: runtimeConfig.verifierTimeoutMs,
          providerId: options.providerId, providerScope, outputLanguage, query,
          allowPersistentLearning: !privateAnalysisContext,
          deliveryContext: projectedCandidate.deliveryContext,
        });
        executionLease.throwIfAborted();
        const issues = [...verification.heuristicIssues, ...(verification.llmIssues ?? [])]
          .filter(issue => issue.severity === 'error' && issue.recoveryKind !== undefined);
        const remainingTurns = runtimeConfig.maxTurns - observedRunTurns();
        const nativeCandidate = acceptedRawBody ?? conclusionText;
        const declarationNeed = requestNativeDeclarationCompletion({
          intent: turnIntent,
          completion: projectedCandidate.deliveryContext.completion ?? {status: 'unknown'},
          candidate: nativeCandidate,
          remainingDeliveryTurns: remainingTurns > 0 ? turnBudget.deliveryTurns : 0,
          repairInvalid: true,
        });
        const declarationRequest = declarationNeed &&
          nativeDeclarationBodyCanFitOutput(nativeCandidate, 128 * 1024) &&
          (remainingBudgetUsd === undefined || remainingBudgetUsd > 0) ? declarationNeed : undefined;
        // Which gate closed is otherwise unrecoverable after the run: the candidate
        // carrying the declaration is private and never persisted.
        if (!declarationRequest) {
          console.log(`[ClaudeRuntime] declaration repair skipped: need=${declarationNeed?.reason ?? 'none'} ` +
            `completion=${projectedCandidate.deliveryContext.completion?.status ?? 'unknown'} turns=${remainingTurns} ` +
            `fits=${nativeDeclarationBodyCanFitOutput(nativeCandidate, 128 * 1024)} ` +
            `budget=${remainingBudgetUsd === undefined ? 'unbounded' : remainingBudgetUsd > 0 ? 'available' : 'exhausted'}`);
        }
        // A repair that cannot run leaves the issue-based correction available, as before repairs existed.
        const correctionNeeded = declarationRequest !== undefined ||
          (declarationNeed === undefined || declarationNeed.reason === INVALID_NATIVE_DECLARATION) && issues.length > 0;
        if (correctionNeeded &&
            projectedCandidate.deliveryContext.completion?.status === 'completed' &&
            remainingTurns > 0 && Date.now() < requestDeadline) {
          assertAuthorized();
          const correctionAttemptId = `${runId}:correction:1`;
          const {stream, close} = sdkQueryWithRetry({
            prompt: declarationRequest
              ? buildNativeDeclarationCompletionPrompt({request: declarationRequest, intent: turnIntent, outputLanguage})
              : generateCorrectionPrompt(issues, conclusionText, outputLanguage, sceneType),
            options: {
              model: runtimeConfig.model, maxTurns: 1, systemPrompt: ctx.sdkSystemPrompt,
              includePartialMessages: true, settingSources: [], tools: [], allowedTools: [],
              mcpServers: {}, strictMcpConfig: true, persistSession: false,
              ...resolveClaudeSdkPermissionOptions(), cwd: runtimeConfig.cwd,
              ...(declarationRequest && remainingBudgetUsd !== undefined ? {maxBudgetUsd: remainingBudgetUsd} : {}),
              effort: ctx.effectiveEffort, env: sdkEnv,
            },
          }, {maxRetries: 0, signal: executionLease.signal, runtimePerformance});
          const unregister = this.registerAbortHandle(sessionId, {abort: close});
          const turnsBeforeCorrection = observedRunTurns();
          let correctionWorkObserved = false;
          let correctionReportedTurns = 0;
          let correctionActive = true;
          let correctionTimedOut = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<void>(resolve => {
            timeout = setTimeout(() => {correctionTimedOut = true; close(); resolve();},
              Math.max(1, Math.min(TEXT_ONLY_CORRECTION_TIMEOUT_MS, requestDeadline - Date.now())));
          });
          let onCorrectionAbort: (() => void) | undefined;
          const abortPromise = new Promise<never>((_, reject) => {
            onCorrectionAbort = () => reject(executionLease.signal.reason ?? new Error('Claude correction cancelled'));
            executionLease.signal.addEventListener('abort', onCorrectionAbort, {once: true});
            if (executionLease.signal.aborted) onCorrectionAbort();
          });
          const collectCorrection = async () => {
            for await (const message of stream) {
              if (!correctionActive || correctionTimedOut) return;
              executionLease.throwIfAborted();
              correctionWorkObserved ||= sdkAttemptHasObservedWork(message);
              if (message.type !== 'result') continue;
              const terminal = claudeTerminalState(message);
              const reportedTurns = (message as any).num_turns;
              if (typeof reportedTurns === 'number' && Number.isFinite(reportedTurns) && reportedTurns >= 0) {
                correctionReportedTurns = reportedTurns;
              }
              if (terminal.status === 'completed' && typeof (message as any).result === 'string' &&
                  (message as any).result.trim()) {
                const candidateText = (message as any).result as string;
                assertAuthorized();
                if (declarationRequest && !acceptNativeDeclarationCompletion({
                  request: declarationRequest, completion: terminal, candidate: candidateText,
                  outputByteLimit: 128 * 1024,
                })) return;
                conclusionText = candidateText.trim();
                acceptedAttemptId = correctionAttemptId;
                acceptedTerminal = terminal;
                acceptedOrigin = 'sdk_final';
                projectedCandidate = projectAcceptedCandidate(conclusionText);
                conclusionText = projectedCandidate.result.conclusion;
                mergedFindings = projectedCandidate.result.findings;
              }
              return;
            }
          };
          try {
            await Promise.race([collectCorrection(), timeoutPromise, abortPromise]);
          } finally {
            correctionActive = false;
            rounds = turnsBeforeCorrection + Math.max(correctionReportedTurns, correctionWorkObserved ? 1 : 0);
            if (onCorrectionAbort) executionLease.signal.removeEventListener('abort', onCorrectionAbort);
            if (timeout) clearTimeout(timeout);
            close(); unregister();
          }
        }
      } catch (error) {
        executionLease.throwIfAborted();
        verificationDegradedMessage = error instanceof Error ? error.message : 'Verification unavailable';
      }
      const finalAnalysisResult = projectedCandidate.result;
      const deliveryContext = projectedCandidate.deliveryContext;
      const isRuntimePartialResult = finalAnalysisResult.partial === true ||
        deliveryContext.completion?.status !== 'completed';
      if (acceptedTerminal.reason === 'provider_error') terminationReason = 'execution_error';
      if (acceptedTerminal.reason === 'budget_limit') terminationReason = 'max_budget_usd';
      if (verificationDegradedMessage) terminationMessage = verificationDegradedMessage;
      const baseConfidence = estimateAnalysisConfidence({findings: finalAnalysisResult.findings});
      finalAnalysisResult.confidence = isRuntimePartialResult
        ? capPartialConfidence(baseConfidence, finalAnalysisResult.findings.length > 0) : baseConfidence;
      finalAnalysisResult.rounds = observedRunTurns();
      finalAnalysisResult.totalDurationMs = Date.now() - startTime;
      finalAnalysisResult.partial = isRuntimePartialResult || undefined;
      finalAnalysisResult.terminationReason ??= terminationReason;
      finalAnalysisResult.terminationMessage ??= terminationMessage === undefined ? undefined
        : sanitizeOwnerCodeAwareStructuredTextWithReceipt(sessionId, terminationMessage).text;
      attachQuickReceipt(finalAnalysisResult);
      // This is the final accepted projection. A shared finalization context can
      // be attached here once, using deliveryContext rather than the native one.
      const gateIssue = applyFinalResultQualityGate({
        result: finalAnalysisResult, query, sceneType, deferFocusedEvidenceFinalization: true,
        context: deliveryContext,
      });
      if (gateIssue) {
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: gateIssue.code,
            message: gateIssue.message,
            partial: true,
          },
          timestamp: Date.now(),
        });
      }

      executionLease.throwIfAborted();
      ctx.sessionContext.addTurn(
        query,
        {
          primaryGoal: query,
          aspects: [],
          expectedOutputType: 'diagnosis',
          complexity: 'complex',
          followUpType: ctx.previousTurns.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: 'claude-agent',
          success: finalAnalysisResult.success,
          findings: finalAnalysisResult.findings,
          confidence: finalAnalysisResult.confidence,
          message: finalAnalysisResult.conclusion,
          partial: finalAnalysisResult.partial,
          completion: finalAnalysisResult.completion,
          conclusionContract: finalAnalysisResult.conclusionContract,
          sourceDerived: privateAnalysisContext || undefined,
          analysisContextFingerprint: options.analysisContextFingerprint,
          terminationReason: finalAnalysisResult.terminationReason,
          terminationMessage: finalAnalysisResult.terminationMessage,
        },
        finalAnalysisResult.findings,
      );

      if (finalAnalysisResult.partial !== true) {
        ctx.sessionContext.updateWorkingMemoryFromConclusion({
          turnIndex: ctx.previousTurns.length,
          query,
          conclusion: finalAnalysisResult.conclusion,
          confidence: finalAnalysisResult.confidence,
        });
      }

      // Captured run features remain available for observed failure diagnostics.
      const fullFeatures = extractTraceFeatures({
        architectureType: ctx.architecture?.type,
        sceneType,
        packageName: options.packageName,
        findingTitles: finalAnalysisResult.findings.map(f => f.title),
        findingCategories: finalAnalysisResult.findings.map(f => f.category).filter(Boolean) as string[],
      });
      // Derive sql_error FailedApproach entries from persistent SQL errors
      // (errors that were never auto-fixed during the session — still in the array)
      const persistentSqlErrors = this.sessionSqlErrors.get(sessionId)?.filter(
        (e: any) => !e.fixedSql && e.errorMessage,
      ) || [];
      for (const sqlErr of persistentSqlErrors.slice(-3)) { // cap at 3 to avoid noise
        failedApproaches.push({
          type: 'sql_error',
          approach: sqlErr.errorSql?.substring(0, 150) || 'unknown SQL',
          reason: sqlErr.errorMessage?.substring(0, 150) || 'SQL query error',
        });
      }

      // P1: Save negative patterns to long-term memory (fire-and-forget)
      if (
        !analysisContextUsesPrivateKnowledge(options) &&
        failedApproaches.length > 0 &&
        fullFeatures.length > 0
      ) {
        saveNegativePattern(fullFeatures, failedApproaches, sceneType, ctx.architecture?.type, {
          knowledgeScope: knowledgeScopeFromAnalysisOptions(options),
        })
          .catch(err => console.warn('[ClaudeRuntime] Negative pattern save failed:', diagnosticLogIdentity((err as Error).message)));
      }

      attachAcceptedFinalization(finalAnalysisResult, deliveryContext, !executionLease.signal.aborted, projectedCandidate.protocolProjection);
      return finalAnalysisResult;
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(
        error,
        executionLease.signal,
      );
      const rawErrorMessage = (error as Error).message || 'Unknown error';
      const errMsg = explainClaudeRuntimeError(
        rawErrorMessage,
        outputLanguage,
        getCredentialSourceHint(options.providerId, providerScopeFromAnalysisOptions(options)),
      );
      const quotaExceeded = isClaudeQuotaError(rawErrorMessage);
      console.error('[ClaudeRuntime] Analysis failed:', diagnosticLogIdentity(rawErrorMessage));

      interruptionRecoveryState?.flushPendingAnswer();
      const body = acceptedRawBody ?? interruptionRecoveryState?.getAccumulatedAnswer().trim() ?? '';
      if (acceptedRawBody === undefined) acceptedOrigin = body ? 'assistant_stream' : 'runtime_fallback';
      acceptedTerminal = executionLease.signal.aborted
        ? {status: 'cancelled', reason: 'cancelled'}
        : acceptedTerminal.status === 'incomplete' ? acceptedTerminal
          : {status: 'failed', reason: quotaExceeded ? 'budget_limit' : 'provider_error'};
      const safeErrorMessage = sanitizeOwnerCodeAwareStructuredTextWithReceipt(sessionId, errMsg).text;
      this.emitUpdate({type: 'error', content: {message: safeErrorMessage}, timestamp: Date.now()});
      const failedProjection = projectAcceptedCandidate(body, true);
      const failedResult = failedProjection.result;
      failedResult.terminationReason = acceptedTerminal.reason === 'timeout' ? 'timeout'
        : acceptedTerminal.reason === 'budget_limit' ? 'max_budget_usd' : 'execution_error';
      // Project diagnostics through the same current guard without assigning
      // their receipt to the conclusion candidate.
      failedResult.terminationMessage = safeErrorMessage;
      attachQuickReceipt(failedResult);
      applyFinalResultQualityGate({result: failedResult, query,
        sceneType: turnIntent?.sceneId, context: failedProjection.deliveryContext,
        deferFocusedEvidenceFinalization: true});
      attachAcceptedFinalization(failedResult, failedProjection.deliveryContext, false, failedProjection.protocolProjection);
      return failedResult;
    } finally {
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      runActivity.active = false;
      try {
        interruptionRecoveryState?.dispose();
        this.activeAnalyses.delete(sessionId);
        runSnapshots.release(sessionId);
        executionLease.settle();
        // Notes persistence now handled by unified SessionStateSnapshot in the route layer.
        // No separate disk I/O needed here.

        // Persist session metrics (fire-and-forget, non-blocking)
        try {
          metricsCollector.recordTurn();
          persistSessionMetrics(metricsCollector.summarize(), analysisContextUsesPrivateKnowledge(options));
        } catch (metricsErr) {
          console.warn('[ClaudeRuntime] Failed to persist metrics:', (metricsErr as Error).message);
        }
      } finally {
        finalizationPhase.end(runtimePerformanceOutcome);
        runtimePerformance.finalize(runtimePerformanceOutcome);
      }
    }
  }

  removeSession(sessionId: string): void {
    // Cancel any pending debounced save to prevent stale write after sync save
    const pendingTimer = saveTimers.get(this.sessionMap);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      saveTimers.delete(this.sessionMap);
    }
    this.removeSessionMapEntries(sessionId);
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionSqlErrors.delete(sessionId);
    this.sessionSqlErrorPartitions.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.activeAnalyses.delete(sessionId);
    if (enterpriseSessionMapDbWritesEnabled()) {
      try {
        deleteClaudeSessionMapRuntimeSnapshots(sessionId);
      } catch (err) {
        console.warn('[ClaudeRuntime] Failed to delete runtime_snapshots session map:', diagnosticLogIdentity((err as Error).message));
      }
    }
    if (legacySessionMapWritesEnabled()) {
      // Use immediate save — session is being removed, must persist before cleanup completes
      savePersistedSessionMapSync(this.sessionMap);
    }
  }

  /** Clean up all session-scoped state for a given session. */
  cleanupSession(sessionId: string): void {
    this.abortSession(sessionId);
    this.removeSession(sessionId);
  }

  abortSession(sessionId: string): void {
    void this.executionGuard.abortSession(sessionId);
    const handles = this.activeAbortHandles.get(sessionId);
    if (!handles) return;
    for (const handle of Array.from(handles)) {
      try {
        handle.abort();
      } catch (error) {
        console.warn('[ClaudeRuntime] Failed to abort SDK handle:', diagnosticLogIdentity((error as Error).message));
      }
    }
  }

  private registerAbortHandle(sessionId: string, handle: RuntimeAbortHandle): () => void {
    let handles = this.activeAbortHandles.get(sessionId);
    if (!handles) {
      handles = new Set();
      this.activeAbortHandles.set(sessionId, handles);
    }
    handles.add(handle);
    return () => {
      const current = this.activeAbortHandles.get(sessionId);
      if (!current) return;
      current.delete(handle);
      if (current.size === 0) this.activeAbortHandles.delete(sessionId);
    };
  }

  private abortAllSessions(): void {
    for (const sessionId of Array.from(this.activeAbortHandles.keys())) {
      this.abortSession(sessionId);
    }
    this.activeAbortHandles.clear();
  }

  /** P1-R3: Public getter for session notes — used by report generation. */
  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) || [];
  }

  /** P1-R3: Public getter for current analysis plan — used by report generation. */
  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  /** P1-R3: Public getter for uncertainty flags — used by report generation. */
  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) || [];
  }

  /** P1-1: Public getter for plan history — used for persistence. */
  getSessionPlanHistory(sessionId: string): AnalysisPlanV3[] {
    return this.sessionPlans.get(sessionId)?.history || [];
  }

  // ===========================================================================
  // Snapshot — atomic serialization / deserialization boundary
  // ===========================================================================

  /**
   * Take a snapshot of all session state for atomic persistence.
   *
   * Reads from ClaudeRuntime's 7 internal Maps (notes, plans, hypotheses,
   * flags, artifacts, architectureCache, sessionMap) and merges with
   * session-level arrays provided by the route layer.
   *
   * @param sessionId - The SmartPerfetto session ID
   * @param traceId - The trace ID
   * @param sessionFields - Session-level arrays from AnalysisSession (route layer)
   */
  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const privateKnowledge = sessionFieldsUsePrivateKnowledge(sessionFields);
    const durableFields = projectSessionFieldsForDurableSnapshot(sessionFields);
    const notes = this.sessionNotes.get(sessionId) || [];
    const planState = this.sessionPlans.get(sessionId);
    const claudeHypotheses = this.sessionHypotheses.get(sessionId) || [];
    const flags = this.sessionUncertaintyFlags.get(sessionId) || [];
    const artifactStore = this.artifactStores.get(sessionId);
    const architecture = this.architectureCache.get(traceId);
    const sessionMapEntry = this.sessionMap.get(
      this.buildSessionMapKey(sessionId, sessionFields.referenceTraceId),
    );
    const sdkSessionId = !privateKnowledge && isFreshFullSdkSessionEntry(sessionMapEntry)
      ? sessionMapEntry.sdkSessionId
      : undefined;

    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,

      // Session fields (route layer) — fields match SessionFieldsForSnapshot exactly
      ...durableFields,

      // ClaudeRuntime Maps
      analysisNotes: privateKnowledge ? [] : notes,
      analysisPlan: privateKnowledge ? null : planState?.current ?? null,
      planHistory: privateKnowledge ? [] : planState?.history ?? [],
      uncertaintyFlags: privateKnowledge ? [] : flags,
      claudeHypotheses: !privateKnowledge && claudeHypotheses.length > 0 ? claudeHypotheses : undefined,

      // Cached detection
      architecture,
      engineState: createClaudeSnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        sdkSessionId,
        sdkSessionMode: sdkSessionId ? 'full' : undefined,
      }),
      ...(sdkSessionId ? { sdkSessionId, sdkSessionMode: 'full' as const } : {}),
      agentRuntimeKind: 'claude-agent-sdk',
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      agentRuntimeProviderSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,

      // Artifacts
      artifacts: privateKnowledge ? undefined : artifactStore?.serialize(),
    };
  }

  /**
   * Restore all ClaudeRuntime Maps from a persisted snapshot.
   *
   * Called during session resume to repopulate the 7 internal Maps
   * that are normally built up during analysis.
   *
   * @param sessionId - The SmartPerfetto session ID
   * @param traceId - The trace ID (for architectureCache key)
   * @param snapshot - The persisted snapshot to restore from
   */
  restoreFromSnapshot(sessionId: string, traceId: string, snapshot: SessionStateSnapshot): void {
    if (snapshot.analysisNotes.length > 0) {
      this.sessionNotes.set(sessionId, [...snapshot.analysisNotes]);
    }

    if (snapshot.analysisPlan || snapshot.planHistory.length > 0) {
      this.sessionPlans.set(sessionId, {
        current: snapshot.analysisPlan,
        history: snapshot.planHistory,
      });
    }

    if (snapshot.claudeHypotheses && snapshot.claudeHypotheses.length > 0) {
      this.sessionHypotheses.set(sessionId, [...snapshot.claudeHypotheses]);
    }

    if (snapshot.uncertaintyFlags.length > 0) {
      this.sessionUncertaintyFlags.set(sessionId, [...snapshot.uncertaintyFlags]);
    }

    if (snapshot.artifacts && snapshot.artifacts.length > 0) {
      this.artifactStores.set(sessionId, ArtifactStore.fromSnapshot(snapshot.artifacts));
    }

    if (snapshot.architecture) {
      setLruCacheEntry(this.architectureCache, traceId, snapshot.architecture);
    }

    const claudeEngineState = getClaudeSnapshotEngineState(snapshot);
    if (claudeEngineState?.sdkSessionId && claudeEngineState.sdkSessionMode === 'full') {
      this.sessionMap.set(this.buildSessionMapKey(sessionId, snapshot.referenceTraceId), {
        sdkSessionId: claudeEngineState.sdkSessionId,
        updatedAt: snapshot.snapshotTimestamp || Date.now(),
        mode: 'full',
      });
    }
  }

  /** P0-1: Convert agentv3 Hypothesis to agentProtocol Hypothesis format for AnalysisResult. */
  private toProtocolHypothesis(h: Hypothesis): ProtocolHypothesis {
    return toRuntimeProtocolHypothesis(h, 'claude');
  }

  reset(): void {
    this.executionGuard.clear();
    this.abortAllSessions();
    this.architectureCache.clear();
    this.vendorCache.clear();
    // Also clear all session-scoped stores to prevent unbounded growth
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionSqlErrorPartitions.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.activeAnalyses.clear();
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }

  /**
   * Build a compact entity context string for the system prompt.
   * Gives Claude awareness of known frames/sessions for drill-down resolution.
   */
  private buildEntityContext(entityStore: any): string | undefined {
    return buildEntityContext(entityStore);
  }

  /**
   * Prepare all context needed for a Claude analysis run.
   * Extracts focus app detection, architecture detection, session context,
   * scene classification, MCP server creation, and system prompt building
   * into a single cohesive preparation phase.
   */
  private async prepareAnalysisContext(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    precomputed: {
      turnIntent: AnalysisTurnIntent;
      turnPolicy: RuntimeTurnPolicy;
      strategyRegistry: ReadonlyStrategyRegistrySnapshot;
      runActivity?: {active: boolean};
      /** The run's focus detection (`detectRunFocusApps`); absent means nothing was detected. */
      focusResult?: FocusAppDetectionResult;
      sessionContext?: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns?: any[];
      sceneType?: SceneType;
      runtimeConfig?: ClaudeAgentConfig;
      analysisRunSpec?: AnalysisRunSpec;
      executionLease?: RuntimeExecutionLease;
      runtimePerformance?: RuntimePerformanceRun;
      toolObserver?: RuntimeToolObserver;
      analysisHistoryReader?: ReturnType<typeof createRuntimeAnalysisHistoryReader>;
      acquisition?: {open: boolean};
      sceneDeadlineMs?: number;
      scenePacing?: ScenePacingInputs;
    },
  ) {
    const {turnIntent, turnPolicy, strategyRegistry} = precomputed;
    const providerScope = precomputed?.analysisRunSpec?.scopes.provider
      ?? providerScopeFromAnalysisOptions(options);
    const knowledgeScope = precomputed?.analysisRunSpec?.scopes.knowledge
      ?? knowledgeScopeFromAnalysisOptions(options);
    const runtimeConfig = precomputed?.runtimeConfig
      ?? resolveRuntimeConfig(this.config, options.providerId, providerScope);
    const executionLease = precomputed?.executionLease;
    const runtimePerformance = precomputed?.runtimePerformance;
    const widenedPreflightDagAdmitted = isRuntimeCandidateAdmitted('task6');
    const startedPreflights: Promise<unknown>[] = [];
    const trackPreflight = <T>(promise: Promise<T>): Promise<T> => {
      startedPreflights.push(promise.then(
        () => undefined,
        () => undefined,
      ));
      return promise;
    };
    let serializedPreflightTail: Promise<void> = Promise.resolve();
    const schedulePreflight = <T>(work: () => Promise<T>): Promise<T> => {
      const promise = widenedPreflightDagAdmitted
        ? Promise.resolve().then(work)
        : serializedPreflightTail.then(work);
      if (!widenedPreflightDagAdmitted) {
        serializedPreflightTail = promise.then(
          () => undefined,
          () => undefined,
        );
      }
      return trackPreflight(promise);
    };
    const settleStartedPreflights = async (): Promise<void> => {
      await Promise.allSettled(startedPreflights);
    };
    const throwIfPreflightAborted = async (): Promise<void> => {
      if (!executionLease?.signal.aborted) return;
      await settleStartedPreflights();
      executionLease.throwIfAborted();
    };
    const runPreflightPhase = <T>(
      phaseName: Parameters<RuntimePerformanceRun['startPhase']>[0],
      work: () => Promise<T>,
    ): Promise<T> => {
      const phase = runtimePerformance?.startPhase(phaseName);
      return schedulePreflight(async () => {
        try {
          executionLease?.throwIfAborted();
          const value = await work();
          phase?.end(executionLease?.signal.aborted ? 'cancelled' : 'ok');
          return value;
        } catch (err) {
          phase?.end(runtimeOutcomeFromError(err, executionLease?.signal));
          throw err;
        }
      });
    };
    const skillRegistryReady = runPreflightPhase('skill_registry', async () => {
      await ensureSkillRegistryInitialized();
    });
    const knowledgeBaseContextPromise = turnPolicy.allowAutomaticPrefetch ? runPreflightPhase('knowledge', async () => {
      try {
        const kb = await getExtendedKnowledgeBase();
        return kb.getContextForAI(query, 8);
      } catch {
        return undefined;
      }
    }) : Promise.resolve(undefined);

    // Phase 0: Selection context logging
    if (options.selectionContext) {
      const sc = options.selectionContext;
      const detail = sc.kind === 'area'
        ? `startNs=${sc.startNs}, endNs=${sc.endNs}`
        : `eventId=${sc.eventId}, ts=${sc.ts}`;
      console.log(`[ClaudeRuntime] Selection context received: kind=${sc.kind}, ${detail}`);
    }

    // Phase 0.5: the focus detection the caller ran before this preparation.
    // One effective-package decision (user > confident inference > none),
    // shared with every other runtime and package consumer.
    const focusTarget = resolveFocusAppTarget({userPackageName: options.packageName, focusResult: precomputed.focusResult});
    const effectivePackageName = focusTarget.packageName;
    console.log(`[ClaudeRuntime] Focus target: ${effectivePackageName ?? '(none)'} source=${focusTarget.source} ` +
      `confidence=${focusTarget.confidence ?? '-'} method=${focusTarget.method} candidates=${focusTarget.candidates.length}`);
    const focusProgress = formatFocusAppTargetProgress(focusTarget, runtimeConfig.outputLanguage);
    if (focusProgress) {
      this.emitUpdate({
        type: 'progress',
        content: {phase: 'starting', message: focusProgress},
        timestamp: Date.now(),
      });
    }

    // Phase 1: Skill executor setup
    const skillExecutor = createSkillExecutor(this.traceProcessorService);

    // Phase 2.8: Comparison context (dual-trace mode)
    const referenceTraceId = options.referenceTraceId;
    const comparisonContextPromise = referenceTraceId && turnPolicy.allowAutomaticPrefetch
      ? runPreflightPhase('comparison', async () => {
      console.log(`[ClaudeRuntime] Comparison mode: current=${traceId}, reference=${referenceTraceId}`);
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            runtimeConfig.outputLanguage,
            '对比模式：正在检测参考 Trace...',
            'Comparison mode: detecting the reference trace...',
          ),
        },
        timestamp: Date.now(),
      });

      const comparisonContext = await buildRuntimeTracePairComparisonContext({
        traceProcessorService: this.traceProcessorService,
        currentTraceId: traceId,
        referenceTraceId,
        ...(options.tracePairContext ? {tracePairContext: options.tracePairContext} : {}),
        detectReferenceArchitecture: async id => {
          const cached = getLruCacheEntry(this.architectureCache, id);
          if (cached) return cached;
          const detected = await createArchitectureDetector().detect({
            traceId: id,
            traceProcessorService: this.traceProcessorService,
            packageName: undefined,
          }) ?? undefined;
          if (detected) setLruCacheEntry(this.architectureCache, id, detected);
          return detected;
        },
        onCapabilityQueryError: (side, error) => {
          console.warn(
            `[ClaudeRuntime] Capability query failed for ${side} trace:`,
            diagnosticLogIdentity((error as Error).message),
          );
        },
      });

      console.log(`[ClaudeRuntime] Comparison context built: refApp=${comparisonContext?.referencePackageName || 'unknown'}, ` +
        `refArch=${comparisonContext?.referenceArchitecture?.type || 'unknown'}, commonCaps=${comparisonContext?.commonCapabilities.length ?? 0}, ` +
        `capDiff=${comparisonContext?.capabilityDiff ? `cur=${comparisonContext.capabilityDiff.currentOnly.length}/ref=${comparisonContext.capabilityDiff.referenceOnly.length}` : 'none'}`);
      return comparisonContext;
    })
      : Promise.resolve(buildRuntimeTracePairIdentityContext({referenceTraceId,
          tracePairContext: options.tracePairContext}));

    // Phase 2: Architecture detection (LRU cached per traceId)
    const architecturePromise = turnPolicy.preflight !== 'none' ? runPreflightPhase('architecture', async () => {
      let architecture = getLruCacheEntry(this.architectureCache, traceId);
      if (!architecture) {
        try {
          const detector = createArchitectureDetector();
          architecture = await detector.detect({
            traceId,
            traceProcessorService: this.traceProcessorService,
            packageName: effectivePackageName,
          });
          if (architecture) {
            setLruCacheEntry(this.architectureCache, traceId, architecture);
          }
          this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
        } catch (err) {
          console.warn('[ClaudeRuntime] Architecture detection failed:', diagnosticLogIdentity((err as Error).message));
        }
      }
      return architecture;
    }) : Promise.resolve(getLruCacheEntry(this.architectureCache, traceId));

    // Phase 2.5: Vendor detection (LRU cached per traceId, reuses SkillAnalysisAdapter.detectVendor)
    const detectedVendorPromise = turnPolicy.preflight !== 'none' ? schedulePreflight(async () => {
      await architecturePromise;
      executionLease?.throwIfAborted();
      let detectedVendor = getLruCacheEntry(this.vendorCache, traceId) ?? null;
      if (!detectedVendor) {
        try {
          const adapter = getSkillAnalysisAdapter(this.traceProcessorService);
          await adapter.ensureInitialized();
          const vendorResult = await adapter.detectVendor(traceId);
          detectedVendor = vendorResult.vendor;
          if (detectedVendor && detectedVendor !== 'aosp') {
            setLruCacheEntry(this.vendorCache, traceId, detectedVendor);
          }
        } catch (err) {
          console.warn('[ClaudeRuntime] Vendor detection failed:', diagnosticLogIdentity((err as Error).message));
        }
      }
      return detectedVendor;
    }) : Promise.resolve(getLruCacheEntry(this.vendorCache, traceId) ?? null);

    // Phase 2.9: Trace data completeness probe (identity-safe shared cache)
    const traceCompletenessPromise = turnPolicy.preflight !== 'none' ? runPreflightPhase('completeness', async () => {
      const architecture = await architecturePromise;
      try {
        return await probeTraceCompleteness(
          this.traceProcessorService,
          traceId,
          architecture?.type,
        );
      } catch (err) {
        console.warn('[ClaudeRuntime] Trace completeness probe failed (non-fatal):', diagnosticLogIdentity((err as Error).message));
        return undefined;
      }
    }) : Promise.resolve(undefined);

    let architecture: Awaited<typeof architecturePromise>;
    let detectedVendor: Awaited<typeof detectedVendorPromise>;
    let traceCompleteness: Awaited<typeof traceCompletenessPromise>;
    let comparisonContext: Awaited<ReturnType<typeof buildRuntimeTracePairComparisonContext>> | undefined;
    let knowledgeBaseContext: Awaited<typeof knowledgeBaseContextPromise>;
    try {
      [architecture, detectedVendor, traceCompleteness, comparisonContext, knowledgeBaseContext] = await Promise.all([
        architecturePromise,
        detectedVendorPromise,
        traceCompletenessPromise,
        comparisonContextPromise ?? Promise.resolve(undefined),
        knowledgeBaseContextPromise,
      ]);
      await skillRegistryReady;
    } catch (error) {
      if (executionLease?.signal.aborted) {
        await settleStartedPreflights();
        executionLease.throwIfAborted();
      }
      throw error;
    }
    await throwIfPreflightAborted();
    executionLease?.throwIfAborted();

    // Phase 3: Session context + conversation history (reuse precomputed if available)
    const sessionContext = precomputed?.sessionContext ?? sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = precomputed?.previousTurns ?? (sessionContext.getAllTurns?.() || []);
    // Composite key for comparison mode session identity isolation
    const sessionMapKey = precomputed?.analysisRunSpec?.identity.sessionMapKey
      ?? this.buildSessionMapKey(sessionId, referenceTraceId);
    // Phase 4: Entity store + entity context for drill-down
    const entityStore = sessionContext.getEntityStore();

    // Phase 5: Scene classification + effort resolution (reuse precomputed if available)
    const sceneType = turnIntent.sceneId;
    const effectiveEffort = resolveEffort(runtimeConfig, sceneType, {
      configuredEffortOverridesScene: hasConfiguredClaudeEffortOverride(options.providerId, providerScope),
    });

    // Phase 5.5: Pattern memory — match similar historical traces (P2-2)
    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    const patternContext = privateAnalysisContext || !turnPolicy.allowAutomaticPrefetch
      ? undefined
      : buildPatternContextSection(traceFeatures, knowledgeScope);
    const negativePatternContext = privateAnalysisContext || !turnPolicy.allowAutomaticPrefetch
      ? undefined
      : buildNegativePatternSection(traceFeatures, knowledgeScope);
    const caseBackgroundContext = turnPolicy.allowAutomaticPrefetch ? buildRuntimeCaseBackgroundContext({
      sceneType,
      architectureType: architecture?.type,
      knowledgeScope,
      outputLanguage: runtimeConfig.outputLanguage,
      privateAnalysisContext,
    }) : undefined;

    // Phase 6: Session-scoped artifact store + analysis notes
    const artifactStore = resolveRuntimeEvidenceStore(options, {sessionId, traceId},
      () => this.artifactStores.get(sessionId) ?? new ArtifactStore());
    this.artifactStores.set(sessionId, artifactStore);
    // Notes restored from SessionStateSnapshot on resume — no separate disk I/O.
    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }

    // Phase 6.5: Session-scoped analysis plan (P0-1: Planning capability)
    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null, history: [] });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    // P1-B1: Preserve plan history (max 3 recent plans) for deeper cross-turn context
    if (analysisPlan.current) {
      analysisPlan.history.push(analysisPlan.current);
      if (analysisPlan.history.length > 3) analysisPlan.history.shift();
    }
    analysisPlan.current = null;
    resetPrePlanToolCallsForNewRun(analysisPlan);

    // Phase 6.6: Watchdog feedback ref — shared between runtime watchdog and MCP tools
    const watchdogWarning: { current: string | null } = { current: null };

    // Phase 6.7: Session-scoped hypotheses for hypothesis-verify cycle (P0-G4)
    if (!this.sessionHypotheses.has(sessionId)) {
      this.sessionHypotheses.set(sessionId, []);
    }
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    // Reset for new turn (hypotheses are per-turn, resolved within each analysis cycle)
    hypotheses.splice(0);

    // Phase 6.8: Session-scoped uncertainty flags (P1-G1)
    if (!this.sessionUncertaintyFlags.has(sessionId)) {
      this.sessionUncertaintyFlags.set(sessionId, []);
    }
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0); // Reset per turn

    // Phase 7: SQL error tracking for in-context learning
    // Seed new sessions with previously learned fix pairs from disk (cross-session learning)
    const sqlErrorPartition = analysisContextMemoryPartitionKey(options);
    if (this.sessionSqlErrorPartitions.get(sessionId) !== sqlErrorPartition) {
      this.sessionSqlErrors.delete(sessionId);
      this.sessionSqlErrorPartitions.set(sessionId, sqlErrorPartition);
    }
    let sqlErrors = this.sessionSqlErrors.get(sessionId);
    if (!sqlErrors) {
      sqlErrors = turnPolicy.allowAutomaticPrefetch ? loadLearnedSqlFixPairs(5, knowledgeScope, options) : [];
      this.sessionSqlErrors.set(sessionId, sqlErrors);
    }

    // Phase 8: MCP server with all session-scoped state
    // P2-G1: Destructure to get both server and auto-derived allowedTools
    await skillRegistryReady;
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    const sceneCoverageRegistry = resolveSceneProductScope(options, {sessionId, traceId, runId: options.runId ?? ''})
      ? snapshotSceneCoverageRegistry(effectiveSkillRegistry, strategyRegistry, turnIntent.sceneId) : undefined;
    skillExecutor.registerSkills(sceneCoverageRegistry ? [...sceneCoverageRegistry.skills] : effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(
      sceneCoverageRegistry ? new Map(sceneCoverageRegistry.fragments) : effectiveSkillRegistry.getFragmentCache(),
    );
    const notesBudget = createRuntimeSkillNotesBudget(turnPolicy.budgetMode === 'quick');
    const canInvokeTool = () => precomputed.acquisition?.open !== false &&
      precomputed.runActivity?.active !== false && !executionLease?.signal.aborted;
    const sceneRunContext = await activateSceneRuntime(options, {sessionId, traceId, runId: options.runId ?? '',
      deadlineMs: precomputed.sceneDeadlineMs ?? 0, traceProcessorService: this.traceProcessorService,
      artifactStore, sceneCoverageRegistry, signal: executionLease?.signal, canInvokeTool, pacing: precomputed.scenePacing});
    const { server: mcpServer, allowedTools, toolDefinitions, sourceUse } = createClaudeMcpServer({
      sceneRunContext,
      toolObserver: precomputed.toolObserver,
      analysisHistoryReader: precomputed.analysisHistoryReader,
      canInvokeTool,
      conversationTraceAttached: options.assistantSurface === 'conversation'
        ? options.conversationTraceAttached === true
        : undefined,
      runManifestAttributionSink: options.runManifestAttributionSink,
      sessionId,
      traceId,
      userQuery: query,
      traceProcessorService: this.traceProcessorService,
      skillExecutor,
      packageName: effectivePackageName,
      focusTarget,
      emitUpdate: (update) => {
        if (precomputed.runActivity?.active !== false && !executionLease?.signal.aborted) this.emitUpdate(update);
      },
      onSkillResult: (result) => {
        if (precomputed.runActivity?.active === false || executionLease?.signal.aborted) return;
        if (result.displayResults) {
          this.captureEntitiesFromSkillDisplayResults(result.displayResults, entityStore);
        }
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      cachedVendor: detectedVendor,
      recentSqlErrors: sqlErrors,
      analysisPlan,
      watchdogWarning,
      hypotheses,
      sceneType,
      uncertaintyFlags,
      referenceTraceId,
      comparisonContext,
      skillNotesBudget: notesBudget,
      lightweight: usesLightweightToolCatalog(turnPolicy),
      allowNewEvidence: turnPolicy.allowNewEvidence,
      strategyRegistry,
      outputLanguage: runtimeConfig.outputLanguage,
      knowledgeScope,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
      sourceUsePolicy: options.sourceUsePolicy,
      analysisContextFingerprint: options.analysisContextFingerprint,
      androidInternalsPackPin: options.androidInternalsPackPin,
    });

    // Phase 9: (removed — skillCatalog was populated but never used in prompt;
    //           Claude uses list_skills MCP tool on demand instead)

    // Phase 10: Knowledge base context was prepared before session-state reset
    // and remains non-fatal — Claude can use lookup_sql_schema tool.

    // Phase 11: Sub-agent definitions (feature-gated)
    let agents: Record<string, any> | undefined;
    if (runtimeConfig.enableSubAgents) {
      agents = buildAgentDefinitions(sceneType, {
        architecture,
        packageName: effectivePackageName,
        allowedTools,
        toolDefinitions,
        codeAwareMode: options.codeAwareMode,
        codebaseIds: options.codebaseIds,
        outputLanguage: runtimeConfig.outputLanguage,
        subAgentModel: runtimeConfig.subAgentModel,
      });
    }

    // Phase 12: SQL error-fix pairs for prompt injection
    const sqlErrorFixPairs = sqlErrors
      .filter((e: any) => e.fixedSql)
      .slice(-3)
      .map((e: any) => ({ errorSql: e.errorSql, errorMessage: e.errorMessage, fixedSql: e.fixedSql }));

    // Phase 13: System prompt assembly
    const traceInfo = this.traceProcessorService.getTrace?.(traceId);
    const analysisContextForRebuild: ClaudeAnalysisContext = {
      query, turnIntent, strategyRegistry, onDemandContext: turnPolicy.onDemandContext,
      // The run's own preflight, not one recomputed from the intent: a
      // conversation turn with no attached trace read no trace facts and the
      // prompt must not advertise them.
      preflight: turnPolicy.preflight,
      architecture,
      packageName: effectivePackageName,
      focusTarget,
      knowledgeBaseContext,
      sceneType,
      availableAgents: agents ? Object.keys(agents) : undefined,
      sqlErrorFixPairs: sqlErrorFixPairs.length > 0 ? sqlErrorFixPairs : undefined,
      patternContext,
      negativePatternContext,
      caseBackgroundContext,
      selectionContext: options.selectionContext,
      comparison: comparisonContext,
      traceCompleteness,
      traceOs: traceInfo?.traceOs,
      traceFormat: traceInfo?.traceFormat,
      outputLanguage: runtimeConfig.outputLanguage,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
    };
    const systemPromptParts = buildSystemPromptParts(analysisContextForRebuild);
    const systemPrompt = systemPromptParts.fullPrompt;
    const sdkSystemPrompt = buildClaudeSdkSystemPrompt(
      systemPromptParts,
      this.runtimeCapabilities,
    );

    return {
      mcpServer,
      systemPrompt,
      sdkSystemPrompt,
      effectiveEffort,
      agents,
      sessionContext,
      previousTurns,
      entityStore,
      analysisPlan,
      architecture,
      watchdogWarning,
      hypotheses,
      sceneType,
      allowedTools, // P2-G1: auto-derived from MCP server registration
      analysisContextForRebuild, // Used by correction retry to rebuild prompt with reduced budget
      sessionMapKey, // Composite key for comparison mode session identity isolation
      analysisRunSpec: precomputed?.analysisRunSpec,
      sourceUse,
    };
  }


  /** Capture entities from skill displayResults into EntityStore for multi-turn drill-down. */
  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    captureSkillDisplayEntities(displayResults, entityStore, 'claude-agent');
  }
}
