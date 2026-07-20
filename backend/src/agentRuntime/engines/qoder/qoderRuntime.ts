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
import { createAnalysisRunSpec } from '../../analysisRunSpec';
import {
  createRuntimeSkillNotesBudget,
  isTruncationVerificationIssue,
  repairTruncatedFinalReport,
} from '../../runtimeCommon';
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
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
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

const importEsmModule = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
// Qoder SDK loader
// ---------------------------------------------------------------------------

export async function loadQoderSdkModule(
  env: EnvLike = process.env,
): Promise<QoderSdkModule> {
  const specifier = '@qoder-ai/qoder-agent-sdk';
  const module = await importEsmModule(specifier) as Partial<QoderSdkModule>;
  if (typeof module.query !== 'function') {
    throw new Error('Qoder Agent SDK module does not export query()');
  }
  return module as QoderSdkModule;
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

    const analysisRunSpec = createAnalysisRunSpec({
      query,
      sessionId,
      traceId,
      options,
      runtimeSelection: this.selection,
      sceneType,
      outputLanguage,
      previousTurns: [],
    });

    // Build system prompt
    const traceFeatures = extractTraceFeatures({
      sceneType,
      architectureType: architecture?.type,
      packageName,
    });

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
      analysisNotes: this.sessionNotes.get(sessionId) ?? [],
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
    const skillExecutor = createSkillExecutor({
      traceProcessorService,
      traceId,
      skillRegistry,
    });

    const artifactStore = this.artifactStores.get(sessionId) ?? new ArtifactStore();
    this.artifactStores.set(sessionId, artifactStore);

    const skillNotesBudget = createRuntimeSkillNotesBudget(quickModeResolution.quickMode);
    const recentSqlErrors = loadLearnedSqlFixPairs();

    const { server: mcpServer, allowedTools: allowedToolNames } = createClaudeMcpServer({
      sessionId,
      traceId,
      traceProcessorService,
      skillExecutor,
      packageName,
      emitUpdate: (update: StreamingUpdate) => this.emitUpdate(update),
      analysisNotes: this.sessionNotes.get(sessionId) ?? [],
      artifactStore,
      recentSqlErrors,
      skillNotesBudget,
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
      const sdk = await loadQoderSdkModule(this.env);

      // Resolve auth
      const auth = this.resolveAuth(sdk);

      // Create SDK MCP server config
      const mcpServers: Record<string, unknown> = {
        smartperfetto: mcpServer,
      };

      const sdkOptions: QoderSdkOptions = {
        auth,
        cwd: process.cwd(),
        systemPrompt: finalSystemPrompt,
        maxTurns,
        model: this.config.model,
        allowedTools: allowedToolNames.length > 0 ? allowedToolNames : undefined,
        allowDangerouslySkipPermissions: true,
        mcpServers,
        env: { ...this.env },
        stderr: (data: string) => {
          // Forward stderr to debug
          if (truthyEnv(this.env.QODER_DEBUG)) {
            console.error('[Qoder SDK stderr]', data);
          }
        },
      };

      // Execute the query
      const q = sdk.query({ prompt: fullPrompt, options: sdkOptions });
      sessionState.sdkQuery = q;

      let assistantText = '';

      for await (const message of q) {
        if (sessionState.aborted) break;

        const msgType = getMessageType(message);

        if (msgType === 'assistant') {
          const text = extractAssistantText(message);
          if (text) {
            assistantText += text;
            sessionState.assistantText = assistantText;

            // Stream answer tokens
            this.emitUpdate({
              type: 'answer_token',
              content: text,
              timestamp: Date.now(),
            });
          }
        } else if (msgType === 'result') {
          // Result message — extract final text
          const resultText = extractAssistantText(message);
          if (resultText) {
            assistantText += resultText;
            sessionState.assistantText = assistantText;
          }
        } else if (msgType === 'system') {
          // System messages — could be init, status, etc.
          // Emit as progress
          if (isRecord(message)) {
            const subtype = message.subtype;
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

      await q.close().catch(() => undefined);

      // Apply code-aware sanitization
      assistantText = sanitizeCodeAwareText(sessionId, assistantText);

      // Extract findings
      const findings: Finding[] = extractFindingsFromText(assistantText);

      // Build analysis result
      const totalDurationMs = Date.now() - startTime;
      const hasFinalReport = hasDeliverableFinalReportHeading(assistantText);

      const result: AnalysisResult = {
        sessionId,
        success: true,
        findings,
        hypotheses: [],
        conclusion: assistantText,
        confidence: 0.75,
        rounds: sessionState.toolCallCount > 0 ? Math.ceil(sessionState.toolCallCount / 3) : 1,
        totalDurationMs,
        partial: !hasFinalReport,
        terminationReason: sessionState.aborted ? 'execution_error' : (hasFinalReport ? undefined : 'max_turns'),
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
      this.sessionNotes.set(sessionId, [
        ...(this.sessionNotes.get(sessionId) ?? []),
        { section: 'observation', content: `Analysis completed: ${findings.length} findings`, priority: 'low', timestamp: Date.now() },
      ]);

      return result;
    } catch (error) {
      const totalDurationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Emit error event
      this.emitUpdate({
        type: 'error',
        content: { message: errorMessage },
        timestamp: Date.now(),
      });

      const isAborted = sessionState.aborted
        || (error instanceof Error && error.name === 'AbortError')
        || isTraceProcessorQueryCancelledError(error);

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
        terminationReason: isAborted ? 'execution_error' : 'execution_error',
        terminationMessage: errorMessage,
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
    return undefined;
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
