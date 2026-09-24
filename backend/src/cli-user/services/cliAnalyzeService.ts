// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI Analyze Facade.
 *
 * Wraps agentv3's service layer into a single `runTurn()` call with no
 * Express dependency. This is the CLI's only touch-point with the agentv3
 * internals — everything else (commands, REPL, IO) depends on this facade.
 *
 * Compared to HTTP route's `runAgentDrivenAnalysis()`, this omits:
 *   - SSE broadcasting (no HTTP response)
 *   - conversation_step derivation (frontend-only concern)
 *   - scene reconstruction payload (deferred to PR-future)
 *   - LLM telemetry logging subscription (best-effort, not critical for CLI)
 *
 * It keeps:
 *   - prepareSession / analyze / conclusion capture
 *   - HTML report generation (written to CLI's session folder, not /api/reports)
 *   - sdkSessionId surfacing for subsequent resume
 */

import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import { AssistantApplicationService } from '../../assistant/application/assistantApplicationService';
import {
  AgentAnalyzeSessionService,
  buildAgentQueryWithContinuityNotice,
  type AnalyzeManagedSession,
} from '../../assistant/application/agentAnalyzeSessionService';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import {prepareAnalysisRunTraceProcessorLeases, type AnalysisRunTraceProcessorLeases} from '../../services/analysisRunTraceProcessorLease';
import { createSessionLogger } from '../../services/sessionLogger';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import { getHTMLReportGenerator } from '../../services/htmlReportGenerator';
import { buildAgentDrivenReportData } from '../../services/agentReportData';
import { buildAnalysisReceipt } from '../../services/analysisReceiptBuilder';
import {recordAdaptiveRoutingPostEvidenceBestEffort} from '../../agentRuntime/adaptiveRoutingProjection';
import { deriveUiActionProposals } from '../../services/uiActionProposalDeriver';
import { persistAgentTurn } from '../../services/persistAgentSession';
import {
  persistAnalysisRunState,
  type AnalysisRunPersistenceScope,
  type PersistedAnalysisRunStatus,
} from '../../services/analysisRunStore';
import {finalizeAnalysisResult} from '../../services/finalizeAnalysisResult';
import {resolveCapturedComparisonIdentity} from '../../services/comparisonAppendixService';
import type {FinalResultQualityIssue} from '../../services/finalResultQualityGate';
import {takeFinalizationContext, type RuntimeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {resolveRuntimeTurnPolicy} from '../../agentRuntime/runtimeTurnPolicy';
import {executeManagedTraceSummaryV1} from '../../services/managedTraceSummary';
import {buildTraceSummaryAttributionV1} from '../../services/traceSummaryAttribution';
import {unavailableTraceSummaryV1} from '../../services/traceSummaryExecutor';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { backendLogPath } from '../../runtimePaths';
import { RagStore } from '../../services/ragStore';
import { SymbolResolver, type ResolvedSymbolCandidate } from '../../services/symbol/symbolResolver';
import { getTraceProcessorPath, TraceProcessorFactory } from '../../services/workingTraceProcessor';
import { withConsoleLogToStderr } from '../io/stdio';
import { installTraceProcessorPrebuilt } from './traceProcessorInstaller';
import {
  resolveAgentRuntimeSelection,
  type BackendAgentRuntimeKind,
} from '../../agentRuntime/runtimeSelection';
import {
  getRuntimeDiagnosticModel,
  getRuntimeDiagnostics,
} from '../../agentRuntime/runtimeDiagnostics';
import { isProductionAgentRuntimeKind } from '../../agentRuntime/runtimeKinds';
import {
  getSnapshotRuntimeKind,
  getSnapshotRuntimeProviderId,
  getSnapshotRuntimeProviderSnapshotHash,
  type SessionStateSnapshot,
} from '../../agentv3/sessionStateSnapshot';
import type { StreamingUpdate } from '../../agent/types';
import type { AnalysisOptions, AnalysisResult } from '../../agent/core/orchestratorTypes';
import {createAnalysisHistoryReader, createRuntimeAnalysisHistoryReader, withAnalysisHistoryReader, type AnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import type { QueryResult } from '../../services/traceProcessorService';
import {
  codeAwareFeatureEnabled,
  MAX_CODEBASE_IDS_PER_ANALYSIS,
  MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS,
  normalizeCodeAwareMode,
  type CodeAwareMode,
} from '../../services/codebase/codeAwareFeature';
import {
  CodebaseRegistry,
  codebaseRootAvailable,
  resolveCodebaseScope,
} from '../../services/codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from '../../services/codebase/defaultCodebaseServices';
import {
  externalKnowledgeSourceHasActiveIndex,
  getDefaultExternalKnowledgeSourceRegistry,
} from '../../services/externalKnowledgeSourceRegistry';
import type {KnowledgeScope} from '../../services/scopedKnowledgeStore';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {
  AnalysisContextAuthorizationChangedError,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../../services/resolvedAnalysisContext';
import {projectOwnerCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {
  clearCodeAwareOutputGuards,
  revokeCodeAwareOutputGuards,
} from '../../services/security/codeAwareOutputRegistry';
import { validateDataEnvelope, type DataEnvelope } from '../../types/dataContract';
import type { CliAnalysisMode, CliSessionLineage } from '../types';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {resolveEffectiveAnalysisMode} from '../../services/effectiveAnalysisMode';
import {
  projectPrimaryAnalysisOptions,
  resolveAnalysisSourceActivation,
} from '../../services/codebase/analysisSourceActivationPolicy';
import {resetRuntimeForSourceActivation} from '../../services/codebase/analysisSourceContextTransition';
import type {AnalysisSourceSupplementOutcome} from '../../services/codebase/analysisSourceSupplement';
import {projectSafeSourceProvenance} from '../../services/codebase/sourceClaimVerifier';
import {
  sanitizeSourceReference,
  sanitizeSourceUseDecision,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from '../../services/codebase/sourceUseDecision';
import {
  projectOwnerAnalysisError,
  privateAnalysisQueryMessage,
  projectOwnerAnalysisResult,
} from '../../services/security/privateAnalysisProjection';
import {registerPrivateAnalysisQueryForEcho} from '../../services/security/codeAwareOutputRegistry';
import {finalReviewProgressUpdate} from '../../services/finalizationProgress';
import {buildSkillRegistryAttribution} from '../../services/selfEvolution/skillFingerprint';
import {getEffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import {
  createRunManifestLifecycle,
  withRunManifestLifecycle,
} from '../../services/selfEvolution/runManifestLifecycle';

/**
 * The finalized-history writer requires an owner-authorized run parent
 * (`analysis_runs` joined to `analysis_sessions`). The HTTP layer creates that
 * graph when it admits a run; the CLI owns its own run lifecycle, so it has to
 * register the same parent or every finalization fails closed with
 * `analysis_history_parent_not_authorized`. Ownership must be the exact scope
 * `persistAgentTurn` later appends with, not a re-resolved default.
 */
function cliAnalysisRunScope(
  session: {tenantId?: string; workspaceId?: string; userId?: string},
  identity: {sessionId: string; runId: string; traceId: string; query: string; mode: string},
): AnalysisRunPersistenceScope | undefined {
  const {tenantId, workspaceId, userId} = session;
  return tenantId && workspaceId && userId
    ? {tenantId, workspaceId, userId, ...identity}
    : undefined;
}

/** Run-lifecycle bookkeeping never turns a delivered analysis into a CLI failure. */
function recordCliAnalysisRunState(
  scope: AnalysisRunPersistenceScope | undefined,
  status: PersistedAnalysisRunStatus,
  error?: string,
): void {
  if (!scope) return;
  try {
    persistAnalysisRunState(scope, status, {error});
  } catch (persistError) {
    console.warn(
      '[CliAnalyzeService] Failed to persist analysis run state:',
      status,
      (persistError as Error).message,
    );
  }
}

export interface RunTurnInput {
  /** Cancels runtime execution and finalization until the turn is committed. */
  signal?: AbortSignal;
  tracePath?: string;
  traceId?: string;
  referenceTraceId?: string;
  query: string;
  /** Local transcript fallback for a missing backend history; never part of the user's question. */
  history?: readonly AnalysisHistoryTurn[];
  sessionId?: string;
  analysisMode?: CliAnalysisMode;
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  /** Backend-session ancestry for CLI Level-3 degraded resume bridges. */
  lineage?: CliSessionLineage;
  /** 1-indexed CLI-visible turn number, bound before analysis starts. */
  turn: number;
  /**
   * Resolves the final durable CLI markdown path once the backend session id
   * is known. The path is attribution only and is omitted for private runs.
   */
  resolveCliTurnPath: (sessionId: string, turn: number) => string;
  /** Receives every StreamingUpdate from the orchestrator in real time. */
  onEvent: (update: StreamingUpdate) => void;
  /**
   * Fires once after `prepareSession` resolves, before `analyze()` starts
   * streaming events. Lets callers create the session folder + switch to
   * direct disk writes instead of buffering events in memory.
   */
  onSessionReady?: (sessionId: string) => void;
}

export interface RunTurnOutput {
  sessionId: string;
  traceId: string;
  sdkSessionId?: string;
  result: AnalysisResult;
  /** Absolute path to the generated HTML report, or undefined if generation failed. */
  reportHtml?: string;
  reportError?: string;
  model?: string;
  providerId?: string | null;
  agentRuntimeKind?: BackendAgentRuntimeKind;
  providerSnapshotHash?: string | null;
  /** Effective mode after defaults and feature-gate normalization. */
  codeAwareMode: CodeAwareMode;
  /** True when durable CLI artifacts must use the private projection. */
  privateKnowledge?: boolean;
  /** Internal source-scope binding for durable history, not a provider credential. */
  analysisContextFingerprint?: string;
  /** Safe, separately persisted source supplement. Never modifies the primary report. */
  sourceSupplement?: AnalysisSourceSupplementOutcome;
  /** Internal continuation that lets the caller commit the primary output first. */
  sourceSupplementTask?: Promise<AnalysisSourceSupplementOutcome | undefined>;
}

export function resolveEffectiveCliCodeAwareMode(input: Pick<
  RunTurnInput,
  'codeAwareMode' | 'codebaseIds'
>): CodeAwareMode {
  const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  if (input.codebaseIds?.length) {
    if (!codeAwareFeatureEnabled()) {
      throw new Error(localize(
        outputLanguage,
        'FEATURE_DISABLED：注册源码分析已禁用',
        'FEATURE_DISABLED: registered source analysis is disabled',
      ));
    }
    const mode = normalizeCodeAwareMode(input.codeAwareMode);
    if (mode === 'off') {
      throw new Error(localize(
        outputLanguage,
        'CODEBASE_IDS_REQUIRE_CODE_AWARE_MODE：codebaseIds 需要 metadata_only 或 provider_send 模式',
        'CODEBASE_IDS_REQUIRE_CODE_AWARE_MODE: codebaseIds require metadata_only or provider_send',
      ));
    }
    return mode;
  }
  return input.codeAwareMode ?? 'off';
}

function validateCliAnalysisContext(input: RunTurnInput, scope: KnowledgeScope): void {
  const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const codebaseIds = Array.from(new Set(input.codebaseIds ?? []));
  const knowledgeSourceIds = Array.from(new Set(input.knowledgeSourceIds ?? []));
  if (codebaseIds.length > MAX_CODEBASE_IDS_PER_ANALYSIS) {
    throw new Error(localize(
      outputLanguage,
      `codebaseIds 超过上限 ${MAX_CODEBASE_IDS_PER_ANALYSIS}`,
      `codebaseIds exceeds the maximum of ${MAX_CODEBASE_IDS_PER_ANALYSIS}`,
    ));
  }
  if (knowledgeSourceIds.length > MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS) {
    throw new Error(localize(
      outputLanguage,
      `knowledgeSourceIds 超过上限 ${MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS}`,
      `knowledgeSourceIds exceeds the maximum of ${MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS}`,
    ));
  }

  const codebaseRegistry = getDefaultCodebaseRegistry();
  for (const codebaseId of codebaseIds) {
    const ref = codebaseRegistry.get(codebaseId, scope);
    if (!ref) {
      throw new Error(localize(
        outputLanguage,
        `当前分析范围内未找到源码库“${codebaseId}”`,
        `Codebase '${codebaseId}' not found in the current analysis scope`,
      ));
    }
    if (!codebaseRootAvailable(ref)) {
      throw new Error(
        localize(
          outputLanguage,
          `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE：源码库“${codebaseId}”的已注册根目录当前不可用`,
          `ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE: Codebase '${codebaseId}' has a registered root that is unavailable`,
        ),
      );
    }
    if (input.codeAwareMode === 'provider_send' && !ref.consent.sendToProvider) {
      throw new Error(localize(
        outputLanguage,
        `源码库“${codebaseId}”尚未授权给模型服务使用`,
        `Codebase '${codebaseId}' is not consented for provider source access`,
      ));
    }
  }

  const knowledgeRegistry = getDefaultExternalKnowledgeSourceRegistry();
  for (const sourceId of knowledgeSourceIds) {
    const source = knowledgeRegistry.get(sourceId, scope);
    if (!source) {
      throw new Error(localize(
        outputLanguage,
        `当前分析范围内未找到知识源“${sourceId}”`,
        `Knowledge source '${sourceId}' not found in the current analysis scope`,
      ));
    }
    if (
      !source.rightsAcknowledged ||
      !source.sendToProvider ||
      !externalKnowledgeSourceHasActiveIndex(source)
    ) {
      throw new Error(localize(
        outputLanguage,
        `知识源“${sourceId}”未激活，或尚未授权给模型服务使用`,
        `Knowledge source '${sourceId}' is inactive or not consented for provider use`,
      ));
    }
  }
}

export function envelopesFromStreamingUpdate(update: StreamingUpdate): DataEnvelope[] {
  if (update.type !== 'data') return [];
  const raw = Array.isArray(update.content) ? update.content : [update.content];
  return raw.filter((item): item is DataEnvelope =>
    Boolean(item && typeof item === 'object' && validateDataEnvelope(item).length === 0));
}

export function shouldExposeLiveStreamingUpdate(update: StreamingUpdate): boolean {
  return update.type !== 'conclusion' && update.type !== 'answer_token';
}

/**
 * Singleton per CLI process.
 * - Own `AssistantApplicationService` — no HTTP routes touch it, so the 30-min
 *   idle cleanup (only scheduled from agentRoutes.ts) never runs.
 * - `SessionPersistenceService` writes to `backend/data/sessions/sessions.db`
 *   (the same DB the HTTP server uses — intentional, so REPL sessions are
 *   visible to the web UI and vice versa).
 */
async function awaitCliFinalizationOperation<T>(operation: Promise<T>, signal: AbortSignal, deadlineMs: number): Promise<T> {
  let onAbort: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
    timer = setTimeout(() => reject(new DOMException('Finalization deadline exceeded', 'TimeoutError')),
      Math.max(0, Math.min(deadlineMs - Date.now(), 2_147_483_647)));
  });
  try { return await Promise.race([operation, interrupted]); }
  finally {clearTimeout(timer); signal.removeEventListener('abort', onAbort);}
}

interface CliAnalysisRunOwner {
  runId: string;
  controller: AbortController;
  sessionId?: string;
  abortRuntime?: () => void;
}

export class CliAnalyzeService {
  private static checkedTraceProcessorPath: string | null = null;
  private static traceProcessorInstallPromise: Promise<void> | null = null;

  // Independent AssistantApplicationService instance — intentionally separate
  // from the HTTP route's instance. The 30-min idle cleanup timer is registered
  // *only* from agentRoutes.ts at server startup, not from this constructor,
  // so a CLI-owned AppService is never subject to abandonment cleanup. This
  // matters because CLI sessions have no SSE clients (AppService's signal for
  // "abandoned"), so a shared instance would prematurely cull them.
  // ⚠ If a future change moves the cleanup timer into AssistantApplicationService's
  // constructor, this design breaks silently — pass `enableIdleCleanup: false` then.
  private readonly appService = new AssistantApplicationService<AnalyzeManagedSession>();
  private readonly persistence: SessionPersistenceService;
  private readonly analyzeService: AgentAnalyzeSessionService<AnalyzeManagedSession>;
  private readonly ownedSessionIds = new Set<string>();
  private readonly activeRuns = new Set<CliAnalysisRunOwner>();
  private readonly currentSessionRuns = new Map<string, CliAnalysisRunOwner>();
  private shuttingDown = false;
  /**
   * Traces this service loaded, so teardown can destroy exactly those.
   *
   * `TraceProcessorFactory.cleanup()` would be simpler, but it destroys every
   * processor in the process. That is indistinguishable in a real CLI run —
   * one command owns the process — and wrong everywhere else: under Jest's
   * `--runInBand` a single process hosts many suites, and a CLI teardown has no
   * business reaching into a processor another one is using.
   */
  private readonly ownedTraceIds = new Set<string>();

  constructor() {
    this.persistence = SessionPersistenceService.getInstance();
    this.analyzeService = new AgentAnalyzeSessionService<AnalyzeManagedSession>({
      assistantAppService: this.appService,
      createSessionLogger,
      sessionPersistenceService: this.persistence,
      // sessionContextManager omitted — AgentAnalyzeSessionService defaults to
      // the module-level singleton internally.
      // Only invoked on resume; PR1 covers fresh analyze only. Returning null
      // lets prepareSession fall through to a new session rather than throw.
      buildRecoveredResultFromContext: () => null,
      onSessionSecurityCleanup: sessionId => {
        this.currentSessionRuns.get(sessionId)?.controller.abort(new AnalysisContextAuthorizationChangedError());
        revokeCodeAwareOutputGuards(sessionId);
      },
    });
  }

  async loadTrace(tracePath: string): Promise<string> {
    await this.ensureTraceProcessorAvailable();
    const service = getTraceProcessorService();
    const traceId = await service.loadTraceFromFilePath(tracePath);
    this.ownedTraceIds.add(traceId);
    // `loadTraceFromFilePath` awaits processing, so the status is already
    // terminal here. Fail now rather than letting an unreadable file reach the
    // runtime: trace_processor exits on it, every `execute_sql` then fails, and
    // the model spends a full turn budget discovering there is nothing to
    // analyse — ending in a "completed" session and exit 0.
    //
    // The authority is trace_processor's own verdict, not our format detector:
    // that detector names three formats, while trace_processor reads many more,
    // so rejecting on its `unknown` would trade wasted turns for refusing
    // traces the tool can actually parse.
    const trace = service.getTrace(traceId);
    if (trace?.status === 'error') {
      // trace_processor decides *whether* to fail; the detector explains *why*
      // when it can. Its raw message here is "Process exited unexpectedly with
      // code 1", which tells the reader nothing about the file they passed.
      const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
      const name = path.basename(tracePath);
      throw new Error(
        trace.traceFormat === 'unknown'
          ? localize(
              language,
              `无法识别的 trace 格式：${name} 不是本工具能读取的 trace`,
              `Unrecognized trace format: ${name} is not a trace this tool can read`,
            )
          : localize(
              language,
              `无法读取 trace：${trace.error ?? '未知错误'}`,
              `Trace could not be read: ${trace.error ?? 'unknown error'}`,
            ),
      );
    }
    return traceId;
  }

  /**
   * Resume-only path: try to reload an existing trace by its original id,
   * preserving identity so the persisted session's `traceId` still matches.
   * Returns true on success, false if the trace file has been evicted from
   * `uploads/traces/` (caller should then degrade to a fresh load).
   */
  async reloadTraceById(traceId: string): Promise<boolean> {
    await this.ensureTraceProcessorAvailable();
    const info = await getTraceProcessorService().getOrLoadTrace(traceId);
    return info !== undefined;
  }

  async queryTrace(traceId: string, sql: string): Promise<QueryResult> {
    await this.ensureTraceProcessorAvailable();
    return getTraceProcessorService().query(traceId, sql);
  }

  async prepareTraceProcessor(): Promise<void> {
    await this.ensureTraceProcessorAvailable();
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
    if (this.shuttingDown) throw new DOMException('CLI service is shutting down', 'AbortError');
    const run: CliAnalysisRunOwner = {runId: randomUUID(), controller: new AbortController()};
    this.activeRuns.add(run);
    const abort = () => run.controller.abort(input.signal?.reason);
    const abortRuntime = () => run.abortRuntime?.();
    input.signal?.addEventListener('abort', abort, {once: true});
    run.controller.signal.addEventListener('abort', abortRuntime, {once: true});
    if (input.signal?.aborted) abort();
    const release = () => {
      input.signal?.removeEventListener('abort', abort);
      run.controller.signal.removeEventListener('abort', abortRuntime);
      this.activeRuns.delete(run);
      if (run.sessionId && this.currentSessionRuns.get(run.sessionId) === run) this.currentSessionRuns.delete(run.sessionId);
    };
    try {
      return await this.runOwnedTurn(input, run);
    } finally {
      release();
    }
  }

  private async runOwnedTurn(input: RunTurnInput, run: CliAnalysisRunOwner): Promise<RunTurnOutput> {
    run.controller.signal.throwIfAborted();
    // Resolve traceId: either passed in (we assume caller already loaded), or load now.
    let traceId = input.traceId;
    if (!traceId) {
      if (!input.tracePath) {
        throw new Error('runTurn requires either tracePath or traceId');
      }
      traceId = await this.loadTrace(input.tracePath);
      run.controller.signal.throwIfAborted();
    }

    const knowledgeScope = resolveCodebaseScope();
    const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const effectiveCodeAwareMode = resolveEffectiveCliCodeAwareMode(input);
    const effectiveInput: RunTurnInput = {
      ...input,
      codeAwareMode: effectiveCodeAwareMode,
    };
    validateCliAnalysisContext(effectiveInput, knowledgeScope);

    if (isCliE2eFakeMode()) {
      const output = await runCliE2eFakeTurn(effectiveInput, traceId);
      run.controller.signal.throwIfAborted();
      this.ownedSessionIds.add(output.sessionId);
      return output;
    }

    const analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(effectiveInput, knowledgeScope);
    const sourceActivation = resolveAnalysisSourceActivation({
      query: input.query,
      analysisMode: input.analysisMode,
      codeAwareMode: effectiveCodeAwareMode,
      codebaseIds: input.codebaseIds,
    });
    const primaryOptions: AnalysisOptions = projectPrimaryAnalysisOptions({
      analysisMode: input.analysisMode,
      codeAwareMode: effectiveCodeAwareMode,
      codebaseIds: input.codebaseIds,
      knowledgeSourceIds: input.knowledgeSourceIds,
      analysisContextFingerprint,
    }, sourceActivation);
    const primaryPrivateKnowledge = Boolean(
      (primaryOptions.codeAwareMode !== 'off' && primaryOptions.codebaseIds?.length) ||
      primaryOptions.knowledgeSourceIds?.length
    );
    const { sessionId, session } = this.analyzeService.prepareSession({
      traceId,
      query: input.query,
      requestedSessionId: input.sessionId,
      referenceTraceId: input.referenceTraceId,
      analysisContextFingerprint,
      providerScope: knowledgeScope,
      options: {
        ...knowledgeScope,
        outputLanguage,
        codeAwareMode: primaryOptions.codeAwareMode,
        codebaseIds: primaryOptions.codebaseIds,
        knowledgeSourceIds: primaryOptions.knowledgeSourceIds,
      },
    });
    this.currentSessionRuns.get(sessionId)?.controller.abort(new DOMException('CLI run superseded', 'AbortError'));
    this.currentSessionRuns.set(sessionId, run);
    run.sessionId = sessionId;
    run.abortRuntime = () => {
      void Promise.resolve().then(() => session.orchestrator.abortSession?.(sessionId)).catch(() => undefined);
    };
    let ownedRunSequence: number | undefined;
    const assertActive = () => {
      run.controller.signal.throwIfAborted();
      if (this.currentSessionRuns.get(sessionId) !== run ||
        (ownedRunSequence !== undefined && session.runSequence !== ownedRunSequence)) {
        throw new DOMException('CLI run is no longer current', 'AbortError');
      }
      assertCurrentAnalysisContextAuthorization(effectiveInput, knowledgeScope, analysisContextFingerprint);
    };
    assertActive();
    this.ownedSessionIds.add(sessionId);
    const resetQuery = await resetRuntimeForSourceActivation({
      orchestrator: session.orchestrator,
      sessionId,
      query: input.query,
      previousActivation: session.sourceActivation,
      nextActivation: sourceActivation,
      queryHistory: session.queryHistory,
      conclusionHistory: session.conclusionHistory,
    });
    assertActive();
    if (resetQuery) session.agentQuery = resetQuery;
    session.sourceActivation = sourceActivation;
    session.sourceAuthorization =
      effectiveCodeAwareMode !== 'off' && input.codebaseIds?.length
        ? {
            codeAwareMode: effectiveCodeAwareMode,
            codebaseIds: [...input.codebaseIds],
            analysisContextFingerprint,
          }
        : undefined;
    session.codeAwareMode = primaryOptions.codeAwareMode;
    session.codebaseIds = primaryOptions.codebaseIds;
    session.knowledgeSourceIds = primaryOptions.knowledgeSourceIds;
    session.analysisContextFingerprint = analysisContextFingerprint;
    if (primaryPrivateKnowledge) registerPrivateAnalysisQueryForEcho(sessionId, input.query);
    if (input.lineage) {
      session.lineage = input.lineage;
    }
    session.tenantId = knowledgeScope.tenantId;
    session.workspaceId = knowledgeScope.workspaceId;
    session.userId = knowledgeScope.userId;
    const effectiveReferenceTraceId = input.referenceTraceId ?? session.referenceTraceId;

    // Bump runSequence for this turn. HTTP route gets the incremented value
    // from an externally-constructed runContext; CLI increments inline so the
    // turn index used by appendMessages (msg-<session>-turn<N>-role) is unique
    // across turns rather than colliding with prior turns of the same session.
    session.runSequence = (session.runSequence || 0) + 1;
    ownedRunSequence = session.runSequence;
    session.queryHistory ??= [];
    session.queryHistory.push({
      turn: session.runSequence,
      query: input.query,
      timestamp: Date.now(),
      sourceDerived: sourceActivation === 'dormant' ? undefined : true,
    });
    const requestedAnalysisMode = resolveEffectiveAnalysisMode(input.analysisMode, {
      referenceTraceId: effectiveReferenceTraceId,
      knowledgeSourceIds: input.knowledgeSourceIds,
    });
    if (!session.runtimeKind) {
      throw new Error(`run_manifest_runtime_missing:${sessionId}`);
    }
    const resolvedScope = resolveKnowledgeScope(knowledgeScope);
    // A private-knowledge run records the projected message in the durable row,
    // never the user's own query — same rule as the HTTP run scope.
    const analysisRunScope = cliAnalysisRunScope(session, {
      sessionId,
      runId: run.runId,
      traceId,
      query: primaryPrivateKnowledge ? privateAnalysisQueryMessage(outputLanguage) : input.query,
      mode: requestedAnalysisMode,
    });
    const runtimeRegistrySnapshot = await getEffectiveRuntimeRegistrySnapshot({
      scope: resolvedScope,
    });
    assertActive();
    const runManifestLifecycle = createRunManifestLifecycle({
      runId: run.runId,
      sessionId,
      scope: {
        tenantId: resolvedScope.tenantId,
        workspaceId: resolvedScope.workspaceId,
      },
      userId: resolvedScope.userId,
      runtime: session.runtimeKind,
      providerId: session.providerId ?? null,
      ...(session.providerSnapshotHash
        ? {providerSnapshotHash: session.providerSnapshotHash}
        : {}),
      outputLanguage,
      analysisMode: requestedAnalysisMode,
      referenceTraceId: effectiveReferenceTraceId,
      skillRegistry: buildSkillRegistryAttribution(
        runtimeRegistrySnapshot.skillRegistry,
      ),
      runtimeRegistrySnapshot,
    });
    const cliTurnPath = primaryPrivateKnowledge ? undefined : input.resolveCliTurnPath(sessionId, input.turn);

    let traceProcessorLeases: AnalysisRunTraceProcessorLeases | undefined;
    // Set once the durable parent exists, so the terminal writes below close
    // only a run that was actually opened.
    let openRunScope: AnalysisRunPersistenceScope | undefined;
    try {
      traceProcessorLeases = await prepareAnalysisRunTraceProcessorLeases({
        service: getTraceProcessorService(), scope: resolvedScope, runId: run.runId, sessionId,
        currentTraceId: traceId, referenceTraceId: effectiveReferenceTraceId,
        signal: run.controller.signal, assertCurrent: assertActive,
        onInvalidated: error => run.controller.abort(error),
      });
      const turnOutput = await traceProcessorLeases.run(() => withRunManifestLifecycle(runManifestLifecycle, async () => {
        // Surface sessionId to the caller now, before analyze() starts emitting
        // events. Without this, callers must buffer events until runTurn resolves,
        // which accumulates the entire analyze run's output in memory.
        assertActive();
        input.onSessionReady?.(sessionId);
        assertActive();

        const orchestrator = session.orchestrator;

        // Subscribe to live updates. Wrap in off()-on-finally to avoid handler leaks
        // if runTurn is called multiple times within one CLI process (REPL path).
        const handler = (update: StreamingUpdate) => {
          try { assertActive(); } catch (error) { run.controller.abort(error); return; }
          const envelopes = envelopesFromStreamingUpdate(update);
          if (envelopes.length > 0) {
            session.dataEnvelopes.push(...envelopes);
          }
          const projectedUpdate = projectOwnerCodeAwareStreamingUpdate(
            sessionId,
            update,
            primaryPrivateKnowledge,
            outputLanguage,
          );
          if (!projectedUpdate || !shouldExposeLiveStreamingUpdate(projectedUpdate)) return;
          try {
            assertActive();
            input.onEvent(projectedUpdate);
          } catch (err) {
            // Don't let a renderer bug kill the analysis — log and continue.
            console.error('[CliAnalyzeService] onEvent handler threw:', (err as Error).message);
          }
        };
        orchestrator.on('update', handler);

        let result: AnalysisResult;
        let context: RuntimeFinalizationContext | undefined;
        let contextTransferred = false;
        let finalQualityIssue: FinalResultQualityIssue | undefined;
        const agentQuery =
          session.agentQuery && session.query === input.query
            ? session.agentQuery
            : buildAgentQueryWithContinuityNotice(input.query, session.continuityBreaks);
        try {
          let runtimeOptions: AnalysisOptions = {
            providerId: session.providerId,
            runId: run.runId,
            referenceTraceId: effectiveReferenceTraceId,
            analysisMode: requestedAnalysisMode,
            codeAwareMode: primaryOptions.codeAwareMode,
            codebaseIds: primaryOptions.codebaseIds,
            knowledgeSourceIds: primaryOptions.knowledgeSourceIds,
            sourceUsePolicy: primaryOptions.sourceUsePolicy,
            analysisContextFingerprint: primaryOptions.analysisContextFingerprint,
            runManifestAttributionSink: runManifestLifecycle.builder,
            ...knowledgeScope,
          };
          if (input.history?.length) {
            // Current source activation controls both the preview and later tool reads.
            const history = input.history.filter(turn => !turn.sourceDerived ||
              (primaryPrivateKnowledge && Boolean(turn.analysisContextFingerprint) &&
                turn.analysisContextFingerprint === analysisContextFingerprint));
            const backendHistory = createRuntimeAnalysisHistoryReader({options: runtimeOptions,
              sessionId, traceId, assertActive,
              getTurns: () => sessionContextManager.get(sessionId, traceId)?.getAnalysisHistory?.() ?? []});
            const reader = createAnalysisHistoryReader({assertActive, getTurns: () => {
              const merged = new Map(history.map(turn => [turn.id, turn]));
              for (const turn of backendHistory.getTurns()) merged.set(turn.id, turn);
              return [...merged.values()];
            }});
            runtimeOptions = withAnalysisHistoryReader(runtimeOptions, reader);
          }
          result = await orchestrator.analyze(agentQuery, sessionId, traceId, runtimeOptions);
          context = takeFinalizationContext(result);
          orchestrator.off('update', handler);
          assertActive();
          if (context && context.runId !== run.runId) throw new Error('finalization_run_identity_mismatch');
          const runtimeDeadlineMs = context?.deadlineMs ?? 0;
          const allowAutomaticPrefetch = context
            ? resolveRuntimeTurnPolicy(context.turnIntent, requestedAnalysisMode).allowAutomaticPrefetch : false;
          if (allowAutomaticPrefetch && Date.now() < runtimeDeadlineMs) {
            try {
              const summary = await awaitCliFinalizationOperation(
                executeManagedTraceSummaryV1(getTraceProcessorService(), traceId, 'current'), run.controller.signal, runtimeDeadlineMs);
              assertActive();
              session.traceSummary = buildTraceSummaryAttributionV1(summary);
            } catch {
              assertActive();
              session.traceSummary = buildTraceSummaryAttributionV1(unavailableTraceSummaryV1('trace_processor_session_unavailable'));
            }
          }
          assertActive();
          const comparisonIdentityRead = effectiveReferenceTraceId
            ? resolveCapturedComparisonIdentity({currentTraceId: traceId,
              referenceTraceId: effectiveReferenceTraceId, dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
              context, signal: run.controller.signal, reportSection: session.comparisonReportSection})
            : undefined;
          const comparisonIdentity = comparisonIdentityRead
            ? context ? await awaitCliFinalizationOperation(comparisonIdentityRead, run.controller.signal, runtimeDeadlineMs)
              : await comparisonIdentityRead
            : undefined;
          assertActive();
          contextTransferred = true;
          const finalized = await finalizeAnalysisResult({result, context, query: input.query,
            owner: {runId: run.runId, signal: run.controller.signal,
              ...(primaryOptions.analysisContextFingerprint !== undefined
                ? {analysisContextFingerprint: primaryOptions.analysisContextFingerprint} : {}),
              isCurrent: () => this.currentSessionRuns.get(sessionId) === run && session.runSequence === ownedRunSequence,
              assertAuthorized: () => assertCurrentAnalysisContextAuthorization(effectiveInput, knowledgeScope, analysisContextFingerprint)},
            dataEnvelopes: session.dataEnvelopes as DataEnvelope[], comparisonReportSection: session.comparisonReportSection,
            ...(comparisonIdentity ? {comparisonIdentity} : {}),
            caseRetrieval: {status: 'not_checked', recommendations: []},
            // The runtime update handler is already detached; report the review directly.
            onProgress: event => {
              try {
                assertActive();
                input.onEvent(finalReviewProgressUpdate(event, outputLanguage));
              } catch (err) {
                console.error('[CliAnalyzeService] onEvent handler threw:', (err as Error).message);
              }
            },
          });
          assertActive();
          result = finalized.result;
          finalQualityIssue = finalized.qualityIssue;
        } catch (error) {
          if (error instanceof AnalysisContextAuthorizationChangedError) {
            orchestrator.off('update', handler);
            revokeCodeAwareOutputGuards(sessionId);
            sessionContextManager.remove(sessionId);
            if (typeof orchestrator.cleanupSession === 'function') {
              await Promise.resolve(orchestrator.cleanupSession(sessionId)).catch(() => undefined);
            }
          }
          throw error;
        } finally {
          orchestrator.off('update', handler);
          if (!contextTransferred) context?.dispose();
        }
        assertActive();
        session.codeAwareMode = primaryOptions.codeAwareMode;
        session.codebaseIds = primaryOptions.codebaseIds;
        session.knowledgeSourceIds = primaryOptions.knowledgeSourceIds;
        session.claimSupport = result.claimSupport;
        session.claimVerificationResult = result.claimVerificationResult;
        session.identityResolutions = result.identityResolutions;
        if (finalQualityIssue) {
          try {
            input.onEvent({
              type: 'degraded',
              content: {
                module: 'cliAnalyzeService',
                fallback: 'final_result_quality_gate',
                code: finalQualityIssue.code,
                partial: true,
                message: result.terminationMessage || finalQualityIssue.message,
              },
              timestamp: Date.now(),
            });
          } catch (err) {
            console.error('[CliAnalyzeService] onEvent handler threw:', (err as Error).message);
          }
        }
        assertActive();
        result.uiActionProposals = deriveUiActionProposals({
          dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
          currentTraceId: traceId,
          existingProposals: result.uiActionProposals,
        });
        session.conclusionHistory ??= [];
        if (result.conclusion) {
          session.conclusionHistory.push({
            turn: session.runSequence ?? 1,
            conclusion: result.conclusion,
            confidence: result.confidence ?? 0,
            timestamp: Date.now(),
            sourceDerived: sourceActivation === 'bounded_explicit' ? true : undefined,
          });
        }
        assertActive();
        recordAdaptiveRoutingPostEvidenceBestEffort({
          builder: runManifestLifecycle.builder,
          result,
          dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
        });
        const runManifest = runManifestLifecycle.sealOnceAndPersist({
          turnCount:
            Number.isSafeInteger(result.rounds) && result.rounds >= 0
              ? result.rounds
              : 0,
        });
        result.analysisReceipt = buildAnalysisReceipt({
          runManifestId: runManifest.runManifestId,
          runId: runManifest.runId,
          capabilityManifest: runManifest.capabilityManifest,
          ...(runManifest.adaptiveRouting
            ? {adaptiveRouting: runManifest.adaptiveRouting}
            : {}),
          session,
          result,
          quickRun: result.quickRun,
          providerId: session.providerId ?? null,
          cliTurnPath,
        });
        assertActive();
        session.result = result;
        sessionContextManager.get(sessionId, traceId)?.annotateLatestCompletedTurn({
          success: result.success,
          findings: result.findings,
          message: result.conclusion,
          confidence: result.confidence,
          partial: result.partial,
          terminationReason: result.terminationReason,
          terminationMessage: result.terminationMessage,
          completion: result.completion,
          outputOrigin: result.outputOrigin,
          conclusionContract: result.conclusionContract,
          claimSupport: result.claimSupport,
          claimVerificationResult: result.claimVerificationResult,
          identityResolutions: result.identityResolutions,
        });

        // Persist to SQLite BEFORE building the report — the snapshot is stashed on
        // the session as `_lastSnapshot` and read by the HTML generator. Routes
        // through the same shared helper the HTTP layer uses, so any future schema
        // change applies to both paths automatically.
        assertActive();
        // Open the durable parent here rather than at run start. `append` fails
        // closed without it, but a `running` row blocks trace deletion and holds
        // a quota slot (simpleTraceRoutes DELETE_BLOCKING_RUN_STATUSES,
        // enterpriseQuotaPolicyService ACTIVE_RUN_STATUSES), and nothing
        // reconciles a CLI-owned row: failInterruptedAnalysisRunsOnStartup runs
        // only in the backend process. Ctrl-C is routine here and unwinds
        // nothing, so the open window stays seconds rather than the whole
        // analysis, and an aborted turn leaves no durable row at all.
        recordCliAnalysisRunState(analysisRunScope, 'running');
        openRunScope = analysisRunScope;
        persistAgentTurn({
          session,
          sessionId,
          traceId,
          query: input.query,
          result,
        });

        const persistedSnapshot = (
          session as unknown as {
            _lastSnapshot?: SessionStateSnapshot;
          }
        )._lastSnapshot;
        const persistedRuntimeKind = getSnapshotRuntimeKind(persistedSnapshot);
        const persistedProviderId = getSnapshotRuntimeProviderId(persistedSnapshot);
        const persistedProviderSnapshotHash = getSnapshotRuntimeProviderSnapshotHash(persistedSnapshot);
        const runtimeSelection = persistedRuntimeKind ? null : resolveAgentRuntimeSelection(session.providerId ?? null);
        const resolvedRuntimeKind = persistedRuntimeKind ?? runtimeSelection?.kind;
        const publicRuntimeKind = isProductionAgentRuntimeKind(resolvedRuntimeKind) ? resolvedRuntimeKind : undefined;
        const modelRuntimeSelection = runtimeSelection ?? {
          kind: resolvedRuntimeKind!,
          source: persistedProviderId ? 'provider' as const : 'env' as const,
          ...(persistedProviderId ? {providerId: persistedProviderId} : {}),
        };
        let model: string | undefined;
        try {
          model = getRuntimeDiagnosticModel(
            getRuntimeDiagnostics(modelRuntimeSelection),
          ) || undefined;
        } catch (error) {
          // Provenance is optional metadata. Do not turn a completed analysis into
          // a CLI failure when a runtime's diagnostic adapter is unavailable.
          console.warn(
            '[CliAnalyzeService] Failed to resolve runtime model provenance:',
            (error as Error).message,
          );
        }

        // SDK/session id is runtime-specific and exposed only through the orchestrator hook.
        const sdkSessionId =
          typeof orchestrator.getSdkSessionId === 'function'
            ? orchestrator.getSdkSessionId(sessionId, effectiveReferenceTraceId)
            : undefined;

        assertActive();
        const reportOutput = this.buildReportHtml(session, result);
        const durableResult = primaryPrivateKnowledge
          ? projectOwnerAnalysisResult(sessionId, result, outputLanguage)
          : result;

        assertActive();
        return {
          sessionId,
          traceId,
          sdkSessionId,
          result: durableResult,
          reportHtml: reportOutput.html,
          reportError:
            primaryPrivateKnowledge && reportOutput.error
              ? projectOwnerAnalysisError(sessionId, reportOutput.error, outputLanguage)
              : reportOutput.error,
          model,
          providerId: persistedProviderId !== undefined ? persistedProviderId : (session.providerId ?? null),
          agentRuntimeKind: publicRuntimeKind,
          providerSnapshotHash:
            persistedProviderSnapshotHash !== undefined
              ? persistedProviderSnapshotHash
              : (session.providerSnapshotHash ?? null),
          codeAwareMode: effectiveCodeAwareMode,
          privateKnowledge: primaryPrivateKnowledge,
          analysisContextFingerprint,
        };
      }));
      recordCliAnalysisRunState(openRunScope, 'completed');
      return turnOutput;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordCliAnalysisRunState(
        openRunScope,
        run.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'cancelled' : 'failed',
        primaryPrivateKnowledge ? projectOwnerAnalysisError(sessionId, message, outputLanguage) : message,
      );
      if (runManifestLifecycle.state === 'collecting') {
        try {
          runManifestLifecycle.sealOnceAndPersist({
            turnCount: 0,
            closePendingSkillInvocationsAsErrors: true,
          });
        } catch (manifestError) {
          console.error(
            '[CliAnalyzeService] Failed to persist terminal run manifest:',
            (manifestError as Error).message,
          );
        }
      }
      throw error;
    } finally {
      traceProcessorLeases?.release();
      runManifestLifecycle.dispose();
    }
  }

  /**
   * Render the finalized result without re-normalizing its signed conclusion or verification.
   */
  private buildReportHtml(
    session: AnalyzeManagedSession,
    result: AnalysisResult,
  ): { html?: string; error?: string } {
    try {
      const reportData = buildAgentDrivenReportData({session, result});
      const html = getHTMLReportGenerator().generateAgentDrivenHTML(reportData);
      return { html };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  private async ensureTraceProcessorAvailable(): Promise<void> {
    const traceProcessorPath = getTraceProcessorPath();
    if (CliAnalyzeService.checkedTraceProcessorPath === traceProcessorPath) return;

    if (!fs.existsSync(traceProcessorPath)) {
      if (process.env.TRACE_PROCESSOR_PATH) {
        throw new Error(
          [
            `trace_processor_shell binary not found at TRACE_PROCESSOR_PATH: ${traceProcessorPath}`,
            '',
            'Fix TRACE_PROCESSOR_PATH or unset it to let SmartPerfetto download the pinned binary automatically.',
          ].join('\n'),
        );
      }

      await this.installTraceProcessor(traceProcessorPath);
    }

    try {
      fs.accessSync(traceProcessorPath, fs.constants.X_OK);
    } catch {
      throw new Error(
        [
          `trace_processor_shell is not executable: ${traceProcessorPath}`,
          '',
          `Run \`chmod +x ${traceProcessorPath}\`, or set TRACE_PROCESSOR_PATH to an executable binary.`,
        ].join('\n'),
      );
    }

    CliAnalyzeService.checkedTraceProcessorPath = traceProcessorPath;
  }

  private async installTraceProcessor(traceProcessorPath: string): Promise<void> {
    if (!CliAnalyzeService.traceProcessorInstallPromise) {
      console.error(`trace_processor_shell not found. Downloading pinned Perfetto binary to ${traceProcessorPath}...`);
      CliAnalyzeService.traceProcessorInstallPromise = installTraceProcessorPrebuilt(traceProcessorPath)
        .finally(() => {
          CliAnalyzeService.traceProcessorInstallPromise = null;
        });
    }
    await CliAnalyzeService.traceProcessorInstallPromise;
  }

  /**
   * Best-effort teardown. Called by CLI on process exit to stop the
   * trace_processor_shell subprocess — otherwise Node waits on it.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const run of this.activeRuns) run.controller.abort(new DOMException('CLI shutdown', 'AbortError'));
    for (const sessionId of this.ownedSessionIds) clearCodeAwareOutputGuards(sessionId);
    this.ownedSessionIds.clear();
    try {
      await getTraceProcessorService().cleanup();
    } catch {
      /* ignore — already cleaned or never started */
    }
    // The line above retires *traces*, and only those uploaded over two hours
    // ago that have also been idle for thirty minutes — a trace this command
    // loaded seconds ago can never match it. Destroying the processors is a
    // separate call, and without it the shell outlives the CLI as an orphan
    // (PPID 1) holding a port from the 9100-9900 pool and its resident trace.
    // One invocation leaks one; the pool is what runs out first.
    // Teardown runs from a `finally`, after the command has already restored
    // console.log and printed its result, so the factory's own log line would
    // land on stdout underneath the output — machine-readable formats included.
    await withConsoleLogToStderr(true, () => {
      for (const traceId of this.ownedTraceIds) {
        try {
          TraceProcessorFactory.remove(traceId);
        } catch {
          /* ignore — already gone */
        }
      }
      this.ownedTraceIds.clear();
    });
  }
}

function isCliE2eFakeMode(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.SMARTPERFETTO_CLI_E2E_FAKE === '1';
}

async function runCliE2eFakeTurn(input: RunTurnInput, traceId: string): Promise<RunTurnOutput> {
  const sessionId = input.sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  input.onSessionReady?.(sessionId);

  const startedAt = Date.now();
  const timestamp = Date.now();
  const codeAware = buildCliE2eFakeCodeAwareContext(input);
  const baseConclusion = process.env.SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE?.trim() || [
    'CLI E2E fake analysis completed.',
    `Question: ${input.query}`,
    `Trace: ${traceId}`,
    ...(input.referenceTraceId ? [`Reference trace: ${input.referenceTraceId}`] : []),
  ].join('\n');
  const fakeConclusion = codeAware.codeReferences.length > 0
    ? [
        baseConclusion,
        '',
        'Code-aware source references:',
        ...codeAware.codeReferences.map(ref => {
          const lineRange = ref.lineRange ? `:${ref.lineRange.start}-${ref.lineRange.end}` : '';
          const symbol = ref.symbol ? `${ref.symbol} ` : '';
          return `- CodeRef ${symbol}${ref.filePath}${lineRange} (chunkId=${ref.chunkId}, codebaseId=${ref.codebaseId})`;
        }),
      ].join('\n')
    : baseConclusion;

  input.onEvent({
    type: 'progress',
    content: {
      phase: 'cli-e2e-fake',
      message: 'running deterministic fake CLI analysis',
    },
    timestamp,
  });
  input.onEvent({
    type: 'thought',
    content: {
      thought: codeAware.codeReferences.length > 0
        ? 'Using SMARTPERFETTO_CLI_E2E_FAKE with deterministic code-aware symbol lookup to exercise source-level report rendering without a live LLM.'
        : 'Using SMARTPERFETTO_CLI_E2E_FAKE to exercise CLI persistence and rendering without a live LLM.',
    },
    timestamp,
  });
  input.onEvent({
    type: 'conclusion',
    content: {
      conclusion: fakeConclusion,
    },
    timestamp,
  });

  const totalDurationMs = Math.max(1, Date.now() - startedAt);
  const conclusionContract: AnalysisResult['conclusionContract'] = codeAware.sourceUseDecision
    ? {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [{
          rank: 1,
          statement: codeAware.codeReferences.length > 0
            ? 'Deterministic code-aware CLI E2E conclusion references source-level CodeRefs.'
            : 'Deterministic code-aware CLI E2E lookup returned no source locations.',
          confidencePercent: 100,
        }],
        clusters: [],
        evidenceChain: codeAware.codeReferences.length > 0 ? [{
          conclusionId: 'cli-e2e-code-aware',
          text: 'CodeRef metadata was resolved from the registered local codebase RAG store.',
        }] : [],
        claims: [],
        uncertainties: [],
        nextSteps: [],
        metadata: {
          confidencePercent: 100,
          rounds: 1,
        },
        sourceReferences: codeAware.codeReferences,
        sourceUseDecision: codeAware.sourceUseDecision,
      }
    : undefined;
  const claimSupport: NonNullable<AnalysisResult['claimSupport']> = [];
  const claimVerificationResult: NonNullable<AnalysisResult['claimVerificationResult']> = {
    schemaVersion: 'claim_verifier@1',
    status: 'not_checked',
    policy: 'record_only',
    notCheckedReason: 'CLI E2E fake mode does not emit structured claims',
    passed: false,
    checkedClaimCount: 0,
    unsupportedClaimCount: 0,
    claimResults: [],
    issues: [],
  };
  const output: RunTurnOutput = {
    sessionId,
    traceId,
    sdkSessionId: `cli-e2e-fake-${sessionId}`,
    model: 'cli-e2e-fake',
    providerId: null,
    agentRuntimeKind: 'openai-agents-sdk',
    providerSnapshotHash: null,
    codeAwareMode: input.codeAwareMode ?? 'off',
    privateKnowledge: false,
    reportHtml: buildCliE2eFakeReportHtml({
      sessionId,
      traceId,
      referenceTraceId: input.referenceTraceId,
      query: input.query,
      conclusion: fakeConclusion,
      conclusionContract,
      sourceUseDecision: codeAware.sourceUseDecision,
      claimSupport,
      claimVerificationResult,
      identityResolutions: [],
      totalDurationMs,
    }),
    result: {
      sessionId,
      success: true,
      findings: [
        {
          id: 'cli-e2e-fake-finding',
          severity: 'info',
          title: 'CLI E2E fake finding',
          description: 'Deterministic finding emitted by the CLI E2E fake runtime.',
          confidence: 1,
          source: 'cli-e2e',
        },
      ],
      hypotheses: [],
      conclusion: fakeConclusion,
      ...(conclusionContract ? { conclusionContract } : {}),
      ...(codeAware.sourceUseDecision ? {
        sourceUseDecision: codeAware.sourceUseDecision,
        sourceReferences: codeAware.codeReferences,
      } : {}),
      claimSupport,
      claimVerificationResult,
      identityResolutions: [],
      confidence: 1,
      rounds: 1,
      totalDurationMs,
    },
  };
  const privateKnowledge = Boolean(
    (output.codeAwareMode !== 'off' && input.codebaseIds?.length)
    || input.knowledgeSourceIds?.length,
  );
  if (!privateKnowledge) return output;
  const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const durableResult = projectOwnerAnalysisResult(sessionId, output.result, outputLanguage);
  return {
    ...output,
    privateKnowledge: true,
    result: durableResult,
    reportHtml: buildCliE2eFakeReportHtml({
      sessionId,
      traceId,
      referenceTraceId: input.referenceTraceId,
      query: privateAnalysisQueryMessage(outputLanguage),
      conclusion: durableResult.conclusion,
      conclusionContract: durableResult.conclusionContract,
      sourceUseDecision: durableResult.sourceUseDecision,
      claimSupport: [],
      claimVerificationResult: durableResult.claimVerificationResult,
      identityResolutions: [],
      totalDurationMs,
    }),
  };
}

function buildCliE2eFakeCodeAwareContext(input: RunTurnInput): {
  codeReferences: SourceReferenceV1[];
  sourceUseDecision?: SourceUseDecisionV1;
} {
  if (!input.codeAwareMode || input.codeAwareMode === 'off' || !input.codebaseIds?.length) {
    return {codeReferences: []};
  }

  const store = new RagStore(backendLogPath('rag_store.json'));
  const registry = new CodebaseRegistry(backendLogPath('codebase_registry.json'));
  const resolver = new SymbolResolver(store, resolveCodebaseScope(), registry);
  const symbols = [
    'MainActivity',
    'onActivityCreate',
    'LoadSimulator',
    'simulateAsyncNetworkLoad',
    'runChaosLoop',
    'LaunchConfig',
    'LoadConfig',
  ];
  const refs = new Map<string, SourceReferenceV1>();
  const selectedCodebaseIds = [...new Set(input.codebaseIds)];
  const queriedCodebaseIds = new Set<string>();

  for (const codebaseId of selectedCodebaseIds) {
    for (const symbol of symbols) {
      queriedCodebaseIds.add(codebaseId);
      const resolved = resolver.resolveApp({symbol, codebaseId, topK: 2});
      if (!resolved.success) continue;
      for (const candidate of resolved.candidates) {
        const ref = candidateToCodeReference(candidate, codebaseId);
        if (ref) refs.set(ref.id, ref);
      }
    }
  }

  const codeReferences = Array.from(refs.values()).slice(0, 8);
  // This records the test-only resolver execution, never a verified source claim
  // or a production MCP ledger. Fixed symbols and topK cannot prove full coverage.
  const sourceUseDecision = sanitizeSourceUseDecision({
    schemaVersion: 'source_use_decision@1',
    codeAwareMode: input.codeAwareMode,
    selectedCodebaseIds,
    status: codeReferences.length > 0 ? 'located' : 'attempted',
    attemptedTools: ['SymbolResolver.resolveApp'],
    queriedCodebaseIds: [...queriedCodebaseIds],
    usedCodebaseIds: [...new Set(codeReferences.map(reference => reference.codebaseId))],
    coverageComplete: false,
    references: codeReferences,
  }, selectedCodebaseIds);
  return {codeReferences: sourceUseDecision?.references ?? [], sourceUseDecision};
}

function candidateToCodeReference(
  candidate: ResolvedSymbolCandidate,
  queriedCodebaseId: string,
): SourceReferenceV1 | undefined {
  if (!candidate.chunkId || !candidate.filePath || candidate.codebaseId !== queriedCodebaseId) {
    return undefined;
  }
  return sanitizeSourceReference({
    chunkId: candidate.chunkId,
    codebaseId: candidate.codebaseId,
    filePath: candidate.filePath,
    ...(candidate.lineRange ? {lineRange: candidate.lineRange} : {}),
    ...(candidate.symbol ? {symbol: candidate.symbol} : {}),
    lookupKind: 'metadata',
  });
}

function buildCliE2eFakeReportHtml(input: {
  sessionId: string;
  traceId: string;
  referenceTraceId?: string;
  query: string;
  conclusion: string;
  conclusionContract?: unknown;
  sourceUseDecision?: SourceUseDecisionV1;
  claimSupport?: AnalysisResult['claimSupport'];
  claimVerificationResult?: AnalysisResult['claimVerificationResult'];
  identityResolutions?: AnalysisResult['identityResolutions'];
  totalDurationMs: number;
}): string {
  const sourceProvenance = projectSafeSourceProvenance({
    conclusionContract: input.conclusionContract,
    actualSourceUseDecision: input.sourceUseDecision,
  });
  return getHTMLReportGenerator().generateAgentDrivenHTML({
    traceId: input.traceId,
    query: input.query,
    result: {
      sessionId: input.sessionId,
      success: true,
      findings: [
        {
          id: 'cli-e2e-fake-finding',
          severity: 'info',
          title: 'CLI E2E fake finding',
          description: 'Deterministic finding emitted by the CLI E2E fake runtime.',
          confidence: 1,
          source: 'cli-e2e',
        },
      ],
      hypotheses: [],
      conclusion: input.conclusion,
      ...(input.conclusionContract ? {conclusionContract: input.conclusionContract} : {}),
      ...(sourceProvenance ? {sourceUseDecision: sourceProvenance.sourceUseDecision} : {}),
      claimSupport: input.claimSupport,
      claimVerificationResult: input.claimVerificationResult,
      identityResolutions: input.identityResolutions,
      confidence: 1,
      rounds: 1,
      totalDurationMs: input.totalDurationMs,
    },
    hypotheses: [],
    dialogue: [],
    ...(sourceProvenance ? {
      sourceContext: {
        selected: sourceProvenance.sourceUseDecision.selectedCodebaseIds.map(codebaseId => ({codebaseId})),
        ...sourceProvenance,
      },
    } : {}),
    timestamp: Date.now(),
  });
}
