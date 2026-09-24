// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {snapshotSceneCoverageRegistry} from '../../../agent/scene/sceneCoveragePlan';
import { EventEmitter } from 'events';
import { createHash, randomUUID } from 'crypto';
import {resolveAgentRuntimeBudgetConfig} from '../../../config';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisCandidateIdentity, type AnalysisDeliveryContext} from '../../../types/analysisDelivery';
import {attachFinalizationContext} from '../../analysisFinalizationContext';
import {createAnalysisTurnIntentResolver, type AnalysisTurnIntent} from '../../analysisTurnIntent';
import {resolveRuntimeTurnPolicy, usesLightweightToolCatalog, type RuntimeTurnPolicy} from '../../runtimeTurnPolicy';
import {createRuntimeTurnCloseoutTape, resolveRuntimeTurnBudget} from '../../runtimeTurnCloseout';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  appendRelationProposalRecoveryFragment,
  nativeDeclarationBodyCanFitOutput,
  requestNativeDeclarationCompletion,
  INVALID_NATIVE_DECLARATION,
} from '../../runtimeConclusionProtocol';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext, toAnalysisHistoryTurn,
  type AnalysisHistoryReader} from '../../analysisHistory';
import type {RuntimeToolObserver} from '../../runtimeToolObserver';
import {runIntentTransport, type IntentTransportInput} from '../../intentTransport';
import {runPiIntentTransport} from './piIntentTransport';
import {buildComplexityClassifierInput} from '../../../agentv3/queryComplexityContext';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import { pathToFileURL } from 'url';
import type { IOrchestrator } from '../../../agent/core/orchestratorTypes';
import type { AnalysisOptions, AnalysisResult } from '../../../agent/core/orchestratorTypes';
import type { ConversationTurn, StreamingUpdate } from '../../../agent/types';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import type { ArchitectureInfo } from '../../../agent/detectors/types';
import { sessionContextManager } from '../../../agent/context/enhancedSessionContext';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
import {resolveEffectiveSkillRegistryForRuntime} from '../../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import {
  commitEvaluationSdkHandoffIfActive,
  recordEvaluationTokenDeltaIfPresent,
} from '../../../services/selfEvolution/evaluationRuntimeHooks';
import type { TraceProcessorService } from '../../../services/traceProcessorService';
import { getExtendedKnowledgeBase } from '../../../services/sqlKnowledgeBase';
import {analysisContextUsesPrivateKnowledge, assertCurrentAnalysisContextAuthorization, buildAnalysisContextAuthorizationFingerprint} from '../../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import {inspectCandidateProtocol, buildCandidateProtocolDiagnostic} from '../../../services/canonicalAnalysisResult';
import {
  isSensitiveRagToolName,
  projectToolResultForExternalSurface,
} from '../../../services/rag/toolResultProjectionFilter';
import { extractSourceLookupCodeReferences } from '../../../services/codebase/sourceLookupTools';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../../services/codebase/sourceClaimVerifier';
import {
  createPiAgentCoreSnapshotEngineState,
  getPiAgentCoreSnapshotEngineState,
  projectSessionFieldsForDurableSnapshot,
  type PiAgentCoreOpaqueState,
  type SessionFieldsForSnapshot,
  sessionFieldsUsePrivateKnowledge,
  type SessionStateSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import {
  createClaudeMcpServer,
  loadLearnedSqlFixPairs,
  MIN_PHASE_SUMMARY_CHARS,
} from '../../../agentv3/claudeMcpServer';
import {buildSystemPrompt} from '../../../agentv3/claudeSystemPrompt';
import { extractFindingsFromText } from '../../../agentv3/claudeFindingExtractor';
import { resolveFocusAppTarget } from '../../focusAppTarget';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {resolveRuntimeEvidenceStore} from '../../runtimeEvidenceContext';
import {activateSceneRuntime, resolveSceneProductScope} from '../../../agent/scene/sceneRuntimeBinding';
import {
  buildNegativePatternSection,
  buildPatternContextSection,
  extractTraceFeatures,
} from '../../../agentv3/analysisPatternMemory';
import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import type {SceneType} from '../../../agentv3/sceneClassifier';
import { DEFAULT_OUTPUT_LANGUAGE, localize, parseOutputLanguage, type OutputLanguage } from '../../../agentv3/outputLanguage';
import { formatToolCallNarration, formatToolResultNarration, issuePrivateToolResultNarrationReceipt, toolResultIsFailure } from '../../../agentv3/toolNarration';
import { estimateAnalysisConfidence } from '../../../agentv3/analysisTermination';
import { planPhaseUpdatedContent } from '../../../agentv3/planPhaseEvents';
import type {
  AnalysisNote,
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  Hypothesis,
  PlanPhase,
  UncertaintyFlag,
} from '../../../agentv3/types';
import {
  getAnalysisPlanCompletionStatus,
  type AnalysisPlanCompletionStatus,
} from '../../../agentv3/planCompletionStatus';
import {
  recordPlanOrPrePlanToolCall,
  resetPrePlanToolCallsForNewRun,
  readToolResultFacts,
} from '../../../agentv3/planToolCallRecorder';
import {
  applyFinalResultQualityGate,
  type FinalResultComparisonIdentity,
} from '../../../services/finalResultQualityGate';
import {
  generateCorrectionPrompt,
  verifyConclusion,
} from '../claude/claudeVerifier';
import type { ClaimVerificationResult } from '../../../types/claimVerification';
import type {
  RuntimeToolConcurrencyPolicy,
  RuntimeToolResult,
  SharedToolSpec,
} from '../../runtimeToolSpec';
import {
  createJsonSchemaFromZodRawShape,
  normalizeRuntimeToolArgs,
  stringifyRuntimeToolResult,
} from '../../runtimeToolSpec';
import type { RuntimeSelection } from '../../runtimeSelection';
import type { RuntimeEngineDefinition, RuntimeFactoryInput } from '../../runtimeRegistry';
import type { EngineCapabilities } from '../../runtimeDescriptorTypes';
import { canonicalRuntimeKind, createAnalysisRunSpec, type AnalysisRunSpec } from '../../analysisRunSpec';
import {
  buildComparisonIdentity,
  buildRuntimeTracePairComparisonContext,
  buildRuntimeTracePairIdentityContext,
  detectRunFocusApps,
} from '../../runtimePromptContext';
import { loadPromptTemplate } from '../../../agentv3/strategyLoader';
import {
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
} from '../../runtimeKinds';
import {
  buildQuickRunReceipt,
  buildQuickMemoryContextPayload,
  captureSkillDisplayEntities,
  createRuntimeSkillNotesBudget,
  quickStopReasonFromTermination,
  resolveQuickTurnBudget,
  toProtocolHypothesis as toRuntimeProtocolHypothesis,
} from '../../runtimeCommon';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import {countCompletedQuickConversationTurns} from '../../quickDirectResult';
import {getLruCacheEntry, setLruCacheEntry} from '../../runtimeCache';
import {
  DEFAULT_FULL_REQUEST_TIMEOUT_MS,
  DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
  summarizeExternalToolResult,
  type RuntimeTimeoutKind,
} from '../../runtimeLimits';
import {
  createPiAgentCoreProviderRuntime,
  type PiAgentCoreProviderRuntimeLoader,
} from './piAgentCoreProvider';
import {
  parsePiAgentCoreModelConfig,
  type PiAgentCoreModelConfig,
} from './piAgentCoreConfig';

export {
  createPiAgentCoreProviderRuntime,
  type PiAgentCoreProviderRuntime,
} from './piAgentCoreProvider';
export type {PiAgentCoreModelConfig} from './piAgentCoreConfig';

export type ExperimentalPiAgentCoreRuntimeKind = typeof EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND;
export type PublicPiAgentCoreRuntimeKind = typeof PI_AGENT_CORE_RUNTIME_KIND;
export type PiAgentCoreRuntimeKind = ExperimentalPiAgentCoreRuntimeKind | PublicPiAgentCoreRuntimeKind;
export {
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
};

export const PI_AGENT_CORE_MODULE_PATH_ENV = 'SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH';
export const PI_AGENT_CORE_FAKE_STREAM_ENV = 'SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM';
export const PI_AGENT_CORE_MODEL_JSON_ENV = 'SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON';
export const PI_AGENT_CORE_SYSTEM_PROMPT_ENV = 'SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT';
export const PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV = 'SMARTPERFETTO_PI_AGENT_CORE_REQUEST_TIMEOUT_MS';
export const PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV = 'SMARTPERFETTO_PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS';
export const PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV = 'SMARTPERFETTO_PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS';

const AGENT_FULL_REQUEST_TIMEOUT_MS_ENV = 'AGENT_FULL_REQUEST_TIMEOUT_MS';
const AGENT_STREAM_IDLE_TIMEOUT_MS_ENV = 'AGENT_STREAM_IDLE_TIMEOUT_MS';
const PI_AGENT_CORE_DEFAULT_ABORT_JOIN_TIMEOUT_MS = 5_000;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const PI_AGENT_CORE_PREVIEW_CLAIM_VERIFICATION: ClaimVerificationResult = {
  schemaVersion: 'claim_verifier@1',
  status: 'not_checked',
  policy: 'record_only',
  notCheckedReason: 'pi-agent-core public preview smoke is capability-limited and does not produce evidence-bound SmartPerfetto claims yet',
  passed: false,
  checkedClaimCount: 0,
  unsupportedClaimCount: 0,
  claimResults: [],
  issues: [],
};

type EnvLike = Record<string, string | undefined>;

const MAX_PI_OPAQUE_MESSAGES = 80;
const MAX_PI_OPAQUE_BYTES = 512 * 1024;
const SENSITIVE_OPAQUE_KEY_RE = /(?:api[_-]?key|auth|authorization|bearer|password|secret|token)/i;

interface PiAgentCoreAgentState {
  messages?: unknown[];
  tools?: unknown[];
  systemPrompt?: string;
  errorMessage?: string;
}

interface PiAgentCoreAgent {
  state: PiAgentCoreAgentState;
  subscribe(listener: (event: PiAgentCoreEvent, signal?: AbortSignal) => Promise<void> | void): () => void;
  prompt(input: string): Promise<void>;
  abort(): void;
  reset(): void;
}

export interface PiAgentCoreAgentOptions extends Record<string, unknown> {
  streamFn: (...args: any[]) => unknown;
}

interface PiAgentCoreModule {
  Agent: new (options: PiAgentCoreAgentOptions) => PiAgentCoreAgent;
}

function sanitizeOpaqueJsonValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_OPAQUE_KEY_RE.test(key)) return '[redacted]';
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeOpaqueJsonValue(item))
      .filter(item => item !== undefined);
  }
  if (typeof value === 'object' && value) {
    const candidate = value as Record<string, unknown>;
    const messageType = typeof candidate.type === 'string' ? candidate.type : '';
    const messageRole = typeof candidate.role === 'string' ? candidate.role : '';
    if (/tool[_-]?result/i.test(messageType) || /tool[_-]?result/i.test(messageRole)) {
      return {
        ...(messageType ? {type: messageType} : {}),
        ...(messageRole ? {role: messageRole} : {}),
        ...(typeof candidate.toolCallId === 'string' ? {toolCallId: candidate.toolCallId} : {}),
        content: '[TOOL_RESULT_REDACTED_FROM_DURABLE_STATE]',
      };
    }
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(candidate)) {
      const sanitized = sanitizeOpaqueJsonValue(childValue, childKey);
      if (sanitized !== undefined) out[childKey] = sanitized;
    }
    return out;
  }
  return undefined;
}

