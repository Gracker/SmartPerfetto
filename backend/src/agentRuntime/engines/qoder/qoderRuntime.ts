// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import type {
  AnalysisOptions,
  AnalysisResult,
  IOrchestrator,
} from '../../../agent/core/orchestratorTypes';
import type { Finding, StreamingUpdate } from '../../../agent/types';
import type { ArchitectureInfo } from '../../../agent/detectors/types';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
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
  type QoderOpaqueState,
  type SessionFieldsForSnapshot,
  type SessionStateSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import {
  applyFinalResultQualityGate,
  hasDeliverableFinalReportHeading,
} from '../../../services/finalResultQualityGate';
import { verifyConclusion } from '../claude/claudeVerifier';
import { sanitizeCodeAwareText } from '../../../services/security/codeAwareOutputRegistry';
import type { RuntimeSelection } from '../../runtimeSelection';
import type { RuntimeEngineDefinition, RuntimeFactoryInput } from '../../runtimeRegistry';
import {
  createRuntimeSkillNotesBudget,
  isTruncationVerificationIssue,
  repairTruncatedFinalReport,
} from '../../runtimeCommon';
import { knowledgeScopeFromAnalysisOptions } from '../../runtimeScopes';
import { buildRuntimeTracePairComparisonContext } from '../../runtimePromptContext';
import { buildCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import { resolveRuntimeQuickMode } from '../../quickModeResolution';
import { isTraceProcessorQueryCancelledError } from '../../../services/traceProcessorCancellation';
import { QODER_AGENT_RUNTIME_KIND } from '../../runtimeKinds';
import {
  QODER_PERSONAL_ACCESS_TOKEN_ENV,
  QODER_CLI_PATH_ENV,
  QODER_MODEL_ENV,
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
  QODER_MODEL_ENV,
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

import { loadQoderSdkModule } from './qoderSdkLoader';

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
    const startTime = Date.now();
    const traceProcessorService = options?.traceProcessorService ?? this.input.traceProcessorService;

    // Ensure skill registry is ready
    await ensureSkillRegistryInitialized();

    // Scene classification
    const sceneType = classifyScene(query);
    const outputLanguage = parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const packageName = options?.packageName;

    // Architecture detection
    let architecture: ArchitectureInfo | undefined;
    try {
      const detector = createArchitectureDetector();
      architecture = await detector.detect({
        traceId,
        traceProcessorService,
        packageName,
      });
      this.architectureCache.set(traceId, architecture);
    } catch {
      // Non-fatal — architecture detection is optional
    }

    // Focus app detection
    let focusApps: DetectedFocusApp[] = [];
    let focusAppMethod: 'battery_stats' | 'oom_adj' | 'frame_timeline' | 'none' = 'none';
    try {
      const focusResult = await detectFocusApps(
        traceProcessorService,
        traceId,
        { timeRange: options?.timeRange as { startNs: number; endNs: number } | undefined },
      );
      focusApps = focusResult.apps;
      focusAppMethod = focusResult.method;
    } catch {
      // Non-fatal
    }

    // Probe trace completeness
    let traceCompleteness: Awaited<ReturnType<typeof probeTraceCompleteness>> | undefined;
    try {
      traceCompleteness = await probeTraceCompleteness(traceProcessorService, traceId);
    } catch {
      // Non-fatal
    }

    // Resolve quick mode
    const quickModeResolution = resolveRuntimeQuickMode({
      query,
      sceneType,
      analysisMode: options?.analysisMode,
      selectionContext: options?.selectionContext,
      packageName,
      hasReferenceTrace: Boolean(options?.referenceTraceId),
      previousTurns: [],
    });

    // Build system prompt
    const traceFeatures = extractTraceFeatures({
      sceneType,
      architectureType: architecture?.type,
      packageName,
    });

    // Shared mutable notes reference (used by both system prompt and MCP tools)
    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }

    const analysisContext: ClaudeAnalysisContext = {
      query,
      packageName,
      sceneType,
      architecture,
      focusApps,
      focusMethod: focusAppMethod,
      selectionContext: options?.selectionContext,
      outputLanguage,
      traceCompleteness,
      analysisNotes: notes,
      patternContext: buildPatternContextSection(traceFeatures),
      negativePatternContext: buildNegativePatternSection(traceFeatures),
      caseBackgroundContext: buildCaseBackgroundContext(sceneType, architecture?.type),
    };

    const systemPrompt = quickModeResolution.quickMode
      ? buildQuickSystemPrompt({
          architecture,
          packageName,
          focusApps,
          focusMethod: focusAppMethod,
          selectionContext: options?.selectionContext,
          outputLanguage,
        })
      : buildSystemPrompt(analysisContext);

    // Merge with optional env system prompt
    const finalSystemPrompt = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n${systemPrompt}`
      : systemPrompt;

    // Build MCP tools
    const skillExecutor = createSkillExecutor(traceProcessorService);
    skillExecutor.registerSkills(skillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(skillRegistry.getFragmentCache());

    const artifactStore = this.artifactStores.get(sessionId) ?? new ArtifactStore();
    this.artifactStores.set(sessionId, artifactStore);

    const isQuickMode = quickModeResolution.quickMode;
    const skillNotesBudget = createRuntimeSkillNotesBudget(isQuickMode);
    const knowledgeScope = knowledgeScopeFromAnalysisOptions(options ?? {});
    const recentSqlErrors = loadLearnedSqlFixPairs();

    // Shared mutable session state (same reference pattern as Claude runtime)
    let planState = this.sessionPlans.get(sessionId);
    if (!planState) {
      planState = { current: null, history: [] };
      this.sessionPlans.set(sessionId, planState);
    }

    let hypotheses = this.sessionHypotheses.get(sessionId);
    if (!hypotheses) {
      hypotheses = [];
      this.sessionHypotheses.set(sessionId, hypotheses);
    }

    let uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId);
    if (!uncertaintyFlags) {
      uncertaintyFlags = [];
      this.sessionUncertaintyFlags.set(sessionId, uncertaintyFlags);
    }

    const watchdogWarning: { current: string | null } = { current: null };

    // Build comparison context for dual-trace mode
    const referenceTraceId = options?.referenceTraceId;
    let comparisonContext: import('../../../agentv3/types').ComparisonContext | undefined;
    if (referenceTraceId) {
      try {
        comparisonContext = await buildRuntimeTracePairComparisonContext({
          traceProcessorService,
          currentTraceId: traceId,
          referenceTraceId,
          tracePairContext: options?.tracePairContext,
        });
      } catch {
        // Non-fatal — comparison context is best-effort
      }
    }

    const { server: mcpServer, allowedTools: allowedToolNames } = isQuickMode
      ? createClaudeMcpServer({
          sessionId,
          traceId,
          traceProcessorService,
          skillExecutor,
          packageName,
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
          analysisContextFingerprint: options?.analysisContextFingerprint,
          androidInternalsPackPin: options?.androidInternalsPackPin,
        })
      : createClaudeMcpServer({
          sessionId,
          traceId,
          userQuery: query,
          traceProcessorService,
          skillExecutor,
          packageName,
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
          analysisContextFingerprint: options?.analysisContextFingerprint,
          androidInternalsPackPin: options?.androidInternalsPackPin,
        });

    // Build the prompt for the Qoder SDK
    const fullPrompt = this.buildAnalysisPrompt(query, analysisContext, options);

    // Create abort controller
    const abortController = new AbortController();
    const sessionState: QoderActiveSession = {
      abortController,
      aborted: false,
      assistantText: '',
      toolCallCount: 0,
    };
    this.activeSessions.set(sessionId, sessionState);

    const maxTurns = quickModeResolution.quickMode
      ? this.config.quickMaxTurns
      : this.config.maxTurns;

    try {
      // Load the Qoder SDK module
      const sdk = await loadQoderSdkModule(this.env) as unknown as QoderSdkModule;

      // Resolve auth
      const auth = this.resolveAuth(sdk);

      // Resolve session resume (skip for code-aware mode to avoid cross-request leakage)
      const existingOpaque = this.sessionOpaqueStates.get(sessionId);
      const resumeSessionId = existingOpaque?.sdkSessionId && !options?.codeAwareMode
        ? existingOpaque.sdkSessionId
        : undefined;

      // Create SDK MCP server config
      const mcpServers: Record<string, unknown> = {
        smartperfetto: mcpServer,
      };

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
      };

      // Execute the query with timeout
      const q = sdk.query({ prompt: fullPrompt, options: sdkOptions });
      sessionState.sdkQuery = q;

      let assistantText = '';
      let sdkResultMeta: { success: boolean; subtype?: string; errors?: string; numTurns?: number } = { success: true };
      let timedOut = false;

      const perTurnMs = isQuickMode ? this.config.quickPerTurnMs : this.config.fullPerTurnMs;
      const timeoutMs = maxTurns * perTurnMs;

      const processStream = async () => {
        for await (const message of q) {
          if (sessionState.aborted) break;

          const msgType = getMessageType(message);

          if (msgType === 'assistant') {
            const text = extractAssistantText(message);
            if (text) {
              assistantText += text;
              sessionState.assistantText = assistantText;
              this.emitUpdate({
                type: 'answer_token',
                content: text,
                timestamp: Date.now(),
              });
            }
          } else if (msgType === 'result') {
            const msg = message as Record<string, unknown>;
            const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'success';
            if (subtype === 'success') {
              const resultText = typeof msg.result === 'string' ? msg.result : extractAssistantText(message);
              if (resultText) {
                assistantText += resultText;
                sessionState.assistantText = assistantText;
              }
              sdkResultMeta = { success: true, numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined };
            } else {
              const errors = Array.isArray(msg.errors) ? (msg.errors as string[]).join('; ') : subtype;
              sdkResultMeta = { success: false, subtype, errors };
            }
          } else if (msgType === 'system') {
            if (isRecord(message)) {
              const subtype = message.subtype;
              if (subtype === 'init') {
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
          timedOut = true;
          q.interrupt().catch(() => undefined);
          q.close().catch(() => undefined);
          reject(new Error('Qoder SDK analysis timed out'));
        }, timeoutMs);
        if (typeof timeoutTimer === 'object' && 'unref' in timeoutTimer) timeoutTimer.unref();
      });

      try {
        await Promise.race([processStream(), timeoutPromise]);
      } catch (timeoutError) {
        if (!timedOut) throw timeoutError;
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      }

      await q.close().catch(() => undefined);

      // Apply code-aware sanitization
      assistantText = sanitizeCodeAwareText(sessionId, assistantText);

      // Extract findings
      const findings: Finding[] = extractFindingsFromText(assistantText);

      // Build analysis result based on SDK result discriminated union
      const totalDurationMs = Date.now() - startTime;
      const hasFinalReport = hasDeliverableFinalReportHeading(assistantText);

      let terminationReason: string | undefined;
      if (timedOut) {
        terminationReason = 'timeout';
      } else if (!sdkResultMeta.success) {
        terminationReason = sdkResultMeta.subtype === 'error_max_turns' ? 'max_turns' : 'execution_error';
      } else if (!hasFinalReport) {
        terminationReason = 'max_turns';
      }

      const result: AnalysisResult = {
        sessionId,
        success: sdkResultMeta.success && !timedOut,
        findings,
        hypotheses: [],
        conclusion: sdkResultMeta.success
          ? assistantText
          : (sdkResultMeta.errors || `Qoder SDK returned ${sdkResultMeta.subtype}`),
        confidence: sdkResultMeta.success ? 0.75 : 0,
        rounds: sdkResultMeta.numTurns ?? (sessionState.toolCallCount > 0 ? Math.ceil(sessionState.toolCallCount / 3) : 1),
        totalDurationMs,
        partial: !hasFinalReport || !sdkResultMeta.success || timedOut,
        terminationReason: terminationReason as AnalysisResult['terminationReason'],
        terminationMessage: sdkResultMeta.success ? undefined : sdkResultMeta.errors,
      };

      // Verify conclusion (non-fatal)
      if (!quickModeResolution.quickMode) {
        try {
          const verification = await verifyConclusion(findings, assistantText, {
            emitUpdate: (update: StreamingUpdate) => this.emitUpdate(update),
            enableLLM: false,
            plan: this.sessionPlans.get(sessionId)?.current ?? null,
            sceneType,
            outputLanguage,
            query,
            emitIssueProgress: false,
          });
          const verificationIssue = [
            ...verification.heuristicIssues,
            ...(verification.llmIssues || []),
          ].find(issue => issue.severity === 'error');

          if (verificationIssue && isTruncationVerificationIssue(verificationIssue)) {
            const repaired = repairTruncatedFinalReport({
              conclusion: assistantText,
              plan: this.sessionPlans.get(sessionId)?.current ?? null,
              hypotheses: this.sessionHypotheses.get(sessionId),
              outputLanguage,
            });
            if (repaired) {
              assistantText = repaired;
              result.conclusion = repaired;
              result.findings = extractFindingsFromText(repaired);
            }
          }
        } catch {
          // Non-fatal — verification is best-effort
        }
      }

      // Apply final result quality gate
      applyFinalResultQualityGate({ result, query, sceneType });

      // Update session state
      notes.push(
        { section: 'observation', content: `Analysis completed: ${findings.length} findings`, priority: 'low', timestamp: Date.now() },
      );

      return result;
    } catch (error) {
      const totalDurationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Clear stale session on missing-conversation errors so next call starts fresh
      if (/No conversation found with session ID/i.test(errorMessage)) {
        this.sessionOpaqueStates.delete(sessionId);
      }

      // Emit error event
      this.emitUpdate({
        type: 'error',
        content: { message: errorMessage },
        timestamp: Date.now(),
      });

      const isAborted = sessionState.aborted
        || (error instanceof Error && error.name === 'AbortError')
        || isTraceProcessorQueryCancelledError(error);

      const isAuthError = /auth|unauthorized|invalid.*token|access.*denied/i.test(errorMessage);

      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: isAborted
          ? localize(outputLanguage, 'Analysis was aborted.', 'Analysis was aborted.')
          : `Qoder Agent SDK analysis failed: ${errorMessage}`,
        confidence: 0,
        rounds: 0,
        totalDurationMs,
        terminationReason: 'execution_error',
        terminationMessage: isAuthError ? `Authentication failed: ${errorMessage}` : errorMessage,
      };
    } finally {
      this.activeSessions.delete(sessionId);
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

  // -------------------------------------------------------------------------
  // Prompt building
  // -------------------------------------------------------------------------

  private buildAnalysisPrompt(
    query: string,
    context: ClaudeAnalysisContext,
    options?: AnalysisOptions,
  ): string {
    const parts: string[] = [query];

    if (context.packageName) {
      parts.push(`\nTarget package: ${context.packageName}`);
    }

    if (context.architecture) {
      parts.push(`\nDetected architecture: ${context.architecture.type}`);
    }

    if (context.focusApps && context.focusApps.length > 0) {
      const appNames = context.focusApps.map(a => a.packageName).join(', ');
      parts.push(`\nFocus apps: ${appNames}`);
    }

    if (options?.timeRange) {
      parts.push(`\nTime range: ${options.timeRange.start} - ${options.timeRange.end}`);
    }

    if (options?.traceContext?.length) {
      parts.push('\nPre-queried trace data:');
      for (const dataset of options.traceContext) {
        parts.push(`\n## ${dataset.label}`);
        parts.push(`Columns: ${dataset.columns.join(', ')}`);
        parts.push(`Rows: ${dataset.rows.length}`);
        if (dataset.rows.length > 0) {
          parts.push('First rows:');
          for (const row of dataset.rows.slice(0, 5)) {
            parts.push(`| ${dataset.columns.map((_, i) => String(row[i] ?? '')).join(' | ')} |`);
          }
        }
      }
    }

    return parts.join('\n');
  }

  // -------------------------------------------------------------------------
  // IOrchestrator — lifecycle
  // -------------------------------------------------------------------------

  reset(): void {
    for (const [, session] of this.activeSessions) {
      session.aborted = true;
      session.abortController.abort();
      session.sdkQuery?.close().catch(() => undefined);
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
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    session.aborted = true;
    session.abortController.abort();
    await session.sdkQuery?.interrupt().catch(() => undefined);
    await session.sdkQuery?.close().catch(() => undefined);
    this.activeSessions.delete(sessionId);
  }

  cleanupSession(sessionId: string): void {
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
    const planState = this.sessionPlans.get(sessionId);
    const artifactStore = this.artifactStores.get(sessionId);
    const opaque = this.sessionOpaqueStates.get(sessionId)
      ?? { version: 1, degradedReason: 'state_unavailable' as const };

    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,
      ...sessionFields,
      analysisNotes: this.sessionNotes.get(sessionId) ?? [],
      analysisPlan: planState?.current ?? null,
      planHistory: planState?.history ?? [],
      uncertaintyFlags: this.sessionUncertaintyFlags.get(sessionId) ?? [],
      claudeHypotheses: this.sessionHypotheses.get(sessionId) ?? undefined,
      architecture: this.architectureCache.get(traceId),
      engineState: createQoderSnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        opaque,
      }),
      agentRuntimeKind: QODER_AGENT_RUNTIME_KIND,
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      agentRuntimeProviderSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
      artifacts: artifactStore?.serialize(),
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
