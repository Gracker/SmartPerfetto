// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import type { IOrchestrator } from '../../../agent/core/orchestratorTypes';
import type { AnalysisOptions, AnalysisResult } from '../../../agent/core/orchestratorTypes';
import type { ConversationTurn, Finding, StreamingUpdate } from '../../../agent/types';
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
import {resolveEffectiveAnalysisMode} from '../../../services/effectiveAnalysisMode';
import {analysisContextUsesPrivateKnowledge} from '../../../services/resolvedAnalysisContext';
import { sanitizeCodeAwareText } from '../../../services/security/codeAwareOutputRegistry';
import {
  isSensitiveRagToolName,
  projectToolResultForExternalSurface,
} from '../../../services/rag/toolResultProjectionFilter';
import { completeFinalReportCodeReferences } from '../../../services/codebase/codeReferenceContract';
import { extractSourceLookupCodeReferences } from '../../../services/codebase/sourceLookupTools';
import {finalizeSourceAwareAnalysisResult} from '../../../services/codebase/sourceClaimVerifier';
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
import {
  buildQuickSystemPrompt,
  buildSystemPrompt,
} from '../../../agentv3/claudeSystemPrompt';
import { extractFindingsFromText } from '../../../agentv3/claudeFindingExtractor';
import { detectFocusApps, focusAppTimeRangeFromSelection } from '../../../agentv3/focusAppDetector';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {
  buildNegativePatternSection,
  buildPatternContextSection,
  extractTraceFeatures,
} from '../../../agentv3/analysisPatternMemory';
import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import { classifyScene, type SceneType } from '../../../agentv3/sceneClassifier';
import { localize, parseOutputLanguage, type OutputLanguage } from '../../../agentv3/outputLanguage';
import type {
  AnalysisNote,
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  Hypothesis,
  PlanPhase,
  UncertaintyFlag,
  VerificationIssue,
} from '../../../agentv3/types';
import {
  getAnalysisPlanCompletionStatus,
  type AnalysisPlanCompletionStatus,
} from '../../../agentv3/planCompletionStatus';
import {
  formatPlanEvidenceGap,
  recordPlanOrPrePlanToolCall,
  resetPrePlanToolCallsForNewRun,
} from '../../../agentv3/planToolCallRecorder';
import {
  assessFinalResultComparisonIdentity,
  assessFinalResultQuality,
  applyFinalResultQualityGate,
  hasDeliverableFinalReportHeading,
  looksLikeProcessNarrationConclusion,
  serializeFinalResultQualityIssueContext,
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
} from '../../runtimeToolSpec';
import type { RuntimeSelection } from '../../runtimeSelection';
import type { RuntimeEngineDefinition, RuntimeFactoryInput } from '../../runtimeRegistry';
import type { EngineCapabilities } from '../../runtimeDescriptorTypes';
import { createAnalysisRunSpec, type AnalysisRunSpec } from '../../analysisRunSpec';
import {
  buildQuickConversationContext,
  buildRuntimeTracePairComparisonContext,
} from '../../runtimePromptContext';
import { loadPromptTemplate } from '../../../agentv3/strategyLoader';
import {
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
} from '../../runtimeKinds';
import {
  buildQuickRunReceipt,
  buildEntityContext,
  buildQuickMemoryContextPayload,
  captureSkillDisplayEntities,
  createRuntimeSkillNotesBudget,
  findTruncationVerificationIssue,
  isTruncationVerificationIssue,
  quickStopReasonFromTermination,
  repairTruncatedFinalReport,
  resolveQuickTurnBudget,
  shouldMarkQuickRunTriage,
  toProtocolHypothesis as toRuntimeProtocolHypothesis,
} from '../../runtimeCommon';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import { assessFinalReportContractCompleteness } from '../../../services/finalReportContractGate';
import { resolveRuntimeQuickMode } from '../../quickModeResolution';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import {buildAdaptiveRoutingForQuickResolution} from '../../adaptiveRoutingProjection';
import {resolveRuntimeFinalReportSceneType} from '../../finalReportSceneResolution';
import {reconcileDeliveredFinalReportPhase} from '../../finalReportPhaseReconciliation';
import {loadRuntimePlanCompletionContinuationPrompt} from '../../planCompletionContinuation';
import {
  buildRuntimeQuickEvidenceAttempt,
  selectReusableRuntimeQuickEvidenceAttempt,
  type RuntimeQuickEvidenceCounts,
  type RuntimeQuickEvidenceDirectAnswer,
  type RuntimeQuickEvidenceAttempt,
} from '../../quickEvidenceDirectAnswer';
import {
  buildQuickDirectAcknowledgementAnalysisResult,
  buildQuickDirectEvidenceAnalysisResult,
  countCompletedQuickConversationTurns,
  emitQuickDirectAnswerEvents,
  emitQuickDirectQualityGateIssue,
} from '../../quickDirectResult';
import {getLruCacheEntry, setLruCacheEntry} from '../../runtimeCache';
import {
  DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS,
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
const PI_AGENT_CORE_PROVIDER_TEXT_MAX_CHARS = DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS;
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
const PI_AGENT_CORE_MAX_PLAN_COMPLETION_CONTINUATIONS = 2;
const PI_AGENT_CORE_MAX_HYPOTHESIS_RESOLUTION_CONTINUATIONS = 1;
const PI_AGENT_CORE_MAX_FINAL_REPORT_CONTINUATIONS = 1;

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

function piModelIdentity(model: Record<string, unknown>): string | undefined {
  const modelId = normalizeOptionalString(model.id)
    ?? normalizeOptionalString(model.name)
    ?? normalizeOptionalString(model.model);
  if (!modelId) return undefined;
  const provider = normalizeOptionalString(model.provider);
  return provider ? `${provider}/${modelId}` : modelId;
}

interface PiAnalysisPreparation {
  systemPrompt: string;
  prompt: string;
  tools: PiAgentCoreTool[];
  allowedToolNames: Set<string>;
  quickMode: boolean;
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
    if (block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
    return '';
  }).filter(Boolean).join('\n');
}

function latestAssistantText(messages: unknown[] | undefined): string {
  const reversed = [...(messages ?? [])].reverse();
  for (const message of reversed) {
    if ((message as { role?: string }).role !== 'assistant') continue;
    const text = extractAssistantText(message);
    if (text) return text;
  }
  return '';
}

