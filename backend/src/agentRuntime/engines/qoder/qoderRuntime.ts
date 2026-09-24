// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {snapshotSceneCoverageRegistry} from '../../../agent/scene/sceneCoveragePlan';
import { EventEmitter } from 'events';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
  AnalysisOptions,
  AnalysisResult,
  IOrchestrator,
} from '../../../agent/core/orchestratorTypes';
import type { Finding, StreamingUpdate } from '../../../agent/types';
import type { ArchitectureInfo } from '../../../agent/detectors/types';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import { sessionContextManager } from '../../../agent/context/enhancedSessionContext';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
import {resolveEffectiveSkillRegistryForRuntime} from '../../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import {
  commitEvaluationSdkHandoffIfActive,
  recordEvaluationTokenDeltaIfPresent,
} from '../../../services/selfEvolution/evaluationRuntimeHooks';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {resolveRuntimeEvidenceStore} from '../../runtimeEvidenceContext';
import {activateSceneRuntime, resolveSceneProductScope} from '../../../agent/scene/sceneRuntimeBinding';
import {
  buildNegativePatternSection,
  buildPatternContextSection,
  extractTraceFeatures,
} from '../../../agentv3/analysisPatternMemory';
import {
  createClaudeMcpServer,
  loadLearnedSqlFixPairs,
} from '../../../agentv3/claudeMcpServer';
import {buildSystemPrompt} from '../../../agentv3/claudeSystemPrompt';
import { extractFindingsFromText } from '../../../agentv3/claudeFindingExtractor';
import { resolveFocusAppTarget } from '../../focusAppTarget';
import { localize, parseOutputLanguage, type OutputLanguage } from '../../../agentv3/outputLanguage';
import {buildComplexityClassifierInput} from '../../../agentv3/queryComplexityContext';
import {buildMaxTurnsTerminationMessage, estimateAnalysisConfidence} from '../../../agentv3/analysisTermination';
import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import type {
  AnalysisNote,
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  Hypothesis,
  UncertaintyFlag,
} from '../../../agentv3/types';
import {
  createQoderSnapshotEngineState,
  getQoderSnapshotEngineState,
  projectSessionFieldsForDurableSnapshot,
  sessionFieldsUsePrivateKnowledge,
  type QoderOpaqueState,
  type SessionFieldsForSnapshot,
  type SessionStateSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import {applyFinalResultQualityGate} from '../../../services/finalResultQualityGate';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisDeliveryContext, type AnalysisOutputOrigin} from '../../../types/analysisDelivery';
import { verifyConclusion } from '../claude/claudeVerifier';
import {
  createCodeAwareStreamingTextProjection,
  sanitizeOwnerCodeAwareText,
} from '../../../services/security/codeAwareOutputRegistry';
import {analysisContextUsesPrivateKnowledge, assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint} from '../../../services/resolvedAnalysisContext';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../../services/codebase/sourceClaimVerifier';
import {extractSourceLookupCodeReferences} from '../../../services/codebase/sourceLookupTools';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import {formatToolCallNarration, formatToolResultNarration, issuePrivateToolResultNarrationReceipt} from '../../../agentv3/toolNarration';
import {planPhaseUpdatedContent} from '../../../agentv3/planPhaseEvents';
import {readRuntimeToolResultFacts} from '../../runtimeToolResult';
import type {RuntimeToolObserver} from '../../runtimeToolObserver';
import {summarizeExternalToolResult} from '../../runtimeLimits';
import type { RuntimeSelection } from '../../runtimeSelection';
import type { RuntimeEngineDefinition, RuntimeFactoryInput } from '../../runtimeRegistry';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';
import {createAnalysisRunSpec, type AnalysisRunSelection} from '../../analysisRunSpec';
import {createAnalysisTurnIntentResolver, type AnalysisTurnIntent} from '../../analysisTurnIntent';
import {resolveRuntimeTurnPolicy, usesLightweightToolCatalog} from '../../runtimeTurnPolicy';
import {createRuntimeTurnCloseoutTape, resolveRuntimeTurnBudget} from '../../runtimeTurnCloseout';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  nativeDeclarationBodyCanFitOutput,
  requestNativeDeclarationCompletion,
} from '../../runtimeConclusionProtocol';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext} from '../../analysisHistory';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import {INTENT_TRANSPORT_CLEANUP_TIMEOUT_MS, runIntentTransport} from '../../intentTransport';
import {runQoderIntentTransport} from './qoderIntentTransport';
import type {IntentTransportInput, IntentTransportResult} from '../../intentTransport';
import {attachFinalizationContext} from '../../analysisFinalizationContext';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {
  createRuntimeSkillNotesBudget,
  buildQuickRunReceipt,
  quickStopReasonFromTermination,
  resolveQuickTurnBudget,
  toProtocolHypothesis,
} from '../../runtimeCommon';
import { knowledgeScopeFromAnalysisOptions } from '../../runtimeScopes';
import {
  buildRuntimeTracePairComparisonContext,
  buildRuntimeTracePairIdentityContext,
  detectRunFocusApps,
} from '../../runtimePromptContext';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import {
  recordPlanOrPrePlanToolCall,
  resetPrePlanToolCallsForNewRun,
} from '../../../agentv3/planToolCallRecorder';
import { isTraceProcessorQueryCancelledError } from '../../../services/traceProcessorCancellation';
import { QODER_AGENT_RUNTIME_KIND } from '../../runtimeKinds';
import {
  QODER_PERSONAL_ACCESS_TOKEN_ENV,
  QODER_CLI_PATH_ENV,
  QODER_BYOK_API_KEY_ENV,
  QODER_BYOK_BASE_URL_ENV,
  QODER_BYOK_PROVIDER_ENV,
  QODER_BYOK_STYLE_ENV,
  QODER_MODEL_ENV,
  QODER_SDK_MODULE_PATH_ENV,
  QODER_SYSTEM_PROMPT_ENV,
  resolveQoderRuntimeConfig,
  getQoderEngineCapabilities,
  getQoderRuntimeDiagnostics,
  type QoderRuntimeConfig,
  type EnvLike,
  truthyEnv,
  numericEnv,
} from './qoderConfig';

export type QoderRuntimeKind = typeof QODER_AGENT_RUNTIME_KIND;

export {
  QODER_AGENT_RUNTIME_KIND,
  QODER_PERSONAL_ACCESS_TOKEN_ENV,
  QODER_CLI_PATH_ENV,
  QODER_BYOK_API_KEY_ENV,
  QODER_BYOK_BASE_URL_ENV,
  QODER_BYOK_PROVIDER_ENV,
  QODER_BYOK_STYLE_ENV,
  QODER_MODEL_ENV,
  QODER_SDK_MODULE_PATH_ENV,
  QODER_SYSTEM_PROMPT_ENV,
  getQoderEngineCapabilities,
  getQoderRuntimeDiagnostics,
  resolveQoderRuntimeConfig,
  type QoderRuntimeConfig,
};

// ---------------------------------------------------------------------------
// SDK type shims — the Qoder Agent SDK is an ESM-only package; we use a
// dynamic import wrapper to avoid loading it at module evaluation time.
// ---------------------------------------------------------------------------

/** Minimal subset of the Qoder SDK Options type we actually use. */
interface QoderSdkOptions {
  auth?: unknown;
  cwd?: string;
  systemPrompt?: string;
  maxTurns?: number;
  model?: string;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  settingSources?: unknown[];
  abortController?: AbortController;
  resume?: string;
  sessionId?: string;
  pathToQoderCLIExecutable?: string;
  mcpServers?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  stderr?: (data: string) => void;
  resolveModel?: (context: { purpose: string }) => {
    model: string | {
      provider: string;
      api_key: string;
      model: string;
      url?: string;
      style?: string;
    };
  };
}