function createPiOpaqueStateFromMessages(messages: unknown[] | undefined): PiAgentCoreOpaqueState {
  const allMessages = Array.isArray(messages) ? messages : [];
  const visibleMessages = allMessages.slice(-MAX_PI_OPAQUE_MESSAGES);
  const truncated = allMessages.length > visibleMessages.length;
  try {
    const sanitized = sanitizeOpaqueJsonValue(visibleMessages);
    const json = JSON.stringify(sanitized);
    if (!json) {
      return { version: 1, messageCount: 0, degradedReason: 'not_json_serializable' };
    }
    const byteSize = Buffer.byteLength(json, 'utf8');
    if (byteSize > MAX_PI_OPAQUE_BYTES) {
      return {
        version: 1,
        messageCount: visibleMessages.length,
        originalMessageCount: allMessages.length,
        truncated: truncated || undefined,
        byteSize,
        degradedReason: 'too_large',
      };
    }
    return {
      version: 1,
      messages: JSON.parse(json) as unknown[],
      messageCount: visibleMessages.length,
      originalMessageCount: truncated ? allMessages.length : undefined,
      truncated: truncated || undefined,
      byteSize,
    };
  } catch {
    return {
      version: 1,
      messageCount: visibleMessages.length,
      originalMessageCount: allMessages.length,
      truncated: truncated || undefined,
      degradedReason: 'not_json_serializable',
    };
  }
}

const importEsmModule = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<unknown>;

export type PiAgentCoreModuleLoader = (
  env: EnvLike,
) => Promise<PiAgentCoreModule>;

export type PiAgentCoreEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages?: unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message?: unknown; toolResults?: unknown[] }
  | {
      type: 'message_update';
      assistantMessageEvent?: {
        type?: string;
        text?: string;
        delta?: string;
        partial?: unknown;
      };
      message?: unknown;
    }
  | { type: 'message_start'; message?: unknown }
  | { type: 'message_end'; message?: unknown }
  | { type: 'tool_execution_start'; toolName?: string; toolCallId?: string; args?: unknown }
  | { type: 'tool_execution_update'; toolName?: string; toolCallId?: string; args?: unknown; update?: unknown; partialResult?: unknown }
  | { type: 'tool_execution_end'; toolName?: string; toolCallId?: string; result?: unknown; isError?: boolean }
  | { type: string; [key: string]: unknown };

export interface PiAgentCoreTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  executionMode: PiAgentCoreNativeToolExecutionMode;
  concurrency?: RuntimeToolConcurrencyPolicy;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details?: unknown;
    isError?: boolean;
    terminate?: boolean;
  }>;
}

export interface PiAgentCoreRuntimeOptions {
  env?: EnvLike;
  moduleLoader?: PiAgentCoreModuleLoader;
  providerRuntimeLoader?: PiAgentCoreProviderRuntimeLoader;
}

interface PiAnalysisPreparation {
  systemPrompt: string;
  prompt: string;
  tools: PiAgentCoreTool[];
  allowedToolNames: Set<string>;
  quickMode: boolean;
  turnIntent: AnalysisTurnIntent;
  policy: RuntimeTurnPolicy;
  sceneType: SceneType;
  packageName?: string;
  architecture?: ArchitectureInfo;
  sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
  previousTurns: ConversationTurn[];
  analysisPlan: { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] };
  notes: AnalysisNote[];
  hypotheses: Hypothesis[];
  uncertaintyFlags: UncertaintyFlag[];
  analysisRunSpec: AnalysisRunSpec;
  comparisonIdentity?: FinalResultComparisonIdentity;
  quickMemoryContextCounts?: ReturnType<typeof buildQuickMemoryContextPayload>['counts'];
  sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'];
  artifactStore: ArtifactStore;
}

/** Bind completion before projection, then carry only the returned candidate context. */
function projectPiAnalysisResult(
  result: AnalysisResult,
  sourceUse: PiAnalysisPreparation['sourceUse'] | undefined,
  context: AnalysisDeliveryContext,
) {
  if (!result.conclusion.trim()) {
    result.success = false;
    result.partial = true;
    result.terminationReason ??= 'quality_gate_failed';
  }
  return finalizeOwnerSourceAwareAnalysisResultWithProjection(result, sourceUse, {
    context,
  });
}

function createPiEvidenceReadView(
  store: ArtifactStore | undefined,
  runId: string,
  sessionId: string,
  traceId: string,
  options: AnalysisOptions,
) {
  if (!store) return undefined;
  const scope = options.runManifestAttributionSink?.identity.scope;
  return store.createEvidenceReadView({
    currentRunId: runId,
    ownerKey: piRuntimeFingerprint({runId, sessionId,
      tenantId: options.tenantId ?? scope?.tenantId,
      workspaceId: options.workspaceId ?? scope?.workspaceId,
      userId: options.userId}),
    allowedTraces: [
      ...(traceId ? [{traceId, traceSide: 'current' as const}] : []),
      ...(options.referenceTraceId ? [{traceId: options.referenceTraceId, traceSide: 'reference' as const}] : []),
    ],
  });
}

function truthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function positiveIntegerEnv(env: EnvLike, keys: readonly string[], fallback: number): number {
  for (const key of keys) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return fallback;
}

function resolvePiRuntimeTimeouts(env: EnvLike): {
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  abortJoinTimeoutMs: number;
} {
  return {
    requestTimeoutMs: positiveIntegerEnv(
      env,
      [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV, AGENT_FULL_REQUEST_TIMEOUT_MS_ENV],
      DEFAULT_FULL_REQUEST_TIMEOUT_MS,
    ),
    streamIdleTimeoutMs: positiveIntegerEnv(
      env,
      [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV, AGENT_STREAM_IDLE_TIMEOUT_MS_ENV],
      DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
    ),
    abortJoinTimeoutMs: positiveIntegerEnv(
      env,
      [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV],
      PI_AGENT_CORE_DEFAULT_ABORT_JOIN_TIMEOUT_MS,
    ),
  };
}

function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = stableFingerprintValue(record[key]);
  }
  return out;
}

function piRuntimeFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableFingerprintValue(value)))
    .digest('hex');
}

function moduleCacheKey(env: EnvLike): string {
  return piRuntimeFingerprint({
    modulePath: env[PI_AGENT_CORE_MODULE_PATH_ENV]?.trim() || 'default',
  });
}

function providerCacheKey(config: PiAgentCoreModelConfig, env: EnvLike): string {
  return piRuntimeFingerprint({
    config,
    resolvedApiKeyEnv: config.apiKeyEnv
      ? {[config.apiKeyEnv]: env[config.apiKeyEnv]}
      : undefined,
  });
}

function buildPiTimeoutResult(input: {
  sessionId: string;
  startedAt: number;
  timeoutKind: RuntimeTimeoutKind;
  timeoutMs: number;
  reason?: unknown;
}): AnalysisResult {
  const message = input.timeoutKind === 'stream_idle'
    ? `Pi Agent Core provider stream idle timeout after ${input.timeoutMs}ms.`
    : `Pi Agent Core request timeout after ${input.timeoutMs}ms.`;
  const detail = input.reason instanceof Error
    ? input.reason.message
    : typeof input.reason === 'string' ? input.reason : undefined;
  const terminationMessage = detail && detail !== message ? `${message} ${detail}` : message;
  return {
    sessionId: input.sessionId,
    success: false,
    findings: [],
    hypotheses: [],
    conclusion: terminationMessage,
    confidence: 0,
    rounds: 1,
    totalDurationMs: Date.now() - input.startedAt,
    partial: true,
    terminationReason: 'timeout',
    terminationMessage,
  };
}

function createPiProviderIdleSupervisor(input: {
  sessionId: string;
  timeoutMs: number;
  markTimeout: (kind: RuntimeTimeoutKind, timeoutMs: number) => void;
  abort: () => void;
}): {
  readonly promise: Promise<never>;
  start(): void;
  pause(): void;
  clear(): void;
  onEvent(event: PiAgentCoreEvent): void;
} {
  let activeTools = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  let settled = false;
  const promise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (settled) return;
    clearTimer();
    if (activeTools > 0) return;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timer = undefined;
      input.markTimeout('stream_idle', input.timeoutMs);
      input.abort();
      rejectTimeout?.(new Error(
        `Pi Agent Core provider stream idle timeout after ${input.timeoutMs}ms`,
      ));
    }, input.timeoutMs);
  };
  return {
    promise,
    start: schedule,
    pause: () => {
      clearTimer();
    },
    clear: () => {
      settled = true;
      clearTimer();
    },
    onEvent: (event) => {
      if (settled) return;
      if (event.type === 'tool_execution_start') {
        activeTools += 1;
        clearTimer();
        return;
      }
      if (event.type === 'tool_execution_end') {
        activeTools = Math.max(0, activeTools - 1);
        schedule();
        return;
      }
      if (isPiAgentCoreProviderActivityEvent(event)) schedule();
    },
  };
}

export function getPiAgentCoreEngineCapabilities(
  kind: PiAgentCoreRuntimeKind = EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
): EngineCapabilities {
  const publicRuntime = kind === PI_AGENT_CORE_RUNTIME_KIND;
  return {
    kind,
    displayName: publicRuntime ? 'Pi Agent Core' : 'Experimental Pi Agent Core',
    production: publicRuntime,
    publicRuntime,
    promptCache: { systemPromptDynamicBoundary: false },
  };
}

export function getPiAgentCoreRuntimeDiagnostics(
  env: EnvLike = process.env,
  runtime: PiAgentCoreRuntimeKind = PI_AGENT_CORE_RUNTIME_KIND,
) {
  const modelJson = env[PI_AGENT_CORE_MODEL_JSON_ENV]?.trim();
  const fakeStream = truthyEnv(env[PI_AGENT_CORE_FAKE_STREAM_ENV]);
  const modulePath = env[PI_AGENT_CORE_MODULE_PATH_ENV]?.trim();
  return {
    configured: Boolean(modelJson || fakeStream),
    runtime,
    experimental: runtime === EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
    package: '@earendil-works/pi-agent-core',
    modelConfigured: Boolean(modelJson),
    fakeStream,
    modulePath: modulePath || undefined,
  };
}

export async function loadPiAgentCoreModule(
  env: EnvLike = process.env,
): Promise<PiAgentCoreModule> {
  const explicitModulePath = env[PI_AGENT_CORE_MODULE_PATH_ENV]?.trim();
  if (explicitModulePath) {
    return importEsmModule(pathToFileURL(explicitModulePath).href) as Promise<PiAgentCoreModule>;
  }

  const packageName = '@earendil-works/pi-agent-core';
  return importEsmModule(packageName) as Promise<PiAgentCoreModule>;
}

function extractAssistantText(message: unknown): string {
  const content = (message as { content?: unknown[] } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const block = part as { type?: string; text?: string; thinking?: string };
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    return '';
  }).filter(Boolean).join('\n');
}

/** Transport whitespace normalization only; prose never selects or deletes an answer. */
export function sanitizePiAgentCoreConclusionText(text: string): string {
  return text.trim();
}

/** The latest assistant in the caller's current-attempt slice owns the answer. */
export function selectAssistantConclusion(messages: unknown[] | undefined): string {
  return extractAssistantText(latestAssistantMessage(messages)).trim();
}

export function buildPiAnalysisCompletion(input: {
  assistant?: Record<string, unknown>;
  candidate: AnalysisCandidateIdentity;
  runtimeKind: PiAgentCoreRuntimeKind;
  turnLimitReached?: boolean;
}): AnalysisCompletion {
  const stop = typeof input.assistant?.stopReason === 'string' ? input.assistant.stopReason : undefined;
  const failed = stop === 'error' || Boolean(input.assistant?.errorMessage);
  const toolCall = Array.isArray(input.assistant?.content) && input.assistant.content.some(
    (part: unknown) => (part as {type?: unknown} | undefined)?.type === 'toolCall',
  );
  return {
    ...input.candidate,
    schemaVersion: 1,
    runtimeKind: canonicalRuntimeKind(input.runtimeKind),
    status: input.turnLimitReached ? 'incomplete'
      : stop === 'aborted' ? 'cancelled' : failed ? 'failed'
      : stop === 'length' ? 'incomplete'
      : stop === 'stop' && !toolCall && input.assistant?.deferred === undefined ? 'completed' : 'unknown',
    ...(input.turnLimitReached ? {reason: 'turn_limit' as const}
      : stop === 'aborted' ? {reason: 'cancelled' as const}
      : failed ? {reason: 'provider_error' as const}
      : stop === 'length' ? {reason: 'output_limit' as const} : {}),
    ...(stop ? {sdkFinishReason: stop} : {}),
  };
}