function looksLikeFinalReport(text: string): boolean {
  return (
    hasDeliverableFinalReportHeading(text) ||
    /#\s+.+分析报告/.test(text) ||
    /##\s*(1[.、)]?\s*)?概览/.test(text) ||
    /##\s*(关键发现|根因分析|优化建议|证据索引)/.test(text) ||
    /\[Evidence:/.test(text)
  );
}

function isDeliverableReportHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const markdownHeading = /^#{1,3}\s+(.+)$/.exec(trimmed);
  let normalized = (markdownHeading?.[1] ?? trimmed).trim();
  normalized = normalized.replace(/^\*\*(.+?)\*\*(.*)$/, '$1$2').trim();

  if (/\bFinal Report Contract\b/i.test(normalized)) return false;
  normalized = normalized.replace(/^\d+(?:\.\d+)*[.、)]?\s*/, '');

  if (
    /^(?:综合结论|关键结论|最终结论|最终报告|根因分析|Final Conclusion|Final Report|Analysis Report|Root Cause(?: Analysis)?)(?:\s*[：:—-]\s*.*)?$/i.test(
      normalized,
    )
  ) {
    return true;
  }

  const chineseProcessNarrationPrefix =
    /^(?:需要|需|请|将|应该|开始|现在|让我|输出|撰写|生成|检查|合同|规范|要求)/;
  const englishProcessNarrationPrefix =
    /^(?:let me|I (?:will|need to|should)|we (?:will|need to|should)|please)\b/i;
  if (
    chineseProcessNarrationPrefix.test(normalized) ||
    englishProcessNarrationPrefix.test(normalized)
  ) {
    return false;
  }

  if (markdownHeading) {
    if (
      /^(?:综合结论|关键结论|最终结论|最终报告|根因分析|Final Conclusion|Final Report|Analysis Report|Root Cause(?: Analysis)?)(?=$|\s|[：:—（(、，,；;及与-])/i.test(
        normalized,
      ) ||
      /^(?:[^#\n：:。.!！？?]{1,40})?(?:分析报告|Analysis Report)(?=$|\s|[：:—（(、，,；;及与-])/i.test(
        normalized,
      )
    ) {
      return true;
    }
  }

  return /^(?:[^#\n：:。.!！？?]{1,40})?(?:分析报告|Analysis Report)(?:\s*[（(][^)）\n]{0,30}[)）])?\s*(?:[：:—-]\s*.*)?$/i.test(
    normalized,
  );
}

function findDeliverableReportHeadingIndex(text: string): number {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (isDeliverableReportHeadingLine(line)) {
      const firstNonWhitespace = line.search(/\S/);
      return offset + Math.max(0, firstNonWhitespace);
    }
    offset += line.length + 1;
  }
  return -1;
}

export function sanitizePiAgentCoreConclusionText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const headingIndex = findDeliverableReportHeadingIndex(trimmed);
  if (headingIndex <= 0) return trimmed;

  const reportText = trimmed.slice(headingIndex).trim();
  const firstReportLine = reportText.split('\n', 1)[0] ?? '';
  if (!isDeliverableReportHeadingLine(firstReportLine)) return trimmed;

  const prefix = trimmed.slice(0, headingIndex).trim();
  const prefixLooksProcessNarration =
    looksLikeProcessNarrationConclusion(prefix) ||
    /(?:the system (?:is )?asking me|I have all (?:the )?necessary|I (?:already have|should|need to)|now let me|let me(?: now)? (?:check|look|write)|key findings?:|我(?:已|会|将)|现在.{0,40}(?:输出|撰写|生成)|开始撰写|完整结构化报告|update_plan_phase|submit_plan|resolve_hypothesis)/i.test(prefix);

  return prefixLooksProcessNarration ? reportText : trimmed;
}

