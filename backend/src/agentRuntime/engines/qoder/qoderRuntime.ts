// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import type {
  AnalysisOptions,
  AnalysisResult,
  IOrchestrator,
} from '../../../agent/core/orchestratorTypes';
import type { ConversationTurn, Finding, StreamingUpdate } from '../../../agent/types';
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
import {
  buildNegativePatternSection,
  buildPatternContextSection,
  extractTraceFeatures,
} from '../../../agentv3/analysisPatternMemory';
import {
  createClaudeMcpServer,
  loadLearnedSqlFixPairs,
} from '../../../agentv3/claudeMcpServer';
import {
  buildQuickSystemPrompt,
  buildSystemPrompt,
} from '../../../agentv3/claudeSystemPrompt';
import { extractFindingsFromText } from '../../../agentv3/claudeFindingExtractor';
import { detectFocusApps, type DetectedFocusApp } from '../../../agentv3/focusAppDetector';
import { localize, parseOutputLanguage, type OutputLanguage } from '../../../agentv3/outputLanguage';
import { classifyScene, type SceneType } from '../../../agentv3/sceneClassifier';
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
import {
  applyFinalResultQualityGate,
  hasDeliverableFinalReportHeading,
} from '../../../services/finalResultQualityGate';
import { verifyConclusion } from '../claude/claudeVerifier';
import {
  createCodeAwareStreamingTextProjection,
  sanitizeCodeAwareText,
} from '../../../services/security/codeAwareOutputRegistry';
import { analysisContextUsesPrivateKnowledge } from '../../../services/resolvedAnalysisContext';
import {finalizeSourceAwareAnalysisResult} from '../../../services/codebase/sourceClaimVerifier';
import type { RuntimeSelection } from '../../runtimeSelection';
import type { RuntimeEngineDefinition, RuntimeFactoryInput } from '../../runtimeRegistry';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';
import { createAnalysisRunSpec, type AnalysisRunSpec } from '../../analysisRunSpec';
import {
  createRuntimeSkillNotesBudget,
  isTruncationVerificationIssue,
  repairTruncatedFinalReport,
  resolveQuickTurnBudget,
  toProtocolHypothesis,
} from '../../runtimeCommon';
import { knowledgeScopeFromAnalysisOptions } from '../../runtimeScopes';
import {
  buildQuickConversationContext,
  buildRuntimeTracePairComparisonContext,
} from '../../runtimePromptContext';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import {PRIOR_EVIDENCE_ONLY_FOLLOWUP_REASON} from '../../../agentv3/queryComplexityClassifier';
import { resolveRuntimeQuickMode } from '../../quickModeResolution';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import {buildAdaptiveRoutingForQuickResolution} from '../../adaptiveRoutingProjection';
import {resetPrePlanToolCallsForNewRun} from '../../../agentv3/planToolCallRecorder';
import {
  buildRuntimeQuickEvidenceAttempt,
  selectReusableRuntimeQuickEvidenceAttempt,
  type RuntimeQuickEvidenceCounts,
  type RuntimeQuickEvidenceDirectAnswer,
  type RuntimeQuickEvidenceAttempt,
} from '../../quickEvidenceDirectAnswer';
import {
  buildQuickDirectEvidenceAnalysisResult,
  emitQuickDirectAnswerEvents,
  emitQuickDirectQualityGateIssue,
} from '../../quickDirectResult';
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
      runId: normalizedOptions.runId,
    });
    const runtimePerformance = createRuntimePerformanceRun(
      normalizedOptions.runManifestAttributionSink,
    );
    const analysisStartedAt = Date.now();
    const sessionState: QoderActiveSession = {
      abortController: new AbortController(),
      aborted: false,
      assistantText: '',
      toolCallCount: 0,
    };
    this.activeSessions.set(sessionId, sessionState);
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';
    let result: AnalysisResult | undefined;
    try {
      result = await this.analyzeGuarded(
        query,
        sessionId,
        traceId,
        normalizedOptions,
        executionLease,
        runtimePerformance,
        sessionState,
      );
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
        result = buildQoderCancelledResult(
          sessionId,
          analysisStartedAt,
          normalizedOptions.outputLanguage
            ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
        );
        return result;
      }
      throw error;
    } finally {
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      try {
        if (this.activeSessions.get(sessionId) === sessionState) {
          this.activeSessions.delete(sessionId);
        }
        executionLease.settle();
      } finally {
        finalizationPhase.end(runtimePerformanceOutcome);
        runtimePerformance.finalize(runtimePerformanceOutcome);
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

    // Scene classification
    const sceneType = classifyScene(query);
    const outputLanguage = options?.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const packageName = options.packageName?.trim() || undefined;
    const normalizedOptions = options ?? {};
    const deferTracePreflightToModel = options?.assistantSurface === 'conversation';
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() ?? [];
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(normalizedOptions);
    if (privateAnalysisContext) {
      this.sessionOpaqueStates.delete(sessionId);
    }
    const knowledgeScope = knowledgeScopeFromAnalysisOptions(normalizedOptions);

    const quickModeResolution = resolveRuntimeQuickMode({
      query,
      sceneType,
      analysisMode: options?.analysisMode,
      conversationSurface: deferTracePreflightToModel,
      selectionContext: options?.selectionContext,
      packageName,
      hasReferenceTrace: Boolean(options?.referenceTraceId),
      previousTurns,
    });
    const priorEvidenceOnlyFollowUp =
      quickModeResolution.localReason === PRIOR_EVIDENCE_ONLY_FOLLOWUP_REASON;
    const skipFocusDetection = deferTracePreflightToModel || (
      priorEvidenceOnlyFollowUp && quickModeResolution.skipFocusDetection
    );
    const skipTracePreflightDetection = deferTracePreflightToModel || (
      priorEvidenceOnlyFollowUp && quickModeResolution.skipTracePreflightDetection
    );
    runtimePerformance.finishClassification('ok');
    const task9Admitted = isRuntimeCandidateAdmitted('task9', this.env);
    let skillRegistryReady: Promise<void> | undefined;
    const initializeSkillRegistry = (): Promise<void> => {
      if (skillRegistryReady) return skillRegistryReady;
      const skillRegistryPhase = runtimePerformance.startPhase('skill_registry');
      skillRegistryReady = (async () => {
        try {
          await ensureSkillRegistryInitialized();
          executionLease.throwIfAborted();
          skillRegistryPhase.end('ok');
        } catch (error) {
          skillRegistryPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
          throw error;
        }
      })();
      return skillRegistryReady;
    };
    if (!task9Admitted) {
      await initializeSkillRegistry();
    }
    let quickEvidenceAttempt: RuntimeQuickEvidenceAttempt | undefined;
    if (quickModeResolution.quickMode) {
      const quickEvidencePhase = runtimePerformance.startPhase('quick_evidence');
      try {
        quickEvidenceAttempt = await buildRuntimeQuickEvidenceAttempt({
          query,
          traceId,
          packageName,
          selectionContext: options?.selectionContext,
          traceProcessorService,
          outputLanguage,
          quickFocusAppPreEvidence: quickModeResolution.quickFocusAppPreEvidence,
          quickProcessIdentityPreEvidence: quickModeResolution.quickProcessIdentityPreEvidence,
          quickTraceFactPreEvidence: quickModeResolution.quickTraceFactPreEvidence,
          quickScrollingTriagePreEvidence: quickModeResolution.quickScrollingTriagePreEvidence,
          emitUpdate: update => this.emitUpdate(update),
        });
        executionLease.throwIfAborted();
        quickEvidencePhase.end('ok');
      } catch (error) {
        quickEvidencePhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
    }
    executionLease.throwIfAborted();
    if (quickEvidenceAttempt?.directAnswer) {
      const directOptions = {
        ...normalizedOptions,
        ...(quickEvidenceAttempt.effectivePackageName ? {
          packageName: quickEvidenceAttempt.effectivePackageName,
        } : {}),
      };
      const directAnalysisRunSpec = createAnalysisRunSpec({
        query,
        sessionId,
        traceId,
        options: directOptions,
        runtimeSelection: this.selection,
        engineCapabilities: getQoderEngineCapabilities(),
        sceneType,
        outputLanguage,
        previousTurns,
        resolvedMode: 'quick',
        budget: { model: 'runtime-pre-evidence' },
        adaptiveRouting: buildAdaptiveRoutingForQuickResolution({
          options: directOptions,
          resolution: quickModeResolution,
        }),
      });
      return this.buildDirectQuickEvidenceResult({
        query,
        sessionId,
        options: directOptions,
        startedAt: startTime,
        sceneType,
        outputLanguage,
        sessionContext,
        previousTurns,
        analysisRunSpec: directAnalysisRunSpec,
        directAnswer: quickEvidenceAttempt.directAnswer,
        evidenceCounts: quickEvidenceAttempt.evidenceCounts,
        persistSessionTurn: !privateAnalysisContext,
        executionLease,
        runtimePerformance,
      });
    }

    const reusableQuickEvidenceAttempt = selectReusableRuntimeQuickEvidenceAttempt(
      quickEvidenceAttempt,
      this.env,
    );

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
    if (task9Admitted) startSdkModuleLoad();

    const effectivePackageName = packageName ?? reusableQuickEvidenceAttempt?.effectivePackageName;

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

    // Focus app detection
    let focusApps: DetectedFocusApp[] = [];
    let focusAppMethod: 'battery_stats' | 'oom_adj' | 'frame_timeline' | 'none' = 'none';
    if (!skipFocusDetection) {
      const focusPhase = runtimePerformance.startPhase('focus');
      try {
        const focusResult = reusableQuickEvidenceAttempt?.focusResult
          ?? await detectFocusApps(
            traceProcessorService,
            traceId,
            { timeRange: options?.timeRange as { startNs: number; endNs: number } | undefined },
          );
        executionLease.throwIfAborted();
        focusApps = focusResult.apps;
        focusAppMethod = focusResult.method;
        focusPhase.end('ok');
      } catch (error) {
        focusPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        executionLease.throwIfAborted();
        // Non-fatal
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
      previousTurns,
      resolvedMode: quickModeResolution.quickMode ? 'quick' : 'full',
      budget: {
        model: this.config.model,
        maxTurns: this.config.maxTurns,
        quickMaxTurns: this.config.quickMaxTurns,
        fullPathPerTurnMs: this.config.fullPerTurnMs,
        quickPathPerTurnMs: this.config.quickPerTurnMs,
      },
      adaptiveRouting: buildAdaptiveRoutingForQuickResolution({
        options: normalizedOptions,
        resolution: quickModeResolution,
      }),
    });

    // Build comparison context before assembling the shared system prompt so
    // both the model and the MCP tools receive the same dual-trace contract.
    const referenceTraceId = options?.referenceTraceId;
    let comparisonContext: import('../../../agentv3/types').ComparisonContext | undefined;
    if (referenceTraceId) {
      const comparisonPhase = runtimePerformance.startPhase('comparison');
      try {
        const detectedComparisonContext = await buildRuntimeTracePairComparisonContext({
          traceProcessorService,
          currentTraceId: traceId,
          referenceTraceId,
          tracePairContext: options?.tracePairContext,
        });
        executionLease.throwIfAborted();
        comparisonContext = detectedComparisonContext;
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
      packageName: effectivePackageName,
      sceneType,
      architecture,
      focusApps,
      focusMethod: focusAppMethod,
      selectionContext: options?.selectionContext,
      outputLanguage,
      traceCompleteness,
      analysisNotes: notes,
      previousFindings: previousTurns.slice(-3).flatMap(turn => turn.findings),
      conversationSummary: previousTurns.length > 0
        ? sessionContext.generatePromptContext(2000)
        : undefined,
      patternContext: privateAnalysisContext
        ? undefined
        : buildPatternContextSection(traceFeatures, knowledgeScope),
      negativePatternContext: privateAnalysisContext
        ? undefined
        : buildNegativePatternSection(traceFeatures, knowledgeScope),
      caseBackgroundContext: buildRuntimeCaseBackgroundContext({
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

    const systemPrompt = quickModeResolution.quickMode
      ? buildQuickSystemPrompt({
          architecture,
          packageName: effectivePackageName,
          focusApps,
          focusMethod: focusAppMethod,
          selectionContext: options?.selectionContext,
          outputLanguage,
          codeAwareMode: options?.codeAwareMode,
          codebaseIds: options?.codebaseIds,
        })
      : buildSystemPrompt(analysisContext);

    // Merge with optional env system prompt
    const finalSystemPrompt = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n${systemPrompt}`
      : systemPrompt;

    await initializeSkillRegistry();
    executionLease.throwIfAborted();

    // Build MCP tools
    const skillExecutor = createSkillExecutor(traceProcessorService);
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    skillExecutor.registerSkills(effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(
      effectiveSkillRegistry.getFragmentCache(),
    );

    const artifactStore = privateAnalysisContext
      ? new ArtifactStore()
      : this.artifactStores.get(sessionId) ?? new ArtifactStore();
    if (!privateAnalysisContext) this.artifactStores.set(sessionId, artifactStore);

    const isQuickMode = quickModeResolution.quickMode;
    const skillNotesBudget = createRuntimeSkillNotesBudget(isQuickMode);
    const recentSqlErrors = loadLearnedSqlFixPairs(5, knowledgeScope, normalizedOptions);

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

    const mcp = priorEvidenceOnlyFollowUp
      ? undefined
      : isQuickMode
        ? createClaudeMcpServer({
            conversationTraceAttached: options?.assistantSurface === 'conversation'
              ? options.conversationTraceAttached === true
              : undefined,
            runManifestAttributionSink: options?.runManifestAttributionSink,
            sessionId,
            traceId,
            traceProcessorService,
            skillExecutor,
            packageName: effectivePackageName,
            emitUpdate: (update: StreamingUpdate) => this.emitUpdate(update),
            artifactStore,
            recentSqlErrors,
            skillNotesBudget,
            sceneType,
            watchdogWarning,
            lightweight: true,
            outputLanguage,
            knowledgeScope,
            codeAwareMode: options?.codeAwareMode,
            codebaseIds: options?.codebaseIds,
            knowledgeSourceIds: options?.knowledgeSourceIds,
            sourceUsePolicy: options?.sourceUsePolicy,
            analysisContextFingerprint: options?.analysisContextFingerprint,
            androidInternalsPackPin: options?.androidInternalsPackPin,
          })
        : createClaudeMcpServer({
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
            emitUpdate: (update: StreamingUpdate) => this.emitUpdate(update),
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

    // The user prompt uses the shared, localized trace-context formatter. All
    // runtime methodology remains in strategies through the shared system prompt.
    let fullPrompt = query;
    if (analysisRunSpec.traceContext.promptSection) {
      fullPrompt = `${analysisRunSpec.traceContext.promptSection}\n\n${fullPrompt}`;
    }
    if (isQuickMode) {
      const quickConversationContext = buildQuickConversationContext(previousTurns, outputLanguage);
      if (quickConversationContext) {
        fullPrompt = `${quickConversationContext}\n\n${fullPrompt}`;
      }
    }

    const { abortController } = sessionState;

    const maxTurns = quickModeResolution.quickMode
      ? this.config.quickMaxTurns
      : this.config.maxTurns;

    let q: QoderQueryLike | undefined;
    let answerProjection: ReturnType<typeof createCodeAwareStreamingTextProjection> | undefined;
    let emitProjectionTail = false;

    try {
      const resolveModel = this.createModelPolicy();

      // The import started immediately after the deterministic quick path
      // missed, so it overlaps only with independent trace preflight.
      const sdk = await startSdkModuleLoad();
      executionLease.throwIfAborted();

      // Resolve auth
      const auth = this.resolveAuth(sdk);

      // Never resume a provider conversation across a private-knowledge run.
      const existingOpaque = this.sessionOpaqueStates.get(sessionId);
      const resumeSessionId = existingOpaque?.sdkSessionId && !privateAnalysisContext
        ? existingOpaque.sdkSessionId
        : undefined;

      // Create SDK MCP server config
      const mcpServers: Record<string, unknown> = mcpServer
        ? {smartperfetto: mcpServer}
        : {};

      const sdkOptions: QoderSdkOptions = {
        auth,
        cwd: this.env.TMPDIR || '/tmp',
        systemPrompt: resumeSessionId ? undefined : finalSystemPrompt,
        maxTurns,
        model: this.config.model,
        tools: [],
        allowedTools: allowedToolNames.length > 0 ? allowedToolNames : undefined,
        permissionMode: 'bypassPermissions',
        settingSources: [],
        abortController,
        resume: resumeSessionId,
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

      answerProjection = createCodeAwareStreamingTextProjection(sessionId, 'qoder-answer');
      const activeAnswerProjection = answerProjection;

      // Execute the query with timeout. Provider timing includes synchronous
      // query creation because this is the first provider-owned operation.
      const providerPhase = runtimePerformance.startPhase('provider');
      commitEvaluationSdkHandoffIfActive();
      executionLease.throwIfAborted();
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
      let sdkFinalResultText = '';
      let sdkResultMeta: { success: boolean; subtype?: string; errors?: string; numTurns?: number } = {
        success: false,
        subtype: 'missing_result',
        errors: 'Qoder SDK stream ended without a result message',
      };
      let timedOut = false;

      const perTurnMs = isQuickMode ? this.config.quickPerTurnMs : this.config.fullPerTurnMs;
      const timeoutMs = maxTurns * perTurnMs;
      const timeoutText = localize(
        outputLanguage,
        `Qoder SDK 分析在 ${timeoutMs}ms 后超时。`,
        `Qoder SDK analysis timed out after ${timeoutMs}ms.`,
      );

      const processStream = async () => {
        for await (const message of sdkQuery) {
          if (sessionState.aborted) {
            executionLease.throwIfAborted();
            return;
          }
          executionLease.throwIfAborted();

          const msgType = getMessageType(message);

          if (msgType === 'assistant') {
            const text = extractAssistantText(message);
            if (text) {
              assistantText += text;
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
            const msg = message as Record<string, unknown>;
            recordEvaluationTokenDeltaIfPresent(
              msg.usage ?? msg.tokens ?? msg,
            );
            const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'success';
            if (subtype === 'success' && msg.is_error !== true) {
              const resultText = typeof msg.result === 'string' ? msg.result : extractAssistantText(message);
              if (resultText) {
                sdkFinalResultText = resultText;
              }
              sdkResultMeta = { success: true, numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined };
            } else {
              const errors = Array.isArray(msg.errors)
                ? (msg.errors as string[]).join('; ')
                : typeof msg.result === 'string' && msg.result.trim()
                  ? msg.result
                  : subtype;
              sdkResultMeta = { success: false, subtype, errors };
            }
          } else if (msgType === 'system') {
            if (isRecord(message)) {
              const subtype = message.subtype;
              if (subtype === 'init' && !privateAnalysisContext) {
                const initSessionId = message.session_id ?? message.sessionId;
                if (typeof initSessionId === 'string') {
                  this.sessionOpaqueStates.set(sessionId, { version: 1, sdkSessionId: initSessionId });
                }
              }
              if (typeof subtype === 'string') {
                this.emitUpdate({
                  type: 'progress',
                  content: `Qoder: ${subtype}`,
                  timestamp: Date.now(),
                });
              }
            }
          }
        }
      };

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          const timeoutError = new Error('Qoder SDK analysis timed out');
          timedOut = true;
          sessionState.aborted = true;
          void this.executionGuard.abortSession(sessionId, timeoutError).catch(() => undefined);
          void sdkQuery.interrupt().catch(() => undefined);
          reject(timeoutError);
        }, timeoutMs);
        if (typeof timeoutTimer === 'object' && 'unref' in timeoutTimer) timeoutTimer.unref();
      });
      void timeoutPromise.catch(() => undefined);

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
        await Promise.race([streamPromise, timeoutPromise, abortPromise]);
        providerPhase.end('ok');
      } catch (timeoutError) {
        providerPhase.end(runtimeOutcomeFromError(timeoutError, executionLease.signal));
        if (!timedOut) throw timeoutError;
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (onExecutionAbort) {
          executionLease.signal.removeEventListener('abort', onExecutionAbort);
        }
      }
      if (timedOut) {
        return finalizeSourceAwareAnalysisResult({
          sessionId,
          success: false,
          findings: [],
          hypotheses: [],
          conclusion: timeoutText,
          confidence: 0,
          rounds: 0,
          totalDurationMs: Date.now() - startTime,
          partial: true,
          terminationReason: 'timeout',
          terminationMessage: timeoutText,
        }, sourceUse);
      }
      executionLease.throwIfAborted();

      // Apply code-aware sanitization
      assistantText = activeAnswerProjection.projectComplete(sdkFinalResultText || assistantText);
      sessionState.assistantText = assistantText;
      const sdkErrorText = sanitizeCodeAwareText(
        sessionId,
        sdkResultMeta.errors || `Qoder SDK returned ${sdkResultMeta.subtype}`,
      );

      // Extract findings
      const findings: Finding[] = extractFindingsFromText(assistantText);

      // Build analysis result based on SDK result discriminated union
      const totalDurationMs = Date.now() - startTime;
      const hasFinalReport = hasDeliverableFinalReportHeading(assistantText);

      let terminationReason: string | undefined;
      if (!sdkResultMeta.success) {
        terminationReason = sdkResultMeta.subtype === 'error_max_turns' ? 'max_turns' : 'execution_error';
      } else if (!hasFinalReport) {
        terminationReason = 'max_turns';
      }

      const result: AnalysisResult = {
        sessionId,
        success: sdkResultMeta.success,
        findings,
        hypotheses: hypotheses.map(hypothesis => toProtocolHypothesis(hypothesis, QODER_AGENT_RUNTIME_KIND)),
        conclusion: sdkResultMeta.success ? assistantText : sdkErrorText,
        confidence: sdkResultMeta.success ? 0.75 : 0,
        rounds: sdkResultMeta.numTurns ?? (sessionState.toolCallCount > 0 ? Math.ceil(sessionState.toolCallCount / 3) : 1),
        totalDurationMs,
        partial: !hasFinalReport || !sdkResultMeta.success,
        terminationReason: terminationReason as AnalysisResult['terminationReason'],
        terminationMessage: sdkResultMeta.success ? undefined : sdkErrorText,
      };
      // Verify conclusion (non-fatal)
      if (!quickModeResolution.quickMode) {
        try {
          executionLease.throwIfAborted();
          const verificationPhase = runtimePerformance.startPhase('verification');
          let verification: Awaited<ReturnType<typeof verifyConclusion>>;
          try {
            verification = await verifyConclusion(findings, assistantText, {
            emitUpdate: (update: StreamingUpdate) => this.emitUpdate(update),
            enableLLM: false,
            plan: planState.current,
            sceneType,
            outputLanguage,
            query,
            emitIssueProgress: false,
          });
            verificationPhase.end('ok');
          } catch (error) {
            verificationPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
            throw error;
          }
          executionLease.throwIfAborted();
          const verificationIssue = [
            ...verification.heuristicIssues,
            ...(verification.llmIssues || []),
          ].find(issue => issue.severity === 'error');

          if (verificationIssue && isTruncationVerificationIssue(verificationIssue)) {
            const repaired = repairTruncatedFinalReport({
              conclusion: assistantText,
              plan: planState.current,
              hypotheses,
              outputLanguage,
            });
            if (repaired) {
              assistantText = repaired;
              result.conclusion = repaired;
              result.findings = extractFindingsFromText(repaired);
            }
          }
        } catch {
          executionLease.throwIfAborted();
          // Non-fatal — verification is best-effort
        }
      }

      // Apply final result quality gate
      executionLease.throwIfAborted();
      finalizeSourceAwareAnalysisResult(result, sourceUse);
      applyFinalResultQualityGate({
        result,
        query,
        sceneType,
        deferFocusedEvidenceFinalization: true,
      });

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
            terminationReason: result.terminationReason,
            terminationMessage: result.terminationMessage,
          },
          result.findings,
        );
      }

      // Update session state
      executionLease.throwIfAborted();
      notes.push(
        { section: 'observation', content: `Analysis completed: ${findings.length} findings`, priority: 'low', timestamp: Date.now() },
      );
      emitProjectionTail = result.success && !privateAnalysisContext;

      return result;
    } catch (error) {
      const totalDurationMs = Date.now() - startTime;
      const errorMessage = describeQoderSdkError(error);
      const safeErrorMessage = sanitizeCodeAwareText(sessionId, errorMessage);
      const isAborted = sessionState.aborted
        || executionLease.signal.aborted
        || (error instanceof Error && error.name === 'AbortError')
        || isTraceProcessorQueryCancelledError(error);

      // Clear stale session on missing-conversation errors so next call starts fresh
      if (/No conversation found with session ID/i.test(errorMessage)) {
        this.sessionOpaqueStates.delete(sessionId);
      }

      if (isAborted) {
        this.sessionOpaqueStates.delete(sessionId);
      } else {
        this.emitUpdate({
          type: 'error',
          content: { message: safeErrorMessage },
          timestamp: Date.now(),
        });
      }

      const isAuthError = /auth|unauthorized|invalid.*token|access.*denied/i.test(errorMessage);
      const abortedMessage = localize(outputLanguage, '分析已中止。', 'Analysis was aborted.');

      return finalizeSourceAwareAnalysisResult({
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: isAborted
          ? abortedMessage
          : localize(
              outputLanguage,
              `Qoder Agent SDK 分析失败：${safeErrorMessage}`,
              `Qoder Agent SDK analysis failed: ${safeErrorMessage}`,
            ),
        confidence: 0,
        rounds: 0,
        totalDurationMs,
        partial: true,
        terminationReason: isAborted ? 'timeout' : 'execution_error',
        terminationMessage: isAborted
          ? abortedMessage
          : isAuthError
          ? localize(
              outputLanguage,
              `认证失败：${safeErrorMessage}`,
              `Authentication failed: ${safeErrorMessage}`,
            )
          : safeErrorMessage,
      }, sourceUse);
    } finally {
      sessionState.sdkQuery = undefined;
      await q?.close().catch(() => undefined);
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

  private createModelPolicy(): QoderSdkOptions['resolveModel'] {
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
      const model = QODER_LIGHT_MODEL_PURPOSES.has(purpose)
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

  private buildDirectQuickEvidenceResult(input: {
    query: string;
    sessionId: string;
    options: AnalysisOptions;
    startedAt: number;
    sceneType: SceneType;
    outputLanguage: OutputLanguage;
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
    previousTurns: ConversationTurn[];
    analysisRunSpec: AnalysisRunSpec;
    directAnswer: RuntimeQuickEvidenceDirectAnswer;
    evidenceCounts: RuntimeQuickEvidenceCounts;
    persistSessionTurn: boolean;
    executionLease: RuntimeExecutionLease;
    runtimePerformance: RuntimePerformanceRun;
  }): AnalysisResult {
    const quickBudget = resolveQuickTurnBudget({
      env: this.env,
      hardCapTurns: this.config.quickMaxTurns,
      targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS'],
      hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS', 'QODER_QUICK_MAX_TURNS'],
      enforcement: 'turn_cap',
    });
    const result = buildQuickDirectEvidenceAnalysisResult({
      query: input.query,
      sessionId: input.sessionId,
      options: input.options,
      startedAt: input.startedAt,
      analysisRunSpec: input.analysisRunSpec,
      budget: quickBudget,
      directAnswer: input.directAnswer,
      evidenceCounts: input.evidenceCounts,
      previousTurns: input.previousTurns,
    });
    emitQuickDirectQualityGateIssue({
      emitUpdate: update => this.emitUpdate(update),
      module: 'qoderRuntime',
      result,
      query: input.query,
      sceneType: input.sceneType,
    });
    if (input.persistSessionTurn) {
      input.executionLease.throwIfAborted();
      input.sessionContext.addTurn(
        input.query,
        {
          primaryGoal: input.query,
          aspects: [],
          expectedOutputType: 'diagnosis',
          complexity: 'simple',
          followUpType: input.previousTurns.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: QODER_AGENT_RUNTIME_KIND,
          success: result.success,
          findings: result.findings,
          confidence: result.confidence,
          message: result.conclusion,
        },
        result.findings,
      );
    }
    input.executionLease.throwIfAborted();
    input.runtimePerformance.recordFirstOutput();
    emitQuickDirectAnswerEvents({
      emitUpdate: update => this.emitUpdate(update),
      result,
      startedAt: input.startedAt,
      outputLanguage: input.outputLanguage,
      runtime: QODER_AGENT_RUNTIME_KIND,
      model: 'runtime-pre-evidence',
    });
    return result;
  }

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