function latestAssistantMessage(messages: unknown[] | undefined): Record<string, unknown> | undefined {
  const reversed = [...(messages ?? [])].reverse();
  return reversed.find(message => (message as { role?: string }).role === 'assistant') as
    | Record<string, unknown>
    | undefined;
}

export function getPiAgentCorePlanCompletionStatus(plan: AnalysisPlanV3 | null | undefined): {
  complete: boolean;
  hasPlan: boolean;
  pendingPhases: PlanPhase[];
  evidenceGaps?: AnalysisPlanCompletionStatus['evidenceGaps'];
} {
  return getAnalysisPlanCompletionStatus(plan, {
    minSummaryChars: MIN_PHASE_SUMMARY_CHARS,
  });
}

function loadPiFinalReportCorrectionSystemPrompt(outputLanguage: OutputLanguage): string {
  const templateName = outputLanguage === 'en'
    ? 'prompt-final-report-correction-system-en'
    : 'prompt-final-report-correction-system-zh';
  const template = loadPromptTemplate(templateName);
  if (!template) {
    throw new Error(`Missing Pi final-report correction system prompt template: ${templateName}`);
  }
  return template;
}

function summarizePiToolResult(result: unknown): string {
  const content = (result as { content?: Array<{ text?: unknown }> } | undefined)?.content;
  const text = Array.isArray(content)
    ? content.map(block => typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n')
    : typeof result === 'string'
      ? result
      : JSON.stringify(result);
  if (!text) return '';
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function extractPiAssistantErrorMessage(message: unknown): string | undefined {
  const assistant = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
  if (!assistant || assistant.role !== 'assistant') return undefined;
  const errorMessage = typeof assistant.errorMessage === 'string' && assistant.errorMessage.trim()
    ? assistant.errorMessage.trim()
    : undefined;
  const stopReason = typeof assistant.stopReason === 'string' ? assistant.stopReason : undefined;
  if (stopReason !== 'error' && stopReason !== 'aborted' && !errorMessage) return undefined;
  return errorMessage || `Pi Agent Core assistant stopped with ${stopReason || 'an execution error'}.`;
}

function hasPiAssistantMessageText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPiAssistantMessageText);
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string' && record.text.trim().length > 0) {
    return true;
  }
  if (record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim().length > 0) {
    return true;
  }
  return hasPiAssistantMessageText(record.content);
}

function hasNonBlankPiEventText(event: Record<string, unknown>): boolean {
  return (typeof event.delta === 'string' && event.delta.trim().length > 0) ||
    (typeof event.text === 'string' && event.text.trim().length > 0) ||
    (typeof event.thinking === 'string' && event.thinking.trim().length > 0);
}

const PI_ASSISTANT_ACTIVITY_EVENT_TYPES = new Set([
  'start',
  'text_start',
  'text_delta',
  'text_end',
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  'error',
]);

const PI_ASSISTANT_DELTA_ACTIVITY_EVENT_TYPES = new Set([
  'text_delta',
  'thinking_delta',
  'toolcall_delta',
]);

const PI_ASSISTANT_VISIBLE_OUTPUT_EVENT_TYPES = new Set([
  'text_delta',
  'thinking_delta',
]);

export function isPiAgentCoreProviderActivityEvent(event: PiAgentCoreEvent): boolean {
  if (event.type !== 'message_update') return false;
  const assistantEvent = event.assistantMessageEvent;
  if (!assistantEvent || typeof assistantEvent !== 'object') return false;
  const assistantRecord = assistantEvent as Record<string, unknown>;
  const eventType = typeof assistantRecord.type === 'string' ? assistantRecord.type : undefined;
  if (!eventType) {
    return typeof assistantRecord.text === 'string' && assistantRecord.text.trim().length > 0;
  }
  if (!PI_ASSISTANT_ACTIVITY_EVENT_TYPES.has(eventType)) return false;
  return PI_ASSISTANT_DELTA_ACTIVITY_EVENT_TYPES.has(eventType)
    ? hasNonBlankPiEventText(assistantRecord)
    : true;
}

export function isPiAgentCoreVisibleOutputEvent(event: PiAgentCoreEvent): boolean {
  if (event.type === 'message_update') {
    const assistantEvent = event.assistantMessageEvent;
    if (!assistantEvent || typeof assistantEvent !== 'object') return false;
    const assistantRecord = assistantEvent as Record<string, unknown>;
    const eventType = typeof assistantRecord.type === 'string' ? assistantRecord.type : undefined;
    if (!eventType) {
      return typeof assistantRecord.text === 'string' && assistantRecord.text.trim().length > 0;
    }
    return PI_ASSISTANT_VISIBLE_OUTPUT_EVENT_TYPES.has(eventType) &&
      hasNonBlankPiEventText(assistantRecord);
  }
  if (event.type === 'agent_end' && Array.isArray(event.messages)) {
    return event.messages.some(message => (
      (message as {role?: unknown} | undefined)?.role === 'assistant' &&
      hasPiAssistantMessageText(message)
    ));
  }
  return false;
}

export function isPiAgentCoreProviderOutputEvent(event: PiAgentCoreEvent): boolean {
  return isPiAgentCoreVisibleOutputEvent(event);
}

export function projectPiAgentCoreEventToStreamingUpdate(
  event: PiAgentCoreEvent,
  timestamp = Date.now(),
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): StreamingUpdate | undefined {
  switch (event.type) {
    case 'agent_start':
      return { type: 'progress', content: 'Pi agent-core run started', timestamp };
    case 'turn_start':
      return { type: 'progress', content: 'Pi agent-core turn started', timestamp };
    case 'message_update':
      // Pi agent-core providers can stream cumulative assistant partials,
      // tool-call JSON, SQL args, and reasoning deltas through message_update.
      // SmartPerfetto keeps the final report route-owned, so Pi text deltas are
      // read from agent state after completion instead of emitted live.
      return undefined;
    case 'message_end':
    case 'turn_end': {
      const errorMessage = extractPiAssistantErrorMessage(event.message);
      return errorMessage
        ? {
            type: 'error',
            content: {
              module: 'pi-agent-core',
              message: errorMessage,
            },
            timestamp,
          }
        : undefined;
    }
    case 'tool_execution_start': {
      const startToolName = typeof event.toolName === 'string' ? event.toolName : 'unknown';
      return {
        type: 'agent_task_dispatched',
        content: {
          taskId: event.toolCallId || 'unknown',
          toolName: startToolName,
          args: event.args,
          // Same shared narrator the Claude and OpenAI paths use, so the
          // timeline reads identically across runtimes.
          message: formatToolCallNarration(startToolName, event.args, outputLanguage),
        },
        timestamp,
      };
    }
    case 'tool_execution_update': {
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'unknown';
      const rawUpdate = event.partialResult ?? event.update;
      const update = isSensitiveRagToolName(toolName)
        ? projectToolResultForExternalSurface(toolName, rawUpdate)
        : rawUpdate;
      return {
        type: 'progress',
        content: {
          module: 'pi-agent-core',
          tool: event.toolName,
          toolCallId: event.toolCallId,
          update,
        },
        timestamp,
      };
    }
    case 'tool_execution_end': {
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'unknown';
      // Failure comes from the raw result: projection can replace a sensitive
      // tool's payload with a rejection envelope that carries no success field.
      const resultIsFailure = toolResultIsFailure({
        toolName,
        result: event.result,
        isError: event.isError === true,
      });
      const projected = projectToolResultForExternalSurface(toolName, event.result);
      const privateToolResultReceipt = issuePrivateToolResultNarrationReceipt({
        toolName, result: projected, isError: resultIsFailure,
      });
      const result = summarizePiToolResult(projected);
      // Narrate the projected object; `result` is byte-truncated for transport.
      const resultNarration = formatToolResultNarration({
        toolName,
        result: projected,
        isError: resultIsFailure,
        language: outputLanguage,
      });
      return event.isError
        ? {
            type: 'agent_response',
            content: {
              taskId: event.toolCallId || 'unknown',
              toolName,
              toolCallId: event.toolCallId,
              result,
              resultNarration,
              ...(privateToolResultReceipt ? {privateToolResultReceipt} : {}),
              isError: true,
              recoverable: true,
            },
            timestamp,
          }
        : {
            type: 'agent_response',
            content: {
              taskId: event.toolCallId || 'unknown',
              toolName,
              result,
              resultNarration,
              ...(privateToolResultReceipt ? {privateToolResultReceipt} : {}),
              isError: resultIsFailure,
            },
            timestamp,
          };
    }
    case 'agent_end':
      return { type: 'progress', content: 'Pi agent-core run ended', timestamp };
    default:
      return undefined;
  }
}

function stringifyPiToolResult(result: RuntimeToolResult): Array<{ type: 'text'; text: string }> {
  return [{type: 'text', text: stringifyRuntimeToolResult(result)}];
}

export type PiAgentCoreNativeToolExecutionMode = 'sequential' | 'parallel';

export function resolvePiAgentCoreNativeToolExecutionMode(input: {
  quickMode: boolean;
  tools: readonly {concurrency?: RuntimeToolConcurrencyPolicy}[];
  env?: Record<string, string | undefined>;
}): PiAgentCoreNativeToolExecutionMode {
  if (
    !isRuntimeCandidateAdmitted('task7', input.env)
    || input.tools.length === 0
  ) return 'sequential';
  return 'parallel';
}

