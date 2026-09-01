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
import {randomUUID} from 'crypto';
import { AssistantApplicationService } from '../../assistant/application/assistantApplicationService';
import {
  AgentAnalyzeSessionService,
  buildAgentQueryWithContinuityNotice,
  type AnalyzeManagedSession,
} from '../../assistant/application/agentAnalyzeSessionService';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import { createSessionLogger } from '../../services/sessionLogger';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import { getHTMLReportGenerator } from '../../services/htmlReportGenerator';
import { buildAgentDrivenReportData } from '../../services/agentReportData';
import { normalizeResultForReport } from '../../services/agentResultNormalizer';
import { buildAnalysisReceipt } from '../../services/analysisReceiptBuilder';
import {recordAdaptiveRoutingPostEvidenceBestEffort} from '../../agentRuntime/adaptiveRoutingProjection';
import { deriveUiActionProposals } from '../../services/uiActionProposalDeriver';
import { persistAgentTurn } from '../../services/persistAgentSession';
import { applyFinalResultQualityGate } from '../../services/finalResultQualityGate';
import {runPreparedAnalysisClaimVerification} from '../../services/evidence/analysisRelationPreparation';
import {executeManagedTraceSummaryV1} from '../../services/managedTraceSummary';
import {buildTraceSummaryAttributionV1} from '../../services/traceSummaryAttribution';
import {unavailableTraceSummaryV1} from '../../services/traceSummaryExecutor';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { backendLogPath } from '../../runtimePaths';
import { RagStore } from '../../services/ragStore';
import { SymbolResolver, type ResolvedSymbolCandidate } from '../../services/symbol/symbolResolver';
import { getTraceProcessorPath } from '../../services/workingTraceProcessor';
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
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
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
import {
  runAnalysisSourceSupplement,
  type AnalysisSourceSupplementOutcome,
} from '../../services/codebase/analysisSourceSupplement';
import {
  privateAnalysisFailureMessage,
  privateAnalysisQueryMessage,
  projectPrivateAnalysisResult,
} from '../../services/security/privateAnalysisProjection';
import {registerPrivateAnalysisQueryForEcho} from '../../services/security/codeAwareOutputRegistry';
import {buildSkillRegistryAttribution} from '../../services/selfEvolution/skillFingerprint';
import {getEffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import {
  createRunManifestLifecycle,
  withRunManifestLifecycle,
} from '../../services/selfEvolution/runManifestLifecycle';

export interface RunTurnInput {
  tracePath?: string;
  traceId?: string;
  referenceTraceId?: string;
  query: string;
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
      onSessionSecurityCleanup: revokeCodeAwareOutputGuards,
    });
  }

  async loadTrace(tracePath: string): Promise<string> {
    await this.ensureTraceProcessorAvailable();
    return getTraceProcessorService().loadTraceFromFilePath(tracePath);
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
    // Resolve traceId: either passed in (we assume caller already loaded), or load now.
    let traceId = input.traceId;
    if (!traceId) {
      if (!input.tracePath) {
        throw new Error('runTurn requires either tracePath or traceId');
      }
      traceId = await this.loadTrace(input.tracePath);
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
    const durablePrivateKnowledge = primaryPrivateKnowledge || sourceActivation === 'deep_supplement';
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
    const runtimeRegistrySnapshot = await getEffectiveRuntimeRegistrySnapshot({
      scope: resolvedScope,
    });
    const runManifestLifecycle = createRunManifestLifecycle({
      runId: randomUUID(),
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
    const cliTurnPath = durablePrivateKnowledge ? undefined : input.resolveCliTurnPath(sessionId, input.turn);

    try {
      return await withRunManifestLifecycle(runManifestLifecycle, async () => {
        // Surface sessionId to the caller now, before analyze() starts emitting
        // events. Without this, callers must buffer events until runTurn resolves,
        // which accumulates the entire analyze run's output in memory.
        input.onSessionReady?.(sessionId);

        const orchestrator = session.orchestrator;

        // Subscribe to live updates. Wrap in off()-on-finally to avoid handler leaks
        // if runTurn is called multiple times within one CLI process (REPL path).
        const handler = (update: StreamingUpdate) => {
          const envelopes = envelopesFromStreamingUpdate(update);
          if (envelopes.length > 0) {
            session.dataEnvelopes.push(...envelopes);
          }
          const projectedUpdate = projectCodeAwareStreamingUpdate(
            sessionId,
            update,
            primaryPrivateKnowledge,
            outputLanguage,
          );
          if (!shouldExposeLiveStreamingUpdate(projectedUpdate)) return;
          try {
            input.onEvent(projectedUpdate);
          } catch (err) {
            // Don't let a renderer bug kill the analysis — log and continue.
            console.error('[CliAnalyzeService] onEvent handler threw:', (err as Error).message);
          }
        };
        orchestrator.on('update', handler);

        let result: AnalysisResult;
        const agentQuery =
          session.agentQuery && session.query === input.query
            ? session.agentQuery
            : buildAgentQueryWithContinuityNotice(input.query, session.continuityBreaks);
        try {
          result = await orchestrator.analyze(agentQuery, sessionId, traceId, {
            providerId: session.providerId,
            referenceTraceId: effectiveReferenceTraceId,
            analysisMode: requestedAnalysisMode,
            codeAwareMode: primaryOptions.codeAwareMode,
            codebaseIds: primaryOptions.codebaseIds,
            knowledgeSourceIds: primaryOptions.knowledgeSourceIds,
            sourceUsePolicy: primaryOptions.sourceUsePolicy,
            analysisContextFingerprint: primaryOptions.analysisContextFingerprint,
            runManifestAttributionSink: runManifestLifecycle.builder,
            ...knowledgeScope,
          });
          if (primaryPrivateKnowledge) {
            assertCurrentAnalysisContextAuthorization(effectiveInput, knowledgeScope, analysisContextFingerprint);
          }
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
        }
        session.codeAwareMode = primaryOptions.codeAwareMode;
        session.codebaseIds = primaryOptions.codebaseIds;
        session.knowledgeSourceIds = primaryOptions.knowledgeSourceIds;
        const normalized = normalizeResultForReport(result, {
          dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
        });
        result.conclusion = normalized.conclusion;
        if (normalized.conclusionContract) {
          result.conclusionContract = normalized.conclusionContract;
        }
        const qualityArtifacts = runPreparedAnalysisClaimVerification({
          conclusionContract: normalized.conclusionContract,
          dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
          comparisonReportSection: session.comparisonReportSection,
          policy: 'record_only',
        });
        result.claimSupport = qualityArtifacts.claimSupport;
        result.claimVerificationResult = qualityArtifacts.claimVerificationResult;
        result.identityResolutions = qualityArtifacts.identityResolutions;
        session.claimSupport = qualityArtifacts.claimSupport;
        session.claimVerificationResult = qualityArtifacts.claimVerificationResult;
        session.identityResolutions = qualityArtifacts.identityResolutions;
        const finalQualityIssue = applyFinalResultQualityGate({ result, query: input.query });
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
        try {
          session.traceSummary = buildTraceSummaryAttributionV1(
            await executeManagedTraceSummaryV1(
              getTraceProcessorService(),
              traceId,
              'current',
            ),
          );
        } catch {
          session.traceSummary = buildTraceSummaryAttributionV1(
            unavailableTraceSummaryV1('trace_processor_session_unavailable'),
          );
        }
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
          qualityArtifacts,
          quickRun: result.quickRun,
          providerId: session.providerId ?? null,
          cliTurnPath,
        });
        session.result = result;
        sessionContextManager.get(sessionId, traceId)?.annotateLatestCompletedTurn({
          success: result.success,
          findings: result.findings,
          message: result.conclusion,
          confidence: result.confidence,
          partial: result.partial,
          terminationReason: result.terminationReason,
          terminationMessage: result.terminationMessage,
          conclusionContract: normalized.conclusionContract,
          claimSupport: qualityArtifacts.claimSupport,
          claimVerificationResult: qualityArtifacts.claimVerificationResult,
          identityResolutions: qualityArtifacts.identityResolutions,
        });

        // Persist to SQLite BEFORE building the report — the snapshot is stashed on
        // the session as `_lastSnapshot` and read by the HTML generator. Routes
        // through the same shared helper the HTTP layer uses, so any future schema
        // change applies to both paths automatically.
        persistAgentTurn({
          session,
          sessionId,
          traceId,
          query: input.query,
          result: { conclusion: result.conclusion, totalDurationMs: result.totalDurationMs },
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

        const reportOutput = this.buildReportHtml(session, result);
        const durableResult = primaryPrivateKnowledge
          ? projectPrivateAnalysisResult(sessionId, result, outputLanguage)
          : result;
        let sourceSupplementTask: Promise<AnalysisSourceSupplementOutcome | undefined> | undefined;
        if (sourceActivation === 'deep_supplement' && session.sourceAuthorization) {
          const supplementRunId = `cli-turn-${input.turn}`;
          input.onEvent({
            type: 'analysis_source_enrichment_started',
            content: {runId: supplementRunId},
            timestamp: Date.now(),
          });
          sourceSupplementTask = runAnalysisSourceSupplement({
            orchestrator,
            sessionId,
            runId: supplementRunId,
            traceId,
            question: input.query,
            primaryConclusion: result.conclusion,
            analysisOptions: {
              providerId: session.providerId,
              outputLanguage,
              codeAwareMode: session.sourceAuthorization.codeAwareMode,
              codebaseIds: session.sourceAuthorization.codebaseIds,
              analysisContextFingerprint,
              ...knowledgeScope,
            },
          }).catch(() => undefined);
        }

        return {
          sessionId,
          traceId,
          sdkSessionId,
          result: durableResult,
          reportHtml: reportOutput.html,
          reportError:
            primaryPrivateKnowledge && reportOutput.error
              ? privateAnalysisFailureMessage(outputLanguage)
              : reportOutput.error,
          model,
          providerId: persistedProviderId !== undefined ? persistedProviderId : (session.providerId ?? null),
          agentRuntimeKind: publicRuntimeKind,
          providerSnapshotHash:
            persistedProviderSnapshotHash !== undefined
              ? persistedProviderSnapshotHash
              : (session.providerSnapshotHash ?? null),
          codeAwareMode: effectiveCodeAwareMode,
          privateKnowledge: durablePrivateKnowledge,
          ...(sourceSupplementTask ? {sourceSupplementTask} : {}),
        };
      });
    } catch (error) {
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
      runManifestLifecycle.dispose();
    }
  }

  /**
   * Build the HTML report for a completed turn. Routes through the shared
   * `normalizeResultForReport` + `buildAgentDrivenReportData` pipeline the
   * HTTP path uses, so CLI and web UI emit identical reports for the same
   * session (same sanitized conclusion text, same derived conclusionContract).
   */
  private buildReportHtml(
    session: AnalyzeManagedSession,
    result: AnalysisResult,
  ): { html?: string; error?: string } {
    try {
      const normalized = normalizeResultForReport(result, {
        dataEnvelopes: session.dataEnvelopes as DataEnvelope[],
      });
      const reportData = buildAgentDrivenReportData({
        session,
        result: {
          sessionId: session.sessionId,
          success: normalized.success,
          findings: normalized.findings,
          hypotheses: normalized.hypotheses,
          conclusion: normalized.conclusion,
          conclusionContract: normalized.conclusionContract,
          sourceUseDecision: normalized.sourceUseDecision ?? result.sourceUseDecision,
          claimSupport: normalized.claimSupport ?? result.claimSupport,
          claimVerificationResult: normalized.claimVerificationResult ?? result.claimVerificationResult,
          identityResolutions: normalized.identityResolutions ?? result.identityResolutions,
          confidence: normalized.confidence,
          rounds: normalized.rounds,
          totalDurationMs: normalized.totalDurationMs,
          partial: normalized.partial,
          terminationReason: normalized.terminationReason,
          terminationMessage: normalized.terminationMessage,
          analysisReceipt: normalized.analysisReceipt ?? result.analysisReceipt,
          uiActionProposals: normalized.uiActionProposals ?? result.uiActionProposals,
        },
      });
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
    for (const sessionId of this.ownedSessionIds) clearCodeAwareOutputGuards(sessionId);
    this.ownedSessionIds.clear();
    try {
      await getTraceProcessorService().cleanup();
    } catch {
      /* ignore — already cleaned or never started */
    }
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
  const conclusionContract = codeAware.codeReferences.length > 0
    ? {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [{
          rank: 1,
          statement: 'Deterministic code-aware CLI E2E conclusion references source-level CodeRefs.',
          confidencePercent: 100,
        }],
        clusters: [],
        evidenceChain: [{
          conclusionId: 'cli-e2e-code-aware',
          text: 'CodeRef metadata was resolved from the registered local codebase RAG store.',
        }],
        claims: [],
        uncertainties: [],
        nextSteps: [],
        metadata: {
          confidencePercent: 100,
          rounds: 1,
        },
        codeReferences: codeAware.codeReferences,
      } as AnalysisResult['conclusionContract'] & {codeReferences: CliE2eFakeCodeReference[]}
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
  const durableResult = projectPrivateAnalysisResult(sessionId, output.result, outputLanguage);
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
      claimSupport: [],
      identityResolutions: [],
      totalDurationMs,
    }),
  };
}

interface CliE2eFakeCodeReference {
  chunkId: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
}

function buildCliE2eFakeCodeAwareContext(input: RunTurnInput): {codeReferences: CliE2eFakeCodeReference[]} {
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
  const refs = new Map<string, CliE2eFakeCodeReference>();

  for (const codebaseId of input.codebaseIds) {
    for (const symbol of symbols) {
      const resolved = resolver.resolveApp({symbol, codebaseId, topK: 2});
      for (const candidate of resolved.candidates) {
        const ref = candidateToCodeReference(candidate, codebaseId);
        if (ref) refs.set(ref.chunkId, ref);
      }
    }
  }

  return {codeReferences: Array.from(refs.values()).slice(0, 8)};
}

function candidateToCodeReference(
  candidate: ResolvedSymbolCandidate,
  fallbackCodebaseId: string,
): CliE2eFakeCodeReference | undefined {
  if (!candidate.chunkId || !candidate.filePath) return undefined;
  return {
    chunkId: candidate.chunkId,
    codebaseId: candidate.codebaseId ?? fallbackCodebaseId,
    filePath: candidate.filePath,
    ...(candidate.lineRange ? {lineRange: candidate.lineRange} : {}),
    ...(candidate.symbol ? {symbol: candidate.symbol} : {}),
  };
}

function buildCliE2eFakeReportHtml(input: {
  sessionId: string;
  traceId: string;
  referenceTraceId?: string;
  query: string;
  conclusion: string;
  conclusionContract?: unknown;
  claimSupport?: AnalysisResult['claimSupport'];
  claimVerificationResult?: AnalysisResult['claimVerificationResult'];
  identityResolutions?: AnalysisResult['identityResolutions'];
  totalDurationMs: number;
}): string {
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
      claimSupport: input.claimSupport,
      claimVerificationResult: input.claimVerificationResult,
      identityResolutions: input.identityResolutions,
      confidence: 1,
      rounds: 1,
      totalDurationMs: input.totalDurationMs,
    },
    hypotheses: [],
    dialogue: [],
    timestamp: Date.now(),
  });
}