export function selectAssistantConclusion(messages: unknown[] | undefined): string {
  const assistantTexts = (messages ?? [])
    .filter(message => (message as { role?: string }).role === 'assistant')
    .map(extractAssistantText)
    .map(text => text.trim())
    .filter(Boolean);
  if (assistantTexts.length === 0) return '';
  const reportTexts = assistantTexts.filter(looksLikeFinalReport);
  const candidates = reportTexts.length > 0 ? reportTexts : assistantTexts;
  return candidates[candidates.length - 1];
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

export function completePiAgentCoreFinalReportPhaseIfDelivered(
  plan: AnalysisPlanV3 | null | undefined,
  conclusion: string,
  outputLanguage: OutputLanguage,
  now: () => number = Date.now,
): PlanPhase | undefined {
  const sanitizedConclusion = sanitizePiAgentCoreConclusionText(conclusion);
  return reconcileDeliveredFinalReportPhase({
    plan,
    conclusion: sanitizedConclusion,
    minSummaryChars: MIN_PHASE_SUMMARY_CHARS,
    isDeliverableReport: candidate => (
      hasDeliverableFinalReportHeading(candidate) && looksLikeFinalReport(candidate)
    ),
    buildSummary: () => localize(
      outputLanguage,
      '最终报告已由 Pi Agent Core 直接交付；该最终结论阶段按完整报告自动闭合。',
      'The final report was delivered by Pi Agent Core; the final-report phase was auto-closed from the complete report.',
    ),
    now,
  });
}

function formatIncompletePlanMessage(
  planStatus: ReturnType<typeof getPiAgentCorePlanCompletionStatus>,
  outputLanguage: OutputLanguage,
): string {
  if (!planStatus.hasPlan) {
    return localize(
      outputLanguage,
      'Pi Agent Core 分析没有提交 plan，结果只能作为不完整分析使用。',
      'Pi Agent Core analysis did not submit a plan; treat the result as incomplete.',
    );
  }
  const pending = planStatus.pendingPhases
    .map(phase => phase.name || phase.id)
    .filter(Boolean)
    .join(', ');
  const evidenceGapText = planStatus.evidenceGaps?.length
    ? localize(
        outputLanguage,
        `；缺失关键工具证据：${planStatus.evidenceGaps.map(gap => formatPlanEvidenceGap(gap, outputLanguage)).join('；')}`,
        `; missing required tool evidence: ${planStatus.evidenceGaps.map(gap => formatPlanEvidenceGap(gap, outputLanguage)).join('; ')}`,
      )
    : '';
  return localize(
    outputLanguage,
    `Pi Agent Core 分析 plan 尚未完成。未完成阶段：${pending || 'unknown'}${evidenceGapText}`,
    `Pi Agent Core analysis plan is incomplete. Pending phases: ${pending || 'unknown'}${evidenceGapText}`,
  );
}

export function shouldContinuePiAgentCoreFinalReportAfterPlanComplete(input: {
  quickMode: boolean;
  planStatus: ReturnType<typeof getPiAgentCorePlanCompletionStatus>;
  finalReportContinuations: number;
  conclusion: string;
  query: string;
  sceneType: SceneType;
  comparisonIdentity?: FinalResultComparisonIdentity;
}): boolean {
  if (
    input.quickMode ||
    !input.planStatus.complete ||
    input.finalReportContinuations >= PI_AGENT_CORE_MAX_FINAL_REPORT_CONTINUATIONS
  ) {
    return false;
  }

  const issue = assessFinalResultQuality({
    result: {
      sessionId: 'pi-agent-core-final-report-quality-check',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: input.conclusion,
      confidence: 1,
      rounds: 1,
      totalDurationMs: 0,
    },
    query: input.query,
    sceneType: input.sceneType,
    comparisonIdentity: input.comparisonIdentity,
  });
  return Boolean(issue);
}

function loadPiFinalReportContinuationPrompt(outputLanguage: OutputLanguage): string {
  const templateName = outputLanguage === 'en'
    ? 'prompt-openai-final-report-continuation-en'
    : 'prompt-openai-final-report-continuation-zh';
  const template = loadPromptTemplate(templateName);
  if (!template) {
    throw new Error(`Missing Pi final-report continuation prompt template: ${templateName}`);
  }
  return template;
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

export async function verifyPiAgentCoreConclusionForCorrection(input: {
  conclusion: string;
  plan: AnalysisPlanV3 | null | undefined;
  hypotheses: Hypothesis[];
  sceneType: SceneType;
  outputLanguage: OutputLanguage;
  query: string;
  allowPersistentLearning: boolean;
  comparisonIdentity?: FinalResultComparisonIdentity;
}): Promise<VerificationIssue[]> {
  const verification = await verifyConclusion(
    extractFindingsFromText(input.conclusion),
    input.conclusion,
    {
      enableLLM: false,
      plan: input.plan,
      hypotheses: input.hypotheses,
      sceneType: input.sceneType,
      outputLanguage: input.outputLanguage,
      query: input.query,
      emitIssueProgress: false,
      allowPersistentLearning: input.allowPersistentLearning,
    },
  );
  const issues: VerificationIssue[] = [
    ...verification.heuristicIssues,
    ...(verification.llmIssues ?? []),
  ];
  const comparisonIdentityIssue = assessFinalResultComparisonIdentity(
    input.conclusion,
    input.comparisonIdentity,
  );
  if (comparisonIdentityIssue) {
    issues.push({
      type: 'missing_check',
      severity: 'error',
      message: comparisonIdentityIssue.message,
    });
  }
  const finalQualityIssue = assessFinalResultQuality({
    result: {
      sessionId: 'pi-agent-core-final-report-quality-check',
      success: true,
      findings: extractFindingsFromText(input.conclusion),
      hypotheses: [],
      conclusion: input.conclusion,
      confidence: 1,
      rounds: 1,
      totalDurationMs: 0,
    },
    query: input.query,
    sceneType: input.sceneType,
    comparisonIdentity: input.comparisonIdentity,
  });
  if (finalQualityIssue) {
    const message = serializeFinalResultQualityIssueContext(finalQualityIssue);
    if (!issues.some(issue => issue.severity === 'error' && issue.message === message)) {
      issues.push({
        type: 'missing_check',
        severity: 'error',
        message,
      });
    }
  }
  return issues;
}

function estimateConfidence(findings: Finding[], partial: boolean): number {
  if (findings.length === 0) return partial ? 0.25 : 0.35;
  const avg = findings.reduce((sum, finding) => sum + (finding.confidence ?? 0.5), 0) / findings.length;
  const confidence = Math.min(1, Math.max(0, avg));
  return partial ? Math.min(confidence, 0.55) : confidence;
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
    case 'tool_execution_start':
      return {
        type: 'agent_task_dispatched',
        content: {
          taskId: event.toolCallId || 'unknown',
          toolName: event.toolName || 'unknown',
          args: event.args,
          message: `Pi agent-core dispatched ${event.toolName || 'unknown'}`,
        },
        timestamp,
      };
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
      const result = summarizePiToolResult(
        projectToolResultForExternalSurface(toolName, event.result),
      );
      return event.isError
        ? {
            type: 'agent_response',
            content: {
              taskId: event.toolCallId || 'unknown',
              toolName,
              toolCallId: event.toolCallId,
              result,
              isError: true,
              recoverable: true,
            },
            timestamp,
          }
        : {
            type: 'agent_response',
            content: {
              taskId: event.toolCallId || 'unknown',
              result,
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
  const content = (result as { content?: Array<Record<string, unknown>> }).content;
  const providerFacingValue = Array.isArray(content)
    ? content.map((block) => (
      typeof block.text === 'string' ? block.text : block
    )).join('\n')
    : typeof result === 'string' ? result : result;
  return [{
    type: 'text',
    text: summarizeExternalToolResult(
      providerFacingValue,
      PI_AGENT_CORE_PROVIDER_TEXT_MAX_CHARS,
    ),
  }];
}

export type PiAgentCoreNativeToolExecutionMode = 'sequential' | 'parallel';

export function resolvePiAgentCoreNativeToolExecutionMode(input: {
  quickMode: boolean;
  tools: readonly {concurrency?: RuntimeToolConcurrencyPolicy}[];
  env?: Record<string, string | undefined>;
}): PiAgentCoreNativeToolExecutionMode {
  if (
    !isRuntimeCandidateAdmitted('task7', input.env)
    || !input.quickMode
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
    if (input.executionLease.signal.aborted) {
      await promptPromise.catch(() => undefined);
    } else if (
      !(error instanceof Error && error.message.includes('provider stream idle timeout'))
    ) {
      input.providerIdle.pause();
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
      const normalizedArgs = normalizeRuntimeToolArgs(params) as Record<string, unknown>;
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
        input: toolArgs,
        returnedCodeReferences: codeReferences.length > 0,
        returnedCodeReferenceHints: codeReferences,
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
      analysisMode: resolveEffectiveAnalysisMode(options.analysisMode, options),
    };
    const executionLease = this.executionGuard.begin({
      runtime: PI_AGENT_CORE_RUNTIME_KIND,
      sessionId,
      referenceTraceId: options.referenceTraceId,
      runId: options.runId,
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
    const requestTimeout = new Promise<never>((_, reject) => {
      requestTimer = setTimeout(() => {
        markTimeout('request', timeouts.requestTimeoutMs);
        this.suppressedOpaqueStateSessions.add(sessionId);
        void this.executionGuard
          .abortSession(sessionId, `Pi Agent Core request timeout after ${timeouts.requestTimeoutMs}ms`)
          .catch(() => undefined);
        this.activeAgents.get(sessionId)?.abort();
        reject(new Error(`Pi Agent Core request timeout after ${timeouts.requestTimeoutMs}ms`));
      }, timeouts.requestTimeoutMs);
    });
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
          currentSourceUse => {
            sourceUse = currentSourceUse;
          },
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
        return finalizeSourceAwareAnalysisResult(buildPiTimeoutResult({
          sessionId,
          startedAt,
          timeoutKind: timeout.kind,
          timeoutMs: timeout.timeoutMs,
          reason: error,
        }), sourceUse);
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
    return Array.isArray(opaque.messages) ? [...opaque.messages] : [];
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

    const conclusion = sanitizePiAgentCoreConclusionText(latestAssistantText(agent.state.messages) ||
      (this.selection.kind === PI_AGENT_CORE_RUNTIME_KIND
        ? 'Pi agent-core runtime completed without assistant text.'
        : 'Experimental Pi agent-core runtime completed without assistant text.'));
    return {
      sessionId,
      success: true,
      findings: [],
      hypotheses: [],
      conclusion,
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
    onSourceUseReady: (sourceUse: PiAnalysisPreparation['sourceUse']) => void,
  ): Promise<AnalysisResult> {
    executionLease.throwIfAborted();
    const startedAt = Date.now();
    const outputLanguage = options.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const sceneType = classifyScene(query);
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() || [];
    const quickResolution = resolveRuntimeQuickMode({
      query,
      sceneType,
      analysisMode: options.analysisMode,
      conversationSurface: options.assistantSurface === 'conversation',
      selectionContext: options.selectionContext,
      packageName: options.packageName,
      hasReferenceTrace: Boolean(options.referenceTraceId),
      previousTurns,
    });
    runtimePerformance.finishClassification('ok');
    if (quickResolution.quickMode && quickResolution.quickAcknowledgementDirectAnswer) {
      const analysisRunSpec = createAnalysisRunSpec({
        query,
        sessionId,
        traceId,
        options,
        runtimeSelection: this.selection,
        engineCapabilities: getPiAgentCoreEngineCapabilities(this.selection.kind),
        sceneType,
        outputLanguage,
        resolvedMode: 'quick',
        budget: {model: 'runtime-acknowledgement'},
        adaptiveRouting: buildAdaptiveRoutingForQuickResolution({
          options,
          resolution: quickResolution,
        }),
      });
      return this.buildDirectQuickAcknowledgementResult({
        query,
        sessionId,
        options,
        startedAt,
        sceneType,
        outputLanguage,
        sessionContext,
        previousTurns,
        analysisRunSpec,
        executionLease,
        runtimePerformance,
      });
    }

    let quickEvidenceAttempt: RuntimeQuickEvidenceAttempt | undefined;
    if (quickResolution.quickMode) {
      const quickEvidencePhase = runtimePerformance.startPhase('quick_evidence');
      const finishQuickEvidenceAsCancelled = () => {
        try {
          quickEvidencePhase.end('cancelled');
        } catch {
          // Runtime performance is internal observability only.
        }
      };
      executionLease.signal.addEventListener('abort', finishQuickEvidenceAsCancelled, {once: true});
      try {
        quickEvidenceAttempt = await buildRuntimeQuickEvidenceAttempt({
          query,
          traceId,
          packageName: options.packageName,
          selectionContext: options.selectionContext,
          traceProcessorService: this.traceProcessorService,
          outputLanguage,
          quickFocusAppPreEvidence: quickResolution.quickFocusAppPreEvidence,
          quickProcessIdentityPreEvidence: quickResolution.quickProcessIdentityPreEvidence,
          quickTraceFactPreEvidence: quickResolution.quickTraceFactPreEvidence,
          quickScrollingTriagePreEvidence: quickResolution.quickScrollingTriagePreEvidence,
          emitUpdate: update => {
            if (!executionLease.signal.aborted) this.emit('update', update);
          },
        });
        executionLease.throwIfAborted();
        quickEvidencePhase.end('ok');
      } catch (error) {
        quickEvidencePhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      } finally {
        executionLease.signal.removeEventListener('abort', finishQuickEvidenceAsCancelled);
      }
    }
    executionLease.throwIfAborted();
    if (quickEvidenceAttempt?.directAnswer) {
      const analysisRunSpec = createAnalysisRunSpec({
        query,
        sessionId,
        traceId,
        options: {
          ...options,
          ...(quickEvidenceAttempt.effectivePackageName ? {
            packageName: quickEvidenceAttempt.effectivePackageName,
          } : {}),
        },
        runtimeSelection: this.selection,
        engineCapabilities: getPiAgentCoreEngineCapabilities(this.selection.kind),
        sceneType,
        outputLanguage,
        resolvedMode: 'quick',
        budget: {model: 'runtime-pre-evidence'},
        adaptiveRouting: buildAdaptiveRoutingForQuickResolution({
          options,
          resolution: quickResolution,
        }),
      });
      return this.buildDirectQuickEvidenceResult({
        query,
        sessionId,
        options,
        startedAt,
        sceneType,
        outputLanguage,
        sessionContext,
        previousTurns,
        analysisRunSpec,
        directAnswer: quickEvidenceAttempt.directAnswer,
        evidenceCounts: quickEvidenceAttempt.evidenceCounts,
        executionLease,
        runtimePerformance,
      });
    }

    const modelConfig = resolvePiAgentCoreModel(this.env, false);
    const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
    let Agent: Awaited<ReturnType<PiAgentCoreModuleLoader>>['Agent'];
    let providerRuntime: Awaited<ReturnType<PiAgentCoreProviderRuntimeLoader>>;
    try {
      if (isRuntimeCandidateAdmitted('task7', this.env)) {
        const loaded = await Promise.all([
          this.getPiAgentCoreModule(),
          this.getProviderRuntime(modelConfig),
        ]);
        Agent = loaded[0].Agent;
        providerRuntime = loaded[1];
      } else {
        Agent = (await this.getPiAgentCoreModule()).Agent;
        providerRuntime = await this.getProviderRuntime(modelConfig);
      }
      sdkStartPhase.end('ok');
    } catch (error) {
      sdkStartPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
      throw error;
    }
    executionLease.throwIfAborted();
    const prep = await this.prepareAnalysis(
      query,
      sessionId,
      traceId,
      options,
      piModelIdentity(modelConfig.model),
      executionLease,
      selectReusableRuntimeQuickEvidenceAttempt(quickEvidenceAttempt, this.env),
    );
    onSourceUseReady(prep.sourceUse);
    executionLease.throwIfAborted();
    const resolveFinalReportSceneType = () => resolveRuntimeFinalReportSceneType({
      query,
      initialSceneType: prep.sceneType,
      plan: prep.analysisPlan.current,
    });
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    if (privateAnalysisContext) this.sessionOpaqueStates.delete(sessionId);

    const agent = new Agent({
      initialState: {
        systemPrompt: prep.systemPrompt,
        model: providerRuntime.model,
        tools: prep.tools,
        messages: privateAnalysisContext
          ? []
          : this.getInitialMessagesForSession(sessionId),
        thinkingLevel: modelConfig.thinkingLevel ?? 'off',
      },
      sessionId,
      streamFn: providerRuntime.streamFn,
      toolExecution: resolvePiAgentCoreNativeToolExecutionMode({
        quickMode: prep.quickMode,
        tools: prep.tools,
        env: this.env,
      }),
      transport: modelConfig.transport ?? 'auto',
      maxRetryDelayMs: modelConfig.maxRetryDelayMs,
      thinkingBudgets: modelConfig.thinkingBudgets,
      beforeToolCall: async ({ toolCall }: any) => {
        if (!prep.allowedToolNames.has(toolCall?.name)) {
          return {
            block: true,
            reason: `Tool ${toolCall?.name || 'unknown'} is not in the SmartPerfetto request-scoped allowlist.`,
          };
        }
        return undefined;
      },
    });
    this.activeAgents.set(sessionId, agent);
    const analysisMessageBoundary = agent.state.messages?.length ?? 0;
    const currentAnalysisMessages = (): unknown[] => (
      (agent.state.messages ?? []).slice(analysisMessageBoundary)
    );

    let rounds = 0;
    let planCompletionContinuations = 0;
    let hypothesisResolutionContinuations = 0;
    let finalReportContinuations = 0;
    let lastPlanCompletionMessageBoundary: number | undefined;
    let finalReportContinuationMessageBoundary: number | undefined;
    let forceFinalReportContinuation = false;
    let correctionInProgress = false;
    let analysisTerminalAssistant: Record<string, unknown> | undefined;
    let analysisErrorMessage: string | undefined;
    let baseConclusion = '';
    let correctedConclusion: string | undefined;
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
    const runProviderPrompt = async (prompt: string): Promise<void> => {
      await runPiProviderPromptWithSupervision({
        agent,
        prompt,
        providerIdle,
        executionLease,
        abortJoinTimeoutMs,
      });
    };
    const repairFinalReportDeterministically = async (input: {
      conclusion: string;
      errorIssues?: VerificationIssue[];
    }): Promise<string | undefined> => {
      const contractIssue = assessFinalReportContractCompleteness({
        conclusion: input.conclusion,
        query,
        sceneType: resolveFinalReportSceneType(),
      });
      const truncationIssue = findTruncationVerificationIssue(input.errorIssues ?? []);
      if (!truncationIssue && !contractIssue?.missingSections.length) return undefined;

      const repairedConclusion = repairTruncatedFinalReport({
        conclusion: input.conclusion,
        plan: prep.analysisPlan.current,
        hypotheses: prep.hypotheses,
        outputLanguage: prep.analysisRunSpec.outputLanguage,
        recoveryKind: truncationIssue ? 'truncation' : 'missing_contract',
        missingContractSections: contractIssue?.missingSections,
      });
      if (!repairedConclusion) return undefined;

      executionLease.throwIfAborted();
      const repairedIssues = await verifyPiAgentCoreConclusionForCorrection({
        conclusion: repairedConclusion,
        plan: prep.analysisPlan.current,
        hypotheses: prep.hypotheses,
        sceneType: resolveFinalReportSceneType(),
        outputLanguage: prep.analysisRunSpec.outputLanguage,
        query,
        allowPersistentLearning: !privateAnalysisContext,
        comparisonIdentity: prep.comparisonIdentity,
      });
      executionLease.throwIfAborted();
      if (repairedIssues.some(issue => issue.severity === 'error')) return undefined;

      this.emit('update', {
        type: 'progress',
        content: {
          phase: 'concluding',
          message: localize(
            prep.analysisRunSpec.outputLanguage,
            truncationIssue
              ? '最终报告输出被截断，已先基于结构化证据本地补齐并重新验证。'
              : '最终报告缺少必需结构，已先基于完成阶段的证据本地补齐并重新验证。',
            truncationIssue
              ? 'The final report output was truncated; it was locally closed from structured evidence and re-verified first.'
              : 'The final report missed required structure; it was locally completed from finished-phase evidence and re-verified first.',
          ),
        },
        timestamp: Date.now(),
      });
      return repairedConclusion;
    };
    let acceptingProviderEvents = true;
    const unsubscribe = agent.subscribe((event) => {
      if (!acceptingProviderEvents || executionLease.signal.aborted) return;
      providerIdle.onEvent(event);
      if (event.type === 'turn_end') rounds++;
      if (event.type === 'done') {
        recordEvaluationTokenDeltaIfPresent(event.message);
      }
      const update = projectPiAgentCoreEventToStreamingUpdate(event);
      if (correctionInProgress && update?.type === 'error') return;
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
          mode: prep.quickMode ? 'fast' : 'full',
          toolCount: prep.tools.length,
          message: this.selection.kind === PI_AGENT_CORE_RUNTIME_KIND
            ? 'Pi agent-core SmartPerfetto analysis started'
            : 'Hidden experimental Pi agent-core SmartPerfetto analysis started',
          source: this.selection.source,
        },
        timestamp: Date.now(),
      });
      commitEvaluationSdkHandoffIfActive();
      executionLease.throwIfAborted();
      const providerPhase = runtimePerformance.startPhase('provider');
      try {
        await runProviderPrompt(prep.prompt);
        executionLease.throwIfAborted();
        while (!prep.quickMode) {
        const latestAssistant = latestAssistantMessage(currentAnalysisMessages());
        const stopReason = typeof latestAssistant?.stopReason === 'string'
          ? latestAssistant.stopReason
          : undefined;
        const errorMessage = typeof latestAssistant?.errorMessage === 'string'
          ? latestAssistant.errorMessage
          : agent.state.errorMessage;
        if (stopReason === 'error' || stopReason === 'aborted' || errorMessage) break;

        const candidateMessages = lastPlanCompletionMessageBoundary === undefined
          ? currentAnalysisMessages()
          : (agent.state.messages ?? []).slice(lastPlanCompletionMessageBoundary);
        const candidateConclusion = sanitizePiAgentCoreConclusionText(
          selectAssistantConclusion(candidateMessages),
        );
        const closedFinalPhase = completePiAgentCoreFinalReportPhaseIfDelivered(
          prep.analysisPlan.current,
          candidateConclusion,
          prep.analysisRunSpec.outputLanguage,
        );
        if (closedFinalPhase) {
          this.emit('update', {
            type: 'plan_phase_updated',
            content: {
              phaseId: closedFinalPhase.id,
              status: closedFinalPhase.status,
              summary: closedFinalPhase.summary,
              phaseName: closedFinalPhase.name,
            },
            timestamp: Date.now(),
          });
        }

        const planStatus = getPiAgentCorePlanCompletionStatus(prep.analysisPlan.current);
        const unresolvedHypotheses = prep.hypotheses.filter(
          hypothesis => hypothesis.status === 'formed',
        );
        if (planStatus.complete && lastPlanCompletionMessageBoundary !== undefined) {
          forceFinalReportContinuation = !(
            hasDeliverableFinalReportHeading(candidateConclusion) &&
            looksLikeFinalReport(candidateConclusion)
          );
        }
        const continuePlan = !planStatus.complete &&
          planCompletionContinuations < PI_AGENT_CORE_MAX_PLAN_COMPLETION_CONTINUATIONS;
        const resolveHypotheses = planStatus.complete &&
          unresolvedHypotheses.length > 0 &&
          hypothesisResolutionContinuations < PI_AGENT_CORE_MAX_HYPOTHESIS_RESOLUTION_CONTINUATIONS;
        if (!continuePlan && !resolveHypotheses) {
          break;
        }

        if (continuePlan) {
          planCompletionContinuations++;
        } else {
          hypothesisResolutionContinuations++;
        }
        this.emit('update', {
          type: 'progress',
          content: {
            module: 'pi-agent-core',
            message: localize(
              prep.analysisRunSpec.outputLanguage,
              continuePlan
                ? '分析 plan 尚未闭合，正在继续补齐未完成阶段和必需证据。'
                : '分析 plan 已闭合，正在用已有证据处理尚未判定的假设。',
              continuePlan
                ? 'The analysis plan is still open; continuing the pending phases and required evidence.'
                : 'The analysis plan is complete; resolving the remaining hypotheses against existing evidence.',
            ),
          },
          timestamp: Date.now(),
        });
        commitEvaluationSdkHandoffIfActive();
        lastPlanCompletionMessageBoundary = agent.state.messages?.length ?? 0;
        executionLease.throwIfAborted();
          await runProviderPrompt(loadRuntimePlanCompletionContinuationPrompt({
          planStatus,
          unresolvedHypotheses,
          outputLanguage: prep.analysisRunSpec.outputLanguage,
          }));
          executionLease.throwIfAborted();
        }
        while (finalReportContinuations < PI_AGENT_CORE_MAX_FINAL_REPORT_CONTINUATIONS) {
        const latestAssistant = latestAssistantMessage(currentAnalysisMessages());
        const stopReason = typeof latestAssistant?.stopReason === 'string'
          ? latestAssistant.stopReason
          : undefined;
        const errorMessage = typeof latestAssistant?.errorMessage === 'string'
          ? latestAssistant.errorMessage
          : agent.state.errorMessage;
        if (stopReason === 'error' || stopReason === 'aborted' || errorMessage) break;

        const candidateConclusion = sanitizePiAgentCoreConclusionText(
          selectAssistantConclusion(currentAnalysisMessages()),
        );
        const planStatus = getPiAgentCorePlanCompletionStatus(prep.analysisPlan.current);
        if (planStatus.complete && candidateConclusion) {
          correctedConclusion = await repairFinalReportDeterministically({
            conclusion: candidateConclusion,
          });
          if (correctedConclusion) {
            forceFinalReportContinuation = false;
            break;
          }
        }
        const shouldContinueFinalReport = forceFinalReportContinuation ||
          shouldContinuePiAgentCoreFinalReportAfterPlanComplete({
          quickMode: prep.quickMode,
          planStatus,
          finalReportContinuations,
          conclusion: candidateConclusion,
          query,
          sceneType: resolveFinalReportSceneType(),
          comparisonIdentity: prep.comparisonIdentity,
        });
        if (!shouldContinueFinalReport) {
          break;
        }

        forceFinalReportContinuation = false;
        finalReportContinuations++;
        this.emit('update', {
          type: 'progress',
          content: {
            module: 'pi-agent-core',
            message: localize(
              prep.analysisRunSpec.outputLanguage,
              '最终报告仍需补齐 Final Report Contract，继续整理完整结论。',
              'The final report still needs Final Report Contract completion; continuing to assemble the full conclusion.',
            ),
          },
          timestamp: Date.now(),
        });
        commitEvaluationSdkHandoffIfActive();
        finalReportContinuationMessageBoundary = agent.state.messages?.length ?? 0;
        executionLease.throwIfAborted();
          await runProviderPrompt(loadPiFinalReportContinuationPrompt(prep.analysisRunSpec.outputLanguage));
          executionLease.throwIfAborted();
        }
        providerPhase.end('ok');
      } catch (error) {
        providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }

      analysisTerminalAssistant = latestAssistantMessage(currentAnalysisMessages());
      const analysisStopReason = typeof analysisTerminalAssistant?.stopReason === 'string'
        ? analysisTerminalAssistant.stopReason
        : undefined;
      analysisErrorMessage = typeof analysisTerminalAssistant?.errorMessage === 'string'
        ? analysisTerminalAssistant.errorMessage
        : agent.state.errorMessage;
      const conclusionCandidateMessages = finalReportContinuationMessageBoundary === undefined
        ? currentAnalysisMessages()
        : (agent.state.messages ?? []).slice(finalReportContinuationMessageBoundary);
      baseConclusion = sanitizePiAgentCoreConclusionText(
        selectAssistantConclusion(conclusionCandidateMessages) ||
        'Pi Agent Core runtime completed without assistant text.',
      );

      if (analysisStopReason !== 'error' && analysisStopReason !== 'aborted' && !analysisErrorMessage) {
        const closedFinalPhase = completePiAgentCoreFinalReportPhaseIfDelivered(
          prep.analysisPlan.current,
          baseConclusion,
          prep.analysisRunSpec.outputLanguage,
        );
        if (closedFinalPhase) {
          this.emit('update', {
            type: 'plan_phase_updated',
            content: {
              phaseId: closedFinalPhase.id,
              status: closedFinalPhase.status,
              summary: closedFinalPhase.summary,
              phaseName: closedFinalPhase.name,
            },
            timestamp: Date.now(),
          });
        }

        const correctionPlanStatus = getPiAgentCorePlanCompletionStatus(prep.analysisPlan.current);
        if (!correctedConclusion && !prep.quickMode && correctionPlanStatus.complete) {
          executionLease.throwIfAborted();
          const heuristicIssues = await verifyPiAgentCoreConclusionForCorrection({
            conclusion: baseConclusion,
            plan: prep.analysisPlan.current,
            hypotheses: prep.hypotheses,
            sceneType: resolveFinalReportSceneType(),
            outputLanguage: prep.analysisRunSpec.outputLanguage,
            query,
            allowPersistentLearning: !privateAnalysisContext,
            comparisonIdentity: prep.comparisonIdentity,
          });
          executionLease.throwIfAborted();
          const errorIssues = heuristicIssues.filter(issue => issue.severity === 'error');
          correctedConclusion = await repairFinalReportDeterministically({
            conclusion: baseConclusion,
            errorIssues,
          });
          const shouldCorrect = !correctedConclusion && errorIssues.length > 0;
          if (shouldCorrect) {
            this.emit('update', {
              type: 'progress',
              content: {
                phase: 'concluding',
                message: localize(
                  prep.analysisRunSpec.outputLanguage,
                  '最终报告证据绑定仍需补齐，正在基于已收集证据自动修订一次。',
                  'The final report still needs evidence binding; applying one correction from collected evidence.',
                ),
              },
              timestamp: Date.now(),
            });

            const originalTools = agent.state.tools;
            const originalSystemPrompt = agent.state.systemPrompt;
            const originalStateError = agent.state.errorMessage;
            const correctionMessageBoundary = agent.state.messages?.length ?? 0;
            try {
              correctionInProgress = true;
              agent.state.tools = [];
              agent.state.systemPrompt = loadPiFinalReportCorrectionSystemPrompt(
                prep.analysisRunSpec.outputLanguage,
              );
              commitEvaluationSdkHandoffIfActive();
              executionLease.throwIfAborted();
              const correctionPhase = runtimePerformance.startPhase('correction');
              try {
                await runProviderPrompt(generateCorrectionPrompt(
                  heuristicIssues,
                  baseConclusion,
                  prep.analysisRunSpec.outputLanguage,
                  resolveFinalReportSceneType(),
                ));
                correctionPhase.end('ok');
              } catch (error) {
                correctionPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
                throw error;
              }
              executionLease.throwIfAborted();

              const correctionMessages = (agent.state.messages ?? [])
                .slice(correctionMessageBoundary);
              const correctionAssistant = latestAssistantMessage(correctionMessages);
              const correctionStopReason = typeof correctionAssistant?.stopReason === 'string'
                ? correctionAssistant.stopReason
                : undefined;
              const correctionErrorMessage = typeof correctionAssistant?.errorMessage === 'string'
                ? correctionAssistant.errorMessage
                : agent.state.errorMessage;
              if (
                correctionStopReason !== 'error' &&
                correctionStopReason !== 'aborted' &&
                !correctionErrorMessage
              ) {
                const candidate = sanitizePiAgentCoreConclusionText(
                  selectAssistantConclusion(correctionMessages),
                );
                if (candidate && hasDeliverableFinalReportHeading(candidate)) {
                  executionLease.throwIfAborted();
                  const candidateIssues = await verifyPiAgentCoreConclusionForCorrection({
                    conclusion: candidate,
                    plan: prep.analysisPlan.current,
                    hypotheses: prep.hypotheses,
                    sceneType: resolveFinalReportSceneType(),
                    outputLanguage: prep.analysisRunSpec.outputLanguage,
                    query,
                    allowPersistentLearning: !privateAnalysisContext,
                    comparisonIdentity: prep.comparisonIdentity,
                  });
                  executionLease.throwIfAborted();
                  if (!candidateIssues.some(issue => issue.severity === 'error')) {
                    correctedConclusion = candidate;
                  }
                }
              }
            } catch {
              console.warn('[PiAgentCoreRuntime] Final report correction failed; keeping original report.');
            } finally {
              agent.state.tools = originalTools;
              agent.state.systemPrompt = originalSystemPrompt;
              agent.state.errorMessage = originalStateError;
              correctionInProgress = false;
            }
          }
        }
      }
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

    const latestAssistant = analysisTerminalAssistant ?? latestAssistantMessage(currentAnalysisMessages());
    const stopReason = typeof latestAssistant?.stopReason === 'string'
      ? latestAssistant.stopReason
      : undefined;
    const errorMessage = typeof latestAssistant?.errorMessage === 'string'
      ? latestAssistant.errorMessage
      : analysisErrorMessage;
    if (stopReason === 'error' || stopReason === 'aborted' || errorMessage) {
      return finalizeSourceAwareAnalysisResult({
        sessionId,
        success: false,
        findings: [],
        hypotheses: prep.hypotheses.map(h => toRuntimeProtocolHypothesis(h, 'pi-agent-core')),
        conclusion: errorMessage || 'Pi Agent Core analysis failed.',
        confidence: 0,
        rounds: Math.max(rounds, 1),
        totalDurationMs: Date.now() - startedAt,
        terminationReason: stopReason === 'aborted' || executionLease.signal.aborted ? 'timeout' : 'execution_error',
        terminationMessage: errorMessage || (executionLease.signal.aborted
          ? 'Pi Agent Core analysis aborted.'
          : 'Pi Agent Core reported an execution error.'),
      }, prep.sourceUse);
    }

    const fallbackConclusionMessages = finalReportContinuationMessageBoundary === undefined
      ? currentAnalysisMessages()
      : (agent.state.messages ?? []).slice(finalReportContinuationMessageBoundary);
    let conclusion = correctedConclusion || baseConclusion || sanitizePiAgentCoreConclusionText(
      selectAssistantConclusion(fallbackConclusionMessages) ||
      'Pi Agent Core runtime completed without assistant text.',
    );
    if (analysisContextUsesPrivateKnowledge(options)) {
      conclusion = sanitizeCodeAwareText(sessionId, conclusion);
    }
    conclusion = completeFinalReportCodeReferences({
      plan: prep.analysisPlan.current,
      conclusion,
      outputLanguage: prep.analysisRunSpec.outputLanguage,
    });

    const planStatus = getPiAgentCorePlanCompletionStatus(prep.analysisPlan.current);
    let partial = false;
    let terminationReason: AnalysisResult['terminationReason'];
    let terminationMessage: string | undefined;
    if (!prep.quickMode && !planStatus.complete) {
      partial = true;
      terminationReason = 'plan_incomplete';
      terminationMessage = formatIncompletePlanMessage(planStatus, prep.analysisRunSpec.outputLanguage);
    } else if (stopReason === 'length') {
      partial = true;
      terminationReason = 'max_turns';
      terminationMessage = 'Pi Agent Core model stopped because the response reached its length limit.';
    }

    const findings = extractFindingsFromText(conclusion);
    const result: AnalysisResult = {
      sessionId,
      success: true,
      findings,
      hypotheses: prep.hypotheses.map(h => toRuntimeProtocolHypothesis(h, 'pi-agent-core')),
      conclusion,
      confidence: estimateConfidence(findings, partial),
      rounds: Math.max(rounds, 1),
      totalDurationMs: Date.now() - startedAt,
      partial: partial || undefined,
      terminationReason,
      terminationMessage,
      quickRun: prep.quickMode
        ? (() => {
            const quickBudget = resolveQuickTurnBudget({
              env: this.env,
              targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS'],
              hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS'],
              enforcement: 'timeout_only',
            });
            return buildQuickRunReceipt({
              requestedMode: options.analysisMode ?? 'auto',
              profile: shouldMarkQuickRunTriage(query) ? 'triage' : undefined,
              budget: quickBudget,
              actualTurns: Math.max(rounds, 1),
              elapsedMs: Date.now() - startedAt,
              stopReason: quickStopReasonFromTermination({
                partial,
                terminationReason,
                actualTurns: Math.max(rounds, 1),
                targetTurns: quickBudget.targetTurns,
                hardCapTurns: quickBudget.hardCapTurns,
              }),
              evidence: {
                frontendPrequeryInjected: prep.analysisRunSpec.traceContext.datasetCount,
              },
              contextInjected: {
                conversationTurns: countCompletedQuickConversationTurns(prep.previousTurns),
                ...(prep.quickMemoryContextCounts ?? {
                  recentSqlResults: 0,
                  sqlPitfallPairs: 0,
                  patternHints: 0,
                  negativePatternHints: 0,
                  caseBackgroundCases: 0,
                }),
              },
              adaptiveRouting: prep.analysisRunSpec.mode.adaptiveRouting,
            });
          })()
        : undefined,
    };

    if (!prep.quickMode) {
      const finalReportSceneType = resolveFinalReportSceneType();
      const verifyCurrentConclusion = async () => {
        result.conclusion = completeFinalReportCodeReferences({
          plan: prep.analysisPlan.current,
          conclusion: result.conclusion,
          outputLanguage: prep.analysisRunSpec.outputLanguage,
        });
        result.findings = extractFindingsFromText(result.conclusion);
        return verifyConclusion(result.findings, result.conclusion, {
          emitUpdate: (update) => this.emit('update', update),
          enableLLM: false,
          plan: prep.analysisPlan.current,
          hypotheses: prep.hypotheses,
          sceneType: finalReportSceneType,
          outputLanguage: prep.analysisRunSpec.outputLanguage,
          query,
          emitIssueProgress: false,
          allowPersistentLearning: !analysisContextUsesPrivateKnowledge(options),
        });
      };
      executionLease.throwIfAborted();
      const verificationPhase = runtimePerformance.startPhase('verification');
      let verification: Awaited<ReturnType<typeof verifyCurrentConclusion>>;
      try {
        verification = await verifyCurrentConclusion();
        verificationPhase.end('ok');
      } catch (error) {
        verificationPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
      executionLease.throwIfAborted();
      let verificationIssue = [
        ...verification.heuristicIssues,
        ...(verification.llmIssues || []),
      ].find(issue => issue.severity === 'error');
      const contractIssue = assessFinalReportContractCompleteness({
        conclusion: result.conclusion,
        query,
        sceneType: finalReportSceneType,
        caseRecommendations: result.conclusionContract?.caseRecommendations,
      });
      const truncationIssue = findTruncationVerificationIssue([
        ...verification.heuristicIssues,
        ...(verification.llmIssues || []),
      ].filter(issue => issue.severity === 'error'));
      if (
        verificationIssue &&
        (truncationIssue || Boolean(contractIssue?.missingSections.length)) &&
        planStatus.complete
      ) {
        const repairedConclusion = repairTruncatedFinalReport({
          conclusion: result.conclusion,
          plan: prep.analysisPlan.current,
          hypotheses: prep.hypotheses,
          outputLanguage: prep.analysisRunSpec.outputLanguage,
          recoveryKind: truncationIssue ? 'truncation' : 'missing_contract',
          missingContractSections: contractIssue?.missingSections,
        });
        if (repairedConclusion) {
          const preRecoveryConfidence = result.confidence;
          result.conclusion = repairedConclusion;
          result.findings = extractFindingsFromText(repairedConclusion);
          result.confidence = Math.min(
            preRecoveryConfidence,
            estimateConfidence(result.findings, Boolean(result.partial)),
          );
          this.emit('update', {
            type: 'progress',
            content: {
              phase: 'concluding',
              message: localize(
                prep.analysisRunSpec.outputLanguage,
                truncationIssue
                  ? '最终报告输出被截断，已基于结构化证据补齐收尾并重新验证。'
                  : '最终报告缺少必需结构，已基于完成阶段的证据补齐并重新验证。',
                truncationIssue
                  ? 'The final report output was truncated; it was closed from structured evidence and re-verified.'
                  : 'The final report missed required structure; it was completed from finished-phase evidence and re-verified.',
              ),
            },
            timestamp: Date.now(),
          });
          executionLease.throwIfAborted();
          const recoveryVerificationPhase = runtimePerformance.startPhase('verification');
          try {
            verification = await verifyCurrentConclusion();
            recoveryVerificationPhase.end('ok');
          } catch (error) {
            recoveryVerificationPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
            throw error;
          }
          executionLease.throwIfAborted();
          verificationIssue = [
            ...verification.heuristicIssues,
            ...(verification.llmIssues || []),
          ].find(issue => issue.severity === 'error');
        }
      }
      if (verificationIssue) {
        result.partial = true;
        result.terminationReason = result.terminationReason ?? 'plan_incomplete';
        result.terminationMessage = result.terminationMessage ?? verificationIssue.message;
        result.confidence = Math.min(0.55, result.confidence);
        this.emit('update', {
          type: 'degraded',
          content: {
            module: 'piAgentCoreRuntime',
            fallback: 'verification_failed',
            partial: true,
            terminationReason: result.terminationReason,
            message: verificationIssue.message,
          },
          timestamp: Date.now(),
        });
      }
    }

    finalizeSourceAwareAnalysisResult(result, prep.sourceUse);
    const wasPartialBeforeQualityGate = result.partial === true;
    const gateIssue = applyFinalResultQualityGate({
      result,
      query,
      sceneType: resolveFinalReportSceneType(),
      comparisonIdentity: prep.comparisonIdentity,
    });
    if (gateIssue && !wasPartialBeforeQualityGate) {
      result.confidence = estimateConfidence(result.findings, true);
      this.emit('update', {
        type: 'degraded',
        content: {
          module: 'piAgentCoreRuntime',
          fallback: gateIssue.code,
          message: gateIssue.message,
          partial: true,
        },
        timestamp: Date.now(),
      });
    }

    executionLease.throwIfAborted();
    prep.sessionContext.addTurn(
      query,
      {
        primaryGoal: query,
        aspects: [],
        expectedOutputType: 'diagnosis',
        complexity: prep.quickMode ? 'simple' : 'complex',
        followUpType: prep.previousTurns.length > 0 ? 'extend' : 'initial',
      },
      {
        agentId: 'pi-agent-core',
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

    return result;
  }

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
    executionLease: RuntimeExecutionLease;
    runtimePerformance: RuntimePerformanceRun;
  }): AnalysisResult {
    const quickBudget = resolveQuickTurnBudget({
      env: this.env,
      targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS'],
      hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS'],
      enforcement: 'timeout_only',
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
      emitUpdate: update => this.emit('update', update),
      module: 'piAgentCoreRuntime',
      result,
      query: input.query,
      sceneType: input.sceneType,
    });
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
        agentId: 'pi-agent-core',
        success: result.success,
        findings: result.findings,
        confidence: result.confidence,
        message: result.conclusion,
      },
      result.findings,
    );
    input.executionLease.throwIfAborted();
    input.runtimePerformance.recordFirstOutput();
    emitQuickDirectAnswerEvents({
      emitUpdate: update => this.emit('update', update),
      result,
      startedAt: input.startedAt,
      outputLanguage: input.outputLanguage,
      runtime: this.selection.kind,
      model: 'runtime-pre-evidence',
    });
    return result;
  }

  private buildDirectQuickAcknowledgementResult(input: {
    query: string;
    sessionId: string;
    options: AnalysisOptions;
    startedAt: number;
    sceneType: SceneType;
    outputLanguage: OutputLanguage;
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
    previousTurns: ConversationTurn[];
    analysisRunSpec: AnalysisRunSpec;
    executionLease: RuntimeExecutionLease;
    runtimePerformance: RuntimePerformanceRun;
  }): AnalysisResult {
    const quickBudget = resolveQuickTurnBudget({
      env: this.env,
      targetEnvKeys: ['AGENT_QUICK_TARGET_TURNS'],
      hardCapEnvKeys: ['AGENT_QUICK_MAX_TURNS'],
      enforcement: 'timeout_only',
    });
    const result = buildQuickDirectAcknowledgementAnalysisResult({
      sessionId: input.sessionId,
      options: input.options,
      outputLanguage: input.outputLanguage,
      startedAt: input.startedAt,
      analysisRunSpec: input.analysisRunSpec,
      budget: quickBudget,
      previousTurns: input.previousTurns,
    });
    emitQuickDirectQualityGateIssue({
      emitUpdate: update => this.emit('update', update),
      module: 'piAgentCoreRuntime',
      result,
      query: input.query,
      sceneType: input.sceneType,
    });
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
        agentId: 'pi-agent-core',
        success: result.success,
        findings: result.findings,
        confidence: result.confidence,
        message: result.conclusion,
      },
      result.findings,
    );
    input.executionLease.throwIfAborted();
    input.runtimePerformance.recordFirstOutput();
    emitQuickDirectAnswerEvents({
      emitUpdate: update => this.emit('update', update),
      result,
      startedAt: input.startedAt,
      outputLanguage: input.outputLanguage,
      runtime: this.selection.kind,
      model: 'runtime-acknowledgement',
    });
    return result;
  }

  private async prepareAnalysis(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    model: string | undefined,
    executionLease: RuntimeExecutionLease,
    quickEvidenceAttempt?: RuntimeQuickEvidenceAttempt,
  ): Promise<PiAnalysisPreparation> {
    executionLease.throwIfAborted();
    const outputLanguage = options.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const sceneType = classifyScene(query);
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() || [];
    const quickResolution = resolveRuntimeQuickMode({
      query,
      sceneType,
      analysisMode: options.analysisMode,
      conversationSurface: options.assistantSurface === 'conversation',
      selectionContext: options.selectionContext,
      packageName: options.packageName,
      hasReferenceTrace: Boolean(options.referenceTraceId),
      previousTurns,
    });
    const quickMode = quickResolution.quickMode;
    const focusResult = quickEvidenceAttempt?.focusResult ?? (quickResolution.skipFocusDetection
      ? { apps: [], method: 'none' as const }
      : await detectFocusApps(this.traceProcessorService, traceId, {
          timeRange: focusAppTimeRangeFromSelection(options.selectionContext),
        }));
    executionLease.throwIfAborted();
    const effectivePackageName = options.packageName
      || quickEvidenceAttempt?.effectivePackageName
      || focusResult.primaryApp;
    const analysisRunSpec = createAnalysisRunSpec({
      query,
      sessionId,
      traceId,
      options,
      runtimeSelection: this.selection,
      engineCapabilities: getPiAgentCoreEngineCapabilities(this.selection.kind),
      sceneType,
      outputLanguage,
      resolvedMode: quickMode ? 'quick' : 'full',
      budget: {model},
      adaptiveRouting: buildAdaptiveRoutingForQuickResolution({
        options,
        resolution: quickResolution,
      }),
    });

    await ensureSkillRegistryInitialized();
    executionLease.throwIfAborted();
    const skillExecutor = createSkillExecutor(this.traceProcessorService);
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    skillExecutor.registerSkills(effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(
      effectiveSkillRegistry.getFragmentCache(),
    );

    let architecture = getLruCacheEntry(this.architectureCache, traceId);
    if (!architecture && !quickResolution.skipTracePreflightDetection) {
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
    if (!quickMode) {
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

    const previousFindings = previousTurns
      .slice(-3)
      .flatMap(turn => turn.findings);
    const conversationSummary = previousTurns.length > 0
      ? sessionContext.generatePromptContext(2000)
      : undefined;
    const entityStore = sessionContext.getEntityStore();
    const entityContext = buildEntityContext(entityStore);

    const watchdogWarning: { current: string | null } = { current: null };
    const knowledgeScope = analysisRunSpec.scopes.knowledge;
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    const recentSqlErrors = loadLearnedSqlFixPairs(5, knowledgeScope, options);
    const skillNotesBudget = createRuntimeSkillNotesBudget(quickMode);
    const comparisonContext = await buildRuntimeTracePairComparisonContext({
      traceProcessorService: this.traceProcessorService,
      currentTraceId: traceId,
      ...(options.referenceTraceId ? { referenceTraceId: options.referenceTraceId } : {}),
      ...(options.tracePairContext ? { tracePairContext: options.tracePairContext } : {}),
    });
    executionLease.throwIfAborted();
    let knowledgeBaseContext: string | undefined;
    if (!quickMode) {
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

    if (!this.artifactStores.has(sessionId)) {
      this.artifactStores.set(sessionId, new ArtifactStore());
    }
    const artifactStore = this.artifactStores.get(sessionId)!;

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
    const previousPlan = analysisPlan.current ?? undefined;
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

    const { toolDefinitions, sourceUse } = createClaudeMcpServer({
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
      emitUpdate: (update) => this.emit('update', update),
      onSkillResult: (result) => {
        captureSkillDisplayEntities(result.displayResults, entityStore, 'pi-agent-core');
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      recentSqlErrors,
      analysisPlan: quickMode ? undefined : analysisPlan,
      watchdogWarning,
      hypotheses,
      sceneType,
      uncertaintyFlags,
      lightweight: quickMode,
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
        analysisPlan: quickMode ? undefined : analysisPlan,
      })
    ));

    let prompt = query;
    if (analysisRunSpec.traceContext.promptSection) {
      prompt = `${analysisRunSpec.traceContext.promptSection}\n\n${prompt}`;
    }
    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });

    if (quickMode) {
      const quickConversationContext = buildQuickConversationContext(previousTurns, outputLanguage);
      if (quickConversationContext) {
        prompt = `${quickConversationContext}\n\n${prompt}`;
      }
      const quickMemoryPayload = buildQuickMemoryContextPayload({
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
        sqlErrorFixPairs: recentSqlErrors,
        recentSqlResultsContext: sessionContext.generateRecentSqlResultPromptContext(3),
        outputLanguage,
      });
      const quickMemoryContext = quickMemoryPayload.text;
      return {
        systemPrompt: buildQuickSystemPrompt({
          architecture,
          packageName: effectivePackageName,
          focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
          focusMethod: focusResult.method,
          selectionContext: options.selectionContext,
          quickMemoryContext,
          outputLanguage,
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
        }),
        prompt,
        tools,
        allowedToolNames,
        quickMode,
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
        ...(comparisonContext ? {
          comparisonIdentity: {
            currentPackageName: effectivePackageName,
            referencePackageName: comparisonContext.referencePackageName,
          },
        } : {}),
        quickMemoryContextCounts: quickMemoryPayload.counts,
      };
    }

    const patternContext = privateAnalysisContext
      ? undefined
      : buildPatternContextSection(traceFeatures, knowledgeScope);
    const negativePatternContext = privateAnalysisContext
      ? undefined
      : buildNegativePatternSection(traceFeatures, knowledgeScope);
    const traceInfo = this.traceProcessorService.getTrace(traceId);
    const systemPromptEnv = normalizeOptionalString(this.env[PI_AGENT_CORE_SYSTEM_PROMPT_ENV]);
    const analysisContext: ClaudeAnalysisContext = {
      query,
      architecture,
      packageName: effectivePackageName,
      focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
      focusMethod: focusResult.method,
      previousFindings,
      conversationSummary,
      knowledgeBaseContext,
      entityContext,
      sceneType,
      analysisNotes: notes.length > 0 ? notes : undefined,
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
      caseBackgroundContext: buildRuntimeCaseBackgroundContext({
        sceneType,
        architectureType: architecture?.type,
        knowledgeScope,
        outputLanguage,
        privateAnalysisContext,
      }),
      previousPlan,
      planHistory: analysisPlan.history.length > 0 ? analysisPlan.history : undefined,
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
      ...(comparisonContext ? {
        comparisonIdentity: {
          currentPackageName: effectivePackageName,
          referencePackageName: comparisonContext.referencePackageName,
        },
      } : {}),
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