function createPiAbortPromise(signal: AbortSignal): {promise: Promise<never>; clear(): void} {
  if (signal.aborted) {
    return {
      promise: Promise.reject(signal.reason instanceof Error
        ? signal.reason
        : new Error(signal.reason ? String(signal.reason) : 'Pi Agent Core execution aborted')),
      clear: () => undefined,
    };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new Error(signal.reason ? String(signal.reason) : 'Pi Agent Core execution aborted'));
    signal.addEventListener('abort', onAbort, {once: true});
  });
  return {
    promise,
    clear: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function joinPiPromptCleanup(
  promptPromise: Promise<unknown>,
  abortJoinTimeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = promptPromise.then(() => true, () => true);
  const bounded = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), abortJoinTimeoutMs);
  });
  try {
    return await Promise.race([cleanup, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPiProviderPromptWithSupervision(input: {
  agent: PiAgentCoreAgent;
  prompt: string;
  providerIdle: ReturnType<typeof createPiProviderIdleSupervisor>;
  executionLease: RuntimeExecutionLease;
  abortJoinTimeoutMs: number;
}): Promise<void> {
  input.providerIdle.start();
  const promptPromise = input.agent.prompt(input.prompt);
  const abort = createPiAbortPromise(input.executionLease.signal);
  void abort.promise.catch(() => undefined);
  try {
    await Promise.race([promptPromise, input.providerIdle.promise, abort.promise]);
    input.providerIdle.pause();
  } catch (error) {
    input.agent.abort();
    input.providerIdle.pause();
    if (input.executionLease.signal.aborted) {
      await promptPromise.catch(() => undefined);
    }
    throw error;
  } finally {
    abort.clear();
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function repairPiAgentCoreSubmitPlanArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.phases)) return args;

  const rootGoal = typeof args.goal === 'string' ? args.goal.trim() : undefined;
  const rootExpectedTools = normalizeStringArray(args.expectedTools);
  const phases = args.phases.map((phase, index) => {
    const source = phase && typeof phase === 'object' && !Array.isArray(phase)
      ? phase as Record<string, unknown>
      : {};
    const id = typeof source.id === 'string' && source.id.trim()
      ? source.id.trim()
      : `p${index + 1}`;
    const goal = typeof source.goal === 'string' && source.goal.trim()
      ? source.goal.trim()
      : rootGoal;
    const name = typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : id;

    return {
      ...source,
      id,
      name,
      goal: goal || name,
      expectedTools: normalizeStringArray(source.expectedTools) ?? rootExpectedTools ?? [],
      ...(source.expectedCalls !== undefined || args.expectedCalls !== undefined
        ? { expectedCalls: source.expectedCalls ?? args.expectedCalls }
        : {}),
    };
  });
  const repaired: Record<string, unknown> = {
    phases,
    successCriteria: typeof args.successCriteria === 'string' && args.successCriteria.trim()
      ? args.successCriteria.trim()
      : rootGoal || 'analysis_complete',
  };
  if (args.waivers !== undefined) {
    repaired.waivers = args.waivers;
  }

  return repaired;
}

export function createPiAgentCoreToolFromSharedSpec(
  spec: SharedToolSpec,
  options: {
    allowedToolNames: ReadonlySet<string>;
    runtimeKind?: PiAgentCoreRuntimeKind;
    analysisPlan?: { current: AnalysisPlanV3 | null };
    onPhaseAutoCompleted?: (phase: AnalysisPlanV3['phases'][number]) => void;
    extra?: unknown;
  },
): PiAgentCoreTool {
  if (!options.allowedToolNames.has(spec.name)) {
    throw new Error(`Pi agent-core tool is not allowed in this request: ${spec.name}`);
  }

  return {
    name: spec.name,
    label: spec.summary || spec.name,
    description: spec.description,
    parameters: createJsonSchemaFromZodRawShape(spec.inputSchema),
    executionMode: spec.concurrency?.mode === 'commutative_read' ? 'parallel' : 'sequential',
    ...(spec.concurrency ? {concurrency: spec.concurrency} : {}),
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (signal?.aborted) {
        return {
          content: [{ type: 'text', text: 'Tool execution aborted before start.' }],
          isError: true,
        };
      }
      onUpdate?.({ type: 'smartperfetto_tool_started', toolCallId, toolName: spec.name });
      const normalizedArgs = normalizeRuntimeToolArgs(params, spec.inputSchema) as Record<string, unknown>;
      const toolArgs = spec.name === 'submit_plan'
        ? repairPiAgentCoreSubmitPlanArgs(normalizedArgs)
        : normalizedArgs;
      const result = await spec.handler(toolArgs, {
        runtime: options.runtimeKind ?? PI_AGENT_CORE_RUNTIME_KIND,
        toolCallId,
        signal,
        ...(options.extra && typeof options.extra === 'object' ? options.extra : {}),
      });
      if (signal?.aborted) {
        return {
          content: [{ type: 'text', text: 'Tool execution aborted after handler completion.' }],
          isError: true,
        };
      }
      const codeReferences = extractSourceLookupCodeReferences(spec.name, result);
      recordPlanOrPrePlanToolCall(options.analysisPlan, {
        toolName: spec.name,
        toolCallId,
        onPhaseAutoCompleted: options.onPhaseAutoCompleted,
        input: toolArgs,
        returnedCodeReferences: codeReferences.length > 0,
        returnedCodeReferenceHints: codeReferences,
        // Read before truncation: planPhaseId and success sit after the body.
        resultFacts: readToolResultFacts(result),
        resultText: summarizePiToolResult(
          projectToolResultForExternalSurface(spec.name, result),
        ),
      });
      onUpdate?.({ type: 'smartperfetto_tool_finished', toolCallId, toolName: spec.name });
      return {
        content: stringifyPiToolResult(result),
        details: result,
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}

function createFakePiStream(finalText: string) {
  return async (model: Record<string, unknown>) => {
    const timestamp = Date.now();
    const finalMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: finalText }],
      api: String(model.api ?? 'smartperfetto-fake'),
      provider: String(model.provider ?? 'smartperfetto'),
      model: String(model.id ?? model.name ?? 'experimental-pi-agent-core-fake'),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp,
    };
    const events = [
      { type: 'start', partial: { ...finalMessage, content: [] } },
      { type: 'text_start', contentIndex: 0, partial: { ...finalMessage, content: [] } },
      { type: 'text_delta', contentIndex: 0, partial: finalMessage, delta: finalText },
      { type: 'text_end', contentIndex: 0, partial: finalMessage, content: finalText },
      { type: 'done', reason: 'stop', message: finalMessage },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          await new Promise(resolve => setTimeout(resolve, 50));
          yield event;
        }
      },
      result: async () => finalMessage,
    };
  };
}