/** Minimal shape of the async generator returned by query(). */
interface QoderQueryLike extends AsyncGenerator<unknown, void> {
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

interface QoderSdkModule {
  query(params: { prompt: string; options?: QoderSdkOptions }): QoderQueryLike;
  qodercliAuth(): unknown;
  accessTokenFromEnv(envVar?: string): unknown;
  createSdkMcpServer(config: unknown): unknown;
  AbortError?: new () => Error;
  ProtocolVersionMismatchError?: new () => Error;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { loadQoderSdkModule, resetQoderSdkModuleCache } from './qoderSdkLoader';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const QODER_SDK_ENV_WHITELIST = [
  'QODER_PERSONAL_ACCESS_TOKEN',
  'QODERCLI_PATH',
  'QODER_MODEL',
  'QODER_LIGHT_MODEL',
  'QODER_DEBUG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'PATH',
  'HOME',
  'TMPDIR',
  'NODE_PATH',
] as const;

function buildQoderSdkEnv(env: EnvLike): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {};
  for (const key of QODER_SDK_ENV_WHITELIST) {
    if (env[key] !== undefined) allowed[key] = env[key];
  }
  return allowed;
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message)) return '';
  const msgContent = message.message as unknown;
  if (!isRecord(msgContent)) return '';
  const content = msgContent.content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (!isRecord(part)) return '';
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    return '';
  }).filter(Boolean).join('\n');
}

function getMessageType(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.type === 'string' ? message.type : undefined;
}