function resolvePiAgentCoreModel(env: EnvLike, fakeStream: boolean): PiAgentCoreModelConfig {
  const rawModel = env[PI_AGENT_CORE_MODEL_JSON_ENV];
  if (rawModel) {
    try {
      return parsePiAgentCoreModelConfig(rawModel);
    } catch (err) {
      throw new Error(`${PI_AGENT_CORE_MODEL_JSON_ENV} must be valid JSON: ${(err as Error).message}`);
    }
  }
  if (fakeStream) {
    return {
      model: {
        id: 'experimental-pi-agent-core-fake',
        name: 'experimental-pi-agent-core-fake',
        api: 'smartperfetto-fake',
        provider: 'smartperfetto',
        baseUrl: '',
        reasoning: false,
        input: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
    };
  }
  throw new Error(
    `${PI_AGENT_CORE_MODEL_JSON_ENV} is required for the experimental Pi agent-core runtime ` +
    `unless ${PI_AGENT_CORE_FAKE_STREAM_ENV}=1 is used for a local smoke.`,
  );
}

export class PiAgentCoreRuntime extends EventEmitter implements IOrchestrator {
  private readonly env: EnvLike;
  private readonly moduleLoader: PiAgentCoreModuleLoader;
  private readonly providerRuntimeLoader: PiAgentCoreProviderRuntimeLoader;
  private readonly moduleRuntimeCache = new Map<string, ReturnType<PiAgentCoreModuleLoader>>();
  private readonly providerRuntimeCache = new Map<string, ReturnType<PiAgentCoreProviderRuntimeLoader>>();
  private readonly activeAgents = new Map<string, PiAgentCoreAgent>();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private readonly sessionNotes = new Map<string, AnalysisNote[]>();
  private readonly sessionPlans = new Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }>();
  private readonly sessionHypotheses = new Map<string, Hypothesis[]>();
  private readonly sessionUncertaintyFlags = new Map<string, UncertaintyFlag[]>();
  private readonly architectureCache = new Map<string, ArchitectureInfo>();
  private readonly sessionOpaqueStates = new Map<string, PiAgentCoreOpaqueState>();
  private readonly suppressedOpaqueStateSessions = new Set<string>();
  private readonly executionGuard = new RuntimeExecutionGuard();

  constructor(
    private readonly traceProcessorService: TraceProcessorService,
    private readonly selection: RuntimeSelection<PiAgentCoreRuntimeKind>,
    options: PiAgentCoreRuntimeOptions = {},
  ) {
    super();
    this.env = {...(options.env ?? process.env)};
    this.moduleLoader = options.moduleLoader ?? loadPiAgentCoreModule;
    this.providerRuntimeLoader = options.providerRuntimeLoader ?? createPiAgentCoreProviderRuntime;
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    options = {
      ...options,
      analysisMode: options.analysisMode ?? 'auto',
    };
    const executionLease = this.executionGuard.begin({
      runtime: PI_AGENT_CORE_RUNTIME_KIND,
      sessionId,
      referenceTraceId: options.referenceTraceId,
      runId: options.runId ?? options.runManifestAttributionSink?.identity.runId ?? randomUUID(),
    });
    this.suppressedOpaqueStateSessions.delete(sessionId);
    const startedAt = Date.now();
    const runtimePerformance = createRuntimePerformanceRun(
      options.runManifestAttributionSink,
    );
    const timeouts = resolvePiRuntimeTimeouts(this.env);
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';
    let result: AnalysisResult | undefined;
    let analysis: Promise<AnalysisResult> | undefined;
    let sourceUse: PiAnalysisPreparation['sourceUse'] | undefined;
    let turnIntent: AnalysisTurnIntent | undefined;
    let strategyRegistry: ReadonlyStrategyRegistrySnapshot | undefined;
    let currentArtifactStore: ArtifactStore | undefined;
    let analysisRunSelection: AnalysisRunSpec['selection'] | undefined;
    let requestTimeoutMs = timeouts.requestTimeoutMs;
    let deferLeaseSettleToAnalysisCleanup = false;
    let leaseSettled = false;
    let timedOut: {kind: RuntimeTimeoutKind; timeoutMs: number} | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    const settleLease = () => {
      if (leaseSettled) return;
      leaseSettled = true;
      executionLease.settle();
    };
    const markTimeout = (kind: RuntimeTimeoutKind, timeoutMs: number) => {
      timedOut ??= {kind, timeoutMs};
    };
    let rejectRequestTimeout: (reason: Error) => void = () => undefined;
    const requestTimeout = new Promise<never>((_, reject) => { rejectRequestTimeout = reject; });
    const armRequestTimeout = (limitMs: number) => {
      if (requestTimer) clearTimeout(requestTimer);
      requestTimeoutMs = Math.min(timeouts.requestTimeoutMs, limitMs);
      requestTimer = setTimeout(() => {
        markTimeout('request', requestTimeoutMs);
        this.suppressedOpaqueStateSessions.add(sessionId);
        const reason = new Error(`Pi Agent Core request timeout after ${requestTimeoutMs}ms`);
        void this.executionGuard.abortSession(sessionId, reason).catch(() => undefined);
        this.activeAgents.get(sessionId)?.abort();
        rejectRequestTimeout(reason);
      }, Math.max(0, startedAt + requestTimeoutMs - Date.now()));
    };
    armRequestTimeout(requestTimeoutMs);
    void requestTimeout.catch(() => undefined);
    const executionAbort = createPiAbortPromise(executionLease.signal);
    void executionAbort.promise.catch(() => undefined);
    try {
      executionLease.throwIfAborted();
      const fakeStream = truthyEnv(this.env[PI_AGENT_CORE_FAKE_STREAM_ENV]);
      analysis = fakeStream
        ? this.analyzeFakeStream(
          query,
          sessionId,
          traceId,
          options,
          executionLease,
          runtimePerformance,
          timeouts.streamIdleTimeoutMs,
          timeouts.abortJoinTimeoutMs,
          markTimeout,
        )
        : this.analyzeWithSmartPerfettoTools(
          query,
          sessionId,
          traceId,
          options,
          executionLease,
          runtimePerformance,
          timeouts.streamIdleTimeoutMs,
          timeouts.abortJoinTimeoutMs,
          markTimeout,
          preparation => {
            sourceUse = preparation.sourceUse;
            currentArtifactStore = preparation.artifactStore;
            analysisRunSelection = preparation.selection;
          },
          (intent, policy, registry) => {
            turnIntent = intent;
            strategyRegistry = registry;
            if (policy.budgetMode === 'quick') {
              const budget = resolveQuickTurnBudget({env: this.env});
              armRequestTimeout(budget.hardCapTurns * positiveIntegerEnv(this.env, ['AGENT_QUICK_PER_TURN_MS'], 40_000));
            }
          },
          () => startedAt + requestTimeoutMs,
        );
      void analysis.catch(() => undefined);
      result = await Promise.race([analysis, requestTimeout, executionAbort.promise]);
      if (!(executionLease.signal.aborted && result.success === false)) {
        executionLease.throwIfAborted();
      }
      runtimePerformanceOutcome = executionLease.signal.aborted
        ? 'cancelled'
        : result.success === false ? 'error' : 'ok';
      return result;
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(
        error,
        executionLease.signal,
      );
      if (executionLease.signal.aborted) {
        this.suppressedOpaqueStateSessions.add(sessionId);
        if (analysis) {
          const analysisCleanedUp = await joinPiPromptCleanup(analysis, timeouts.abortJoinTimeoutMs);
          deferLeaseSettleToAnalysisCleanup = !analysisCleanedUp;
        }
        const timeout = timedOut ?? {kind: 'request' as const, timeoutMs: timeouts.requestTimeoutMs};
        const interrupted = buildPiTimeoutResult({
          sessionId,
          startedAt,
          timeoutKind: timeout.kind,
          timeoutMs: timeout.timeoutMs,
          reason: error,
        });
        interrupted.turnIntent = turnIntent;
        interrupted.outputOrigin = 'runtime_fallback';
        interrupted.completion = {
          schemaVersion: 1, runtimeKind: canonicalRuntimeKind(this.selection.kind),
          runId: executionLease.key.runId!, attemptId: 'interrupted',
          candidateRef: `${executionLease.key.runId}:pi:interrupted`,
          conclusionFingerprint: analysisDeliveryFingerprint(interrupted.conclusion),
          status: timedOut ? 'incomplete' : 'cancelled',
          reason: timedOut ? 'timeout' : 'cancelled',
        };
        const projected = projectPiAnalysisResult(interrupted, sourceUse, {
          entry: 'runtime_draft', acceptedCandidate: interrupted.completion,
          completion: interrupted.completion, outputOrigin: interrupted.outputOrigin, turnIntent,
        });
        applyFinalResultQualityGate({result: projected.result, query, context: projected.deliveryContext});
        if (turnIntent && strategyRegistry && projected.deliveryContext) {
          attachFinalizationContext(projected.result, {
            runId: executionLease.key.runId!, sessionId, deadlineMs: startedAt + requestTimeoutMs,
            turnIntent, strategyRegistry,
            selection: analysisRunSelection,
            traceIdentity: {currentTraceId: traceId || undefined, referenceTraceId: options.referenceTraceId},
            deliveryContext: projected.deliveryContext, protocolProjection: projected.protocolProjection,
            sourceUse: sourceUse?.getSourceUseDecision(),
            sourceScope: sourceUse?.getSourceExecutionScope?.(),
            evidenceReadView: createPiEvidenceReadView(currentArtifactStore, executionLease.key.runId!, sessionId, traceId, options),
          });
        }
        return projected.result;
      }
      throw error;
    } finally {
      executionAbort.clear();
      if (requestTimer) clearTimeout(requestTimer);
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      try {
        if (deferLeaseSettleToAnalysisCleanup && analysis) {
          void analysis
            .finally(settleLease)
            .catch(() => undefined);
        } else {
          settleLease();
        }
      } finally {
        finalizationPhase.end(runtimePerformanceOutcome);
        runtimePerformance.finalize(runtimePerformanceOutcome);
      }
    }
  }

  private getInitialMessagesForSession(sessionId: string): unknown[] {
    const opaque = this.sessionOpaqueStates.get(sessionId);
    if (!opaque) return [];
    if (opaque.degradedReason) {
      this.emit('update', {
        type: 'degraded',
        content: {
          module: 'pi-agent-core',
          fallback: 'smartperfetto_context',
          reason: opaque.degradedReason,
          message: 'Pi Agent Core third-party transcript state was unavailable; continuing with SmartPerfetto session context only.',
        },
        timestamp: Date.now(),
      });
      return [];
    }
    // Logical history is supplied by the scoped SmartPerfetto context. Native
    // transcripts may contain stale selections and unbounded tool payloads.
    return [];
  }

  private rememberOpaqueState(sessionId: string, agent: PiAgentCoreAgent): void {
    this.sessionOpaqueStates.set(sessionId, createPiOpaqueStateFromMessages(agent.state.messages));
  }

  private getProviderRuntime(modelConfig: PiAgentCoreModelConfig) {
    const key = providerCacheKey(modelConfig, this.env);
    const cached = this.providerRuntimeCache.get(key);
    if (cached) return cached;
    const loading = this.providerRuntimeLoader(modelConfig, this.env)
      .catch((error) => {
        if (this.providerRuntimeCache.get(key) === loading) {
          this.providerRuntimeCache.delete(key);
        }
        throw error;
      });
    this.providerRuntimeCache.set(key, loading);
    return loading;
  }

  private getPiAgentCoreModule() {
    const key = moduleCacheKey(this.env);
    const cached = this.moduleRuntimeCache.get(key);
    if (cached) return cached;
    const loading = this.moduleLoader(this.env)
      .catch((error) => {
        if (this.moduleRuntimeCache.get(key) === loading) {
          this.moduleRuntimeCache.delete(key);
        }
        throw error;
      });
    this.moduleRuntimeCache.set(key, loading);
    return loading;
  }

  private async analyzeFakeStream(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    executionLease: RuntimeExecutionLease,
    runtimePerformance: RuntimePerformanceRun,
    streamIdleTimeoutMs: number,
    abortJoinTimeoutMs: number,
    markTimeout: (kind: RuntimeTimeoutKind, timeoutMs: number) => void,
  ): Promise<AnalysisResult> {
    executionLease.throwIfAborted();
    const startedAt = Date.now();
    const modelConfig = resolvePiAgentCoreModel(this.env, true);
    const { Agent } = await this.getPiAgentCoreModule();
    executionLease.throwIfAborted();
    const systemPrompt = this.env[PI_AGENT_CORE_SYSTEM_PROMPT_ENV] ?? '';
    const streamFn = createFakePiStream(
      this.selection.kind === PI_AGENT_CORE_RUNTIME_KIND
        ? `Pi agent-core smoke completed for query "${query}" on trace ${traceId}.`
        : `Experimental Pi agent-core smoke completed for query "${query}" on trace ${traceId}.`,
    );
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    if (privateAnalysisContext) this.sessionOpaqueStates.delete(sessionId);

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: modelConfig.model,
        tools: [],
        messages: privateAnalysisContext
          ? []
          : this.getInitialMessagesForSession(sessionId),
      },
      streamFn,
      toolExecution: 'sequential',
      beforeToolCall: async (context: unknown) => ({
        block: true,
        reason: `Tool calls are blocked until SmartPerfetto explicitly maps shared tools: ${JSON.stringify(context)}`,
      }),
    });
    this.activeAgents.set(sessionId, agent);
    const messageBoundary = agent.state.messages?.length ?? 0;

    const providerIdle = createPiProviderIdleSupervisor({
      sessionId,
      timeoutMs: streamIdleTimeoutMs,
      markTimeout,
      abort: () => {
        this.suppressedOpaqueStateSessions.add(sessionId);
        void this.executionGuard
          .abortSession(sessionId, `Pi Agent Core provider stream idle timeout after ${streamIdleTimeoutMs}ms`)
          .catch(() => undefined);
        this.activeAgents.get(sessionId)?.abort();
      },
    });
    void providerIdle.promise.catch(() => undefined);
    let acceptingProviderEvents = true;
    const unsubscribe = agent.subscribe((event) => {
      if (!acceptingProviderEvents || executionLease.signal.aborted) return;
      providerIdle.onEvent(event);
      if (event.type === 'done') {
        recordEvaluationTokenDeltaIfPresent(event.message);
      }
      const update = projectPiAgentCoreEventToStreamingUpdate(event);
      if (
        isPiAgentCoreVisibleOutputEvent(event)
        || update?.type === 'answer_token'
        || update?.type === 'thought'
      ) {
        runtimePerformance.recordFirstOutput();
      }
      if (update) this.emit('update', update);
    });
    try {
      this.emit('update', {
        type: 'progress',
        content: {
          module: 'pi-agent-core',
          runtime: this.selection.kind,
          message: this.selection.kind === PI_AGENT_CORE_RUNTIME_KIND
            ? 'Pi agent-core runtime selected'
            : 'Hidden experimental Pi agent-core runtime selected',
          source: this.selection.source,
        },
        timestamp: Date.now(),
      });
      commitEvaluationSdkHandoffIfActive();
      executionLease.throwIfAborted();
      runtimePerformance.finishClassification('ok');
      const providerPhase = runtimePerformance.startPhase('provider');
      try {
        await runPiProviderPromptWithSupervision({
          agent,
          prompt: query,
          providerIdle,
          executionLease,
          abortJoinTimeoutMs,
        });
        providerPhase.end('ok');
      } catch (error) {
        providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
      executionLease.throwIfAborted();
    } finally {
      acceptingProviderEvents = false;
      if (privateAnalysisContext || executionLease.signal.aborted) {
        this.sessionOpaqueStates.delete(sessionId);
      } else {
        this.rememberOpaqueState(sessionId, agent);
      }
      providerIdle.clear();
      unsubscribe();
      if (this.activeAgents.get(sessionId) === agent) {
        this.activeAgents.delete(sessionId);
      }
    }

    const assistant = latestAssistantMessage((agent.state.messages ?? []).slice(messageBoundary));
    const conclusion = extractAssistantText(assistant).trim();
    const candidate: AnalysisCandidateIdentity = {
      runId: executionLease.key.runId!, attemptId: 'smoke',
      candidateRef: `${executionLease.key.runId}:pi:smoke`,
      conclusionFingerprint: analysisDeliveryFingerprint(conclusion),
    };
    const completion = buildPiAnalysisCompletion({assistant, candidate, runtimeKind: this.selection.kind});
    const result: AnalysisResult = {
      sessionId,
      success: completion.status !== 'failed' && completion.status !== 'cancelled',
      findings: [],
      hypotheses: [],
      conclusion, completion,
      outputOrigin: completion.status === 'completed' ? 'sdk_final' : 'assistant_stream',
      claimSupport: [],
      claimVerificationResult: PI_AGENT_CORE_PREVIEW_CLAIM_VERIFICATION,
      identityResolutions: [],
      confidence: 0.25,
      rounds: 1,
      totalDurationMs: Date.now() - startedAt,
      partial: true,
      terminationReason: 'plan_incomplete',
      terminationMessage: this.selection.kind === PI_AGENT_CORE_RUNTIME_KIND
        ? 'Pi agent-core runtime completed through the capability-limited public preview path.'
        : 'Hidden experimental Pi agent-core runtime smoke path; SmartPerfetto tool/report parity is not public yet.',
    };
    const projected = projectPiAnalysisResult(result, undefined, {
      entry: 'runtime_draft', acceptedCandidate: candidate, completion, outputOrigin: result.outputOrigin,
    });
    applyFinalResultQualityGate({result: projected.result, query, context: projected.deliveryContext});
    return projected.result;
  }

  private async analyzeWithSmartPerfettoTools(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    executionLease: RuntimeExecutionLease,
    runtimePerformance: RuntimePerformanceRun,
    streamIdleTimeoutMs: number,
    abortJoinTimeoutMs: number,
    markTimeout: (kind: RuntimeTimeoutKind, timeoutMs: number) => void,
    onPreparationReady: (input: {sourceUse: PiAnalysisPreparation['sourceUse']; artifactStore: ArtifactStore;
      selection: AnalysisRunSpec['selection']}) => void,
    onPolicyReady: (intent: AnalysisTurnIntent, policy: RuntimeTurnPolicy, registry: ReadonlyStrategyRegistrySnapshot) => void,
    getRunDeadlineMs: () => number,
  ): Promise<AnalysisResult> {
    executionLease.throwIfAborted();
    const startedAt = Date.now();
    const outputLanguage = options.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    const authorizationScope = resolveKnowledgeScope(options);
    const authorizationFingerprint = options.analysisContextFingerprint ??
      buildAnalysisContextAuthorizationFingerprint(options, authorizationScope);
    const analysisHistoryReader = createRuntimeAnalysisHistoryReader({options, sessionId, traceId,
      getTurns: () => sessionContext.getAnalysisHistory?.() ?? (sessionContext.getAllTurns?.() ?? [])
        .map(turn => toAnalysisHistoryTurn({...turn, traceId, sourceDerived: turn.result?.sourceDerived,
          analysisContextFingerprint: turn.result?.analysisContextFingerprint})),
      assertActive: () => {
        executionLease.throwIfAborted();
        assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
      }});
    const modelConfig = resolvePiAgentCoreModel(this.env, false);
    // Pi accepts one complete configured model, not an ID-only light-model override.
    // The same pinned native provider is reused by classification and the main Agent.
    const providerPromise = this.getProviderRuntime(modelConfig);
    const classifierTimeoutMs = positiveIntegerEnv(this.env, ['AGENT_CLASSIFIER_TIMEOUT_MS'], 30_000);
    const intentResolver = createAnalysisTurnIntentResolver({
      productRun: {options, runId: executionLease.key.runId!, sessionId, traceId},
      context: buildComplexityClassifierInput({
        query, sceneType: 'general', selectionContext: options.selectionContext,
        hasReferenceTrace: Boolean(options.referenceTraceId), previousTurns: [], history: analysisHistoryReader.getTurns(),
        requestedMode: options.analysisMode ?? 'auto',
      }),
      signal: executionLease.signal,
      deadlineMs: Date.now() + classifierTimeoutMs,
      dispatch: input => runIntentTransport(input, async scope => runPiIntentTransport({
        ...input, signal: scope.signal, providerRuntime: await providerPromise, maxOutputTokens: 1024,
      })),
    });
    const turnIntent = await intentResolver.resolve();
    executionLease.throwIfAborted();
    const policy = resolveRuntimeTurnPolicy(turnIntent, options.analysisMode ?? 'auto');
    onPolicyReady(turnIntent, policy, intentResolver.strategyRegistry);
    runtimePerformance.finishClassification(turnIntent.status === 'resolved' ? 'ok' : 'error');
    const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
    let Agent: Awaited<ReturnType<PiAgentCoreModuleLoader>>['Agent'];
    let providerRuntime: Awaited<ReturnType<PiAgentCoreProviderRuntimeLoader>>;
    try {
      Agent = (await this.getPiAgentCoreModule()).Agent;
      providerRuntime = await providerPromise;
      sdkStartPhase.end('ok');
    } catch (error) {
      sdkStartPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
      throw error;
    }
    executionLease.throwIfAborted();
    const closeoutTape = createRuntimeTurnCloseoutTape();
    let toolAdmissionsOpen = true;
    const prep = await this.prepareAnalysis(
      query, sessionId, traceId, options, providerRuntime.model.id,
      executionLease, turnIntent, policy, intentResolver.strategyRegistry, analysisHistoryReader, closeoutTape.observe,
      () => toolAdmissionsOpen && !executionLease.signal.aborted, getRunDeadlineMs(),
    );
    onPreparationReady({sourceUse: prep.sourceUse, artifactStore: prep.artifactStore,
      selection: prep.analysisRunSpec.selection});
    executionLease.throwIfAborted();
    if (privateAnalysisContext) this.sessionOpaqueStates.delete(sessionId);

    const quickBudget = resolveQuickTurnBudget({env: this.env, enforcement: 'turn_cap'});
    const maxTurns = prep.quickMode ? quickBudget.hardCapTurns : resolveAgentRuntimeBudgetConfig(this.env).maxTurns;
    const turnBudget = resolveRuntimeTurnBudget(maxTurns);
    let rounds = 0;
    let turnLimitReached = false;
    let correctionInProgress = false;
    let attempt = 0;
    let acceptedAssistant: Record<string, unknown> | undefined;
    let acceptedAttemptId = 'main';
    let acceptedTurnLimitReached = false;
    let acceptedText = '';
    let closeoutAccepted = false;
    const agent = new Agent({
      initialState: {
        systemPrompt: prep.systemPrompt,
        model: providerRuntime.model,
        tools: prep.tools,
        messages: privateAnalysisContext ? [] : this.getInitialMessagesForSession(sessionId),
        thinkingLevel: modelConfig.thinkingLevel ?? 'off',
      },
      sessionId,
      streamFn: providerRuntime.streamFn,
      toolExecution: resolvePiAgentCoreNativeToolExecutionMode({quickMode: prep.quickMode, tools: prep.tools, env: this.env}),
      transport: modelConfig.transport ?? 'auto',
      maxRetryDelayMs: modelConfig.maxRetryDelayMs,
      thinkingBudgets: modelConfig.thinkingBudgets,
      // Pi calls this after the real assistant/tool turn, before dispatching another.
      shouldStopAfterTurn: ({message}: {message: Record<string, unknown>}) => {
        if (rounds < turnBudget.acquisitionTurns) return false;
        const toolCall = Array.isArray(message.content) && message.content.some(part => part?.type === 'toolCall');
        const finished = message.stopReason === 'stop' && !message.errorMessage
          && message.deferred === undefined && !toolCall;
        turnLimitReached = !finished && message.stopReason !== 'error'
          && message.stopReason !== 'aborted' && message.stopReason !== 'length'
          && !message.errorMessage;
        return true;
      },
      beforeToolCall: async ({toolCall}: {toolCall?: {name?: string}}) => {
        executionLease.throwIfAborted();
        if (turnLimitReached || !toolCall?.name || !prep.allowedToolNames.has(toolCall.name)) {
          return {block: true, reason: 'Tool is not in the SmartPerfetto request-scoped allowlist.'};
        }
        return undefined;
      },
    });
    this.activeAgents.set(sessionId, agent);
    const providerIdle = createPiProviderIdleSupervisor({
      sessionId, timeoutMs: streamIdleTimeoutMs, markTimeout,
      abort: () => {
        this.suppressedOpaqueStateSessions.add(sessionId);
        void this.executionGuard.abortSession(sessionId,
          new Error(`Pi Agent Core provider stream idle timeout after ${streamIdleTimeoutMs}ms`)).catch(() => undefined);
        agent.abort();
      },
    });
    void providerIdle.promise.catch(() => undefined);
    const runProviderPrompt = async (prompt: string, turnLimit = turnBudget.acquisitionTurns) => {
      executionLease.throwIfAborted();
      if (rounds >= turnLimit) { turnLimitReached = true; return undefined; }
      const boundary = agent.state.messages?.length ?? 0;
      const attemptId = `${++attempt}`;
      const beforeRounds = rounds;
      try {
        await runPiProviderPromptWithSupervision({agent, prompt, providerIdle, executionLease, abortJoinTimeoutMs});
      } finally {
        // An attempted provider turn consumes budget even if it fails.
        if (rounds === beforeRounds) rounds++;
      }
      executionLease.throwIfAborted();
      const assistant = latestAssistantMessage((agent.state.messages ?? []).slice(boundary));
      return {assistant, attemptId, text: extractAssistantText(assistant).trim(), turnLimitReached};
    };
    const runId = executionLease.key.runId!;
    const candidateIdentity = (text: string, attemptId: string): AnalysisCandidateIdentity => ({
      runId, attemptId, candidateRef: `${runId}:pi:${attemptId}`,
      conclusionFingerprint: analysisDeliveryFingerprint(text),
    });
    const completionFor = (assistant: Record<string, unknown> | undefined, text: string, attemptId: string, limited = false) => (
      buildPiAnalysisCompletion({assistant, candidate: candidateIdentity(text, attemptId), runtimeKind: this.selection.kind, turnLimitReached: limited})
    );
    let acceptingProviderEvents = true;
    let declarationCompletionInProgress = false;
    const unsubscribe = agent.subscribe(event => {
      if (!acceptingProviderEvents || executionLease.signal.aborted) return;
      providerIdle.onEvent(event);
      if (event.type === 'turn_end') rounds++;
      if (event.type === 'done') recordEvaluationTokenDeltaIfPresent(event.message);
      if (declarationCompletionInProgress && isPiAgentCoreVisibleOutputEvent(event)) return;
      const update = projectPiAgentCoreEventToStreamingUpdate(event, Date.now(), outputLanguage);
      if (correctionInProgress && update?.type === 'error') return;
      if (isPiAgentCoreVisibleOutputEvent(event)) runtimePerformance.recordFirstOutput();
      if (update) this.emit('update', update);
    });
    let verification: Awaited<ReturnType<typeof verifyConclusion>> | undefined;
    const verifyCandidate = async (text: string, assistant: Record<string, unknown> | undefined, attemptId: string, limited = false) => {
      executionLease.throwIfAborted();
      const phase = runtimePerformance.startPhase('verification');
      try {
        const value = await verifyConclusion(extractFindingsFromText(text), text, {
          emitUpdate: update => { if (!executionLease.signal.aborted) this.emit('update', update); },
          enableLLM: false, plan: prep.analysisPlan.current, hypotheses: prep.hypotheses,
          sceneType: turnIntent.sceneId, outputLanguage, query,
          emitIssueProgress: false, allowPersistentLearning: !privateAnalysisContext,
          deliveryContext: {entry: 'runtime_draft', turnIntent,
            acceptedCandidate: candidateIdentity(text, attemptId),
            completion: completionFor(assistant, text, attemptId, limited),
            outputOrigin: closeoutAccepted || completionFor(assistant, text, attemptId, limited).status === 'completed'
              ? 'sdk_final' : 'assistant_stream'},
        });
        const nativeProtocol = inspectCandidateProtocol(text);
        if (assistant) this.emit('update', {type: 'progress', content: {phase: 'candidate_protocol',
          candidateProtocolDiagnostic: buildCandidateProtocolDiagnostic(nativeProtocol, 'native', attemptId === '1' ? 1 : 2)}, timestamp: Date.now()});
        if (completionFor(assistant, text, attemptId, limited).status === 'completed' &&
            (nativeProtocol.status === 'invalid' || !nativeProtocol.canonicalBody.trim())) {
          value.heuristicIssues.push({type: 'missing_check', severity: 'error', recoveryKind: 'continue_output',
            message: nativeProtocol.status === 'invalid'
              ? localize(outputLanguage, '当前候选的结论声明格式无效，需要按本轮协议重新输出。',
                'The candidate has invalid conclusion declarations and needs to follow this turn\'s protocol.')
              : localize(outputLanguage, '当前候选没有可交付的正文，需要补全完整答案。',
                'The candidate has no deliverable body and needs a complete answer.')});
          value.passed = false;
        }
        executionLease.throwIfAborted();
        phase.end('ok');
        return value;
      } catch (error) {
        phase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
    };
    try {
      this.emit('update', {
        type: 'progress', content: {module: 'pi-agent-core', runtime: this.selection.kind,
          mode: prep.quickMode ? 'fast' : 'full', source: this.selection.source}, timestamp: Date.now(),
      });
      commitEvaluationSdkHandoffIfActive();
      const providerPhase = runtimePerformance.startPhase('provider');
      try {
        const candidate = await runProviderPrompt(prep.prompt);
        if (candidate) {
          acceptedAssistant = candidate.assistant;
          acceptedText = candidate.text;
          acceptedAttemptId = candidate.attemptId;
          acceptedTurnLimitReached = candidate.turnLimitReached;
        }
        providerPhase.end('ok');
      } catch (error) {
        providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
      toolAdmissionsOpen = false;
      if (acceptedTurnLimitReached && turnBudget.deliveryTurns > 0
        && rounds < turnBudget.totalTurns && Date.now() < getRunDeadlineMs()) {
        const closeoutPrompt = closeoutTape.buildPrompt({query, priorConclusion: acceptedText, outputLanguage});
        if (closeoutPrompt) {
          try {
            executionLease.throwIfAborted();
            assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
            agent.state.tools = [];
            const closeoutAttemptId = `closeout-${++attempt}`;
            rounds++;
            const closeout = await runPiIntentTransport({
              prompt: closeoutPrompt, systemPrompt: prep.systemPrompt,
              signal: executionLease.signal, deadlineMs: getRunDeadlineMs(),
              outputByteLimit: 64 * 1024, providerRuntime,
            });
            executionLease.throwIfAborted();
            assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
            if (closeout.status === 'ok') {
              acceptedText = closeout.text;
              acceptedAttemptId = closeoutAttemptId;
              acceptedAssistant = {role: 'assistant', stopReason: closeout.finishReason ?? 'stop',
                content: [{type: 'text', text: closeout.text}]};
              closeoutAccepted = true;
            }
          } catch {
            executionLease.throwIfAborted();
            // Preserve the original candidate if optional delivery fails.
          }
        }
      }
      verification = await verifyCandidate(acceptedText, acceptedAssistant, acceptedAttemptId, acceptedTurnLimitReached);
      const issues = [...verification.heuristicIssues, ...(verification.llmIssues ?? [])];
      const actionable = issues.filter(issue => issue.severity === 'error' && issue.recoveryKind &&
        issue.type !== 'plan_deviation' && issue.type !== 'unresolved_hypothesis');
      const acceptedCompletion = completionFor(acceptedAssistant, acceptedText, acceptedAttemptId, acceptedTurnLimitReached);
      const declarationNeed = requestNativeDeclarationCompletion({
        intent: turnIntent, completion: acceptedCompletion, candidate: acceptedText,
        remainingDeliveryTurns: rounds < turnBudget.totalTurns ? turnBudget.deliveryTurns : 0,
        repairInvalid: true,
      });
      const declarationRequest = declarationNeed && nativeDeclarationBodyCanFitOutput(acceptedText, 64 * 1024)
        ? declarationNeed : undefined;
      // A repair that cannot run leaves the issue-based correction available, as before repairs existed.
      const correctionNeeded = declarationRequest !== undefined ||
        (declarationNeed === undefined || declarationNeed.reason === INVALID_NATIVE_DECLARATION) && actionable.length > 0;
      if (correctionNeeded &&
        rounds < (declarationRequest ? turnBudget.totalTurns : turnBudget.acquisitionTurns)
        && completionFor(acceptedAssistant, acceptedText, acceptedAttemptId, acceptedTurnLimitReached).status === 'completed') {
        const originalTools = agent.state.tools;
        const originalSystemPrompt = agent.state.systemPrompt;
        const originalError = agent.state.errorMessage;
        const declarationMessageBoundary = agent.state.messages?.length ?? 0;
        let acceptedDeclaration: string | undefined;
        correctionInProgress = true;
        declarationCompletionInProgress = Boolean(declarationRequest);
        try {
          agent.state.tools = [];
          agent.state.systemPrompt = declarationRequest
            ? originalSystemPrompt
            : `${originalSystemPrompt}\n\n${loadPiFinalReportCorrectionSystemPrompt(outputLanguage)}`;
          assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
          const correctionDiagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(acceptedText), 'native', 1);
          const correctionPrompt = declarationRequest
            ? buildNativeDeclarationCompletionPrompt({request: declarationRequest, intent: turnIntent, outputLanguage})
            : appendRelationProposalRecoveryFragment(
              `${generateCorrectionPrompt(actionable, acceptedText, outputLanguage,
                turnIntent.sceneId)}\n\n${JSON.stringify({candidateProtocolDiagnostic: correctionDiagnostic})}`,
              correctionDiagnostic, outputLanguage);
          const candidate = await runProviderPrompt(correctionPrompt,
            declarationRequest ? turnBudget.totalTurns : turnBudget.acquisitionTurns);
          assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
          if (candidate && completionFor(candidate.assistant, candidate.text, candidate.attemptId, candidate.turnLimitReached).status === 'completed') {
            const checked = await verifyCandidate(candidate.text, candidate.assistant, candidate.attemptId, candidate.turnLimitReached);
            const originalProtocol = inspectCandidateProtocol(acceptedText);
            const correctedProtocol = inspectCandidateProtocol(candidate.text);
            acceptedDeclaration = declarationRequest ? acceptNativeDeclarationCompletion({
              request: declarationRequest,
              completion: completionFor(candidate.assistant, candidate.text, candidate.attemptId, candidate.turnLimitReached),
              candidate: candidate.text,
              outputByteLimit: 64 * 1024,
            }) : undefined;
            const ordinaryCorrectionAccepted = !declarationRequest && correctedProtocol.canonicalBody.trim() &&
              correctedProtocol.status !== 'invalid' &&
              !(originalProtocol.status !== 'absent' && correctedProtocol.status === 'absent') &&
              ![...checked.heuristicIssues, ...(checked.llmIssues ?? [])].some(issue => issue.severity === 'error' &&
                issue.type !== 'plan_deviation' && issue.type !== 'unresolved_hypothesis');
            if (acceptedDeclaration || ordinaryCorrectionAccepted) {
              acceptedAssistant = candidate.assistant;
              acceptedText = candidate.text;
              acceptedAttemptId = candidate.attemptId;
              acceptedTurnLimitReached = candidate.turnLimitReached;
              verification = checked;
            }
          }
        } catch {
          executionLease.throwIfAborted();
          // A failed correction does not certify or replace the accepted candidate.
        } finally {
          if (declarationRequest && !acceptedDeclaration) {
            agent.state.messages = (agent.state.messages ?? []).slice(0, declarationMessageBoundary);
          }
          agent.state.tools = originalTools;
          agent.state.systemPrompt = originalSystemPrompt;
          agent.state.errorMessage = originalError;
          declarationCompletionInProgress = false;
          correctionInProgress = false;
        }
      }
    } finally {
      acceptingProviderEvents = false;
      toolAdmissionsOpen = false;
      if (privateAnalysisContext || executionLease.signal.aborted) this.sessionOpaqueStates.delete(sessionId);
      else this.rememberOpaqueState(sessionId, agent);
      providerIdle.clear();
      unsubscribe();
      if (this.activeAgents.get(sessionId) === agent) this.activeAgents.delete(sessionId);
    }
    executionLease.throwIfAborted();
    const conclusion = acceptedText;
    const completion = completionFor(acceptedAssistant, conclusion, acceptedAttemptId, acceptedTurnLimitReached);
    // Exploration diagnostics remain in the verifier and session state; they
    // do not establish whether this native answer fulfilled its delivery.
    const evidenceIssue = [...(verification?.heuristicIssues ?? []), ...(verification?.llmIssues ?? [])]
      .find(issue => issue.severity === 'error' && issue.type !== 'plan_deviation' && issue.type !== 'unresolved_hypothesis');
    const partial = completion.status !== 'completed' || !conclusion || Boolean(evidenceIssue);
    const terminationReason: AnalysisResult['terminationReason'] = completion.reason === 'turn_limit' ? 'max_turns'
      : completion.status === 'failed' ? 'execution_error'
      : completion.status === 'cancelled' ? 'timeout'
      : partial ? 'quality_gate_failed' : undefined;
    const findings = extractFindingsFromText(conclusion);
    const nativeResult: AnalysisResult = {
      sessionId, success: completion.status !== 'failed' && completion.status !== 'cancelled', findings,
      hypotheses: prep.hypotheses.map(h => toRuntimeProtocolHypothesis(h, 'pi-agent-core')),
      conclusion, turnIntent, completion,
      outputOrigin: closeoutAccepted || completion.status === 'completed' ? 'sdk_final' : 'assistant_stream',
      confidence: estimateAnalysisConfidence({findings, partial}),
      rounds, totalDurationMs: Date.now() - startedAt,
      partial: partial || undefined, terminationReason,
      terminationMessage: evidenceIssue?.message,
      ...(prep.quickMode ? {quickRun: buildQuickRunReceipt({
        requestedMode: options.analysisMode ?? 'auto', turnIntent, budget: quickBudget,
        actualTurns: rounds, elapsedMs: Date.now() - startedAt,
        stopReason: quickStopReasonFromTermination({partial, terminationReason, actualTurns: rounds,
          targetTurns: quickBudget.targetTurns, hardCapTurns: quickBudget.hardCapTurns}),
        evidence: {frontendPrequeryInjected: prep.analysisRunSpec.traceContext.datasetCount},
        contextInjected: {conversationTurns: countCompletedQuickConversationTurns(prep.previousTurns),
          ...prep.quickMemoryContextCounts},
      })} : {}),
    };
    const projected = projectPiAnalysisResult(nativeResult, prep.sourceUse, {
      entry: 'runtime_draft', acceptedCandidate: completion, completion,
      outputOrigin: nativeResult.outputOrigin, turnIntent,
    });
    const result = projected.result;
    this.emit('update', {type: 'progress', content: {phase: 'candidate_protocol',
      candidateProtocolDiagnostic: buildCandidateProtocolDiagnostic(inspectCandidateProtocol(result.conclusion), 'runtime_projected',
        acceptedAttemptId === '1' ? 1 : 2, projected.conclusionProjection.disposition)}, timestamp: Date.now()});
    applyFinalResultQualityGate({result, query, sceneType: turnIntent.sceneId,
      context: projected.deliveryContext,
      comparisonIdentity: prep.comparisonIdentity, deferFocusedEvidenceFinalization: true});
    executionLease.throwIfAborted();
    prep.sessionContext.addTurn(query, {
      primaryGoal: query, aspects: [], expectedOutputType: 'diagnosis',
      complexity: prep.quickMode ? 'simple' : 'complex',
      followUpType: prep.previousTurns.length > 0 ? 'extend' : 'initial',
    }, {
      agentId: 'pi-agent-core', success: result.success, findings: result.findings,
      confidence: result.confidence, message: result.conclusion, partial: result.partial,
      terminationReason: result.terminationReason, terminationMessage: result.terminationMessage,
      completion: result.completion, conclusionContract: result.conclusionContract,
      sourceDerived: privateAnalysisContext || undefined,
      analysisContextFingerprint: options.analysisContextFingerprint,
    }, result.findings);
    const deadlineMs = getRunDeadlineMs();
    if (projected.deliveryContext) {
      attachFinalizationContext(result, {
        runId, sessionId, deadlineMs, turnIntent, strategyRegistry: intentResolver.strategyRegistry,
        selection: prep.analysisRunSpec.selection,
        traceIdentity: {currentTraceId: traceId || undefined, referenceTraceId: options.referenceTraceId},
        deliveryContext: projected.deliveryContext, protocolProjection: projected.protocolProjection,
        sourceUse: prep.sourceUse.getSourceUseDecision(),
        sourceScope: prep.sourceUse.getSourceExecutionScope?.(),
        evidenceReadView: createPiEvidenceReadView(prep.artifactStore, runId, sessionId, traceId, options),
        ...(result.completion?.status === 'completed' && result.success && result.conclusion
          && result.outputOrigin !== 'runtime_fallback' ? {
            providerQuery: {text: prep.analysisRunSpec.query.text, analysisContextFingerprint: options.analysisContextFingerprint},
            dispatchText: (input: IntentTransportInput) => runPiIntentTransport({
              ...input, deadlineMs: Math.min(deadlineMs, input.deadlineMs), providerRuntime,
            }),
          } : {}),
      });
    }
    return result;
  }

  private async prepareAnalysis(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    model: string | undefined,
    executionLease: RuntimeExecutionLease,
    turnIntent: AnalysisTurnIntent,
    policy: RuntimeTurnPolicy,
    strategyRegistry: ReadonlyStrategyRegistrySnapshot,
    analysisHistoryReader: AnalysisHistoryReader,
    toolObserver?: RuntimeToolObserver,
    canInvokeTool?: () => boolean,
    sceneDeadlineMs?: number,
  ): Promise<PiAnalysisPreparation> {
    executionLease.throwIfAborted();
    const outputLanguage = options.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const sceneType = turnIntent.sceneId;
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() ?? [];
    const quickMode = policy.budgetMode === 'quick';
    const focusResult = await detectRunFocusApps({
      traceProcessorService: this.traceProcessorService, traceId, preflight: policy.preflight,
      selectionContext: options.selectionContext,
    });
    executionLease.throwIfAborted();
    const focusTarget = resolveFocusAppTarget({userPackageName: options.packageName, focusResult});
    const effectivePackageName = focusTarget.packageName;
    const analysisRunSpec = createAnalysisRunSpec({
      history: analysisHistoryReader.getTurns(),
      query,
      sessionId,
      traceId,
      options,
      runtimeSelection: this.selection,
      engineCapabilities: getPiAgentCoreEngineCapabilities(this.selection.kind),
      sceneType,
      outputLanguage,
      resolvedMode: quickMode ? 'quick' : 'full',
      resolvedModel: model,
      budget: {
        model,
        maxTurns: resolveAgentRuntimeBudgetConfig(this.env).maxTurns,
        quickMaxTurns: resolveQuickTurnBudget({env: this.env}).hardCapTurns,
        quickTargetTurns: resolveQuickTurnBudget({env: this.env}).targetTurns,
        quickPathPerTurnMs: positiveIntegerEnv(this.env, ['AGENT_QUICK_PER_TURN_MS'], 40_000),
        classifierTimeoutMs: positiveIntegerEnv(this.env, ['AGENT_CLASSIFIER_TIMEOUT_MS'], 30_000),
      },
      turnIntent,
    });

    await ensureSkillRegistryInitialized();
    executionLease.throwIfAborted();
    const skillExecutor = createSkillExecutor(this.traceProcessorService);
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    const sceneCoverageRegistry = resolveSceneProductScope(options, {sessionId, traceId, runId: options.runId ?? ''})
      ? snapshotSceneCoverageRegistry(effectiveSkillRegistry, strategyRegistry, turnIntent.sceneId) : undefined;
    skillExecutor.registerSkills(sceneCoverageRegistry ? [...sceneCoverageRegistry.skills] : effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(
      sceneCoverageRegistry ? new Map(sceneCoverageRegistry.fragments) : effectiveSkillRegistry.getFragmentCache(),
    );

    let architecture = getLruCacheEntry(this.architectureCache, traceId);
    if (!architecture && policy.preflight !== 'none') {
      try {
        architecture = await createArchitectureDetector().detect({
          traceId,
          traceProcessorService: this.traceProcessorService,
          packageName: effectivePackageName,
          signal: executionLease.signal,
        });
        executionLease.throwIfAborted();
        if (architecture) setLruCacheEntry(this.architectureCache, traceId, architecture);
      } catch (err) {
        executionLease.throwIfAborted();
        console.warn('[PiAgentCoreRuntime] Architecture detection failed:', (err as Error).message);
      }
    }
    executionLease.throwIfAborted();
    if (architecture) {
      this.emit('update', {
        type: 'architecture_detected',
        content: { architecture },
        timestamp: Date.now(),
      });
    }

    let traceCompleteness: Awaited<ReturnType<typeof probeTraceCompleteness>> | undefined;
    if (policy.preflight !== 'none') {
      try {
        traceCompleteness = await probeTraceCompleteness(
          this.traceProcessorService,
          traceId,
          architecture?.type,
        );
        executionLease.throwIfAborted();
      } catch (err) {
        executionLease.throwIfAborted();
        console.warn('[PiAgentCoreRuntime] Trace completeness probe failed:', (err as Error).message);
      }
    }

    const entityStore = sessionContext.getEntityStore();

    const watchdogWarning: { current: string | null } = { current: null };
    const knowledgeScope = analysisRunSpec.scopes.knowledge;
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    const recentSqlErrors = policy.allowNewEvidence ? loadLearnedSqlFixPairs(5, knowledgeScope, options) : [];
    const skillNotesBudget = createRuntimeSkillNotesBudget(quickMode);
    const pairInput = {
      traceProcessorService: this.traceProcessorService,
      currentTraceId: traceId,
      ...(options.referenceTraceId ? { referenceTraceId: options.referenceTraceId } : {}),
      ...(options.tracePairContext ? { tracePairContext: options.tracePairContext } : {}),
    };
    const comparisonContext = policy.allowAutomaticPrefetch
      ? await buildRuntimeTracePairComparisonContext(pairInput)
      : buildRuntimeTracePairIdentityContext(pairInput);
    executionLease.throwIfAborted();
    let knowledgeBaseContext: string | undefined;
    if (policy.allowAutomaticPrefetch) {
      try {
        const kb = await getExtendedKnowledgeBase();
        executionLease.throwIfAborted();
        knowledgeBaseContext = kb.getContextForAI(query, 8);
      } catch {
        executionLease.throwIfAborted();
        // Non-fatal. Pi can still use lookup_sql_schema/knowledge tools.
      }
    }
    executionLease.throwIfAborted();

    const artifactStore = resolveRuntimeEvidenceStore(options, {sessionId, traceId},
      () => this.artifactStores.get(sessionId) ?? new ArtifactStore());
    this.artifactStores.set(sessionId, artifactStore);

    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }

    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null, history: [] });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    if (analysisPlan.current) {
      analysisPlan.history.push(analysisPlan.current);
      if (analysisPlan.history.length > 3) analysisPlan.history.shift();
    }
    analysisPlan.current = null;
    resetPrePlanToolCallsForNewRun(analysisPlan);

    if (!this.sessionHypotheses.has(sessionId)) {
      this.sessionHypotheses.set(sessionId, []);
    }
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    hypotheses.splice(0);

    if (!this.sessionUncertaintyFlags.has(sessionId)) {
      this.sessionUncertaintyFlags.set(sessionId, []);
    }
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0);

    const sceneRunContext = await activateSceneRuntime(options, {sessionId, traceId, runId: options.runId ?? '',
      deadlineMs: sceneDeadlineMs ?? 0, traceProcessorService: this.traceProcessorService,
      artifactStore, sceneCoverageRegistry, signal: executionLease.signal, canInvokeTool});
    const { toolDefinitions, sourceUse } = createClaudeMcpServer({
      sceneRunContext,
      toolObserver, canInvokeTool, analysisHistoryReader,
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
      emitUpdate: (update) => this.emit('update', update),
      onSkillResult: (result) => {
        captureSkillDisplayEntities(result.displayResults, entityStore, 'pi-agent-core');
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      recentSqlErrors,
      analysisPlan,
      watchdogWarning,
      hypotheses,
      sceneType,
      uncertaintyFlags,
      lightweight: usesLightweightToolCatalog(policy),
      allowNewEvidence: policy.allowNewEvidence,
      strategyRegistry,
      skillNotesBudget,
      outputLanguage,
      knowledgeScope,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
      sourceUsePolicy: options.sourceUsePolicy,
      analysisContextFingerprint: options.analysisContextFingerprint,
      androidInternalsPackPin: options.androidInternalsPackPin,
      referenceTraceId: options.referenceTraceId,
      ...(comparisonContext ? { comparisonContext } : {}),
    });
    const allowedToolNames = new Set(toolDefinitions.map(definition => definition.name));
    const tools = toolDefinitions.map(definition => (
      createPiAgentCoreToolFromSharedSpec(definition.shared, {
        allowedToolNames,
        runtimeKind: this.selection.kind,
        analysisPlan,
        onPhaseAutoCompleted: phase => this.emit('update', {
          type: 'plan_phase_updated',
          content: planPhaseUpdatedContent({phaseId: phase.id, phaseName: phase.name, status: 'completed', summary: phase.summary, origin: 'auto'}),
          timestamp: Date.now(),
        }),
      })
    ));

    let prompt = query;
    const historyContext = renderAnalysisHistoryContext(analysisHistoryReader.getTurns(), {outputLanguage});
    if (historyContext) prompt = `${historyContext}\n\n${prompt}`;
    if (analysisRunSpec.traceContext.promptSection) {
      prompt = `${analysisRunSpec.traceContext.promptSection}\n\n${prompt}`;
    }
    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });

    const patternContext = privateAnalysisContext || !policy.allowAutomaticPrefetch
      ? undefined
      : buildPatternContextSection(traceFeatures, knowledgeScope);
    const negativePatternContext = privateAnalysisContext || !policy.allowAutomaticPrefetch
      ? undefined
      : buildNegativePatternSection(traceFeatures, knowledgeScope);
    const traceInfo = this.traceProcessorService.getTrace(traceId);
    const systemPromptEnv = normalizeOptionalString(this.env[PI_AGENT_CORE_SYSTEM_PROMPT_ENV]);
    const analysisContext: ClaudeAnalysisContext = {
      query, turnIntent, strategyRegistry, onDemandContext: policy.onDemandContext,
      architecture,
      packageName: effectivePackageName,
      focusTarget,
      knowledgeBaseContext,
      sceneType,
      sqlErrorFixPairs: recentSqlErrors
        .filter((entry: any) => entry.fixedSql)
        .slice(-3)
        .map((entry: any) => ({
          errorSql: entry.errorSql,
          errorMessage: entry.errorMessage,
          fixedSql: entry.fixedSql,
        })),
      patternContext,
      negativePatternContext,
      caseBackgroundContext: policy.allowAutomaticPrefetch ? buildRuntimeCaseBackgroundContext({
        sceneType,
        architectureType: architecture?.type,
        knowledgeScope,
        outputLanguage,
        privateAnalysisContext,
      }) : undefined,
      selectionContext: options.selectionContext,
      traceCompleteness,
      traceOs: traceInfo?.traceOs,
      traceFormat: traceInfo?.traceFormat,
      outputLanguage,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      ...(comparisonContext ? { comparison: comparisonContext } : {}),
    };
    const sharedSystemPrompt = buildSystemPrompt(analysisContext);
    return {
      systemPrompt: systemPromptEnv
        ? `${sharedSystemPrompt}\n\n${systemPromptEnv}`
        : sharedSystemPrompt,
      prompt,
      tools,
      allowedToolNames,
      quickMode,
      turnIntent,
      policy,
      sceneType,
      packageName: effectivePackageName,
      architecture,
      sessionContext,
      previousTurns,
      analysisPlan,
      notes,
      hypotheses,
      uncertaintyFlags,
      analysisRunSpec,
      sourceUse,
      artifactStore,
      ...(comparisonContext ? {comparisonIdentity: buildComparisonIdentity(focusTarget, comparisonContext)} : {}),
    };
  }

  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    setLruCacheEntry(this.architectureCache, traceId, architecture);
  }

  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return getLruCacheEntry(this.architectureCache, traceId);
  }

  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) || [];
  }

  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) || [];
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
    const activeAgent = this.activeAgents.get(sessionId);
    const activeAgentOpaque = activeAgent && !this.suppressedOpaqueStateSessions.has(sessionId)
      ? createPiOpaqueStateFromMessages(activeAgent.state.messages)
      : undefined;
    const opaque = privateKnowledge
      ? undefined
      : this.sessionOpaqueStates.get(sessionId)
        ?? activeAgentOpaque;
    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,
      ...durableFields,
      analysisNotes: privateKnowledge ? [] : this.sessionNotes.get(sessionId) || [],
      analysisPlan: privateKnowledge ? null : planState?.current ?? null,
      planHistory: privateKnowledge ? [] : planState?.history ?? [],
      uncertaintyFlags: privateKnowledge ? [] : this.sessionUncertaintyFlags.get(sessionId) || [],
      claudeHypotheses: privateKnowledge ? undefined : this.sessionHypotheses.get(sessionId) || undefined,
      architecture: getLruCacheEntry(this.architectureCache, traceId),
      engineState: createPiAgentCoreSnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        opaque,
      }),
      agentRuntimeKind: PI_AGENT_CORE_RUNTIME_KIND,
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
    if (snapshot.artifacts && snapshot.artifacts.length > 0) {
      this.artifactStores.set(sessionId, ArtifactStore.fromSnapshot(snapshot.artifacts));
    }
    if (snapshot.architecture) {
      setLruCacheEntry(this.architectureCache, traceId, snapshot.architecture);
    }
    const opaque = getPiAgentCoreSnapshotEngineState(snapshot)?.opaque;
    if (opaque) {
      this.sessionOpaqueStates.set(sessionId, opaque);
    }
  }

  reset(): void {
    this.executionGuard.clear();
    for (const agent of this.activeAgents.values()) {
      agent.reset();
    }
    this.activeAgents.clear();
    this.sessionOpaqueStates.clear();
    this.suppressedOpaqueStateSessions.clear();
    this.architectureCache.clear();
    this.providerRuntimeCache.clear();
    this.moduleRuntimeCache.clear();
    this.removeAllListeners();
  }

  abortActiveRun(): void {
    for (const sessionId of this.activeAgents.keys()) {
      this.suppressedOpaqueStateSessions.add(sessionId);
    }
    for (const agent of this.activeAgents.values()) {
      agent.abort();
    }
  }

  abortSession(sessionId: string): void {
    this.suppressedOpaqueStateSessions.add(sessionId);
    void this.executionGuard
      .abortSession(sessionId, `Runtime analysis aborted for session ${sessionId}`)
      .catch(() => undefined);
    this.activeAgents.get(sessionId)?.abort();
  }

  cleanupSession(sessionId: string): void {
    this.abortSession(sessionId);
    this.activeAgents.delete(sessionId);
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.sessionOpaqueStates.delete(sessionId);
    this.suppressedOpaqueStateSessions.delete(sessionId);
  }
}

export function createPiAgentCoreRuntime(
  input: RuntimeFactoryInput,
  options: PiAgentCoreRuntimeOptions = {},
): IOrchestrator {
  const runtimeOptions: PiAgentCoreRuntimeOptions = {
    ...options,
    env: options.env ?? input.env,
  };
  return new PiAgentCoreRuntime(
    input.traceProcessorService,
    input.selection.kind === EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND ||
      input.selection.kind === PI_AGENT_CORE_RUNTIME_KIND
      ? input.selection as RuntimeSelection<PiAgentCoreRuntimeKind>
      : { kind: PI_AGENT_CORE_RUNTIME_KIND, source: 'env' },
    runtimeOptions,
  );
}

export function createPiAgentCoreRuntimeDefinition(
  kind: PiAgentCoreRuntimeKind = EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
): RuntimeEngineDefinition {
  return {
    kind,
    capabilities: getPiAgentCoreEngineCapabilities(kind),
    createOrchestrator: (input) => createPiAgentCoreRuntime(input),
  };
}