function describeQoderSdkError(error: unknown): string {
  if (isRecord(error) && error.exitCode === 41) {
    return [
      'Qoder authentication failed.',
      'Run `qodercli login` or set a valid QODER_PERSONAL_ACCESS_TOKEN.',
      'QODER_BYOK_API_KEY configures the model provider but does not replace Qoder authentication.',
    ].join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}

function buildQoderCancelledResult(
  sessionId: string,
  startedAt: number,
  outputLanguage: OutputLanguage,
): AnalysisResult {
  const message = localize(outputLanguage, '分析已中止。', 'Analysis was aborted.');
  return {
    sessionId,
    success: false,
    findings: [],
    hypotheses: [],
    conclusion: message,
    confidence: 0,
    rounds: 0,
    totalDurationMs: Date.now() - startedAt,
    partial: true,
    terminationReason: 'timeout',
    terminationMessage: message,
  };
}

async function settleQoderWork(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>(resolve => {timer = setTimeout(resolve, INTENT_TRANSPORT_CLEANUP_TIMEOUT_MS);}),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function bindQoderDelivery(
  result: AnalysisResult,
  executionLease: RuntimeExecutionLease,
  turnIntent: AnalysisTurnIntent | undefined,
  outputOrigin: AnalysisOutputOrigin,
  status: AnalysisCompletion['status'],
  reason?: AnalysisCompletion['reason'],
  sdkFinishReason?: string,
  projectionOptions: {
    sourceUse?: Parameters<typeof finalizeOwnerSourceAwareAnalysisResultWithProjection>[1];
    attemptId?: string;
  } = {},
): {context: AnalysisDeliveryContext; protocolProjection?: ReturnType<typeof finalizeOwnerSourceAwareAnalysisResultWithProjection>['protocolProjection']} {
  const runId = executionLease.key.runId!;
  const attemptId = projectionOptions.attemptId ?? 'main';
  const candidate = {
    runId, attemptId, candidateRef: `${runId}:qoder:${attemptId}`,
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion),
  };
  const completion: AnalysisCompletion = {
    ...candidate, schemaVersion: 1, runtimeKind: QODER_AGENT_RUNTIME_KIND, status,
    ...(reason ? {reason} : {}), ...(sdkFinishReason ? {sdkFinishReason} : {}),
  };
  result.turnIntent = turnIntent;
  result.completion = completion;
  result.outputOrigin = outputOrigin;
  const nativeContext: AnalysisDeliveryContext = {
    entry: 'runtime_draft', acceptedCandidate: candidate, completion, outputOrigin, turnIntent,
  };
  const projected = finalizeOwnerSourceAwareAnalysisResultWithProjection(result, projectionOptions.sourceUse, {
    context: nativeContext,
  });
  if (!projected.deliveryContext) throw new Error('Qoder delivery context was lost during privacy projection');
  if (projected.conclusionProjection.disposition === 'replaced') result.confidence = 0;
  return {context: projected.deliveryContext, protocolProjection: projected.protocolProjection};
}

const QODER_LIGHT_MODEL_PURPOSES = new Set([
  'compact',
  'compression',
  'suggestion',
  'title',
  'utility',
]);

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface QoderActiveSession {
  abortController: AbortController;
  aborted: boolean;
  sdkQuery?: QoderQueryLike;
  assistantText: string;
  toolCallCount: number;
  rounds?: number;
  turnIntent?: AnalysisTurnIntent;
  sourceUse?: ReturnType<typeof createClaudeMcpServer>['sourceUse'];
  timedOut?: boolean;
  timeoutMs?: number;
  deadlineMs?: number;
  strategyRegistry?: ReadonlyStrategyRegistrySnapshot;
  analysisRunSelection?: AnalysisRunSelection;
  artifactStore?: ArtifactStore;
  delivery?: {result: AnalysisResult} & ReturnType<typeof bindQoderDelivery>;
  dispatchText?: (input: IntentTransportInput) => Promise<IntentTransportResult>;
  armMainBudget(timeoutMs: number): void;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class QoderRuntime extends EventEmitter implements IOrchestrator {
  private readonly env: EnvLike;
  private readonly selection: RuntimeSelection<QoderRuntimeKind>;
  private readonly config: QoderRuntimeConfig;
  private readonly activeSessions = new Map<string, QoderActiveSession>();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private readonly sessionNotes = new Map<string, AnalysisNote[]>();
  private readonly sessionPlans = new Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }>();
  private readonly sessionHypotheses = new Map<string, Hypothesis[]>();
  private readonly sessionUncertaintyFlags = new Map<string, UncertaintyFlag[]>();
  private readonly architectureCache = new Map<string, ArchitectureInfo>();
  private readonly sessionOpaqueStates = new Map<string, QoderOpaqueState>();
  private readonly executionGuard = new RuntimeExecutionGuard();

  constructor(
    private readonly input: RuntimeFactoryInput,
  ) {
    super();
    this.env = input.env ?? process.env;
    this.selection = input.selection as RuntimeSelection<QoderRuntimeKind>;
    this.config = resolveQoderRuntimeConfig(this.env);
  }

  // -------------------------------------------------------------------------
  // IOrchestrator — analyze
  // -------------------------------------------------------------------------

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options?: AnalysisOptions,
  ): Promise<AnalysisResult> {
    const normalizedOptions = options ?? {};
    const executionLease = this.executionGuard.begin({
      runtime: QODER_AGENT_RUNTIME_KIND,
      sessionId,
      referenceTraceId: normalizedOptions.referenceTraceId,
      runId: normalizedOptions.runId ?? randomUUID(),
    });
    const runtimePerformance = createRuntimePerformanceRun(
      normalizedOptions.runManifestAttributionSink,
    );
    const analysisStartedAt = Date.now();
    let mainBudgetTimer: ReturnType<typeof setTimeout> | undefined;
    const sessionState: QoderActiveSession = {
      abortController: new AbortController(),
      aborted: false,
      assistantText: '',
      toolCallCount: 0,
      armMainBudget: timeoutMs => {
        sessionState.timeoutMs = timeoutMs;
        sessionState.deadlineMs = Date.now() + timeoutMs;
        mainBudgetTimer = setTimeout(() => {
          sessionState.timedOut = true;
          sessionState.aborted = true;
          sessionState.abortController.abort();
          void this.executionGuard.abortSession(sessionId, new Error('Qoder SDK analysis timed out')).catch(() => undefined);
          void sessionState.sdkQuery?.interrupt().catch(() => undefined);
        }, timeoutMs);
        mainBudgetTimer.unref?.();
      },
    };
    this.activeSessions.set(sessionId, sessionState);
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';
    let result: AnalysisResult | undefined;
    let onExecutionAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onExecutionAbort = () => reject(executionLease.signal.reason ?? new Error('Qoder analysis aborted'));
      executionLease.signal.addEventListener('abort', onExecutionAbort, {once: true});
    });
    const analysis = this.analyzeGuarded(query, sessionId, traceId, normalizedOptions,
      executionLease, runtimePerformance, sessionState);
    try {
      result = await Promise.race([analysis, aborted]);
      runtimePerformanceOutcome = executionLease.signal.aborted
        ? 'cancelled'
        : result.success === false ? 'error' : 'ok';
      return result;
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(
        error,
        executionLease.signal,
      );
      if (runtimePerformanceOutcome === 'cancelled') {
        await settleQoderWork(analysis);
        result = buildQoderCancelledResult(
          sessionId,
          analysisStartedAt,
          normalizedOptions.outputLanguage
            ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
        );
        result.rounds = sessionState.rounds ?? 0;
        if (sessionState.assistantText.trim()) result.conclusion = sessionState.assistantText;
        if (sessionState.timedOut) {
          const timeoutText = localize(normalizedOptions.outputLanguage ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
            `Qoder SDK 分析在 ${sessionState.timeoutMs}ms 后超时。`,
            `Qoder SDK analysis timed out after ${sessionState.timeoutMs}ms.`);
          if (!sessionState.assistantText.trim()) result.conclusion = timeoutText;
          result.terminationMessage = timeoutText;
          runtimePerformanceOutcome = 'error';
        }
        const {context, protocolProjection} = bindQoderDelivery(result, executionLease, sessionState.turnIntent,
          sessionState.assistantText.trim() ? 'assistant_stream' : 'runtime_fallback',
          sessionState.timedOut ? 'incomplete' : 'cancelled', sessionState.timedOut ? 'timeout' : 'cancelled',
          undefined, {sourceUse: sessionState.sourceUse});
        sessionState.delivery = {result, context, protocolProjection};
        return result;
      }
      const message = describeQoderSdkError(error);
      result = {
        sessionId, success: false, findings: [], hypotheses: [], conclusion: message,
        confidence: 0, rounds: 0, totalDurationMs: Date.now() - analysisStartedAt,
        partial: true, terminationReason: 'execution_error', terminationMessage: message,
      };
      const {context, protocolProjection} = bindQoderDelivery(result, executionLease, sessionState.turnIntent, 'runtime_fallback', 'failed', 'provider_error',
        undefined, {sourceUse: sessionState.sourceUse});
      sessionState.delivery = {result, context, protocolProjection};
      return result;
    } finally {
      clearTimeout(mainBudgetTimer);
      if (onExecutionAbort) executionLease.signal.removeEventListener('abort', onExecutionAbort);
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      try {
        if (result && sessionState.delivery?.result === result && sessionState.turnIntent
          && sessionState.strategyRegistry && sessionState.deadlineMs !== undefined) {
          const ownerKey = analysisDeliveryFingerprint({runId: executionLease.key.runId, sessionId,
            runtime: this.selection.kind, tenantId: normalizedOptions.tenantId, workspaceId: normalizedOptions.workspaceId,
            userId: normalizedOptions.userId, providerId: normalizedOptions.providerId,
            analysisContextFingerprint: normalizedOptions.analysisContextFingerprint});
          attachFinalizationContext(result, {
            runId: executionLease.key.runId!, sessionId, deadlineMs: sessionState.deadlineMs,
            turnIntent: sessionState.turnIntent, strategyRegistry: sessionState.strategyRegistry,
            selection: sessionState.analysisRunSelection,
            traceIdentity: {currentTraceId: traceId, referenceTraceId: normalizedOptions.referenceTraceId},
            deliveryContext: sessionState.delivery.context, protocolProjection: sessionState.delivery.protocolProjection,
            sourceUse: sessionState.sourceUse?.getSourceUseDecision(),
            sourceScope: sessionState.sourceUse?.getSourceExecutionScope?.(),
            evidenceReadView: sessionState.artifactStore?.createEvidenceReadView({
              currentRunId: executionLease.key.runId!,
              allowedTraces: [{traceId, traceSide: 'current'},
                ...(normalizedOptions.referenceTraceId
                  ? [{traceId: normalizedOptions.referenceTraceId, traceSide: 'reference' as const}] : [])],
              ownerKey,
            }),
            ...(result.success && result.outputOrigin === 'sdk_final' && result.completion?.status === 'completed'
              && result.completion.reason !== 'turn_limit' && !executionLease.signal.aborted ? {
                providerQuery: {text: query, analysisContextFingerprint: normalizedOptions.analysisContextFingerprint},
                dispatchText: sessionState.dispatchText,
              } : {}),
          });
        }
      } finally {
        try {
          if (this.activeSessions.get(sessionId) === sessionState) {
            if (executionLease.signal.aborted) this.sessionOpaqueStates.delete(sessionId);
            this.activeSessions.delete(sessionId);
          }
          executionLease.settle();
        } finally {
          finalizationPhase.end(runtimePerformanceOutcome);
          runtimePerformance.finalize(runtimePerformanceOutcome);
        }
      }
    }
  }

  private async analyzeGuarded(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    executionLease: RuntimeExecutionLease,
    runtimePerformance: RuntimePerformanceRun,
    sessionState: QoderActiveSession,
  ): Promise<AnalysisResult> {
    executionLease.throwIfAborted();
    const startTime = Date.now();
    const traceProcessorService = options.traceProcessorService ?? this.input.traceProcessorService;

    const outputLanguage = options.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const packageName = options.packageName?.trim() || undefined;
    const normalizedOptions = options;
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() ?? [];
    const authorizationScope = resolveKnowledgeScope(options);
    const authorizationFingerprint = options.analysisContextFingerprint ??
      buildAnalysisContextAuthorizationFingerprint(options, authorizationScope);
    const assertAuthorized = () => {
      executionLease.throwIfAborted();
      assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
    };
    const analysisHistoryReader = createRuntimeAnalysisHistoryReader({
      options, sessionId, traceId, getTurns: () => sessionContext.getAnalysisHistory(),
      assertActive: assertAuthorized,
    });
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(normalizedOptions);
    if (privateAnalysisContext) this.sessionOpaqueStates.delete(sessionId);
    const knowledgeScope = knowledgeScopeFromAnalysisOptions(normalizedOptions);

    let sdkModulePromise: Promise<QoderSdkModule> | undefined;
    const startSdkModuleLoad = (): Promise<QoderSdkModule> => {
      if (sdkModulePromise) return sdkModulePromise;
      const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
      let sdkStartPhaseEnded = false;
      const finishSdkStartPhase = (outcome: RuntimePerformanceOutcome) => {
        if (sdkStartPhaseEnded) return;
        sdkStartPhaseEnded = true;
        sdkStartPhase.end(outcome);
      };
      const onSdkLoadAbort = () => finishSdkStartPhase('cancelled');
      executionLease.signal.addEventListener('abort', onSdkLoadAbort, {once: true});
      let sdkModuleLoad: Promise<QoderSdkModule>;
      try {
        sdkModuleLoad = loadQoderSdkModule(this.env) as Promise<QoderSdkModule>;
      } catch (error) {
        finishSdkStartPhase(runtimeOutcomeFromError(error, executionLease.signal));
        sdkModuleLoad = Promise.reject(error);
      }
      sdkModulePromise = sdkModuleLoad.then(
        sdk => {
          executionLease.signal.removeEventListener('abort', onSdkLoadAbort);
          finishSdkStartPhase(executionLease.signal.aborted ? 'cancelled' : 'ok');
          return sdk;
        },
        error => {
          executionLease.signal.removeEventListener('abort', onSdkLoadAbort);
          finishSdkStartPhase(runtimeOutcomeFromError(error, executionLease.signal));
          throw error;
        },
      );
      void sdkModulePromise.catch(() => undefined);
      return sdkModulePromise;
    };
    let authPromise: Promise<unknown> | undefined;
    const resolveRunAuth = (sdk: QoderSdkModule): Promise<unknown> =>
      authPromise ??= Promise.resolve().then(() => this.resolveAuth(sdk));
    const scopedSdkEnv = buildQoderSdkEnv(this.env);
    const dispatchQoderText = (
      input: IntentTransportInput,
      config: QoderRuntimeConfig,
      loadSdk: () => Promise<QoderSdkModule>,
      resolveAuth: (sdk: QoderSdkModule) => Promise<unknown>,
    ): Promise<IntentTransportResult> => runIntentTransport(input, async scope => {
      const directory = await mkdtemp(join(tmpdir(), 'smartperfetto-qoder-text-'));
      scope.onCleanup(() => rm(directory, {recursive: true, force: true}));
      scope.throwIfInactive();
      return runQoderIntentTransport({
        ...input, signal: scope.signal, loadSdk,
        resolveAuth: sdk => resolveAuth(sdk as QoderSdkModule),
        config, scopedEnv: scopedSdkEnv, isolatedClassifierDirectory: directory,
      });
    });
    const intentResolver = createAnalysisTurnIntentResolver({
      productRun: {options, runId: executionLease.key.runId!, sessionId, traceId},
      context: buildComplexityClassifierInput({
        query, sceneType: 'general', selectionContext: options.selectionContext,
        hasReferenceTrace: Boolean(options.referenceTraceId), previousTurns: [],
        history: analysisHistoryReader.getTurns(),
        requestedMode: options.analysisMode,
      }),
      signal: executionLease.signal,
      deadlineMs: Date.now() + (numericEnv(this.env.AGENT_CLASSIFIER_TIMEOUT_MS) ?? 30_000),
      dispatch: input => dispatchQoderText(input, this.config, startSdkModuleLoad, resolveRunAuth),
    });
    sessionState.strategyRegistry = intentResolver.strategyRegistry;
    const turnIntent = await intentResolver.resolve();
    sessionState.turnIntent = turnIntent;
    const policy = resolveRuntimeTurnPolicy(turnIntent, options.analysisMode);
    const sceneType = turnIntent.sceneId;
    const isQuickMode = policy.budgetMode === 'quick';
    const quickBudget = resolveQuickTurnBudget({
      env: this.env, hardCapTurns: this.config.quickMaxTurns,
      targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS'],
      hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS', 'QODER_QUICK_MAX_TURNS'],
      enforcement: 'turn_cap',
    });
    const maxTurns = isQuickMode ? quickBudget.hardCapTurns : this.config.maxTurns;
    const turnBudget = resolveRuntimeTurnBudget(maxTurns);
    const closeoutTape = createRuntimeTurnCloseoutTape();
    let acquisitionOpen = true;

    sessionState.armMainBudget(maxTurns * (isQuickMode ? this.config.quickPerTurnMs : this.config.fullPerTurnMs));
    const skipTracePreflightDetection = policy.preflight === 'none';
    runtimePerformance.finishClassification(turnIntent.status === 'resolved' ? 'ok' : 'error');
    executionLease.throwIfAborted();

    // Focus app detection precedes architecture detection: the effective
    // package (user > confident inference > none) scopes both. Qoder alone
    // accepts an explicit `timeRange` option; it overrides the selection.
    const focusResult = await detectRunFocusApps({
      traceProcessorService, traceId, preflight: policy.preflight,
      selectionContext: options?.selectionContext,
      timeRange: options?.timeRange as { startNs: number; endNs: number } | undefined,
      measure: async detect => {
        const focusPhase = runtimePerformance.startPhase('focus');
        try {
          const result = await detect();
          executionLease.throwIfAborted();
          focusPhase.end('ok');
          return result;
        } catch (error) {
          focusPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
          executionLease.throwIfAborted();
          return undefined; // Non-fatal
        }
      },
    });
    executionLease.throwIfAborted();
    const focusTarget = resolveFocusAppTarget({userPackageName: packageName, focusResult});
    const effectivePackageName = focusTarget.packageName;

    // Architecture detection
    let architecture: ArchitectureInfo | undefined;
    if (!skipTracePreflightDetection) {
      const architecturePhase = runtimePerformance.startPhase('architecture');
      try {
        const detector = createArchitectureDetector();
        const detectedArchitecture = await detector.detect({
          traceId,
          traceProcessorService,
          packageName: effectivePackageName,
        });
        executionLease.throwIfAborted();
        architecture = detectedArchitecture;
        this.architectureCache.set(traceId, architecture);
        architecturePhase.end('ok');
      } catch (error) {
        architecturePhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        executionLease.throwIfAborted();
        // Non-fatal — architecture detection is optional
      }
    }
    executionLease.throwIfAborted();

    // Probe trace completeness
    let traceCompleteness: Awaited<ReturnType<typeof probeTraceCompleteness>> | undefined;
    if (!skipTracePreflightDetection) {
      const completenessPhase = runtimePerformance.startPhase('completeness');
      try {
        const detectedTraceCompleteness = await probeTraceCompleteness(
          traceProcessorService,
          traceId,
          architecture?.type,
        );
        executionLease.throwIfAborted();
        traceCompleteness = detectedTraceCompleteness;
        completenessPhase.end('ok');
      } catch (error) {
        completenessPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        executionLease.throwIfAborted();
        // Non-fatal
      }
    }
    executionLease.throwIfAborted();

    const analysisRunSpec = createAnalysisRunSpec({
      query,
      sessionId,
      traceId,
      options,
      runtimeSelection: this.selection,
      engineCapabilities: getQoderEngineCapabilities(),
      sceneType,
      outputLanguage,
      previousTurns: [], history: analysisHistoryReader.getTurns(),
      resolvedMode: policy.budgetMode,
      resolvedModel: this.config.model,
      turnIntent,
      budget: {
        model: this.config.model,
        maxTurns: this.config.maxTurns,
        quickMaxTurns: this.config.quickMaxTurns,
        fullPathPerTurnMs: this.config.fullPerTurnMs,
        quickPathPerTurnMs: this.config.quickPerTurnMs,
      },
    });
    sessionState.analysisRunSelection = analysisRunSpec.selection;

    // Build comparison context before assembling the shared system prompt so
    // both the model and the MCP tools receive the same dual-trace contract.
    const referenceTraceId = options?.referenceTraceId;
    let comparisonContext = buildRuntimeTracePairIdentityContext({
      referenceTraceId, tracePairContext: options.tracePairContext,
    });
    if (referenceTraceId && policy.allowAutomaticPrefetch) {
      const comparisonPhase = runtimePerformance.startPhase('comparison');
      try {
        const detectedComparisonContext = await buildRuntimeTracePairComparisonContext({
          traceProcessorService,
          currentTraceId: traceId,
          referenceTraceId,
          tracePairContext: options?.tracePairContext,
        });
        executionLease.throwIfAborted();
        comparisonContext = detectedComparisonContext ?? comparisonContext;
        comparisonPhase.end('ok');
      } catch (error) {
        comparisonPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        executionLease.throwIfAborted();
        // Non-fatal — comparison context is best-effort
      }
    }
    executionLease.throwIfAborted();

    // Build system prompt
    const traceFeatures = extractTraceFeatures({
      sceneType,
      architectureType: architecture?.type,
      packageName: effectivePackageName,
    });

    // Shared mutable notes reference (used by both system prompt and MCP tools)
    let notes = privateAnalysisContext ? undefined : this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      if (!privateAnalysisContext) this.sessionNotes.set(sessionId, notes);
    }

    const analysisContext: ClaudeAnalysisContext = {
      query,
      turnIntent,
      strategyRegistry: intentResolver.strategyRegistry,
      onDemandContext: policy.onDemandContext,
      packageName: effectivePackageName,
      focusTarget,
      sceneType,
      architecture,
      selectionContext: options?.selectionContext,
      outputLanguage,
      traceCompleteness,
      patternContext: privateAnalysisContext || !policy.allowAutomaticPrefetch
        ? undefined
        : buildPatternContextSection(traceFeatures, knowledgeScope),
      negativePatternContext: privateAnalysisContext || !policy.allowAutomaticPrefetch
        ? undefined
        : buildNegativePatternSection(traceFeatures, knowledgeScope),
      caseBackgroundContext: !policy.allowAutomaticPrefetch ? undefined : buildRuntimeCaseBackgroundContext({
        sceneType,
        architectureType: architecture?.type,
        knowledgeScope,
        outputLanguage,
        privateAnalysisContext,
      }),
      comparison: comparisonContext,
      codeAwareMode: options?.codeAwareMode,
      codebaseIds: options?.codebaseIds,
    };

    const systemPrompt = buildSystemPrompt(analysisContext);

    // Merge with optional env system prompt
    const finalSystemPrompt = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n${systemPrompt}`
      : systemPrompt;

    const skillRegistryPhase = runtimePerformance.startPhase('skill_registry');
    try {
      await ensureSkillRegistryInitialized();
      executionLease.throwIfAborted();
      skillRegistryPhase.end('ok');
    } catch (error) {
      skillRegistryPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
      throw error;
    }
    executionLease.throwIfAborted();

    // Build MCP tools
    const skillExecutor = createSkillExecutor(traceProcessorService);
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    const sceneCoverageRegistry = resolveSceneProductScope(normalizedOptions, {sessionId, traceId, runId: normalizedOptions.runId ?? ''})
      ? snapshotSceneCoverageRegistry(effectiveSkillRegistry, intentResolver.strategyRegistry, turnIntent.sceneId) : undefined;
    skillExecutor.registerSkills(sceneCoverageRegistry ? [...sceneCoverageRegistry.skills] : effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(
      sceneCoverageRegistry ? new Map(sceneCoverageRegistry.fragments) : effectiveSkillRegistry.getFragmentCache(),
    );

    const artifactStore = resolveRuntimeEvidenceStore(normalizedOptions, {sessionId, traceId},
      () => privateAnalysisContext ? new ArtifactStore() : this.artifactStores.get(sessionId) ?? new ArtifactStore());
    if (!privateAnalysisContext) this.artifactStores.set(sessionId, artifactStore);
    sessionState.artifactStore = artifactStore;

    const skillNotesBudget = createRuntimeSkillNotesBudget(isQuickMode);
    const recentSqlErrors = policy.allowAutomaticPrefetch
      ? loadLearnedSqlFixPairs(5, knowledgeScope, normalizedOptions) : [];

    // Shared mutable session state (same reference pattern as Claude runtime)
    let planState = privateAnalysisContext ? undefined : this.sessionPlans.get(sessionId);
    if (!planState) {
      planState = { current: null, history: [] };
      if (!privateAnalysisContext) this.sessionPlans.set(sessionId, planState);
    }
    if (planState.current) {
      planState.history.push(planState.current);
      if (planState.history.length > 3) planState.history.shift();
    }
    planState.current = null;
    resetPrePlanToolCallsForNewRun(planState);

    let hypotheses = privateAnalysisContext ? undefined : this.sessionHypotheses.get(sessionId);
    if (!hypotheses) {
      hypotheses = [];
      if (!privateAnalysisContext) this.sessionHypotheses.set(sessionId, hypotheses);
    }

    let uncertaintyFlags = privateAnalysisContext ? undefined : this.sessionUncertaintyFlags.get(sessionId);
    if (!uncertaintyFlags) {
      uncertaintyFlags = [];
      if (!privateAnalysisContext) this.sessionUncertaintyFlags.set(sessionId, uncertaintyFlags);
    }

    const watchdogWarning: { current: string | null } = { current: null };
    const isRunDeliverable = () => this.activeSessions.get(sessionId) === sessionState
      && !sessionState.aborted
      && !sessionState.abortController.signal.aborted
      && !executionLease.signal.aborted;
    const emitToolUpdate = (update: StreamingUpdate) => {
      if (isRunDeliverable()) this.emitUpdate(update);
    };
    const startedToolCallIds = new Set<string>();
    const settledToolCallIds = new Set<string>();
    const toolObserver: RuntimeToolObserver = async event => {
      await closeoutTape.observe(event);
      const isDeliverable = () => isRunDeliverable()
        && !event.extra.signal?.aborted;
      if (!isDeliverable()) return;

      const {toolCallId, toolName, params} = event;
      if (event.phase === 'started') {
        if (startedToolCallIds.has(toolCallId)) return;
        startedToolCallIds.add(toolCallId);
        sessionState.toolCallCount += 1;
        this.emitUpdate({
          type: 'agent_task_dispatched',
          content: {
            taskId: toolCallId,
            toolName,
            args: params,
            message: formatToolCallNarration(toolName, params, outputLanguage),
          },
          timestamp: Date.now(),
        });
        return;
      }

      if (settledToolCallIds.has(toolCallId)) return;
      settledToolCallIds.add(toolCallId);
      const rawResult = event.phase === 'completed' ? event.result : {
        success: false,
        error: event.error instanceof Error ? event.error.message : String(event.error),
      };
      const resultFacts = readRuntimeToolResultFacts(rawResult);
      const codeReferences = extractSourceLookupCodeReferences(toolName, rawResult);
      const projectedResult = projectToolResultForExternalSurface(toolName, rawResult);
      const privateToolResultReceipt = issuePrivateToolResultNarrationReceipt({
        toolName, result: projectedResult, isError: resultFacts.success === false,
      });
      const resultText = summarizeExternalToolResult(projectedResult);
      recordPlanOrPrePlanToolCall(planState, {
        toolCallId,
        toolName,
        input: params,
        resultText,
        resultFacts,
        returnedCodeReferences: codeReferences.length > 0,
        returnedCodeReferenceHints: codeReferences,
        onPhaseAutoCompleted: phase => {
          if (!isDeliverable()) return;
          this.emitUpdate({
            type: 'plan_phase_updated',
            content: planPhaseUpdatedContent({
              phaseId: phase.id,
              phaseName: phase.name,
              status: 'completed',
              summary: phase.summary,
              origin: 'auto',
            }),
            timestamp: Date.now(),
          });
        },
      });
      if (!isDeliverable()) return;
      this.emitUpdate({
        type: 'agent_response',
        content: {
          taskId: toolCallId,
          toolName,
          result: resultText,
          ...(privateToolResultReceipt ? {privateToolResultReceipt} : {}),
          resultNarration: formatToolResultNarration({
            toolName,
            args: params,
            result: projectedResult,
            isError: resultFacts.success === false,
            language: outputLanguage,
          }),
          isError: resultFacts.success === false,
        },
        timestamp: Date.now(),
      });
    };

    const canInvokeTool = () => acquisitionOpen && isRunDeliverable();
    const sceneRunContext = await activateSceneRuntime(normalizedOptions, {sessionId, traceId,
      runId: executionLease.key.runId!, deadlineMs: sessionState.deadlineMs ?? 0,
      traceProcessorService, artifactStore, sceneCoverageRegistry, signal: executionLease.signal, canInvokeTool});
    const mcp = createClaudeMcpServer({
      sceneRunContext,
      allowNewEvidence: policy.allowNewEvidence,
      strategyRegistry: intentResolver.strategyRegistry,
      lightweight: usesLightweightToolCatalog(policy),
      toolObserver,
      analysisHistoryReader,
      canInvokeTool,
      conversationTraceAttached: options?.assistantSurface === 'conversation'
        ? options.conversationTraceAttached === true
        : undefined,
      runManifestAttributionSink: options?.runManifestAttributionSink,
      sessionId,
      traceId,
      userQuery: query,
      traceProcessorService,
      skillExecutor,
      packageName: effectivePackageName,
      focusTarget,
      emitUpdate: emitToolUpdate,
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      recentSqlErrors,
      analysisPlan: planState,
      watchdogWarning,
      hypotheses,
      sceneType,
      uncertaintyFlags,
      referenceTraceId,
      comparisonContext,
      skillNotesBudget,
      outputLanguage,
      knowledgeScope,
      codeAwareMode: options?.codeAwareMode,
      codebaseIds: options?.codebaseIds,
      knowledgeSourceIds: options?.knowledgeSourceIds,
      sourceUsePolicy: options?.sourceUsePolicy,
      analysisContextFingerprint: options?.analysisContextFingerprint,
      androidInternalsPackPin: options?.androidInternalsPackPin,
    });
    const mcpServer = mcp?.server;
    const allowedToolNames = mcp?.allowedTools ?? [];
    const sourceUse = mcp?.sourceUse;
    sessionState.sourceUse = sourceUse;

    // The user prompt uses the shared, localized trace-context formatter. All
    // runtime methodology remains in strategies through the shared system prompt.
    let fullPrompt = query;
    if (analysisRunSpec.traceContext.promptSection) {
      fullPrompt = `${analysisRunSpec.traceContext.promptSection}\n\n${fullPrompt}`;
    }
    const historyContext = renderAnalysisHistoryContext(analysisHistoryReader.getTurns(), {outputLanguage});
    if (historyContext) fullPrompt = `${historyContext}\n\n${fullPrompt}`;

    const { abortController } = sessionState;

    let q: QoderQueryLike | undefined;
    let answerProjection: ReturnType<typeof createCodeAwareStreamingTextProjection> | undefined;
    let emitProjectionTail = false;

    try {
      const resolveModel = this.createModelPolicy(turnIntent.status === 'resolved');

      const sdk = await startSdkModuleLoad();
      executionLease.throwIfAborted();

      // Resolve auth
      const auth = await resolveRunAuth(sdk);
      executionLease.throwIfAborted();
      // Final review reuses this run's established SDK/auth and primary model.
      // It never consults the settled run lease or resumes its SDK conversation.
      // Qoder exposes no supported output-token setting; the native transport
      // enforces one SDK turn plus the caller's byte, terminal and time limits.
      if (this.config.model) {
        const finalizationConfig = {...this.config, lightModel: undefined};
        sessionState.dispatchText = input => dispatchQoderText(input, finalizationConfig,
          async () => sdk, async () => auth);
      }

      // Create SDK MCP server config
      const mcpServers: Record<string, unknown> = mcpServer
        ? {smartperfetto: mcpServer}
        : {};

      const sdkOptions: QoderSdkOptions = {
        auth,
        cwd: this.env.TMPDIR || '/tmp',
        systemPrompt: finalSystemPrompt,
        maxTurns: turnBudget.acquisitionTurns,
        model: this.config.model,
        tools: [],
        allowedTools: allowedToolNames.length > 0 ? allowedToolNames : undefined,
        permissionMode: 'bypassPermissions',
        settingSources: [],
        abortController,
        pathToQoderCLIExecutable: this.config.cliPath || undefined,
        mcpServers,
        env: buildQoderSdkEnv(this.env),
        stderr: (data: string) => {
          if (truthyEnv(this.env.QODER_DEBUG)) {
            console.error('[Qoder SDK stderr]', data);
          }
        },
        resolveModel,
      };

      answerProjection = createCodeAwareStreamingTextProjection(sessionId, 'qoder-answer', 'owner');
      const activeAnswerProjection = answerProjection;

      // Execute the query with timeout. Provider timing includes synchronous
      // query creation because this is the first provider-owned operation.
      const providerPhase = runtimePerformance.startPhase('provider');
      commitEvaluationSdkHandoffIfActive();
      assertAuthorized();
      try {
        q = sdk.query({ prompt: fullPrompt, options: sdkOptions });
      } catch (error) {
        providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
      sessionState.sdkQuery = q;
      const sdkQuery = q;
      executionLease.throwIfAborted();

      let assistantText = '';
      let observedTurns = 0;
      let sdkFinalResultText = '';
      let sdkFinalBodySupplied = false;
      let sdkResultMeta: {
        success: boolean; subtype?: string; errors?: string; numTurns?: number;
        status: AnalysisCompletion['status']; reason?: AnalysisCompletion['reason']; stopReason?: string;
      } = {
        status: 'unknown',
        success: false,
        subtype: 'missing_result',
        errors: 'Qoder SDK stream ended without a result message',
      };
      const processStream = async () => {
        for await (const message of sdkQuery) {
          if (sessionState.aborted) {
            executionLease.throwIfAborted();
            return;
          }
          executionLease.throwIfAborted();

          const msgType = getMessageType(message);

          if (msgType === 'assistant') {
            observedTurns++;
            sessionState.rounds = Math.max(sessionState.rounds ?? 0, observedTurns);
            const text = extractAssistantText(message);
            if (text) {
              assistantText += text;
              // Cancellation/timeout can win the outer race before this stream settles.
              sessionState.assistantText = assistantText;
              const projectedText = activeAnswerProjection.write(text);
              if (projectedText) {
                runtimePerformance.recordFirstOutput();
                this.emitUpdate({
                  type: 'answer_token',
                  content: projectedText,
                  timestamp: Date.now(),
                });
              }
            }
          } else if (msgType === 'result') {
            acquisitionOpen = false;
            const msg = message as Record<string, unknown>;
            recordEvaluationTokenDeltaIfPresent(
              msg.usage ?? msg.tokens ?? msg,
            );
            const subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;
            const stopReason = typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined;
            const success = subtype === 'success' && msg.is_error === false
              && (msg.stop_reason == null || stopReason === 'end_turn' || stopReason === 'stop_sequence');
            const reason: AnalysisCompletion['reason'] = subtype === 'error_max_turns' ? 'turn_limit'
              : stopReason === 'max_tokens' ? 'output_limit'
              : (subtype && subtype !== 'success') || msg.is_error === true ? 'provider_error' : undefined;
            const numTurns = typeof msg.num_turns === 'number' && Number.isSafeInteger(msg.num_turns)
              && msg.num_turns >= 0 ? msg.num_turns : undefined;
            sdkFinalBodySupplied = typeof msg.result === 'string';
            sdkFinalResultText = sdkFinalBodySupplied ? msg.result as string : '';
            sdkResultMeta = {
              success, subtype, stopReason,
              numTurns: numTurns ?? (reason === 'turn_limit' ? turnBudget.acquisitionTurns : undefined),
              reason,
              status: success ? 'completed' : reason === 'turn_limit' || reason === 'output_limit'
                ? 'incomplete' : reason === 'provider_error' ? 'failed' : 'unknown',
              ...(!success ? {errors: Array.isArray(msg.errors)
                ? msg.errors.filter((value): value is string => typeof value === 'string').join('; ')
                : subtype ?? 'Qoder SDK result did not establish completion'} : {}),
            };
            sessionState.rounds = Math.max(sessionState.rounds ?? 0, observedTurns, sdkResultMeta.numTurns ?? 0);
            sessionState.assistantText = sdkFinalBodySupplied &&
              (reason !== 'turn_limit' || sdkFinalResultText.trim()) ? sdkFinalResultText : assistantText;
            // This receipt terminates the current attempt. A later stale message
            // cannot replace its body, session identity or completion facts.
            return;
          } else if (msgType === 'system') {
            if (isRecord(message)) {
              const subtype = message.subtype;
              if (subtype === 'init' && !privateAnalysisContext) {
                const initSessionId = message.session_id ?? message.sessionId;
                if (typeof initSessionId === 'string') {
                  this.sessionOpaqueStates.set(sessionId, { version: 1, sdkSessionId: initSessionId });
                }
              }
            }
          }
        }
      };

      let onExecutionAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        onExecutionAbort = () => {
          const reason = executionLease.signal.reason;
          reject(reason instanceof Error ? reason : new Error('Qoder SDK analysis aborted'));
        };
        if (executionLease.signal.aborted) {
          onExecutionAbort();
        } else {
          executionLease.signal.addEventListener('abort', onExecutionAbort, { once: true });
        }
      });
      void abortPromise.catch(() => undefined);

      const streamPromise = processStream();
      void streamPromise.catch(() => undefined);
      try {
        await Promise.race([streamPromise, abortPromise]);
        providerPhase.end('ok');
      } catch (error) {
        providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      } finally {
        if (onExecutionAbort) {
          executionLease.signal.removeEventListener('abort', onExecutionAbort);
        }
      }
      executionLease.throwIfAborted();

      acquisitionOpen = false;
      sessionState.rounds = Math.max(sdkResultMeta.numTurns ?? 0, observedTurns);
      let closeoutAccepted = false;
      let acceptedAttemptId = 'main';
      let acceptedFinishReason = sdkResultMeta.stopReason;
      const originalAnswer = sdkFinalBodySupplied && sdkFinalResultText.trim()
        ? sdkFinalResultText : assistantText;
      sessionState.assistantText = originalAnswer;
      if (sdkResultMeta.reason === 'turn_limit' && turnBudget.deliveryTurns > 0 &&
          sessionState.rounds < turnBudget.totalTurns && sessionState.deadlineMs !== undefined &&
          Date.now() < sessionState.deadlineMs) {
        // Retire acquisition before the isolated summary can use the returned tape.
        await settleQoderWork(Promise.resolve().then(() => sdkQuery.close()));
        sessionState.sdkQuery = undefined;
        q = undefined;
        executionLease.throwIfAborted();
        const prompt = closeoutTape.buildPrompt({query, outputLanguage,
          priorConclusion: sanitizeOwnerCodeAwareText(sessionId, originalAnswer)});
        if (prompt && Date.now() < sessionState.deadlineMs) {
          sessionState.rounds += 1;
          try {
            assertAuthorized();
            const summary = await dispatchQoderText({
              prompt, systemPrompt: finalSystemPrompt, signal: executionLease.signal,
              deadlineMs: sessionState.deadlineMs, outputByteLimit: 128 * 1024,
            }, {...this.config, lightModel: undefined},
            async () => {assertAuthorized(); return sdk;},
            async () => {assertAuthorized(); return auth;});
            assertAuthorized();
            if (summary.status === 'ok' && summary.text.trim()) {
              sdkFinalBodySupplied = true;
              sdkFinalResultText = summary.text.trim();
              closeoutAccepted = true;
              acceptedAttemptId = 'turn-closeout:1';
              acceptedFinishReason = summary.finishReason;
            }
          } catch {
            executionLease.throwIfAborted();
            // Failed delivery retains the original answer and the cap receipt.
          }
        }
      }
      const declarationOutputLimit = 128 * 1024;
      const declarationRequest = requestNativeDeclarationCompletion({
        intent: turnIntent,
        completion: {status: sdkResultMeta.status},
        candidate: originalAnswer,
        remainingDeliveryTurns: sdkResultMeta.reason !== 'turn_limit' &&
          sessionState.rounds < turnBudget.totalTurns ? turnBudget.deliveryTurns : 0,
        repairInvalid: true,
      });
      if (declarationRequest && nativeDeclarationBodyCanFitOutput(originalAnswer, declarationOutputLimit) &&
          sessionState.deadlineMs !== undefined && Date.now() < sessionState.deadlineMs) {
        await settleQoderWork(Promise.resolve().then(() => sdkQuery.close()));
        sessionState.sdkQuery = undefined;
        q = undefined;
        executionLease.throwIfAborted();
        sessionState.rounds += 1;
        try {
          assertAuthorized();
          const repaired = await dispatchQoderText({
            prompt: buildNativeDeclarationCompletionPrompt({request: declarationRequest, intent: turnIntent, outputLanguage}),
            systemPrompt: finalSystemPrompt,
            signal: executionLease.signal,
            deadlineMs: sessionState.deadlineMs,
            outputByteLimit: declarationOutputLimit,
          }, {...this.config, lightModel: undefined},
          async () => {assertAuthorized(); return sdk;},
          async () => {assertAuthorized(); return auth;});
          assertAuthorized();
          if (repaired.status === 'ok' && acceptNativeDeclarationCompletion({
            request: declarationRequest, completion: {status: 'completed'}, candidate: repaired.text,
            outputByteLimit: declarationOutputLimit,
          })) {
            sdkFinalBodySupplied = true;
            sdkFinalResultText = repaired.text;
            closeoutAccepted = true;
            acceptedAttemptId = 'declaration-completion:1';
            acceptedFinishReason = repaired.finishReason;
          }
        } catch {
          executionLease.throwIfAborted();
          // A failed declaration completion cannot replace the original candidate.
        }
      }
      // Native completion and authorship are established before any privacy
      // transformation. Only the issued projection chain may transfer them.
      const originalBody = sdkResultMeta.reason === 'turn_limit' && !closeoutAccepted
        ? originalAnswer : sdkFinalBodySupplied ? sdkFinalResultText : assistantText;
      const nativeCompleted = sdkResultMeta.success && sdkFinalBodySupplied && !!sdkFinalResultText.trim();
      const sdkErrorText = sdkResultMeta.errors || 'Qoder SDK did not supply a final answer';
      const usesErrorFallback = !originalBody && !sdkResultMeta.success;
      const outputOrigin: AnalysisOutputOrigin = usesErrorFallback ? 'runtime_fallback'
        : closeoutAccepted || (sdkFinalBodySupplied &&
          (sdkResultMeta.reason !== 'turn_limit' || sdkFinalResultText.trim())) ? 'sdk_final'
          : assistantText ? 'assistant_stream' : 'runtime_fallback';
      const findings = extractFindingsFromText(originalBody);
      const terminationReason: AnalysisResult['terminationReason'] = sdkResultMeta.reason === 'turn_limit'
        ? 'max_turns' : nativeCompleted ? undefined : 'execution_error';
      const result: AnalysisResult = {
        sessionId, success: nativeCompleted, findings,
        hypotheses: hypotheses.map(hypothesis => toProtocolHypothesis(hypothesis, QODER_AGENT_RUNTIME_KIND)),
        conclusion: usesErrorFallback ? sdkErrorText : originalBody,
        confidence: nativeCompleted ? estimateAnalysisConfidence({findings}) : 0,
        rounds: sessionState.rounds,
        totalDurationMs: Date.now() - startTime,
        partial: !nativeCompleted,
        terminationReason,
        terminationMessage: sdkResultMeta.reason === 'turn_limit'
          ? buildMaxTurnsTerminationMessage({mode: isQuickMode ? 'fast' : 'full',
              turns: sessionState.rounds, maxTurns, outputLanguage})
          : nativeCompleted ? undefined : sdkErrorText,
      };
      const {context: deliveryContext, protocolProjection} = bindQoderDelivery(result, executionLease, turnIntent, outputOrigin,
        sdkResultMeta.status === 'completed' && !nativeCompleted ? 'unknown' : sdkResultMeta.status,
        sdkResultMeta.reason, acceptedFinishReason,
        {sourceUse, attemptId: acceptedAttemptId});
      sessionState.assistantText = result.conclusion;
      sessionState.delivery = {result, context: deliveryContext, protocolProjection};
      const verificationPhase = runtimePerformance.startPhase('verification');
      try {
        const verification = await verifyConclusion(result.findings, result.conclusion, {
          emitUpdate: update => { if (isRunDeliverable()) this.emitUpdate(update); },
          enableLLM: false, plan: planState.current, hypotheses, sceneType, outputLanguage,
          deliveryContext, conclusionContract: result.conclusionContract,
          emitIssueProgress: false, allowPersistentLearning: !privateAnalysisContext,
        });
        executionLease.throwIfAborted();
        verificationPhase.end('ok');
        if ([...verification.heuristicIssues, ...(verification.llmIssues ?? [])]
          .some(issue => issue.severity === 'error' && issue.type !== 'plan_deviation' && issue.type !== 'unresolved_hypothesis')) {
          result.partial = true;
          result.terminationReason ??= 'quality_gate_failed';
          result.confidence = Math.min(result.confidence, estimateAnalysisConfidence({findings: result.findings, partial: true}));
        }
      } catch (error) {
        verificationPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        executionLease.throwIfAborted();
        // No advisory verifier failure can certify the result. The shared final
        // assessment will retain unavailable/not-checked assurance explicitly.
      }
      if (isQuickMode) result.quickRun = buildQuickRunReceipt({
        requestedMode: options.analysisMode ?? 'auto', turnIntent, budget: quickBudget,
        actualTurns: result.rounds, elapsedMs: result.totalDurationMs,
        stopReason: quickStopReasonFromTermination({partial: result.partial,
          terminationReason: result.terminationReason, actualTurns: result.rounds,
          targetTurns: quickBudget.targetTurns, hardCapTurns: quickBudget.hardCapTurns}),
      });
      executionLease.throwIfAborted();
      applyFinalResultQualityGate({result, context: deliveryContext, deferFocusedEvidenceFinalization: true});

      if (!privateAnalysisContext) {
        executionLease.throwIfAborted();
        sessionContext.addTurn(
          query,
          {
            primaryGoal: query,
            aspects: [],
            expectedOutputType: 'diagnosis',
            complexity: isQuickMode ? 'simple' : 'complex',
            followUpType: previousTurns.length > 0 ? 'extend' : 'initial',
          },
          {
            agentId: QODER_AGENT_RUNTIME_KIND,
            success: result.success,
            findings: result.findings,
            confidence: result.confidence,
            message: result.conclusion,
            partial: result.partial,
            completion: result.completion,
            conclusionContract: result.conclusionContract,
            analysisContextFingerprint: options.analysisContextFingerprint,
            terminationReason: result.terminationReason,
            terminationMessage: result.terminationMessage,
          },
          result.findings,
        );
      }

      // Update session state
      executionLease.throwIfAborted();
      emitProjectionTail = result.success && !privateAnalysisContext;

      return result;
    } catch (error) {
      // The outer run owns cancellation/timeout finalization. A late attempt
      // must not clear a newer run's opaque state or publish another result.
      if (executionLease.signal.aborted) throw error;
      const totalDurationMs = Date.now() - startTime;
      const errorMessage = describeQoderSdkError(error);
      const safeErrorMessage = sanitizeOwnerCodeAwareText(sessionId, errorMessage);
      const isAborted = sessionState.aborted
        || executionLease.signal.aborted
        || (error instanceof Error && error.name === 'AbortError')
        || isTraceProcessorQueryCancelledError(error);

      // A failed/cancelled attempt is not a resumable proof of conversation state.
      this.sessionOpaqueStates.delete(sessionId);
      if (!isAborted) this.emitUpdate({
        type: 'error', content: {message: safeErrorMessage}, timestamp: Date.now(),
      });

      const abortedMessage = localize(outputLanguage, '分析已中止。', 'Analysis was aborted.');

      const result: AnalysisResult = {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: isAborted
          ? abortedMessage
          : localize(
              outputLanguage,
              `Qoder Agent SDK 分析失败：${errorMessage}`,
              `Qoder Agent SDK analysis failed: ${errorMessage}`,
            ),
        confidence: 0,
        rounds: 0,
        totalDurationMs,
        partial: true,
        terminationReason: isAborted ? 'timeout' : 'execution_error',
        terminationMessage: isAborted
          ? abortedMessage
          : errorMessage,
      };
      const {context, protocolProjection} = bindQoderDelivery(result, executionLease, turnIntent, 'runtime_fallback',
        isAborted ? 'cancelled' : 'failed', isAborted ? 'cancelled' : 'provider_error',
        undefined, {sourceUse});
      sessionState.delivery = {result, context, protocolProjection};
      return result;
    } finally {
      acquisitionOpen = false;
      sessionState.sdkQuery = undefined;
      if (q) await settleQoderWork(Promise.resolve().then(() => q!.close()));
      let projectedTail = '';
      try {
        projectedTail = answerProjection?.flush() ?? '';
      } catch {
        // Projection cleanup is fail-closed and must not replace the analysis result.
      }
      if (emitProjectionTail && projectedTail && !executionLease.signal.aborted) {
        runtimePerformance.recordFirstOutput();
        this.emitUpdate({
          type: 'answer_token',
          content: projectedTail,
          timestamp: Date.now(),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Auth resolution
  // -------------------------------------------------------------------------

  private resolveAuth(sdk: QoderSdkModule): unknown {
    // Prefer personal access token from env
    if (this.config.hasAccessToken) {
      return sdk.accessTokenFromEnv(QODER_PERSONAL_ACCESS_TOKEN_ENV);
    }
    // Fall back to local qodercli login state
    return sdk.qodercliAuth();
  }

  private createModelPolicy(allowLightModel = true): QoderSdkOptions['resolveModel'] {
    const { apiKey, provider, baseUrl, style } = this.config.byok;
    const byokRequested = Boolean(apiKey || provider || baseUrl || style);
    if (!byokRequested) return undefined;

    const missing = [
      !apiKey ? QODER_BYOK_API_KEY_ENV : undefined,
      !provider ? QODER_BYOK_PROVIDER_ENV : undefined,
      !this.config.model ? QODER_MODEL_ENV : undefined,
    ].filter((value): value is string => Boolean(value));
    if (missing.length > 0) {
      throw new Error(`Qoder BYOK configuration is incomplete; missing ${missing.join(', ')}`);
    }

    return ({ purpose }) => {
      const model = allowLightModel && QODER_LIGHT_MODEL_PURPOSES.has(purpose)
        ? this.config.lightModel || this.config.model!
        : this.config.model!;
      return {
        model: {
          provider: provider!,
          api_key: apiKey!,
          model,
          ...(baseUrl ? { url: baseUrl } : {}),
          ...(style ? { style } : {}),
        },
      };
    };
  }

  // -------------------------------------------------------------------------
  // IOrchestrator — lifecycle
  // -------------------------------------------------------------------------

  reset(): void {
    this.executionGuard.clear();
    resetQoderSdkModuleCache();
    for (const [, session] of this.activeSessions) {
      session.aborted = true;
      session.abortController.abort();
      session.sdkQuery?.interrupt().catch(() => undefined);
    }
    this.activeSessions.clear();
    this.sessionNotes.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.architectureCache.clear();
    this.sessionOpaqueStates.clear();
    this.artifactStores.clear();
  }

  async abortSession(sessionId: string): Promise<void> {
    this.sessionOpaqueStates.delete(sessionId);
    await this.executionGuard.abortSession(sessionId);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    session.aborted = true;
    session.abortController.abort();
    await session.sdkQuery?.interrupt().catch(() => undefined);
  }

  cleanupSession(sessionId: string): void {
    void this.abortSession(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.artifactStores.delete(sessionId);
    this.sessionOpaqueStates.delete(sessionId);
  }

  getSdkSessionId(sessionId: string): string | undefined {
    return this.sessionOpaqueStates.get(sessionId)?.sdkSessionId;
  }

  // -------------------------------------------------------------------------
  // Snapshot / Restore
  // -------------------------------------------------------------------------

  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) ?? [];
  }

  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) ?? [];
  }

  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const privateKnowledge = sessionFieldsUsePrivateKnowledge(sessionFields);
    const durableFields = projectSessionFieldsForDurableSnapshot(sessionFields);
    const planState = this.sessionPlans.get(sessionId);
    const artifactStore = this.artifactStores.get(sessionId);
    const opaque = privateKnowledge
      ? undefined
      : this.sessionOpaqueStates.get(sessionId)
        ?? { version: 1, degradedReason: 'state_unavailable' as const };

    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,
      ...durableFields,
      analysisNotes: privateKnowledge ? [] : this.sessionNotes.get(sessionId) ?? [],
      analysisPlan: privateKnowledge ? null : planState?.current ?? null,
      planHistory: privateKnowledge ? [] : planState?.history ?? [],
      uncertaintyFlags: privateKnowledge ? [] : this.sessionUncertaintyFlags.get(sessionId) ?? [],
      claudeHypotheses: privateKnowledge ? undefined : this.sessionHypotheses.get(sessionId) ?? undefined,
      architecture: this.architectureCache.get(traceId),
      engineState: createQoderSnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        opaque,
      }),
      agentRuntimeKind: QODER_AGENT_RUNTIME_KIND,
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      agentRuntimeProviderSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
      artifacts: privateKnowledge ? undefined : artifactStore?.serialize(),
    };
  }

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
    if (snapshot.architecture) {
      this.architectureCache.set(traceId, snapshot.architecture);
    }
    if (snapshot.artifacts) {
      try {
        this.artifactStores.set(sessionId, ArtifactStore.fromSnapshot(snapshot.artifacts));
      } catch {
        // Ignore malformed legacy artifact snapshots
      }
    }
    const opaque = getQoderSnapshotEngineState(snapshot)?.opaque;
    if (opaque) {
      this.sessionOpaqueStates.set(sessionId, opaque);
    }
  }

  restoreArchitectureCache(traceId: string, architecture: any): void {
    this.architectureCache.set(traceId, architecture);
  }

  getCachedArchitecture(traceId: string): any {
    return this.architectureCache.get(traceId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }
}

// ---------------------------------------------------------------------------
// Engine definition factory
// ---------------------------------------------------------------------------

export function createQoderRuntimeDefinition(
  kind: QoderRuntimeKind = QODER_AGENT_RUNTIME_KIND,
): RuntimeEngineDefinition {
  return {
    kind,
    capabilities: getQoderEngineCapabilities(kind),
    createOrchestrator: input => new QoderRuntime(input),
  };
}
