// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import {
  Agent,
  MaxTurnsExceededError,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  type AgentInputItem,
  type RunStreamEvent,
} from '@openai/agents';
import OpenAI from 'openai';
import {
  commitEvaluationSdkHandoffIfActive,
  recordEvaluationTokenDeltaIfPresent,
} from '../../../services/selfEvolution/evaluationRuntimeHooks';

import type { TraceProcessorService } from '../../../services/traceProcessorService';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
import {resolveEffectiveSkillRegistryForRuntime} from '../../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import { getSkillAnalysisAdapter } from '../../../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import { sessionContextManager } from '../../../agent/context/enhancedSessionContext';
import type { ConversationTurn, StreamingUpdate, Finding } from '../../../agent/types';
import type { Hypothesis as ProtocolHypothesis } from '../../../agent/types/agentProtocol';
import type {
  AnalysisOptions,
  AnalysisResult,
  AnalysisTerminationReason,
  IOrchestrator,
} from '../../../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../../../agent/detectors/types';
import {
  createClaudeMcpServer,
  loadLearnedSqlFixPairs,
  MIN_PHASE_SUMMARY_CHARS,
} from '../../../agentv3/claudeMcpServer';
import {
  buildQuickSystemPrompt,
  buildSystemPrompt,
} from '../../../agentv3/claudeSystemPrompt';
import { loadPromptTemplate, renderTemplate } from '../../../agentv3/strategyLoader';
import { extractFindingsFromText } from '../../../agentv3/claudeFindingExtractor';
import {
  detectFocusApps,
  focusAppTimeRangeFromSelection,
  type FocusAppDetectionResult,
} from '../../../agentv3/focusAppDetector';
import { classifyScene, type SceneType } from '../../../agentv3/sceneClassifier';
import { getExtendedKnowledgeBase } from '../../../services/sqlKnowledgeBase';
import {resolveEffectiveAnalysisMode} from '../../../services/effectiveAnalysisMode';
import {
  analysisContextMemoryPartitionKey,
  analysisContextUsesPrivateKnowledge,
} from '../../../services/resolvedAnalysisContext';
import type {
  AnalysisNote,
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  ComplexityClassifierInput,
  Hypothesis,
  PlanPhase,
  TracePairContext,
  TraceCompleteness,
  UncertaintyFlag,
} from '../../../agentv3/types';
import { expectedToolNames } from '../../../agentv3/types';
import {
  formatPlanEvidenceGap,
  recordPlanOrPrePlanToolCall,
  resetPrePlanToolCallsForNewRun,
  type PlanEvidenceGap,
} from '../../../agentv3/planToolCallRecorder';
import {
  getAnalysisPlanCompletionStatus,
  hasAdequateClosedPhaseSummary as hasAdequateClosedPhaseSummaryWithMin,
  type AnalysisPlanCompletionStatus,
} from '../../../agentv3/planCompletionStatus';
import { isConclusionLikePlanPhase } from '../../../agentv3/planPhaseSemantics';
import {
  classifyQueryComplexityLocal,
  isAcknowledgementFollowupReason,
} from '../../../agentv3/queryComplexityClassifier';
import { buildComplexityClassifierInput } from '../../../agentv3/queryComplexityContext';
import { classifyQueryWithOpenAILightModel } from './openAiComplexityClassifier';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {
  createOpenAISnapshotEngineState,
  getOpenAISnapshotEngineState,
  projectSessionFieldsForDurableSnapshot,
  type SessionFieldsForSnapshot,
  sessionFieldsUsePrivateKnowledge,
  type SessionStateSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import {
  extractTraceFeatures,
  extractKeyInsights,
  saveAnalysisPattern,
  saveQuickPathPattern,
  promoteQuickPatternIfMatching,
  buildPatternContextSection,
  buildNegativePatternSection,
} from '../../../agentv3/analysisPatternMemory';
import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from '../../../agentv3/outputLanguage';
import {
  createCodeAwareStreamingTextProjection,
  sanitizeCodeAwareText,
  type CodeAwareStreamingTextProjection,
} from '../../../services/security/codeAwareOutputRegistry';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import { formatToolCallNarration } from '../../../agentv3/toolNarration';
import { loadOpenAIConfig, type OpenAIAgentConfig } from './openAiConfig';
import { buildOpenAIChatCompletionsTokenLimit } from '../../../services/providerManager/openAiChatCompletionsCompat';
import {
  createMimoReasoningContentFetch,
  shouldUseMimoReasoningContentCompat,
} from './mimoReasoningCompat';
import { createOpenAIToolsFromMcpDefinitions } from './openAiToolAdapter';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import {
  assessFinalResultComparisonIdentity,
  assessFinalResultQuality,
  applyFinalResultQualityGate,
  hasDeliverableFinalReportHeading,
  looksLikePhaseSummaryFallback,
  serializeFinalResultQualityIssueContext,
  type FinalResultComparisonIdentity,
  type FinalResultQualityIssue,
} from '../../../services/finalResultQualityGate';
import {
  findCriticalFindingsWithoutEvidence,
  verifyConclusion,
} from '../claude/claudeVerifier';
import {
  assessFinalReportContractCompleteness,
  type FinalReportContractCompletenessResult,
} from '../../../services/finalReportContractGate';
import {
  SDK_SESSION_FRESHNESS_MS,
  buildQuickRunReceipt,
  buildEntityContext,
  buildQuickConversationContext,
  buildQuickMemoryContextPayload,
  buildRuntimeSessionMapKey,
  captureSkillDisplayEntities,
  collectRecentFindings,
  createRuntimeSkillNotesBudget,
  findTruncationVerificationIssue,
  getLruCacheEntry,
  isFreshRuntimeEntry,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
  quickStopReasonFromTermination,
  resolveQuickTurnBudget,
  shouldMarkQuickRunTriage,
  repairTruncatedFinalReport,
  setLruCacheEntry,
  toProtocolHypothesis as toRuntimeProtocolHypothesis,
} from '../../runtimeCommon';
import {
  createAnalysisRunSpec,
  type AnalysisRunSpec,
} from '../../analysisRunSpec';
import {buildAdaptiveRoutingForModeDecision} from '../../adaptiveRoutingProjection';
import type { RuntimeSelection } from '../../runtimeSelection';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';
import { OPENAI_AGENT_RUNTIME_KIND } from '../../runtimeKinds';
import { resolveRuntimeFinalReportSceneType } from '../../finalReportSceneResolution';
import {reconcileDeliveredFinalReportPhase} from '../../finalReportPhaseReconciliation';
import { buildFocusAppEvidencePayload } from '../../focusAppEvidence';
import {
  completeFinalReportCodeReferences,
  finalReportMissingRequiredCodeReference,
  loadCodeReferenceContractPrompt,
} from '../../../services/codebase/codeReferenceContract';
import { extractSourceLookupCodeReferences } from '../../../services/codebase/sourceLookupTools';
import {finalizeSourceAwareAnalysisResult} from '../../../services/codebase/sourceClaimVerifier';
import { buildQuickProcessIdentityDirectAnswer } from '../../quickProcessIdentityDirectAnswer';
import {
  buildQuickProcessIdentityEvidence,
  createQuickProcessIdentitySkillExecutor,
  shouldUseEvidenceOnlyQuickAnalysis,
} from '../../quickProcessIdentityEvidence';
import { buildQuickTraceFactDirectAnswer } from '../../quickTraceFactDirectAnswer';
import {
  buildQuickTraceFactEvidence,
  joinRuntimeEvidenceContexts,
  shouldSkipFocusDetectionForQuickTraceFactEvidence,
  shouldUseTraceFactEvidenceOnlyQuickAnalysis,
} from '../../quickTraceFactEvidence';
import {
  buildRuntimeQuickEvidenceAttempt,
  selectReusableRuntimeQuickEvidenceAttempt,
  countRuntimeQuickEvidenceCitedRefs,
  sanitizeRuntimeQuickEvidenceRoutingContext,
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
import {
  deriveRuntimeQuickPreEvidenceFlags,
} from '../../quickModeResolution';
import {buildRuntimeTracePairComparisonContext} from '../../runtimePromptContext';
import {
  createResettableRuntimeTimeout,
  resolveFullRequestTimeoutMs,
  serializedByteLength,
  summarizeExternalToolResult,
  type RuntimeTimeoutKind,
} from '../../runtimeLimits';

interface OpenAISessionEntry {
  history?: AgentInputItem[];
  lastResponseId?: string;
  runState?: string;
  updatedAt: number;
}

type OpenAIAnalysisSessionState = {
  artifactStore: ArtifactStore;
  notes: AnalysisNote[];
  analysisPlan: { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] };
  previousPlan?: AnalysisPlanV3;
  hypotheses: Hypothesis[];
  uncertaintyFlags: UncertaintyFlag[];
};

interface OpenAIModeClassification {
  quickMode: boolean;
  source: 'user_explicit' | 'hard_rule' | 'ai';
  reason: string;
  skipQuickTracePreflightDetection: boolean;
  quickAcknowledgementDirectAnswer: boolean;
  quickFocusAppPreEvidence: boolean;
  quickProcessIdentityPreEvidence: boolean;
  quickTraceFactPreEvidence: boolean;
  quickScrollingTriagePreEvidence: boolean;
}

interface RuntimeAbortHandle {
  readonly aborted: boolean;
  abort(): void;
}

interface LinkedAbortController {
  controller: AbortController;
  dispose(): void;
}

class RuntimeAnalysisAbortScope implements RuntimeAbortHandle {
  private readonly controller = new AbortController();

  get aborted(): boolean {
    return this.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): void {
    if (this.signal.aborted) return;
    const error = new Error('Analysis aborted');
    error.name = 'AbortError';
    this.controller.abort(error);
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) return;
    if (this.signal.reason instanceof Error) throw this.signal.reason;
    const error = new Error('Analysis aborted');
    error.name = 'AbortError';
    throw error;
  }

  createLinkedController(): LinkedAbortController {
    const controller = new AbortController();
    const abortChild = () => controller.abort(this.signal.reason);
    if (this.signal.aborted) {
      abortChild();
    } else {
      this.signal.addEventListener('abort', abortChild, { once: true });
    }
    return {
      controller,
      dispose: () => this.signal.removeEventListener('abort', abortChild),
    };
  }
}

const OPENAI_SESSION_FRESHNESS_MS = SDK_SESSION_FRESHNESS_MS;
const OPENAI_MAX_PLAN_CONTINUATIONS = 3;
const OPENAI_MAX_FINAL_REPORT_CONTINUATIONS = 4;
const OPENAI_PLAN_COMPLETE_IDLE_ABORT_MS = 8_000;

type PlanCompletionStatus = AnalysisPlanCompletionStatus;

function hasAdequateClosedPhaseSummary(phase: PlanPhase): boolean {
  return hasAdequateClosedPhaseSummaryWithMin(phase, MIN_PHASE_SUMMARY_CHARS);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeToolOutput(value: unknown): string {
  return summarizeExternalToolResult(value);
}

function isAbortLikeError(error: unknown): boolean {
  const maybe = error as { name?: unknown; constructor?: { name?: string }; message?: unknown };
  const name = typeof maybe?.name === 'string' ? maybe.name : '';
  const constructorName = maybe?.constructor?.name || '';
  const message = typeof maybe?.message === 'string' ? maybe.message.toLowerCase() : '';
  return name === 'AbortError'
    || name === 'APIUserAbortError'
    || constructorName === 'APIUserAbortError'
    || message.includes('aborted')
    || message.includes('abort');
}

function isRecoverableOpenAIStreamTermination(error: unknown): boolean {
  const message = formatOpenAIError(error).trim().toLowerCase();
  if (!message) return false;
  return message === 'terminated'
    || message.includes('stream terminated')
    || message.includes('response terminated')
    || message.includes('connection terminated')
    || message.includes('socket hang up')
    || message.includes('econnreset');
}

function formatOpenAIError(error: unknown): string {
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

function compactProviderErrorMessage(error: unknown): string {
  const message = formatOpenAIError(error).trim();
  if (!/<html[\s>]|<\/html>|<body[\s>]|<\/body>|<h1[\s>]/i.test(message)) {
    return message;
  }

  const status = message.match(/\b([45]\d{2})\b/)?.[1];
  const heading = message.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || message.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || 'Provider returned an HTML error page';
  const text = heading
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return status ? `provider HTTP ${status}: ${text}` : `provider error: ${text}`;
}

function isMissingOpenAIPreviousResponseError(error: unknown, previousResponseId?: string): boolean {
  if (!previousResponseId) return false;
  const message = formatOpenAIError(error);
  const mentionsPreviousResponse = /previous[_\s-]?response|previousResponseId|previous_response_id|lastResponseId/i.test(message);
  const mentionsResponse = /response/i.test(message);
  const mentionsId = message.includes(previousResponseId);
  const isMissing = /not found|no .*found|does not exist|could not find|missing|expired|gone|404/i.test(message);

  return isMissing && (mentionsPreviousResponse || (mentionsResponse && mentionsId));
}

function readCompletedStreamFinalOutput(
  stream: { finalOutput: unknown },
  state: { streamCompleted: boolean; completedByPlanIdle: boolean; timedOut: boolean },
): unknown | undefined {
  if (!state.streamCompleted || state.completedByPlanIdle || state.timedOut) {
    return undefined;
  }
  return stream.finalOutput;
}

function readPlanEligibleStreamFinalOutput(
  stream: { finalOutput: unknown },
  state: {
    streamCompleted: boolean;
    completedByPlanIdle: boolean;
    timedOut: boolean;
    quickMode: boolean;
    planComplete: boolean;
  },
): unknown | undefined {
  const finalOutput = readCompletedStreamFinalOutput(stream, state);
  if (finalOutput === undefined) return undefined;
  return state.quickMode || state.planComplete ? finalOutput : undefined;
}

function stripOpenAiReasoningArtifacts(text: string, options: { preserveWhitespace?: boolean } = {}): string {
  const stripped = text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/?think>/gi, '');
  if (options.preserveWhitespace) return stripped;
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

interface OpenAiReasoningFilterState {
  insideThink: boolean;
  pendingTagPrefix: string;
}

function createOpenAiReasoningFilterState(): OpenAiReasoningFilterState {
  return {
    insideThink: false,
    pendingTagPrefix: '',
  };
}

function isReasoningTagPrefix(value: string): boolean {
  const lower = value.toLowerCase();
  return '<think>'.startsWith(lower) || '</think>'.startsWith(lower);
}

function filterOpenAiVisibleAnswerDelta(delta: string, state: OpenAiReasoningFilterState): string {
  const input = `${state.pendingTagPrefix}${delta}`;
  state.pendingTagPrefix = '';
  let output = '';
  let index = 0;

  while (index < input.length) {
    const remaining = input.slice(index);
    const lower = remaining.toLowerCase();
    if (lower.startsWith('<think>')) {
      state.insideThink = true;
      index += '<think>'.length;
      continue;
    }
    if (lower.startsWith('</think>')) {
      state.insideThink = false;
      index += '</think>'.length;
      continue;
    }
    if (remaining[0] === '<' && isReasoningTagPrefix(remaining)) {
      state.pendingTagPrefix = remaining;
      break;
    }
    if (!state.insideThink) {
      output += remaining[0];
    }
    index += 1;
  }

  return output;
}

function looksLikeProcessNarrationParagraph(paragraph: string): boolean {
  const compact = paragraph.trim().replace(/\s+/g, ' ');
  if (!compact) return false;
  return /^(?:我来|我需要|我将|我会|现在|接下来|下一步|首先[，,]?.*提交|调用\s*`?[\w-]+`?|记录关键发现|数据量充足|非常丰富的数据|让我|为了完成|I need\b|I will\b|Now I\b|Next\b|Let me\b)/i.test(compact)
    || /现在进入\s*Phase|Phase\s*\d+(?:\.\d+)?.*返回|关键概览|阶段状态更新|执行剩余阶段|继续执行剩余阶段|update_plan_phase|submit_plan|resolve_hypothesis|provider 未主动结束 stream|plan 未完成|plan 已完成/i.test(compact);
}

function hasReportMarkers(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,3}\s+\S/.test(text)
    || /(^|\n)\s{0,3}\*\*[^*\n]{2,80}\*\*/.test(text)
    || /(^|\n)\s{0,3}\|/.test(text);
}

function normalizeConclusionForComparison(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isSameConclusionText(a: string | undefined, b: string | undefined): boolean {
  const normalizedA = normalizeConclusionForComparison(a || '');
  const normalizedB = normalizeConclusionForComparison(b || '');
  return normalizedA.length > 0 && normalizedA === normalizedB;
}

function cleanPlanSummaryForFinalReport(summary: string): string {
  return summary
    .trim()
    .replace(/^(?:完成综合结论输出|完整结构化报告已(?:输出|生成))[。:：\s]*/i, '')
    .replace(/^核心发现[：:\s]*/i, '')
    .replace(/^所有关键artifact已在Phase\s*\d+(?:\.\d+)?中获取完毕[：:。\s]*/i, '')
    .trim();
}

function isSubstantialReportText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200 || !hasDeliverableFinalReportHeading(trimmed)) return false;
  if (looksLikeProcessNarrationParagraph(trimmed)) return false;
  return !looksLikeProcessNarrationParagraph(trimmed.split(/\n{2,}/)[0] || '');
}

function isRicherReportCandidate(candidate: string, baseline: string): boolean {
  const candidateTrimmed = candidate.trim();
  const baselineTrimmed = baseline.trim();
  if (!isSubstantialReportText(candidateTrimmed)) return false;
  if (!baselineTrimmed || !isSubstantialReportText(baselineTrimmed)) return true;
  return candidateTrimmed.length > Math.max(200, baselineTrimmed.length * 1.25);
}

function selectOpenAiRecoveryAnswer(input: {
  runAnswer: string;
  accumulatedAnswer: string;
}): string {
  return input.runAnswer.trim() ? input.runAnswer : input.accumulatedAnswer;
}

function findEmbeddedFinalReportStart(text: string): number {
  const match = /#{1,3}\s*(?:[\w\u4e00-\u9fff` .:：_-]{0,40})?(?:分析报告|综合结论|最终结论|最终报告|Final Report|Analysis Report)(?=\s|$|[：:。.!！?\n])/i.exec(text);
  return match?.index ?? -1;
}

function looksLikeProcessNarrationPrefix(prefix: string): boolean {
  const compact = prefix.trim().replace(/\s+/g, ' ');
  if (!compact) return false;
  return /(?:我需要|我将|我会|让我|接下来|下一步|根据\s*Phase|Phase\s*\d+(?:\.\d+)?\s*要求|更新计划|执行深钻|提交分析计划|调用\s*`?[\w-]+`?|update_plan_phase|submit_plan|plan\s*(?:未完成|已完成|phase))/i
    .test(compact);
}

function sanitizeOpenAiConclusionText(
  conclusion: string,
  options: {
    completedByPlanIdle?: boolean;
    planComplete?: boolean;
    fallbackConclusion?: string;
  } = {},
): string {
  const trimmed = stripOpenAiReasoningArtifacts(conclusion);
  const fallback = options.fallbackConclusion
    ? stripOpenAiReasoningArtifacts(options.fallbackConclusion)
    : undefined;
  if (!trimmed) return fallback || '';

  const embeddedReportStart = findEmbeddedFinalReportStart(trimmed);
  if (embeddedReportStart > 0) {
    const prefix = trimmed.slice(0, embeddedReportStart);
    const report = trimmed.slice(embeddedReportStart).trim();
    if (
      report.length >= 80 &&
      hasReportMarkers(report) &&
      looksLikeProcessNarrationPrefix(prefix)
    ) {
      return report;
    }
  }

  const paragraphs = trimmed.split(/\n{2,}/);
  let firstReportParagraph = 0;
  while (
    firstReportParagraph < paragraphs.length &&
    looksLikeProcessNarrationParagraph(paragraphs[firstReportParagraph])
  ) {
    firstReportParagraph++;
  }

  const stripped = firstReportParagraph > 0
    ? paragraphs.slice(firstReportParagraph).join('\n\n').trim()
    : trimmed;
  const strippedStillProcess = looksLikeProcessNarrationParagraph(stripped.split(/\n{2,}/)[0] || '');
  const strippedHasProcessNarration = looksLikeProcessNarrationParagraph(stripped);
  if (firstReportParagraph > 0 && stripped.length >= 80 && !strippedStillProcess && !strippedHasProcessNarration) {
    return stripped;
  }

  if (
    fallback &&
    (options.completedByPlanIdle || options.planComplete) &&
    (firstReportParagraph > 0 || strippedStillProcess || strippedHasProcessNarration || !hasReportMarkers(trimmed))
  ) {
    return fallback;
  }

  return trimmed;
}

function chooseOpenAiConclusionText(input: {
  candidate: string;
  accumulatedAnswer: string;
  completedByPlanIdle?: boolean;
  planComplete?: boolean;
  fallbackConclusion?: string;
}): string {
  const selected = sanitizeOpenAiConclusionText(input.candidate, {
    completedByPlanIdle: input.completedByPlanIdle,
    planComplete: input.planComplete,
    fallbackConclusion: input.fallbackConclusion,
  });
  const fallback = input.fallbackConclusion?.trim();
  const accumulated = input.accumulatedAnswer.trim();
  const selectedIsFallback = fallback ? isSameConclusionText(selected, fallback) : false;
  const selectedNeedsRecovery =
    selectedIsFallback ||
    looksLikePhaseSummaryFallback(selected) ||
    !isSubstantialReportText(selected) ||
    looksLikeProcessNarrationParagraph(selected.split(/\n{2,}/)[0] || '');
  const mayRecoverAccumulated =
    accumulated.length > 0 &&
    !isSameConclusionText(accumulated, input.candidate) &&
    (input.completedByPlanIdle || (input.planComplete && selectedNeedsRecovery));
  if (!mayRecoverAccumulated) return selected;

  const recovered = sanitizeOpenAiConclusionText(accumulated, {
    completedByPlanIdle: input.completedByPlanIdle,
    planComplete: input.planComplete,
    fallbackConclusion: input.fallbackConclusion,
  });

  if (isRicherReportCandidate(recovered, selected)) {
    return recovered;
  }
  if (hasDeliverableFinalReportHeading(recovered) && recovered.length > Math.max(200, selected.length * 1.25)) {
    return recovered;
  }
  if (fallback && selectedIsFallback && hasDeliverableFinalReportHeading(recovered) && recovered.length > selected.length) {
    return recovered;
  }
  return selected;
}

interface OpenAIRunInputResolution {
  input: string | AgentInputItem[];
  effectivePrompt: string;
  previousResponseId?: string;
  shouldPersistRemoteSession: boolean;
}

function resolveOpenAIRunInput(params: {
  quickMode: boolean;
  config: OpenAIAgentConfig;
  sessionEntry?: OpenAISessionEntry;
  effectivePrompt: string;
  previousTurns: Parameters<typeof buildQuickConversationContext>[0];
  allowRemotePersistence?: boolean;
  now?: number;
}): OpenAIRunInputResolution {
  let effectivePrompt = params.effectivePrompt;
  if (params.quickMode) {
    const quickConversationContext = buildQuickConversationContext(
      params.previousTurns,
      params.config.outputLanguage,
    );
    if (quickConversationContext) {
      effectivePrompt = `${quickConversationContext}\n\n${effectivePrompt}`;
    }
    return {
      input: effectivePrompt,
      effectivePrompt,
      shouldPersistRemoteSession: false,
    };
  }

  if (params.allowRemotePersistence === false) {
    const localConversationContext = buildQuickConversationContext(
      params.previousTurns,
      params.config.outputLanguage,
    );
    if (localConversationContext) {
      effectivePrompt = `${localConversationContext}\n\n${effectivePrompt}`;
    }
    return {
      input: effectivePrompt,
      effectivePrompt,
      shouldPersistRemoteSession: false,
    };
  }

  const hasFreshSessionEntry = isFreshRuntimeEntry(
    params.sessionEntry,
    OPENAI_SESSION_FRESHNESS_MS,
    params.now ?? Date.now(),
  );
  const freshSessionEntry = hasFreshSessionEntry ? params.sessionEntry : undefined;
  const usePreviousResponse = params.config.protocol === 'responses'
    && !!freshSessionEntry?.lastResponseId;
  if (usePreviousResponse) {
    return {
      input: effectivePrompt,
      effectivePrompt,
      previousResponseId: freshSessionEntry.lastResponseId,
      shouldPersistRemoteSession: true,
    };
  }

  if (
    freshSessionEntry?.history &&
    serializedByteLength(freshSessionEntry.history) <= params.config.maxHistoryBytes
  ) {
    return {
      input: [
        ...freshSessionEntry.history,
        { role: 'user', content: effectivePrompt } as AgentInputItem,
      ],
      effectivePrompt,
      shouldPersistRemoteSession: true,
    };
  }

  return {
    input: effectivePrompt,
    effectivePrompt,
    shouldPersistRemoteSession: true,
  };
}

function buildOpenAIModelSettings(
  config: Pick<OpenAIAgentConfig, 'maxOutputTokens' | 'protocol'>,
  model: string,
  allowRemotePersistence: boolean,
) {
  const chatCompletionsTokenLimit = config.protocol === 'chat_completions'
    ? buildOpenAIChatCompletionsTokenLimit(model, config.maxOutputTokens)
    : undefined;
  const usesMaxCompletionTokens = chatCompletionsTokenLimit
    && 'max_completion_tokens' in chatCompletionsTokenLimit;

  return {
    ...(usesMaxCompletionTokens
      ? { providerData: chatCompletionsTokenLimit }
      : { maxTokens: config.maxOutputTokens }),
    parallelToolCalls: false,
    store: allowRemotePersistence,
  };
}

async function commitAfterProviderClose<T>(
  closeProvider: () => Promise<void>,
  abortScope: Pick<RuntimeAnalysisAbortScope, 'throwIfAborted'>,
  commit: () => T,
): Promise<T> {
  abortScope.throwIfAborted();
  await closeProvider();
  abortScope.throwIfAborted();
  return commit();
}

export const __testing = {
  RuntimeAnalysisAbortScope,
  isMissingOpenAIPreviousResponseError,
  readCompletedStreamFinalOutput,
  readPlanEligibleStreamFinalOutput,
  stripOpenAiReasoningArtifacts,
  createOpenAiReasoningFilterState,
  filterOpenAiVisibleAnswerDelta,
  sanitizeOpenAiConclusionText,
  chooseOpenAiConclusionText,
  selectOpenAiRecoveryAnswer,
  resolveOpenAIRunInput,
  isRecoverableOpenAIStreamTermination,
  compactProviderErrorMessage,
  commitAfterProviderClose,
  buildOpenAIModelSettings,
};

export class OpenAIRuntime extends EventEmitter implements IOrchestrator {
  private readonly traceProcessorService: TraceProcessorService;
  private readonly architectureCache = new Map<string, ArchitectureInfo>();
  private readonly vendorCache = new Map<string, string>();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private readonly sessionNotes = new Map<string, AnalysisNote[]>();
  private readonly sessionSqlErrors = new Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number; fixedSql?: string }>>();
  private readonly sessionSqlErrorPartitions = new Map<string, string>();
  private readonly sessionPlans = new Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }>();
  private readonly sessionHypotheses = new Map<string, Hypothesis[]>();
  private readonly sessionUncertaintyFlags = new Map<string, UncertaintyFlag[]>();
  private readonly sessionMap = new Map<string, OpenAISessionEntry>();
  private readonly activeAnalyses = new Set<string>();
  private readonly activeAbortHandles = new Map<string, Set<RuntimeAbortHandle>>();
  private readonly executionGuard = new RuntimeExecutionGuard();

  private readonly runtimeSelection: RuntimeSelection;

  constructor(
    traceProcessorService: TraceProcessorService,
    runtimeSelection: RuntimeSelection = { kind: 'openai-agents-sdk', source: 'default' },
  ) {
    super();
    this.traceProcessorService = traceProcessorService;
    this.runtimeSelection = runtimeSelection;
  }

  private buildSessionMapKey(sessionId: string, referenceTraceId?: string): string {
    return buildRuntimeSessionMapKey(sessionId, referenceTraceId);
  }

  getSdkSessionId(sessionId: string, referenceTraceId?: string): string | undefined {
    const entry = this.sessionMap.get(this.buildSessionMapKey(sessionId, referenceTraceId));
    return isFreshRuntimeEntry(entry, OPENAI_SESSION_FRESHNESS_MS)
      ? entry.lastResponseId
      : undefined;
  }

  restoreSessionMapping(sessionId: string, sdkSessionId: string, referenceTraceId?: string): void {
    const sessionMapKey = this.buildSessionMapKey(sessionId, referenceTraceId);
    const existing = this.sessionMap.get(sessionMapKey);
    this.sessionMap.set(sessionMapKey, {
      ...existing,
      lastResponseId: sdkSessionId,
      updatedAt: Date.now(),
    });
  }

  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    setLruCacheEntry(this.architectureCache, traceId, architecture);
  }

  private forgetOpenAILastResponseId(sessionMapKey: string, reason: string): void {
    const existing = this.sessionMap.get(sessionMapKey);
    if (existing) {
      this.sessionMap.set(sessionMapKey, {
        ...existing,
        lastResponseId: undefined,
        runState: undefined,
        updatedAt: Date.now(),
      });
    }
    console.warn(
      `[OpenAIRuntime] Discarded stale previousResponseId for ${sessionMapKey}` +
      `${existing ? '' : ' (not present in memory)'}: ${reason}`,
    );
  }

  private async retryWithoutPreviousResponse(params: {
    query: string;
    sessionId: string;
    traceId: string;
    options: AnalysisOptions;
    sessionMapKey: string;
    errorMessage: string;
    outputLanguage: OutputLanguage;
  }): Promise<void> {
    this.forgetOpenAILastResponseId(params.sessionMapKey, params.errorMessage);
    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'openAiRuntime',
        fallback: 'fresh_openai_run_after_missing_previous_response',
        error: 'missing_previous_response',
        message: localize(
          params.outputLanguage,
          'OpenAI 远端 previous response 已不可用，已清理旧 response id 并使用本地持久化上下文重新发起分析...',
          'OpenAI previous response is no longer available. Retrying with persisted local context without previousResponseId...',
        ),
      },
      timestamp: Date.now(),
    });
  }

  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return this.architectureCache.get(traceId);
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
      runtime: OPENAI_AGENT_RUNTIME_KIND,
      sessionId,
      referenceTraceId: options.referenceTraceId,
      runId: options.runId,
    });
    const runtimePerformance = createRuntimePerformanceRun(
      options.runManifestAttributionSink,
    );
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';

    const startTime = Date.now();
    let accumulatedAnswer = '';
    let rounds = 0;
    let observedToolCalls = 0;
    const resolvedConfig = loadOpenAIConfig(options.providerId, providerScopeFromAnalysisOptions(options));
    const config = options.outputLanguage
      ? {...resolvedConfig, outputLanguage: options.outputLanguage}
      : resolvedConfig;
    let sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'] | undefined;
    const sceneType = classifyScene(query);
    const analysisAbortScope = new RuntimeAnalysisAbortScope();
    const bridgeExecutionAbort = () => analysisAbortScope.abort();
    if (executionLease.signal.aborted) {
      bridgeExecutionAbort();
    } else {
      executionLease.signal.addEventListener('abort', bridgeExecutionAbort, { once: true });
    }
    const unregisterAnalysisAbortHandle = this.registerAbortHandle(sessionId, analysisAbortScope);
    try {
      executionLease.throwIfAborted();
      const modeClassification = await this.classifyModeForRequest(
        query,
        sessionId,
        traceId,
        options,
        sceneType,
        config,
        analysisAbortScope.signal,
      );
      executionLease.throwIfAborted();
      analysisAbortScope.throwIfAborted();
      const quickMode = modeClassification.quickMode;
      const inferReportedRounds = (visibleText?: string) => {
        const hasVisibleWork = Boolean((visibleText ?? accumulatedAnswer).trim()) || observedToolCalls > 0;
        if (quickMode) {
          return Math.max(rounds, hasVisibleWork ? (observedToolCalls > 0 ? observedToolCalls + 1 : 1) : 0);
        }
        return Math.max(rounds, hasVisibleWork ? 1 : 0);
      };
      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const previousTurns = sessionContext.getAllTurns?.() || [];
      const analysisRunSpec = createAnalysisRunSpec({
        query,
        sessionId,
        traceId,
        options,
        runtimeSelection: this.runtimeSelection,
        sceneType,
        outputLanguage: config.outputLanguage,
        previousTurns,
        resolvedMode: quickMode ? 'quick' : 'full',
        budget: {
          model: config.model,
          lightModel: config.lightModel,
          maxTurns: config.maxTurns,
          quickMaxTurns: config.quickMaxTurns,
          quickTargetTurns: config.quickTargetTurns,
          maxOutputTokens: config.maxOutputTokens,
          fullPathPerTurnMs: config.fullPathPerTurnMs,
          quickPathPerTurnMs: config.quickPathPerTurnMs,
          classifierTimeoutMs: config.classifierTimeoutMs,
        },
        adaptiveRouting: buildAdaptiveRoutingForModeDecision({
          options,
          resolvedMode: quickMode ? 'quick' : 'full',
          classifierSource: modeClassification.source,
          quickAcknowledgementDirectAnswer:
            modeClassification.quickAcknowledgementDirectAnswer,
          directEvidenceAvailable: Boolean(
            modeClassification.quickFocusAppPreEvidence
            || modeClassification.quickProcessIdentityPreEvidence
            || modeClassification.quickTraceFactPreEvidence
            || modeClassification.quickScrollingTriagePreEvidence
          ),
          outputCap: config.maxOutputTokens,
        }),
      });
      const quickBudget = quickMode
        ? resolveQuickTurnBudget({
            hardCapTurns: config.quickMaxTurns,
            targetTurns: config.quickTargetTurns,
            enforcement: 'turn_cap',
          })
        : undefined;
      runtimePerformance.finishClassification('ok');

      if (quickMode && quickBudget && modeClassification.quickAcknowledgementDirectAnswer) {
        analysisAbortScope.throwIfAborted();
        const result = buildQuickDirectAcknowledgementAnalysisResult({
          sessionId,
          options,
          outputLanguage: config.outputLanguage,
          startedAt: startTime,
          analysisRunSpec,
          budget: quickBudget,
          previousTurns,
        });
        emitQuickDirectQualityGateIssue({
          emitUpdate: update => this.emitUpdate(update),
          module: 'openAiRuntime',
          result,
          query,
          sceneType,
        });
        this.recordTurn({
          query,
          sessionId,
          result,
          sessionContext,
          previousTurnCount: previousTurns.length,
          quickMode,
        });
        runtimePerformance.recordFirstOutput();
        emitQuickDirectAnswerEvents({
          emitUpdate: update => this.emitUpdate(update),
          result,
          startedAt: startTime,
          outputLanguage: config.outputLanguage,
          runtime: 'openai-agents-sdk',
          model: 'runtime-acknowledgement',
        });
        return result;
      }

      let quickEvidenceAttempt: RuntimeQuickEvidenceAttempt | undefined;
      if (quickMode && quickBudget) {
        const quickEvidencePhase = runtimePerformance.startPhase('quick_evidence');
        try {
          quickEvidenceAttempt = await buildRuntimeQuickEvidenceAttempt({
            query,
            traceId,
            packageName: options.packageName,
            selectionContext: options.selectionContext,
            traceProcessorService: this.traceProcessorService,
            outputLanguage: config.outputLanguage,
            quickFocusAppPreEvidence: modeClassification.quickFocusAppPreEvidence,
            quickProcessIdentityPreEvidence: modeClassification.quickProcessIdentityPreEvidence,
            quickTraceFactPreEvidence: modeClassification.quickTraceFactPreEvidence,
            quickScrollingTriagePreEvidence: modeClassification.quickScrollingTriagePreEvidence,
            emitUpdate: update => this.emitUpdate(update),
          });
          quickEvidencePhase.end('ok');
        } catch (error) {
          quickEvidencePhase.end(runtimeOutcomeFromError(error, executionLease.signal));
          throw error;
        }
      }
      analysisAbortScope.throwIfAborted();
      if (quickBudget && quickEvidenceAttempt?.directAnswer) {
        return this.buildDirectQuickEvidenceResult({
          query,
          sessionId,
          options,
          startTime,
          sceneType,
          outputLanguage: config.outputLanguage,
          sessionContext,
          previousTurns,
          analysisRunSpec,
          quickBudget,
          directAnswer: quickEvidenceAttempt.directAnswer,
          evidenceCounts: quickEvidenceAttempt.evidenceCounts,
          runtimePerformance,
        });
      }

      const context = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        config,
        sceneType,
        lightweight: quickMode,
        analysisRunSpec,
        sessionContext,
        previousTurns,
        skipQuickTracePreflightDetection: modeClassification.skipQuickTracePreflightDetection,
        quickProcessIdentityPreEvidence: modeClassification.quickProcessIdentityPreEvidence,
        quickTraceFactPreEvidence: modeClassification.quickTraceFactPreEvidence,
        quickEvidenceAttempt: selectReusableRuntimeQuickEvidenceAttempt(quickEvidenceAttempt),
        executionLease,
        runtimePerformance,
      });
      sourceUse = context.sourceUse;
      executionLease.throwIfAborted();
      analysisAbortScope.throwIfAborted();
      const resolveFinalReportSceneType = () => resolveRuntimeFinalReportSceneType({
        query,
        initialSceneType: sceneType,
        plan: this.sessionPlans.get(sessionId)?.current,
      });

      const directQuickAnswer = context.directProcessIdentityAnswer ?? context.directTraceFactAnswer;
      if (quickMode && quickBudget && directQuickAnswer) {
        const result = buildQuickDirectEvidenceAnalysisResult({
          query,
          sessionId,
          options,
          startedAt: startTime,
          analysisRunSpec,
          budget: quickBudget,
          directAnswer: directQuickAnswer,
          evidenceCounts: {
            currentRunDataEnvelopes: 0,
            citedEvidenceRefs: countRuntimeQuickEvidenceCitedRefs(directQuickAnswer),
          },
          previousTurns: context.previousTurns,
          hypotheses: context.hypotheses.map(h => this.toProtocolHypothesis(h)),
          contextInjected: context.quickMemoryContextCounts,
        });
        emitQuickDirectQualityGateIssue({
          emitUpdate: update => this.emitUpdate(update),
          module: 'openAiRuntime',
          result,
          query,
          sceneType,
        });
        this.recordTurn({
          query,
          sessionId,
          result,
          sessionContext: context.sessionContext,
          previousTurnCount: context.previousTurns.length,
          quickMode,
        });
        this.recordPatternMemory({
          sessionId,
          result,
          previousTurnCount: context.previousTurns.length,
          quickMode,
          sceneType,
          architecture: context.architecture,
          packageName: context.effectivePackageName,
          options,
        });
        runtimePerformance.recordFirstOutput();
        emitQuickDirectAnswerEvents({
          emitUpdate: update => this.emitUpdate(update),
          result,
          startedAt: startTime,
          outputLanguage: config.outputLanguage,
          runtime: 'openai-agents-sdk',
          model: 'runtime-pre-evidence',
        });
        return result;
      }

      const promptPrefix = analysisRunSpec.traceContext.promptSection;
      const effectivePrompt = promptPrefix ? `${promptPrefix}\n\n${query}` : query;
      const sessionEntry = this.sessionMap.get(context.sessionMapKey);
      let runInput = resolveOpenAIRunInput({
        quickMode,
        config,
        sessionEntry,
        effectivePrompt,
        previousTurns: context.previousTurns,
        allowRemotePersistence: !analysisContextUsesPrivateKnowledge(options),
      });
      const selectedModel = quickMode ? config.lightModel : config.model;

      analysisAbortScope.throwIfAborted();
      const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
      setTracingDisabled(true);
      let provider: OpenAIProvider;
      let runner: Runner;
      let agent: Agent;
      try {
        provider = shouldUseMimoReasoningContentCompat(config)
          ? new OpenAIProvider({
            openAIClient: new OpenAI({
              apiKey: config.apiKey,
              baseURL: config.baseURL,
              fetch: createMimoReasoningContentFetch() as any,
            }),
            useResponses: false,
          })
          : new OpenAIProvider({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            useResponses: config.protocol === 'responses',
          });
        runner = new Runner({
          modelProvider: provider,
          tracingDisabled: true,
          traceIncludeSensitiveData: false,
          workflowName: 'SmartPerfetto Analysis',
          toolExecution: { maxFunctionToolConcurrency: 1 },
        });
        agent = new Agent({
          name: 'SmartPerfetto',
          instructions: context.systemPrompt,
          model: selectedModel,
          tools: context.tools,
          toolUseBehavior: 'run_llm_again',
          modelSettings: buildOpenAIModelSettings(
            config,
            selectedModel,
            !analysisContextUsesPrivateKnowledge(options),
          ),
        });
        sdkStartPhase.end('ok');
      } catch (error) {
        sdkStartPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }

      let activeController: AbortController | undefined;
      const timeoutMs = quickMode
        ? config.quickPathPerTurnMs * config.quickMaxTurns
        : resolveFullRequestTimeoutMs(
          config.fullPathPerTurnMs,
          config.maxTurns,
          config.fullRequestTimeoutMs,
        );
      let timedOut = false;
      let timeoutKind: RuntimeTimeoutKind = 'request';

      analysisAbortScope.throwIfAborted();
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'answering',
          message: localize(
            config.outputLanguage,
            `AI 分析引擎分析中 (${agent.model})...`,
            `AI analysis engine is running (${agent.model})...`,
          ),
          runtime: 'openai-agents-sdk',
          model: agent.model,
        },
        timestamp: Date.now(),
      });

      const deadlineAt = Date.now() + timeoutMs;
      const requestTimeout = createResettableRuntimeTimeout({
        timeoutMs,
        message: `OpenAI request timeout after ${timeoutMs}ms`,
        onTimeout: () => {
          timedOut = true;
          timeoutKind = 'request';
          activeController?.abort();
        },
      });
      let currentPreviousResponseId = runInput.previousResponseId;
      for (;;) {
      let currentInput: string | AgentInputItem[] = runInput.input;
      try {
        let conclusion = '';
        let finalHistory: AgentInputItem[] | undefined;
        let finalLastResponseId: string | undefined;
        let finalRunState: string | undefined;
        let partial = false;
        let terminationReason: AnalysisTerminationReason | undefined;
        let terminationMessage: string | undefined;
        let finalReportContinuations = 0;
        const toolInputsByTaskId = new Map<string, { toolName: string; args: Record<string, unknown> }>();
        const markTimeoutPartial = (planStatus: PlanCompletionStatus) => {
          partial = true;
          terminationReason = 'timeout';
          terminationMessage = timeoutKind === 'stream_idle'
            ? localize(
              config.outputLanguage,
              `OpenAI provider 连续 ${Math.round(config.streamIdleTimeoutMs / 1000)} 秒没有流事件，结果可能不完整。`,
              `The OpenAI provider emitted no stream events for ${Math.round(config.streamIdleTimeoutMs / 1000)} seconds; the result may be incomplete.`,
            )
            : localize(
              config.outputLanguage,
              `OpenAI 分析超过 ${Math.round(timeoutMs / 1000)} 秒超时，结果可能不完整。`,
              `OpenAI analysis timed out after ${Math.round(timeoutMs / 1000)} seconds; the result may be incomplete.`,
            );
          conclusion = this.withIncompletePlanWarning(conclusion, planStatus, config.outputLanguage);
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: 'partial_result_after_timeout',
              partial: true,
              terminationReason,
              timeoutKind,
              message: terminationMessage,
            },
            timestamp: Date.now(),
          });
        };
        const markHistoryLimitPartial = () => {
          partial = true;
          terminationReason = 'plan_incomplete';
          terminationMessage = localize(
            config.outputLanguage,
            'OpenAI 分析历史达到内存上限，已基于现有证据结束分析。',
            'OpenAI analysis history reached its memory limit; ending with the evidence collected so far.',
          );
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: 'partial_result_after_history_limit',
              partial: true,
              terminationReason,
              message: terminationMessage,
            },
            timestamp: Date.now(),
          });
        };

        for (let continuation = 0; ; continuation++) {
          analysisAbortScope.throwIfAborted();
          if (timedOut || Date.now() >= deadlineAt) {
            timedOut = true;
            markTimeoutPartial(this.getPlanCompletionStatus(sessionId, quickMode));
            break;
          }
          const linkedController = analysisAbortScope.createLinkedController();
          const controller = linkedController.controller;
          activeController = controller;
          let runAnswer = '';
          let runTurns = 0;
          let completedByPlanIdle = false;
          const answerStreamFilter = createOpenAiReasoningFilterState();
          const answerTextProjection = analysisContextUsesPrivateKnowledge(options)
            ? createCodeAwareStreamingTextProjection(
                sessionId,
                `openai-answer-${continuation}-${finalReportContinuations}`,
              )
            : undefined;
          let suppressedRunAnswer = '';
          let planCompleteIdleTimer: ReturnType<typeof setTimeout> | undefined;
          const clearPlanCompleteIdleTimer = () => {
            if (planCompleteIdleTimer) {
              clearTimeout(planCompleteIdleTimer);
              planCompleteIdleTimer = undefined;
            }
          };
          const providerIdleTimeout = createResettableRuntimeTimeout({
            timeoutMs: config.streamIdleTimeoutMs,
            message: `OpenAI provider stream idle timeout after ${config.streamIdleTimeoutMs}ms`,
            onTimeout: () => {
              timedOut = true;
              timeoutKind = 'stream_idle';
              controller.abort();
            },
          });
          void providerIdleTimeout.promise.catch(() => undefined);
          const schedulePlanCompleteIdleAbort = () => {
            clearPlanCompleteIdleTimer();
            if (!this.shouldFinalizeAfterPlanComplete(sessionId, quickMode, runAnswer, accumulatedAnswer)) {
              return;
            }
            planCompleteIdleTimer = setTimeout(() => {
              if (analysisAbortScope.signal.aborted) return;
              completedByPlanIdle = true;
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'concluding',
                    message: localize(
                      config.outputLanguage,
                      '分析阶段已完成，正在整理最终报告。',
                      'Analysis phases are complete; preparing the final report.',
                    ),
                  },
                  timestamp: Date.now(),
                });
              controller.abort();
            }, OPENAI_PLAN_COMPLETE_IDLE_ABORT_MS);
          };
          const runStream = () => {
            commitEvaluationSdkHandoffIfActive();
            return runner.run(agent, currentInput, {
                stream: true,
                maxTurns: quickMode ? config.quickMaxTurns : config.maxTurns,
                context: { signal: controller.signal },
                signal: controller.signal,
                ...(currentPreviousResponseId
                  ? { previousResponseId: currentPreviousResponseId }
                  : {}),
              });
          };
          let stream!: Awaited<ReturnType<typeof runStream>>;

          let streamCompleted = false;
          try {
            const providerPhase = runtimePerformance.startPhase('provider');
            try {
              stream = await Promise.race([
                runStream(),
                providerIdleTimeout.promise,
                requestTimeout.promise,
              ]);
              analysisAbortScope.throwIfAborted();
              const consumeStream = async () => {
                try {
                  for await (const event of stream) {
                    providerIdleTimeout.reset();
                    clearPlanCompleteIdleTimer();
                    runTurns = stream.currentTurn || runTurns;
                    const delta = this.handleStreamEvent(event, config.outputLanguage, {
                      sessionId,
                      quickMode,
                      answerStreamFilter,
                      answerTextProjection,
                      runtimePerformance,
                      toolInputsByTaskId,
                      tracePairContext: options.tracePairContext,
                      onToolCalled: () => {
                        observedToolCalls++;
                      },
                      onSuppressedAnswerDelta: delta => {
                        suppressedRunAnswer += delta;
                      },
                    });
                    if (delta) {
                      runAnswer += delta;
                      accumulatedAnswer += delta;
                    }
                    schedulePlanCompleteIdleAbort();
                  }
                  clearPlanCompleteIdleTimer();
                  await stream.completed;
                  const evaluationUsage =
                    (stream as any).runContext?.usage
                    ?? (stream as any).context?.usage
                    ?? (stream as any).state?.usage;
                  recordEvaluationTokenDeltaIfPresent(evaluationUsage);
                  streamCompleted = true;
                } catch (error) {
                  if (!(isAbortLikeError(error) && (completedByPlanIdle || timedOut))) {
                    throw error;
                  }
                } finally {
                  const projectedTail = answerTextProjection?.flush() ?? '';
                  if (projectedTail) {
                    runtimePerformance.recordFirstOutput();
                    this.emitUpdate({
                      type: 'answer_token',
                      content: {token: projectedTail},
                      timestamp: Date.now(),
                    });
                  }
                }
              };
              await Promise.race([
                consumeStream(),
                providerIdleTimeout.promise,
                requestTimeout.promise,
              ]);
              providerPhase.end(streamCompleted ? 'ok' : timedOut ? 'cancelled' : 'ok');
            } catch (error) {
              providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
              if (timedOut) {
                markTimeoutPartial(this.getPlanCompletionStatus(sessionId, quickMode));
                break;
              }
              throw error;
            }
          } finally {
            providerIdleTimeout.clear();
            clearPlanCompleteIdleTimer();
            if (activeController === controller) {
              activeController = undefined;
            }
            linkedController.dispose();
          }

          analysisAbortScope.throwIfAborted();
          rounds += runTurns || stream.currentTurn || 0;
          let planStatus = this.getPlanCompletionStatus(sessionId, quickMode);
          const finalReportSceneType = resolveFinalReportSceneType();
          const completedStreamFinalOutput = readCompletedStreamFinalOutput(stream, {
            streamCompleted,
            completedByPlanIdle,
            timedOut,
          });
          const reconciliationCandidate = chooseOpenAiConclusionText({
            candidate: typeof completedStreamFinalOutput === 'string'
              ? completedStreamFinalOutput
              : (completedStreamFinalOutput
                  ? JSON.stringify(completedStreamFinalOutput)
                  : suppressedRunAnswer),
            accumulatedAnswer: suppressedRunAnswer,
            completedByPlanIdle,
            planComplete: false,
          });
          if (this.reconcileCompletedConclusionPhase({
            sessionId,
            quickMode,
            conclusion: reconciliationCandidate,
            query,
            sceneType: finalReportSceneType,
            comparisonIdentity: context.comparisonIdentity,
          })) {
            planStatus = this.getPlanCompletionStatus(sessionId, quickMode);
            if (!runAnswer.trim()) {
              runAnswer = reconciliationCandidate;
            }
          }
          const streamFinalOutput = readPlanEligibleStreamFinalOutput(stream, {
            streamCompleted,
            completedByPlanIdle,
            timedOut,
            quickMode,
            planComplete: planStatus.complete,
          });
          const finalOutput = typeof streamFinalOutput === 'string'
            ? streamFinalOutput
            : (streamFinalOutput ? JSON.stringify(streamFinalOutput) : runAnswer);
          const fallbackConclusion = this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, config.outputLanguage);
          const recoveryAnswer = selectOpenAiRecoveryAnswer({ runAnswer, accumulatedAnswer });
          conclusion = chooseOpenAiConclusionText({
            candidate: finalOutput ||
              runAnswer ||
              accumulatedAnswer ||
              fallbackConclusion ||
              '',
            accumulatedAnswer: recoveryAnswer,
            completedByPlanIdle,
            planComplete: planStatus.complete,
            fallbackConclusion,
          });
          if (streamCompleted) {
            if (serializedByteLength(stream.history) <= config.maxHistoryBytes) {
              finalHistory = stream.history;
            } else {
              finalHistory = undefined;
              console.warn(
                `[OpenAIRuntime] Session ${sessionId}: skipping oversized retained history ` +
                `(limitBytes=${config.maxHistoryBytes})`,
              );
            }
            finalLastResponseId = stream.lastResponseId;
            finalRunState = this.safeSerializeRunState(stream.state);
          }

          if (timedOut && !completedByPlanIdle) {
            markTimeoutPartial(planStatus);
            break;
          }
          if (planStatus.complete) {
            const streamHistory = Array.isArray(stream.history)
              ? stream.history as AgentInputItem[]
              : [];
            const streamHistoryWithinBudget =
              serializedByteLength(streamHistory) <= config.maxHistoryBytes;
            const finalReportQualityIssue = this.assessFinalReportQualityIssue({
              sessionId,
              conclusion,
              query,
              sceneType: finalReportSceneType,
              comparisonIdentity: context.comparisonIdentity,
            });
            const canRequestFinalReportAfterPlanComplete =
              !quickMode &&
              planStatus.complete &&
              !timedOut &&
              finalReportContinuations < OPENAI_MAX_FINAL_REPORT_CONTINUATIONS;
            const shouldRequestFinalReport =
              this.shouldRequestFinalReportAfterPlanComplete({
              sessionId,
              quickMode,
              planStatus,
              conclusion,
              fallbackConclusion,
              completedByPlanIdle,
              timedOut,
              finalReportContinuations,
              query,
              sceneType: finalReportSceneType,
              comparisonIdentity: context.comparisonIdentity,
              qualityIssue: finalReportQualityIssue,
              }) ||
              (canRequestFinalReportAfterPlanComplete && Boolean(finalReportQualityIssue));
            if (shouldRequestFinalReport && streamHistory.length > 0 && !streamHistoryWithinBudget) {
              markHistoryLimitPartial();
              break;
            }
            if (shouldRequestFinalReport && streamHistory.length > 0) {
              finalReportContinuations++;
              this.emitUpdate({
                type: 'progress',
                content: {
                  phase: 'concluding',
                  message: this.formatPlanCompleteReportContinuationMessage(config.outputLanguage),
                },
                timestamp: Date.now(),
              });
              currentInput = [
                ...streamHistory,
                {
                  role: 'user',
                  content: this.buildFinalReportAfterPlanCompletePrompt({
                    outputLanguage: config.outputLanguage,
                    missingSections: assessFinalReportContractCompleteness({
                      conclusion,
                      query,
                      sceneType: finalReportSceneType,
                    })?.missingSections,
                    qualityIssue: finalReportQualityIssue,
                    requireCodeReference: this.finalReportMissingCodeReference(sessionId, conclusion),
                  }),
                } as AgentInputItem,
              ];
              currentPreviousResponseId = undefined;
              continue;
            }
            break;
          }

          if (continuation >= OPENAI_MAX_PLAN_CONTINUATIONS) {
            partial = true;
            terminationReason = 'plan_incomplete';
            terminationMessage = this.formatIncompletePlanMessage(planStatus, config.outputLanguage);
            conclusion = this.withIncompletePlanWarning(conclusion, planStatus, config.outputLanguage);
            this.emitUpdate({
              type: 'degraded',
              content: {
                module: 'openAiRuntime',
                fallback: 'partial_result_after_incomplete_plan',
                partial: true,
                terminationReason,
                message: terminationMessage,
              },
              timestamp: Date.now(),
            });
            break;
          }

          this.emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: this.formatPlanContinuationMessage(planStatus, config.outputLanguage),
            },
            timestamp: Date.now(),
          });
          if (serializedByteLength(stream.history) > config.maxHistoryBytes) {
            markHistoryLimitPartial();
            break;
          }
          currentInput = [
            ...(stream.history as AgentInputItem[]),
            {
              role: 'user',
              content: this.buildPlanContinuationPrompt(planStatus, config.outputLanguage),
            } as AgentInputItem,
          ];
          currentPreviousResponseId = undefined;
        }

        analysisAbortScope.throwIfAborted();
        requestTimeout.clear();
        if (analysisContextUsesPrivateKnowledge(options)) {
          conclusion = sanitizeCodeAwareText(sessionId, conclusion);
        }
        conclusion = completeFinalReportCodeReferences({
          plan: this.sessionPlans.get(sessionId)?.current,
          conclusion,
          outputLanguage: config.outputLanguage,
        });
        const finalReportSceneType = resolveFinalReportSceneType();
        const finalFallbackConclusion = this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, config.outputLanguage);
        if (
          finalFallbackConclusion &&
          (isSameConclusionText(conclusion, finalFallbackConclusion) ||
            looksLikePhaseSummaryFallback(conclusion)) &&
          !partial
        ) {
          partial = true;
            terminationMessage = localize(
              config.outputLanguage,
              '分析阶段已完成，但模型没有输出独立最终报告；已使用阶段摘要兜底，结果信息密度可能不足。',
              'Analysis phases completed, but the model did not produce an independent final report; falling back to phase summaries, which may be less informative.',
            );
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: 'completed_plan_summary_fallback',
              partial: true,
              message: terminationMessage,
            },
            timestamp: Date.now(),
          });
        }
        let findings = extractFindingsFromText(conclusion);
        let confidence = partial
          ? Math.min(0.55, this.estimateConfidence(findings, conclusion))
          : this.estimateConfidence(findings, conclusion);
        rounds = inferReportedRounds(conclusion);
        const result: AnalysisResult = {
          sessionId,
          success: true,
          findings,
          hypotheses: context.hypotheses.map(h => this.toProtocolHypothesis(h)),
          conclusion,
          confidence,
          rounds,
          totalDurationMs: Date.now() - startTime,
          partial: partial || undefined,
          terminationReason,
          terminationMessage,
          quickRun: quickMode && quickBudget
            ? buildQuickRunReceipt({
                requestedMode: options.analysisMode ?? 'auto',
                profile: shouldMarkQuickRunTriage(query) ? 'triage' : undefined,
                budget: quickBudget,
                actualTurns: rounds,
                elapsedMs: Date.now() - startTime,
                stopReason: quickStopReasonFromTermination({
                  partial,
                  terminationReason,
                  actualTurns: rounds,
                  targetTurns: quickBudget.targetTurns,
                  hardCapTurns: quickBudget.hardCapTurns,
                }),
                evidence: {
                  frontendPrequeryInjected: analysisRunSpec.traceContext.datasetCount,
                },
                contextInjected: {
                  conversationTurns: countCompletedQuickConversationTurns(context.previousTurns),
                  ...(context.quickMemoryContextCounts ?? {
                    recentSqlResults: 0,
                    sqlPitfallPairs: 0,
                    patternHints: 0,
                    negativePatternHints: 0,
                    caseBackgroundCases: 0,
                  }),
                },
                adaptiveRouting: analysisRunSpec.mode.adaptiveRouting,
              })
            : undefined,
        };
        if (!quickMode) {
          const verifyCurrentConclusion = async () => {
            result.conclusion = completeFinalReportCodeReferences({
              plan: this.sessionPlans.get(sessionId)?.current,
              conclusion: result.conclusion,
              outputLanguage: config.outputLanguage,
            });
            result.findings = extractFindingsFromText(result.conclusion);
            return verifyConclusion(result.findings, result.conclusion, {
              emitUpdate: (update) => this.emitUpdate(update),
              enableLLM: false,
              plan: this.sessionPlans.get(sessionId)?.current ?? null,
              hypotheses: context.hypotheses,
              sceneType: finalReportSceneType,
              outputLanguage: config.outputLanguage,
              query,
              emitIssueProgress: false,
              allowPersistentLearning: !analysisContextUsesPrivateKnowledge(options),
            });
          };
          const verificationPhase = runtimePerformance.startPhase('verification');
          let verification: Awaited<ReturnType<typeof verifyCurrentConclusion>>;
          try {
            verification = await verifyCurrentConclusion();
            verificationPhase.end('ok');
          } catch (error) {
            verificationPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
            throw error;
          }
          analysisAbortScope.throwIfAborted();
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
            this.getPlanCompletionStatus(sessionId, quickMode).complete
          ) {
            const repairedConclusion = repairTruncatedFinalReport({
              conclusion: result.conclusion,
              plan: this.sessionPlans.get(sessionId)?.current ?? null,
              hypotheses: context.hypotheses,
              outputLanguage: config.outputLanguage,
              recoveryKind: truncationIssue ? 'truncation' : 'missing_contract',
              missingContractSections: contractIssue?.missingSections,
            });
            if (repairedConclusion) {
              const preRecoveryConfidence = result.confidence;
              result.conclusion = repairedConclusion;
              result.findings = extractFindingsFromText(repairedConclusion);
              result.confidence = Math.min(
                preRecoveryConfidence,
                this.estimateConfidence(result.findings, repairedConclusion),
              );
              this.emitUpdate({
                type: 'progress',
                content: {
                  phase: 'concluding',
                  message: localize(
                    config.outputLanguage,
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
              verification = await verifyCurrentConclusion();
              analysisAbortScope.throwIfAborted();
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
            this.emitUpdate({
              type: 'degraded',
              content: {
                module: 'openAiRuntime',
                fallback: 'verification_failed',
                partial: true,
                terminationReason: result.terminationReason,
                verificationIssueType: verificationIssue.type,
                message: verificationIssue.message,
              },
              timestamp: Date.now(),
            });
          }
        }
        analysisAbortScope.throwIfAborted();
        finalizeSourceAwareAnalysisResult(result, context.sourceUse);
        const gateIssue = applyFinalResultQualityGate({
          result,
          query,
          sceneType: finalReportSceneType,
          comparisonIdentity: context.comparisonIdentity,
        });
        if (gateIssue) {
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: gateIssue.code,
              partial: true,
              message: gateIssue.message,
            },
            timestamp: Date.now(),
          });
        }

        return await commitAfterProviderClose(
          () => provider.close().catch(() => undefined),
          analysisAbortScope,
          () => {
            if (runInput.shouldPersistRemoteSession) {
              this.sessionMap.set(context.sessionMapKey, {
                history: finalHistory,
                lastResponseId: finalLastResponseId,
                runState: finalRunState,
                updatedAt: Date.now(),
              });
            }

            this.recordTurn({
              query,
              sessionId,
              result,
              sessionContext: context.sessionContext,
              previousTurnCount: context.previousTurns.length,
              quickMode,
            });
            this.recordPatternMemory({
              sessionId,
              result,
              previousTurnCount: context.previousTurns.length,
              quickMode,
              sceneType,
              architecture: context.architecture,
              packageName: context.effectivePackageName,
              options,
            });

            this.emitUpdate({
              type: 'conclusion',
              content: { conclusion: result.conclusion, durationMs: Date.now() - startTime, turns: rounds },
              timestamp: Date.now(),
            });
            this.emitUpdate({
              type: 'answer_token',
              content: { done: true, totalChars: result.conclusion.length },
              timestamp: Date.now(),
            });

            return result;
          },
        );
      } catch (error) {
        if (currentPreviousResponseId && isMissingOpenAIPreviousResponseError(error, currentPreviousResponseId)) {
          await this.retryWithoutPreviousResponse({
            query,
            sessionId,
            traceId,
            options,
            sessionMapKey: context.sessionMapKey,
            errorMessage: formatOpenAIError(error),
            outputLanguage: config.outputLanguage,
          });
          runInput = resolveOpenAIRunInput({
            quickMode,
            config,
            sessionEntry: this.sessionMap.get(context.sessionMapKey),
            effectivePrompt,
            previousTurns: context.previousTurns,
            allowRemotePersistence: !analysisContextUsesPrivateKnowledge(options),
          });
          currentInput = runInput.input;
          currentPreviousResponseId = runInput.previousResponseId;
          continue;
        }
        requestTimeout.clear();
        await provider.close().catch(() => undefined);
        analysisAbortScope.throwIfAborted();
        if (error instanceof MaxTurnsExceededError) {
          const reportedRounds = inferReportedRounds();
          return finalizeSourceAwareAnalysisResult(this.recordMaxTurnsPartialResult({
            error,
            query,
            sessionId,
            outputLanguage: config.outputLanguage,
            accumulatedAnswer,
            context,
            startTime,
            rounds: reportedRounds,
            quickMode,
            maxTurns: quickMode ? config.quickMaxTurns : config.maxTurns,
            quickBudget,
            requestedMode: options.analysisMode ?? 'auto',
            frontendPrequeryInjected: analysisRunSpec.traceContext.datasetCount,
            codeAwareMode: options.codeAwareMode,
            knowledgeSourceIds: options.knowledgeSourceIds,
          }), sourceUse);
        }
        const reportedRounds = inferReportedRounds();
        const recoverablePartial = this.recoverPartialResultAfterStreamTermination({
          error,
          sessionId,
          quickMode,
          outputLanguage: config.outputLanguage,
          accumulatedAnswer,
          context,
          query,
          startTime,
          rounds: reportedRounds,
          quickBudget,
          requestedMode: options.analysisMode ?? 'auto',
          frontendPrequeryInjected: analysisRunSpec.traceContext.datasetCount,
          codeAwareMode: options.codeAwareMode,
          knowledgeSourceIds: options.knowledgeSourceIds,
        });
        if (recoverablePartial) {
          return finalizeSourceAwareAnalysisResult(recoverablePartial, sourceUse);
        }
        throw error;
      }
      }
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(
        error,
        executionLease.signal,
      );
      analysisAbortScope.throwIfAborted();
      const message = compactProviderErrorMessage(error);
      this.emitUpdate({
        type: 'error',
        content: { message: `AI analysis failed: ${message}` },
        timestamp: Date.now(),
      });
      return finalizeSourceAwareAnalysisResult({
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: localize(
          config.outputLanguage,
          `AI 分析失败：${message}`,
          `AI analysis failed: ${message}`,
        ),
        confidence: 0,
        rounds,
        totalDurationMs: Date.now() - startTime,
        terminationReason: 'execution_error',
        terminationMessage: message,
      }, sourceUse);
    } finally {
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      try {
        executionLease.signal.removeEventListener('abort', bridgeExecutionAbort);
        unregisterAnalysisAbortHandle();
        this.activeAnalyses.delete(sessionId);
        executionLease.settle();
      } finally {
        finalizationPhase.end(runtimePerformanceOutcome);
        runtimePerformance.finalize(runtimePerformanceOutcome);
      }
    }
  }

  reset(): void {
    this.executionGuard.clear();
    this.abortAllSessions();
    this.architectureCache.clear();
    this.vendorCache.clear();
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionSqlErrorPartitions.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.sessionMap.clear();
    this.activeAnalyses.clear();
  }

  cleanupSession(sessionId: string): void {
    this.abortSession(sessionId);
    this.sessionMap.delete(sessionId);
    for (const key of Array.from(this.sessionMap.keys())) {
      if (key.startsWith(`${sessionId}:ref:`)) this.sessionMap.delete(key);
    }
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionSqlErrors.delete(sessionId);
    this.sessionSqlErrorPartitions.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.activeAnalyses.delete(sessionId);
  }

  abortSession(sessionId: string): void {
    void this.executionGuard.abortSession(sessionId);
    const handles = this.activeAbortHandles.get(sessionId);
    if (!handles) return;
    for (const handle of Array.from(handles)) {
      try {
        handle.abort();
      } catch (error) {
        console.warn('[OpenAIRuntime] Failed to abort SDK handle:', (error as Error).message);
      }
    }
  }

  private registerAbortHandle(sessionId: string, handle: RuntimeAbortHandle): () => void {
    let handles = this.activeAbortHandles.get(sessionId);
    if (!handles) {
      handles = new Set();
      this.activeAbortHandles.set(sessionId, handles);
    }
    const cancellationAlreadyRequested = Array.from(handles).some(active => active.aborted);
    handles.add(handle);
    if (cancellationAlreadyRequested) handle.abort();
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

  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const privateKnowledge = sessionFieldsUsePrivateKnowledge(sessionFields);
    const durableFields = projectSessionFieldsForDurableSnapshot(sessionFields);
    const planState = this.sessionPlans.get(sessionId);
    const artifactStore = this.artifactStores.get(sessionId);
    const sessionEntry = this.sessionMap.get(
      this.buildSessionMapKey(sessionId, sessionFields.referenceTraceId),
    );
    const freshSessionEntry = !privateKnowledge &&
      isFreshRuntimeEntry(sessionEntry, OPENAI_SESSION_FRESHNESS_MS)
      ? sessionEntry
      : undefined;
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
      architecture: this.architectureCache.get(traceId),
      engineState: createOpenAISnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        history: freshSessionEntry?.history,
        lastResponseId: freshSessionEntry?.lastResponseId,
        runState: freshSessionEntry?.runState,
      }),
      sdkSessionId: freshSessionEntry?.lastResponseId,
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      agentRuntimeProviderSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
      openAIHistory: freshSessionEntry?.history,
      openAILastResponseId: freshSessionEntry?.lastResponseId,
      openAIRunState: freshSessionEntry?.runState,
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
      this.architectureCache.set(traceId, snapshot.architecture);
    }
    const openAIEngineState = getOpenAISnapshotEngineState(snapshot);
    const restoredHistory = openAIEngineState?.history as AgentInputItem[] | undefined;
    const maxRestoredHistoryBytes = loadOpenAIConfig(null).maxHistoryBytes;
    const boundedRestoredHistory = restoredHistory &&
      serializedByteLength(restoredHistory) <= maxRestoredHistoryBytes
      ? restoredHistory
      : undefined;
    const restoredLastResponseId = openAIEngineState?.lastResponseId;
    const restoredRunState = openAIEngineState?.runState;
    if (boundedRestoredHistory || restoredLastResponseId || restoredRunState) {
      this.sessionMap.set(this.buildSessionMapKey(sessionId, snapshot.referenceTraceId), {
        history: boundedRestoredHistory,
        lastResponseId: restoredLastResponseId,
        runState: restoredRunState,
        updatedAt: snapshot.snapshotTimestamp || Date.now(),
      });
    }
  }

  private resetAnalysisSessionState(sessionId: string): OpenAIAnalysisSessionState {
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

    return {
      artifactStore,
      notes,
      analysisPlan,
      previousPlan,
      hypotheses,
      uncertaintyFlags,
    };
  }

  private async prepareAnalysisContext(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    runtime: {
      config: OpenAIAgentConfig;
      sceneType: SceneType;
      lightweight: boolean;
      analysisRunSpec: AnalysisRunSpec;
      sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns: ConversationTurn[];
      skipQuickTracePreflightDetection: boolean;
      quickProcessIdentityPreEvidence?: boolean;
      quickTraceFactPreEvidence?: boolean;
      quickEvidenceAttempt?: RuntimeQuickEvidenceAttempt;
      executionLease?: RuntimeExecutionLease;
      runtimePerformance?: RuntimePerformanceRun;
    },
  ) {
    const { config, sceneType, lightweight, analysisRunSpec, sessionContext } = runtime;
    const knowledgeScope = analysisRunSpec.scopes.knowledge;
    const reusableQuickEvidenceAttempt = runtime.quickEvidenceAttempt;
    const executionLease = runtime.executionLease;
    const runtimePerformance = runtime.runtimePerformance;
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
        } catch (error) {
          phase?.end(runtimeOutcomeFromError(error, executionLease?.signal));
          throw error;
        }
      });
    };
    let effectivePackageName = options.packageName ?? reusableQuickEvidenceAttempt?.effectivePackageName;

    const skipQuickTracePreflight = lightweight && runtime.skipQuickTracePreflightDetection;
    const quickProcessIdentityPreEvidence = lightweight
      && !!runtime.quickProcessIdentityPreEvidence
      && !reusableQuickEvidenceAttempt;
    const quickTraceFactPreEvidence = lightweight
      && !!runtime.quickTraceFactPreEvidence
      && !reusableQuickEvidenceAttempt;
    const skipFocusDetectionForQuickTraceFact = !!effectivePackageName
      ? (quickProcessIdentityPreEvidence || quickTraceFactPreEvidence)
      : quickTraceFactPreEvidence
        && !quickProcessIdentityPreEvidence
        && shouldSkipFocusDetectionForQuickTraceFactEvidence(query);
    const skipFocusDetection =
      skipQuickTracePreflight || skipFocusDetectionForQuickTraceFact;
    const selectionTimeRange = focusAppTimeRangeFromSelection(options.selectionContext);
    const focusPhase = runtimePerformance?.startPhase('focus');
    let focusResult: FocusAppDetectionResult;
    try {
      focusResult = reusableQuickEvidenceAttempt?.focusResult ?? (skipFocusDetection
        ? {
            apps: [],
            primaryApp: undefined,
            method: 'none' as const,
            timeRange: selectionTimeRange,
          }
        : await detectFocusApps(this.traceProcessorService, traceId, {
            timeRange: selectionTimeRange,
          }));
      focusPhase?.end(executionLease?.signal.aborted ? 'cancelled' : 'ok');
    } catch (error) {
      focusPhase?.end(runtimeOutcomeFromError(error, executionLease?.signal));
      throw error;
    }
    if (!effectivePackageName && focusResult.primaryApp) {
      effectivePackageName = focusResult.primaryApp;
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            config.outputLanguage,
            `检测到焦点应用: ${focusResult.primaryApp} (${focusResult.method})`,
            `Detected focus app: ${focusResult.primaryApp} (${focusResult.method})`,
          ),
        },
        timestamp: Date.now(),
      });
    }

    const quickProcessIdentityExecutor = quickProcessIdentityPreEvidence
      ? createQuickProcessIdentitySkillExecutor(this.traceProcessorService)
      : undefined;
    const focusEvidencePayload = lightweight && !skipFocusDetection && !reusableQuickEvidenceAttempt
      ? buildFocusAppEvidencePayload(focusResult, traceId, 'current', config.outputLanguage)
      : undefined;
    if (focusEvidencePayload?.envelope) {
      this.emitUpdate({
        type: 'data',
        content: [focusEvidencePayload.envelope],
        timestamp: Date.now(),
      });
    }
    const promptFocusResult = focusEvidencePayload?.focusResult ?? focusResult;
    const processIdentityEvidencePromise = quickProcessIdentityExecutor
      ? buildQuickProcessIdentityEvidence({
          skillExecutor: quickProcessIdentityExecutor,
          traceId,
          focusResult: promptFocusResult,
          packageName: effectivePackageName,
          outputLanguage: config.outputLanguage,
        })
      : Promise.resolve(undefined);
    const traceFactEvidencePromise = quickTraceFactPreEvidence
      ? buildQuickTraceFactEvidence({
          traceProcessor: this.traceProcessorService,
          traceId,
          query,
          focusResult: promptFocusResult,
          packageName: effectivePackageName,
          timeRange: focusAppTimeRangeFromSelection(options.selectionContext),
          outputLanguage: config.outputLanguage,
        })
      : Promise.resolve(undefined);
    const architecturePromise = skipQuickTracePreflight
      ? Promise.resolve(undefined)
      : runPreflightPhase('architecture', () => this.detectArchitecture(traceId, effectivePackageName));
    const detectedVendorPromise = skipQuickTracePreflight
      ? Promise.resolve(null)
      : schedulePreflight(() => {
          executionLease?.throwIfAborted();
          return this.detectVendor(traceId);
        });
    const traceCompletenessPromise = lightweight
      ? Promise.resolve(undefined)
      : runPreflightPhase('completeness', async () => this.detectCompleteness(
          traceId,
          await architecturePromise,
        ));
    const referenceTraceId = options.referenceTraceId;
    const fullModeComparisonContextPromise = referenceTraceId && !lightweight
      ? runPreflightPhase('comparison', () => this.buildComparisonContext(traceId, referenceTraceId, config.outputLanguage, options.tracePairContext))
      : undefined;
    const fullModeSkillRegistryReady = !lightweight
      ? runPreflightPhase('skill_registry', async () => {
          await ensureSkillRegistryInitialized();
        })
      : undefined;
    const fullModeKnowledgeBaseContextPromise = !lightweight
      ? runPreflightPhase('knowledge', async () => {
          try {
            const kb = await getExtendedKnowledgeBase();
            return kb.getContextForAI(query, 8);
          } catch {
            return undefined;
          }
        })
      : undefined;

    let architecture: Awaited<ReturnType<OpenAIRuntime['detectArchitecture']>>;
    let detectedVendor: Awaited<ReturnType<OpenAIRuntime['detectVendor']>>;
    let traceCompleteness: Awaited<ReturnType<OpenAIRuntime['detectCompleteness']>>;
    try {
      [architecture, detectedVendor, traceCompleteness] = await Promise.all([
        architecturePromise,
        detectedVendorPromise,
        traceCompletenessPromise,
      ]);
    } catch (error) {
      if (executionLease?.signal.aborted) {
        await settleStartedPreflights();
        executionLease.throwIfAborted();
      }
      throw error;
    }
    await throwIfPreflightAborted();

    const previousTurns = runtime.previousTurns;
    let traceFeatures: ReturnType<typeof extractTraceFeatures> | undefined;
    const getTraceFeatures = () => {
      traceFeatures ??= extractTraceFeatures({
        architectureType: architecture?.type,
        sceneType,
        packageName: effectivePackageName,
      });
      return traceFeatures;
    };

    const [processIdentityEvidence, traceFactEvidence] = await Promise.all([
      processIdentityEvidencePromise,
      traceFactEvidencePromise,
    ]);
    if (processIdentityEvidence?.envelopes.length) {
      this.emitUpdate({
        type: 'data',
        content: processIdentityEvidence.envelopes,
        timestamp: Date.now(),
      });
    }
    if (traceFactEvidence?.envelopes.length) {
      this.emitUpdate({
        type: 'data',
        content: traceFactEvidence.envelopes,
        timestamp: Date.now(),
      });
    }
    const useProcessIdentityEvidenceOnlyQuick = shouldUseEvidenceOnlyQuickAnalysis({
      skipQuickTracePreflightDetection: skipQuickTracePreflight,
      processIdentityEvidence,
    });
    const useTraceFactEvidenceOnlyQuick = shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence,
      traceFactEvidence,
    });
    const useEvidenceOnlyQuick = (
      quickProcessIdentityPreEvidence || quickTraceFactPreEvidence
    )
      && (!quickProcessIdentityPreEvidence || useProcessIdentityEvidenceOnlyQuick)
      && (!quickTraceFactPreEvidence || useTraceFactEvidenceOnlyQuick);
    const directProcessIdentityAnswer = quickProcessIdentityPreEvidence && !quickTraceFactPreEvidence
      ? buildQuickProcessIdentityDirectAnswer({
          evidence: processIdentityEvidence,
          outputLanguage: config.outputLanguage,
        })
      : undefined;
    const directTraceFactAnswer = !quickProcessIdentityPreEvidence
      ? buildQuickTraceFactDirectAnswer({
          evidence: traceFactEvidence,
          outputLanguage: config.outputLanguage,
        })
      : undefined;
    const directQuickAnswer = directProcessIdentityAnswer ?? directTraceFactAnswer;

    if (directQuickAnswer) {
      await throwIfPreflightAborted();
      executionLease?.throwIfAborted();
      const { hypotheses } = this.resetAnalysisSessionState(sessionId);
      return {
        systemPrompt: '',
        tools: [],
        sessionContext,
        previousTurns,
        architecture,
        hypotheses,
        allowedTools: [],
        sessionMapKey: analysisRunSpec.identity.sessionMapKey,
        quickMemoryContextCounts: undefined,
        effectivePackageName,
        comparisonIdentity: undefined,
        directProcessIdentityAnswer,
        directTraceFactAnswer,
        sourceUse: undefined,
      };
    }

    const sqlErrorPartition = analysisContextMemoryPartitionKey(options);
    if (this.sessionSqlErrorPartitions.get(sessionId) !== sqlErrorPartition) {
      this.sessionSqlErrors.delete(sessionId);
      this.sessionSqlErrorPartitions.set(sessionId, sqlErrorPartition);
    }
    let sqlErrors = this.sessionSqlErrors.get(sessionId);
    const ensureSqlErrorsLoaded = () => {
      if (!this.sessionSqlErrors.has(sessionId)) {
        sqlErrors = loadLearnedSqlFixPairs(5, knowledgeScope, options);
        this.sessionSqlErrors.set(sessionId, sqlErrors);
      }
      sqlErrors = this.sessionSqlErrors.get(sessionId) ?? [];
      return sqlErrors;
    };
    if (!skipQuickTracePreflight) {
      ensureSqlErrorsLoaded();
    }
    sqlErrors ??= [];

    const shouldBuildComparisonContext = !!referenceTraceId && (!lightweight || !useEvidenceOnlyQuick);
    const [comparisonContext, knowledgeBaseContext] = await Promise.all([
      shouldBuildComparisonContext
        ? (fullModeComparisonContextPromise
            ?? this.buildComparisonContext(traceId, referenceTraceId!, config.outputLanguage, options.tracePairContext))
        : Promise.resolve(undefined),
      !lightweight
        ? (fullModeKnowledgeBaseContextPromise ?? Promise.resolve(undefined))
        : Promise.resolve(undefined),
    ]);
    if (!useEvidenceOnlyQuick) {
      await (fullModeSkillRegistryReady ?? Promise.resolve());
    }
    await throwIfPreflightAborted();
    executionLease?.throwIfAborted();

    const {
      artifactStore,
      notes,
      analysisPlan,
      previousPlan,
      hypotheses,
      uncertaintyFlags,
    } = this.resetAnalysisSessionState(sessionId);
    const previousFindings = this.collectPreviousFindings(sessionContext);
    const conversationSummary = previousTurns.length > 0
      ? sessionContext.generatePromptContext(2000)
      : undefined;
    const entityStore = sessionContext.getEntityStore();
    const entityContext = this.buildEntityContext(entityStore);
    const skillRegistryReady = !useEvidenceOnlyQuick
      ? (fullModeSkillRegistryReady ?? ensureSkillRegistryInitialized())
      : undefined;
    const traceInfo = lightweight ? undefined : this.traceProcessorService.getTrace(traceId);

    if (skipQuickTracePreflight && !useEvidenceOnlyQuick) {
      const [fallbackArchitecture, fallbackDetectedVendor] = await Promise.all([
        architecture ? Promise.resolve(architecture) : this.detectArchitecture(traceId, effectivePackageName),
        detectedVendor ? Promise.resolve(detectedVendor) : this.detectVendor(traceId),
      ]);
      architecture = fallbackArchitecture;
      detectedVendor = fallbackDetectedVendor;
      sqlErrors = ensureSqlErrorsLoaded();
    }

    const shouldInjectQuickMemoryContext = lightweight && !useEvidenceOnlyQuick;
    const sqlErrorFixPairs = (!lightweight || shouldInjectQuickMemoryContext)
      ? sqlErrors
          .filter((e: any) => e.fixedSql)
          .slice(-3)
          .map((e: any) => ({ errorSql: e.errorSql, errorMessage: e.errorMessage, fixedSql: e.fixedSql }))
      : [];
    const quickMemoryPayload = shouldInjectQuickMemoryContext
      ? buildQuickMemoryContextPayload({
          patternContext: analysisContextUsesPrivateKnowledge(options)
            ? undefined
            : buildPatternContextSection(getTraceFeatures(), knowledgeScope),
          negativePatternContext: analysisContextUsesPrivateKnowledge(options)
            ? undefined
            : buildNegativePatternSection(getTraceFeatures(), knowledgeScope),
          caseBackgroundContext: buildRuntimeCaseBackgroundContext({
            sceneType,
            architectureType: architecture?.type,
            knowledgeScope,
            outputLanguage: config.outputLanguage,
            privateAnalysisContext: analysisContextUsesPrivateKnowledge(options),
          }),
          sqlErrorFixPairs,
          recentSqlResultsContext: sessionContext.generateRecentSqlResultPromptContext(3),
          outputLanguage: config.outputLanguage,
        })
      : undefined;
    const quickMemoryContext = quickMemoryPayload?.text;

    let allowedTools: string[] = [];
    let tools: ReturnType<typeof createOpenAIToolsFromMcpDefinitions> = [];
    let sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'] | undefined;
    if (!useEvidenceOnlyQuick) {
      await (skillRegistryReady ?? ensureSkillRegistryInitialized());
      const skillExecutor = createSkillExecutor(this.traceProcessorService);
      const effectiveSkillRegistry =
        resolveEffectiveSkillRegistryForRuntime(skillRegistry);
      skillExecutor.registerSkills(effectiveSkillRegistry.getAllSkills());
      skillExecutor.setFragmentRegistry(
        effectiveSkillRegistry.getFragmentCache(),
      );

      const skillNotesBudget = createRuntimeSkillNotesBudget(lightweight);
      const mcp = createClaudeMcpServer({
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
        emitUpdate: (update) => this.emitUpdate(update),
        onSkillResult: (result) => {
          if (result.displayResults) {
            this.captureEntitiesFromSkillDisplayResults(result.displayResults, entityStore);
          }
        },
        analysisNotes: notes,
        artifactStore,
        cachedArchitecture: architecture,
        cachedVendor: detectedVendor,
        recentSqlErrors: sqlErrors,
        analysisPlan: lightweight ? undefined : analysisPlan,
        watchdogWarning: { current: null },
        hypotheses,
        sceneType,
        uncertaintyFlags,
        referenceTraceId: options.referenceTraceId,
        comparisonContext,
        lightweight,
        skillNotesBudget,
        outputLanguage: config.outputLanguage,
        knowledgeScope,
        codeAwareMode: options.codeAwareMode,
        codebaseIds: options.codebaseIds,
        knowledgeSourceIds: options.knowledgeSourceIds,
        sourceUsePolicy: options.sourceUsePolicy,
        analysisContextFingerprint: options.analysisContextFingerprint,
        androidInternalsPackPin: options.androidInternalsPackPin,
      });
      allowedTools = mcp.allowedTools;
      tools = createOpenAIToolsFromMcpDefinitions(mcp.toolDefinitions);
      sourceUse = mcp.sourceUse;
    }

    const systemPrompt = lightweight
      ? buildQuickSystemPrompt({
          architecture,
          packageName: effectivePackageName,
          focusApps: promptFocusResult.apps.length > 0 ? promptFocusResult.apps : undefined,
          focusMethod: promptFocusResult.method,
          selectionContext: options.selectionContext,
          runtimeEvidenceContext: joinRuntimeEvidenceContexts(
            sanitizeRuntimeQuickEvidenceRoutingContext(
              reusableQuickEvidenceAttempt?.runtimeEvidenceContext,
              config.outputLanguage,
            ),
            processIdentityEvidence?.promptContext,
            traceFactEvidence?.promptContext,
          ),
          quickMemoryContext,
          outputLanguage: config.outputLanguage,
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
        })
      : buildSystemPrompt({
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
          availableAgents: undefined,
          sqlErrorFixPairs: sqlErrorFixPairs.length > 0 ? sqlErrorFixPairs : undefined,
          patternContext: analysisContextUsesPrivateKnowledge(options)
            ? undefined
            : buildPatternContextSection(getTraceFeatures(), knowledgeScope),
          negativePatternContext: analysisContextUsesPrivateKnowledge(options)
            ? undefined
            : buildNegativePatternSection(getTraceFeatures(), knowledgeScope),
          caseBackgroundContext: buildRuntimeCaseBackgroundContext({
            sceneType,
            architectureType: architecture?.type,
            knowledgeScope,
            outputLanguage: config.outputLanguage,
            privateAnalysisContext: analysisContextUsesPrivateKnowledge(options),
          }),
          previousPlan,
          planHistory: analysisPlan.history.length > 0 ? analysisPlan.history : undefined,
          selectionContext: options.selectionContext,
          comparison: comparisonContext,
          traceCompleteness,
          traceOs: traceInfo?.traceOs,
          traceFormat: traceInfo?.traceFormat,
          outputLanguage: config.outputLanguage,
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
        } satisfies ClaudeAnalysisContext);

    const sessionMapKey = analysisRunSpec.identity.sessionMapKey;

    return {
      systemPrompt,
      tools,
      sessionContext,
      previousTurns,
      architecture,
      hypotheses,
      allowedTools,
      sessionMapKey,
      quickMemoryContextCounts: quickMemoryPayload?.counts,
      effectivePackageName,
      sourceUse,
      ...(comparisonContext ? {
        comparisonIdentity: {
          currentPackageName: effectivePackageName,
          referencePackageName: comparisonContext.referencePackageName,
        } satisfies FinalResultComparisonIdentity,
      } : {}),
      directProcessIdentityAnswer,
      directTraceFactAnswer,
    };
  }

  private async detectArchitecture(
    traceId: string,
    packageName?: string,
  ): Promise<ArchitectureInfo | undefined> {
    const cached = getLruCacheEntry(this.architectureCache, traceId);
    if (cached) return cached;
    try {
      const detector = createArchitectureDetector();
      const architecture = await detector.detect({
        traceId,
        traceProcessorService: this.traceProcessorService,
        packageName,
      });
      if (architecture) {
        setLruCacheEntry(this.architectureCache, traceId, architecture);
        this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
      }
      return architecture;
    } catch (error) {
      console.warn('[OpenAIRuntime] Architecture detection failed:', (error as Error).message);
      return undefined;
    }
  }

  private async buildComparisonContext(
    traceId: string,
    referenceTraceId: string,
    outputLanguage: OutputLanguage,
    tracePairContext?: TracePairContext,
  ): Promise<import('../../../agentv3/types').ComparisonContext> {
    this.emitUpdate({
      type: 'progress',
      content: {
        phase: 'starting',
        message: localize(
          outputLanguage,
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
      ...(tracePairContext ? {tracePairContext} : {}),
      detectReferenceArchitecture: id => this.detectArchitecture(id, undefined),
      onCapabilityQueryError: (side, error) => {
        console.warn(
          `[OpenAIRuntime] Capability query failed for ${side} trace:`,
          (error as Error).message,
        );
      },
    });
    if (!comparisonContext) {
      throw new Error('Reference trace comparison context was not created');
    }
    return comparisonContext;
  }

  private async detectVendor(traceId: string): Promise<string | null> {
    const cached = getLruCacheEntry(this.vendorCache, traceId);
    if (cached) return cached;
    try {
      const adapter = getSkillAnalysisAdapter(this.traceProcessorService);
      await adapter.ensureInitialized();
      const result = await adapter.detectVendor(traceId);
      if (result.vendor && result.vendor !== 'aosp') {
        setLruCacheEntry(this.vendorCache, traceId, result.vendor);
      }
      return result.vendor;
    } catch (error) {
      console.warn('[OpenAIRuntime] Vendor detection failed:', (error as Error).message);
      return null;
    }
  }

  private async detectCompleteness(
    traceId: string,
    architecture?: ArchitectureInfo,
  ): Promise<TraceCompleteness | undefined> {
    try {
      return await probeTraceCompleteness(
        this.traceProcessorService,
        traceId,
        architecture?.type,
      );
    } catch (error) {
      console.warn('[OpenAIRuntime] Trace completeness probe failed:', (error as Error).message);
      return undefined;
    }
  }

  /**
   * Decide quickMode for this request. Provider-symmetric to ClaudeRuntime:
   *   explicit fast/full → user wins; auto → keyword/hard rules first, then
   *   OpenAI light-model AI fallback. Stays provider-independent: never calls
   *   the Anthropic SDK, even when the operator hasn't installed it.
   */
  private async classifyModeForRequest(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    sceneType: SceneType,
    config: OpenAIAgentConfig,
    analysisSignal?: AbortSignal,
  ): Promise<OpenAIModeClassification> {
    const explicitMode = options.analysisMode;
    if (options.assistantSurface === 'conversation') {
      return {
        quickMode: true,
        source: 'user_explicit',
        reason: 'conversation surface uses on-demand evidence',
        skipQuickTracePreflightDetection: true,
        quickAcknowledgementDirectAnswer: false,
        quickFocusAppPreEvidence: false,
        quickProcessIdentityPreEvidence: false,
        quickTraceFactPreEvidence: false,
        quickScrollingTriagePreEvidence: false,
      };
    }
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() ?? [];
    const classifierInput: ComplexityClassifierInput = buildComplexityClassifierInput({
      query,
      sceneType,
      selectionContext: options.selectionContext,
      hasReferenceTrace: !!options.referenceTraceId,
      previousTurns,
    });
    const deriveFlags = (classification: { complexity?: string; reason?: string } | undefined) =>
      deriveRuntimeQuickPreEvidenceFlags({
        query,
        selectionContext: options.selectionContext,
        packageName: options.packageName,
        hasReferenceTrace: !!options.referenceTraceId,
        directEvidenceEligibleQuickMode: !options.referenceTraceId && classification?.complexity === 'quick',
        complexity: classification?.complexity,
        reason: classification?.reason,
      });
    const shouldSkipQuickPreflightForEvidence = (flags: ReturnType<typeof deriveFlags>) => (
      flags.quickProcessIdentityPreEvidence || flags.quickTraceFactPreEvidence
    );

    if (explicitMode === 'fast') {
      const local = classifyQueryComplexityLocal(classifierInput);
      const flags = deriveRuntimeQuickPreEvidenceFlags({
        query,
        selectionContext: options.selectionContext,
        packageName: options.packageName,
        hasReferenceTrace: !!options.referenceTraceId,
        directEvidenceEligibleQuickMode: !options.referenceTraceId,
        complexity: local?.complexity,
        reason: local?.reason,
      });
      const quickAcknowledgementDirectAnswer = !!local
        && local.complexity === 'quick'
        && isAcknowledgementFollowupReason(local.reason);
      return {
        quickMode: true,
        source: 'user_explicit',
        reason: 'user requested fast',
        skipQuickTracePreflightDetection: shouldSkipQuickPreflightForEvidence(flags),
        quickAcknowledgementDirectAnswer,
        ...flags,
      };
    }
    if (explicitMode === 'full') {
      return {
        quickMode: false,
        source: 'user_explicit',
        reason: 'user requested full',
        skipQuickTracePreflightDetection: false,
        quickAcknowledgementDirectAnswer: false,
        quickFocusAppPreEvidence: false,
        quickProcessIdentityPreEvidence: false,
        quickTraceFactPreEvidence: false,
        quickScrollingTriagePreEvidence: false,
      };
    }

    const local = classifyQueryComplexityLocal(classifierInput);
    if (local) {
      console.log(`[OpenAIRuntime] auto → ${local.complexity} (${local.source}: ${local.reason})`);
      const flags = deriveFlags(local);
      const quickAcknowledgementDirectAnswer = local.complexity === 'quick'
        && isAcknowledgementFollowupReason(local.reason);
      return {
        quickMode: local.complexity === 'quick',
        source: local.source,
        reason: local.reason,
        skipQuickTracePreflightDetection: shouldSkipQuickPreflightForEvidence(flags),
        quickAcknowledgementDirectAnswer,
        ...flags,
      };
    }

    const ai = await classifyQueryWithOpenAILightModel(classifierInput, config, analysisSignal);
    console.log(`[OpenAIRuntime] auto → ${ai.complexity} (ai: ${ai.reason})`);
    const flags = deriveFlags(ai);
    return {
      quickMode: ai.complexity === 'quick',
      source: 'ai',
      reason: ai.reason,
      skipQuickTracePreflightDetection: shouldSkipQuickPreflightForEvidence(flags),
      quickAcknowledgementDirectAnswer: ai.complexity === 'quick' &&
        isAcknowledgementFollowupReason(ai.reason),
      ...flags,
    };
  }

  private getPlanCompletionStatus(sessionId: string, quickMode: boolean): PlanCompletionStatus {
    const plan = this.sessionPlans.get(sessionId)?.current ?? null;
    return getAnalysisPlanCompletionStatus(plan, {
      quickMode,
      minSummaryChars: MIN_PHASE_SUMMARY_CHARS,
    });
  }

  private reconcileCompletedConclusionPhase(input: {
    sessionId: string;
    quickMode: boolean;
    conclusion: string;
    query?: string;
    sceneType?: SceneType;
    comparisonIdentity?: FinalResultComparisonIdentity;
  }): boolean {
    if (input.quickMode) return false;
    const conclusion = sanitizeOpenAiConclusionText(input.conclusion);
    const phase = reconcileDeliveredFinalReportPhase({
      plan: this.sessionPlans.get(input.sessionId)?.current,
      conclusion,
      minSummaryChars: MIN_PHASE_SUMMARY_CHARS,
      isDeliverableReport: candidate => (
        isSubstantialReportText(candidate) &&
        !assessFinalReportContractCompleteness({
          conclusion: candidate,
          query: input.query,
          sceneType: input.sceneType,
        }) &&
        !assessFinalResultComparisonIdentity(candidate, input.comparisonIdentity)
      ),
      buildSummary: candidate => candidate.replace(/\s+/g, ' ').trim().slice(0, 600),
    });
    if (!phase) return false;
    this.emitUpdate({
      type: 'plan_phase_updated',
      content: {
        phaseId: phase.id,
        phaseName: phase.name,
        status: 'completed',
        summary: phase.summary,
        reconciledFromFinalReport: true,
      },
      timestamp: Date.now(),
    });
    return true;
  }

  private shouldFinalizeAfterPlanComplete(
    sessionId: string,
    quickMode: boolean,
    answer: string,
    fallbackAnswer = '',
  ): boolean {
    if (quickMode) {
      return false;
    }
    const status = this.getPlanCompletionStatus(sessionId, quickMode);
    if (!status.complete) {
      return false;
    }
    return answer.trim().length > 0 ||
      fallbackAnswer.trim().length > 0 ||
      this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, DEFAULT_OUTPUT_LANGUAGE) !== undefined;
  }

  private shouldRequestFinalReportAfterPlanComplete(input: {
    sessionId?: string;
    quickMode: boolean;
    planStatus: PlanCompletionStatus;
    conclusion: string;
    fallbackConclusion?: string;
    completedByPlanIdle: boolean;
    timedOut: boolean;
    finalReportContinuations: number;
    query?: string;
    sceneType?: SceneType;
    comparisonIdentity?: FinalResultComparisonIdentity;
    qualityIssue?: FinalResultQualityIssue;
  }): boolean {
    if (
      input.quickMode ||
      !input.planStatus.complete ||
      input.timedOut ||
      input.finalReportContinuations >= OPENAI_MAX_FINAL_REPORT_CONTINUATIONS
    ) {
      return false;
    }

    const conclusion = input.conclusion.trim();
    const fallback = input.fallbackConclusion?.trim();
    if (!conclusion) return true;
    if (fallback && isSameConclusionText(conclusion, fallback)) return true;
    if (looksLikePhaseSummaryFallback(conclusion)) return true;
    if (!hasDeliverableFinalReportHeading(conclusion)) return true;
    if (looksLikeProcessNarrationParagraph(conclusion)) return true;
    if (assessFinalReportContractCompleteness({
      conclusion,
      query: input.query,
      sceneType: input.sceneType,
    })) {
      return true;
    }
    if (assessFinalResultComparisonIdentity(conclusion, input.comparisonIdentity)) return true;
    if (input.sessionId && this.finalReportMissingCodeReference(input.sessionId, conclusion)) return true;
    if (looksLikeProcessNarrationParagraph(conclusion.split(/\n{2,}/)[0] || '')) return true;
    if (findCriticalFindingsWithoutEvidence(extractFindingsFromText(conclusion)).length > 0) return true;
    return Boolean(input.qualityIssue ?? this.assessFinalReportQualityIssue({
      sessionId: input.sessionId,
      conclusion,
      query: input.query,
      sceneType: input.sceneType,
      comparisonIdentity: input.comparisonIdentity,
    }));
  }

  private assessFinalReportQualityIssue(input: {
    sessionId?: string;
    conclusion: string;
    query?: string;
    sceneType?: SceneType;
    comparisonIdentity?: FinalResultComparisonIdentity;
  }): FinalResultQualityIssue | undefined {
    return assessFinalResultQuality({
      result: {
        sessionId: input.sessionId || 'openai-final-report-quality-check',
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
  }

  private finalReportMissingCodeReference(sessionId: string, conclusion: string): boolean {
    return finalReportMissingRequiredCodeReference({
      plan: this.sessionPlans.get(sessionId)?.current,
      conclusion,
    });
  }

  private buildFinalReportAfterPlanCompletePrompt(input: {
    outputLanguage: OutputLanguage;
    missingSections?: FinalReportContractCompletenessResult['missingSections'];
    qualityIssue?: FinalResultQualityIssue;
    requireCodeReference?: boolean;
  }): string {
    const templateName = input.outputLanguage === 'en'
      ? 'prompt-openai-final-report-continuation-en'
      : 'prompt-openai-final-report-continuation-zh';
    const template = loadPromptTemplate(templateName);
    if (!template) {
      throw new Error(`Missing OpenAI final-report continuation prompt template: ${templateName}`);
    }
    let prompt = template;

    if (input.missingSections?.length) {
      const missingSectionsTemplateName = input.outputLanguage === 'en'
        ? 'prompt-final-report-missing-sections-en'
        : 'prompt-final-report-missing-sections-zh';
      const missingSectionsTemplate = loadPromptTemplate(missingSectionsTemplateName);
      if (!missingSectionsTemplate) {
        throw new Error(`Missing final-report missing-sections prompt template: ${missingSectionsTemplateName}`);
      }
      prompt += `\n\n${renderTemplate(missingSectionsTemplate, {
        missing_sections: input.missingSections
          .map(section => `- ${section.label}${section.description ? `: ${section.description}` : ''}`)
          .join('\n'),
      })}`;
    }

    if (input.qualityIssue) {
      const qualityTemplateName = input.outputLanguage === 'en'
        ? 'prompt-final-report-quality-issue-en'
        : 'prompt-final-report-quality-issue-zh';
      const qualityTemplate = loadPromptTemplate(qualityTemplateName);
      if (!qualityTemplate) {
        throw new Error(`Missing final-report quality prompt template: ${qualityTemplateName}`);
      }
      prompt += `\n\n${renderTemplate(qualityTemplate, {
        quality_issue_context: serializeFinalResultQualityIssueContext(input.qualityIssue),
      })}`;
    }

    return input.requireCodeReference
      ? `${prompt}\n\n${loadCodeReferenceContractPrompt(input.outputLanguage)}`
      : prompt;
  }

  private formatPlanCompleteReportContinuationMessage(outputLanguage: OutputLanguage): string {
    return localize(
      outputLanguage,
      '最终报告仍需补齐，继续整理完整结论。',
      'The final report still needs completion; continuing to assemble the full conclusion.',
    );
  }

  private buildCompletedPlanFallbackConclusion(
    sessionId: string,
    quickMode: boolean,
    outputLanguage: OutputLanguage,
  ): string | undefined {
    if (quickMode) return undefined;
    const plan = this.sessionPlans.get(sessionId)?.current ?? null;
    if (!plan || plan.phases.length === 0) return undefined;
    if (!this.getPlanCompletionStatus(sessionId, quickMode).complete) return undefined;

    const summaries = plan.phases
      .filter(hasAdequateClosedPhaseSummary)
      .map(phase => {
        const name = phase.name || phase.id;
        return `- ${name}: ${cleanPlanSummaryForFinalReport(phase.summary || '')}`;
      });
    if (summaries.length === 0) return undefined;

    const finalPhase = [...plan.phases]
      .reverse()
      .find(phase => hasAdequateClosedPhaseSummary(phase) &&
        isConclusionLikePlanPhase(phase));
    const finalSummary = cleanPlanSummaryForFinalReport(
      finalPhase?.summary?.trim() || summaries[summaries.length - 1]?.replace(/^-\s*[^:]+:\s*/, '') || '',
    );
    const evidenceBullets = plan.phases
      .filter(phase => hasAdequateClosedPhaseSummary(phase) && !isConclusionLikePlanPhase(phase))
      .map(phase => {
        const name = phase.name || phase.id;
        return `- ${name}: ${cleanPlanSummaryForFinalReport(phase.summary || '')}`;
      })
      .filter(line => line.trim().length > 4)
      .slice(0, 8)
      .join('\n');

    return localize(
      outputLanguage,
      [
        '## 综合结论',
        '',
        finalSummary || '分析计划已完成，以下结论基于已采集的结构化证据收敛。',
        '',
        '## 关键证据链',
        '',
        evidenceBullets || '- 已完成的计划阶段均有结构化证据支撑。',
        '',
        '## 根因拆解',
        '',
        '- 以上证据按阶段产出、关键指标、已确认假设和已排除因素归并；优化优先级以已验证且可执行的瓶颈为准。',
        '',
        '## 优化建议',
        '',
        '- 优先处理证据支持的可操作瓶颈；对已排除但风险较高的因素保留必要监控。',
        '',
        '## 置信度/限制',
        '',
        '- 结论基于已完成计划阶段的结构化证据收敛；若需要代码级 owner 定位，应结合源码符号继续分析。',
      ].join('\n'),
      [
        '## Final Conclusion',
        '',
        finalSummary || 'The analysis plan completed; this conclusion is synthesized from the collected structured evidence.',
        '',
        '## Key Evidence',
        '',
        evidenceBullets || '- Completed plan phases contain structured evidence.',
        '',
        '## Root Cause Breakdown',
        '',
        '- The evidence is grouped by phase outputs, key metrics, confirmed hypotheses, and excluded factors; optimization priority should follow verified and actionable bottlenecks.',
        '',
        '## Recommendations',
        '',
        '- Prioritize actionable bottlenecks supported by evidence; keep monitoring excluded factors that still carry residual risk.',
        '',
        '## Confidence / Limits',
        '',
        '- This conclusion is synthesized from structured evidence collected by the completed plan phases. Use source-code symbol lookup for owner-level fixes.',
      ].join('\n'),
    );
  }

  private buildPlanPhaseSummaryFallbackConclusion(
    sessionId: string,
    quickMode: boolean,
    outputLanguage: OutputLanguage,
  ): string | undefined {
    if (quickMode) return undefined;
    const plan = this.sessionPlans.get(sessionId)?.current ?? null;
    if (!plan || plan.phases.length === 0) return undefined;

    const summaries = plan.phases
      .filter(hasAdequateClosedPhaseSummary)
      .map(phase => `- ${phase.id} ${phase.name || phase.id}: ${phase.summary?.trim()}`);
    if (summaries.length === 0) return undefined;

    const status = this.getPlanCompletionStatus(sessionId, quickMode);
    if (status.complete) {
      return this.buildCompletedPlanFallbackConclusion(sessionId, quickMode, outputLanguage);
    }

    const pending = status.pendingPhases
      .map(phase => `${phase.id}:${phase.name || phase.id}`)
      .join(', ');
    return localize(
      outputLanguage,
      `OpenAI 流在计划完成前中断。以下是已完成阶段的可用摘要：\n\n${summaries.join('\n')}\n\n未完成阶段：${pending || '无'}`,
      `The OpenAI stream ended before the plan completed. Usable summaries from completed phases:\n\n${summaries.join('\n')}\n\nPending phases: ${pending || 'none'}`,
    );
  }

  private recoverPartialResultAfterStreamTermination(params: {
    error: unknown;
    sessionId: string;
    quickMode: boolean;
    outputLanguage: OutputLanguage;
    accumulatedAnswer: string;
    context: Awaited<ReturnType<OpenAIRuntime['prepareAnalysisContext']>>;
    query: string;
    startTime: number;
    rounds: number;
    quickBudget?: ReturnType<typeof resolveQuickTurnBudget>;
    requestedMode?: AnalysisOptions['analysisMode'];
    frontendPrequeryInjected?: number;
    codeAwareMode?: AnalysisOptions['codeAwareMode'];
    knowledgeSourceIds?: string[];
  }): AnalysisResult | undefined {
    if (!isRecoverableOpenAIStreamTermination(params.error)) {
      return undefined;
    }

    const planStatus = this.getPlanCompletionStatus(params.sessionId, params.quickMode);
    const fallbackConclusion = this.buildPlanPhaseSummaryFallbackConclusion(
      params.sessionId,
      params.quickMode,
      params.outputLanguage,
    );
    const conclusionBase = chooseOpenAiConclusionText({
      candidate: params.accumulatedAnswer || fallbackConclusion || '',
      accumulatedAnswer: params.accumulatedAnswer,
      completedByPlanIdle: false,
      planComplete: planStatus.complete,
      fallbackConclusion,
    });
    if (!conclusionBase.trim()) {
      return undefined;
    }

    const message = formatOpenAIError(params.error);
    let conclusion = planStatus.complete
      ? conclusionBase
      : this.withIncompletePlanWarning(conclusionBase, planStatus, params.outputLanguage);
    if ((params.codeAwareMode && params.codeAwareMode !== 'off') || params.knowledgeSourceIds?.length) {
      conclusion = sanitizeCodeAwareText(params.sessionId, conclusion);
    }
    const findings = extractFindingsFromText(conclusion);
    const confidence = Math.min(0.55, this.estimateConfidence(findings, conclusion));
    const terminationReason: AnalysisTerminationReason = planStatus.complete ? 'timeout' : 'plan_incomplete';
    const terminationMessage = localize(
      params.outputLanguage,
      `OpenAI stream 在分析过程中中断：${message}。已保留已完成阶段的部分结果。`,
      `The OpenAI stream terminated during analysis: ${message}. Preserving partial results from completed phases.`,
    );

    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'openAiRuntime',
        fallback: 'partial_result_after_stream_termination',
        partial: true,
        terminationReason,
        message: terminationMessage,
      },
      timestamp: Date.now(),
    });

    const result: AnalysisResult = {
      sessionId: params.sessionId,
      success: true,
      findings,
      hypotheses: params.context.hypotheses.map(h => this.toProtocolHypothesis(h)),
      conclusion,
      confidence,
      rounds: params.rounds,
      totalDurationMs: Date.now() - params.startTime,
      partial: true,
      terminationReason,
      terminationMessage,
      quickRun: params.quickMode && params.quickBudget
        ? buildQuickRunReceipt({
            requestedMode: params.requestedMode ?? 'auto',
            profile: shouldMarkQuickRunTriage(params.query) ? 'triage' : undefined,
            budget: params.quickBudget,
            actualTurns: params.rounds,
            elapsedMs: Date.now() - params.startTime,
            stopReason: quickStopReasonFromTermination({
              partial: true,
              terminationReason,
              actualTurns: params.rounds,
              targetTurns: params.quickBudget.targetTurns,
              hardCapTurns: params.quickBudget.hardCapTurns,
            }),
            evidence: {
              frontendPrequeryInjected: params.frontendPrequeryInjected ?? 0,
              },
              contextInjected: {
                conversationTurns: countCompletedQuickConversationTurns(params.context.previousTurns),
                ...(params.context.quickMemoryContextCounts ?? {
                  recentSqlResults: 0,
                  sqlPitfallPairs: 0,
                patternHints: 0,
                negativePatternHints: 0,
                caseBackgroundCases: 0,
              }),
            },
          })
        : undefined,
    };

    this.recordTurn({
      query: params.query,
      sessionId: params.sessionId,
      result,
      sessionContext: params.context.sessionContext,
      previousTurnCount: params.context.previousTurns.length,
      quickMode: params.quickMode,
    });

    this.emitUpdate({
      type: 'conclusion',
      content: { conclusion, durationMs: Date.now() - params.startTime, turns: params.rounds },
      timestamp: Date.now(),
    });
    this.emitUpdate({
      type: 'answer_token',
      content: { done: true, totalChars: conclusion.length },
      timestamp: Date.now(),
    });

    return result;
  }

  private recordMaxTurnsPartialResult(params: {
    error: { message?: string };
    query: string;
    sessionId: string;
    outputLanguage: OutputLanguage;
    accumulatedAnswer: string;
    context: Pick<
      Awaited<ReturnType<OpenAIRuntime['prepareAnalysisContext']>>,
      'hypotheses' | 'sessionContext' | 'previousTurns' | 'quickMemoryContextCounts'
    >;
    startTime: number;
    rounds: number;
    quickMode: boolean;
    maxTurns?: number;
    quickBudget?: ReturnType<typeof resolveQuickTurnBudget>;
    requestedMode?: AnalysisOptions['analysisMode'];
    frontendPrequeryInjected?: number;
    codeAwareMode?: AnalysisOptions['codeAwareMode'];
    knowledgeSourceIds?: string[];
  }): AnalysisResult {
    const maxTurnText = Number.isFinite(params.maxTurns)
      ? localize(
          params.outputLanguage,
          `（当前上限 ${params.maxTurns} turns）`,
          ` (current limit: ${params.maxTurns} turns)`,
        )
      : '';
    let partialConclusion = params.accumulatedAnswer || localize(
      params.outputLanguage,
      `分析达到轮次上限${maxTurnText}，尚未形成完整结论。`,
      `The analysis reached the turn limit${maxTurnText} before a complete conclusion was produced.`,
    );
    if ((params.codeAwareMode && params.codeAwareMode !== 'off') || params.knowledgeSourceIds?.length) {
      partialConclusion = sanitizeCodeAwareText(params.sessionId, partialConclusion);
    }
    const findings = extractFindingsFromText(partialConclusion);
    const confidence = Math.min(0.55, this.estimateConfidence(findings, partialConclusion));
    const result: AnalysisResult = {
      sessionId: params.sessionId,
      success: true,
      findings,
      hypotheses: params.context.hypotheses.map(h => this.toProtocolHypothesis(h)),
      conclusion: partialConclusion,
      confidence,
      rounds: params.rounds,
      totalDurationMs: Date.now() - params.startTime,
      partial: true,
      terminationReason: 'max_turns',
      terminationMessage: params.error.message,
      quickRun: params.quickMode && params.quickBudget
        ? buildQuickRunReceipt({
            requestedMode: params.requestedMode ?? 'auto',
            profile: shouldMarkQuickRunTriage(params.query) ? 'triage' : undefined,
            budget: params.quickBudget,
            actualTurns: params.rounds,
            elapsedMs: Date.now() - params.startTime,
            stopReason: quickStopReasonFromTermination({
              partial: true,
              terminationReason: 'max_turns',
              actualTurns: params.rounds,
              targetTurns: params.quickBudget.targetTurns,
              hardCapTurns: params.quickBudget.hardCapTurns,
            }),
            evidence: {
              frontendPrequeryInjected: params.frontendPrequeryInjected ?? 0,
              },
              contextInjected: {
                conversationTurns: countCompletedQuickConversationTurns(params.context.previousTurns),
                ...(params.context.quickMemoryContextCounts ?? {
                  recentSqlResults: 0,
                  sqlPitfallPairs: 0,
                patternHints: 0,
                negativePatternHints: 0,
                caseBackgroundCases: 0,
              }),
            },
          })
        : undefined,
    };

    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'openAiRuntime',
        fallback: 'partial_result_after_max_turns',
        partial: true,
        terminationReason: 'max_turns',
        message: this.formatOpenAiMaxTurnsMessage(params.outputLanguage, params.maxTurns),
      },
      timestamp: Date.now(),
    });
    this.recordTurn({
      query: params.query,
      sessionId: params.sessionId,
      result,
      sessionContext: params.context.sessionContext,
      previousTurnCount: params.context.previousTurns.length,
      quickMode: params.quickMode,
    });
    this.emitUpdate({
      type: 'conclusion',
      content: { conclusion: result.conclusion, durationMs: Date.now() - params.startTime, turns: params.rounds },
      timestamp: Date.now(),
    });
    this.emitUpdate({
      type: 'answer_token',
      content: { done: true, totalChars: result.conclusion.length },
      timestamp: Date.now(),
    });

    return result;
  }

  private formatOpenAiMaxTurnsMessage(outputLanguage: OutputLanguage, maxTurns?: number): string {
    const maxTurnText = Number.isFinite(maxTurns)
      ? localize(outputLanguage, `（当前上限 ${maxTurns} turns）`, ` (current limit: ${maxTurns} turns)`)
      : '';
    return localize(
      outputLanguage,
      `OpenAI 分析达到轮次上限${maxTurnText}，结果可能不完整。可在 Provider Manager 提高 Max Turns，或清空该字段使用默认 100。`,
      `OpenAI analysis reached the turn limit${maxTurnText}; the result may be incomplete. Raise Max Turns in Provider Manager, or clear the field to use the default 100.`,
    );
  }

  private formatPlanContinuationMessage(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    if (!status.hasPlan) {
      return localize(
        outputLanguage,
        '继续建立分析计划并补齐必要证据...',
        'Continuing by creating the analysis plan and collecting required evidence...',
      );
    }
    if (status.evidenceGaps && status.evidenceGaps.length > 0) {
      const gaps = status.evidenceGaps
        .map(gap => formatPlanEvidenceGap(gap, outputLanguage))
        .slice(0, 3)
        .join(outputLanguage === 'en' ? '; ' : '；');
      return localize(
        outputLanguage,
        `继续补齐缺失的关键工具证据：${gaps}`,
        `Continuing the missing required tool evidence: ${gaps}`,
      );
    }
    const phaseNames = status.pendingPhases.map(p => p.name || p.id).slice(0, 3).join('、');
    return localize(
      outputLanguage,
      `继续补齐剩余分析阶段：${phaseNames}`,
      `Continuing the remaining analysis phases: ${phaseNames}`,
    );
  }

  private formatIncompletePlanMessage(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    if (!status.hasPlan) {
      return localize(
        outputLanguage,
        'OpenAI 分析没有提交 plan，结果只能作为不完整分析使用。',
        'OpenAI analysis did not submit a plan; treat the result as incomplete.',
      );
    }
    const phaseNames = status.pendingPhases.map(p => `${p.id}:${p.name}`).join(', ');
    const evidenceGapText = status.evidenceGaps?.length
      ? outputLanguage === 'en'
        ? `; missing required tool evidence: ${status.evidenceGaps.map(gap => formatPlanEvidenceGap(gap, outputLanguage)).join('; ')}`
        : `；缺失关键工具证据：${status.evidenceGaps.map(gap => formatPlanEvidenceGap(gap, outputLanguage)).join('；')}`
      : '';
    return localize(
      outputLanguage,
      `OpenAI 分析达到继续执行上限，但 plan 仍未完成。未完成阶段：${phaseNames}${evidenceGapText}`,
      `OpenAI analysis reached the continuation limit, but the plan is still incomplete. Pending phases: ${phaseNames}${evidenceGapText}`,
    );
  }

  private buildPlanContinuationPrompt(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    const pending = status.pendingPhases.map(phase => {
      const tools = expectedToolNames(phase).length ? `；预期调用: ${expectedToolNames(phase).join(', ')}` : '';
      return `- ${phase.id} ${phase.name}: ${phase.goal}${tools}`;
    }).join('\n');
    const gapText = status.evidenceGaps?.length
      ? outputLanguage === 'en'
        ? `\n\nMissing required tool evidence:\n${status.evidenceGaps.map(gap => `- ${formatPlanEvidenceGap(gap, outputLanguage)}`).join('\n')}`
        : `\n\n缺失的关键工具证据：\n${status.evidenceGaps.map(gap => `- ${formatPlanEvidenceGap(gap, outputLanguage)}`).join('\n')}`
      : '';

    return localize(
      outputLanguage,
      status.hasPlan
        ? `系统校验：你刚才给出了阶段性回答，但当前分析 plan 还没有完成，所以那不是最终答案。请继续执行剩余阶段，不要重述已完成内容。\n\n未完成阶段：\n${pending}${gapText}\n\n要求：继续调用必要工具收集证据；完成或跳过每个阶段时必须调用 update_plan_phase；只有所有阶段 completed/skipped 后，才能输出最终结论。`
        : '系统校验：你刚才直接回答了用户，但当前是 full 分析模式，尚未调用 submit_plan。请先调用 submit_plan 建立分析计划，然后执行必要工具。只有所有计划阶段 completed/skipped 后，才能输出最终结论。',
      status.hasPlan
        ? `System check: you produced an interim answer, but the analysis plan is not complete, so that was not a final answer. Continue the remaining phases without restating completed work.\n\nPending phases:\n${pending}${gapText}\n\nRequirements: call the necessary tools to collect evidence; call update_plan_phase whenever completing or skipping each phase; only produce the final conclusion after every phase is completed or skipped.`
        : 'System check: you answered directly, but this is full analysis mode and submit_plan has not been called. Call submit_plan first, then execute the necessary tools. Only produce the final conclusion after every planned phase is completed or skipped.',
    );
  }

  private withIncompletePlanWarning(
    conclusion: string,
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    const warning = this.formatIncompletePlanMessage(status, outputLanguage);
    return conclusion.trim()
      ? `${warning}\n\n${conclusion}`
      : warning;
  }

  private shouldExposeOpenAiAnswerDelta(sessionId: string, quickMode: boolean): boolean {
    return quickMode || this.getPlanCompletionStatus(sessionId, quickMode).complete;
  }

  private handleStreamEvent(
    event: RunStreamEvent,
    outputLanguage: OutputLanguage,
    streamContext: {
      sessionId: string;
      quickMode: boolean;
      answerStreamFilter: OpenAiReasoningFilterState;
      answerTextProjection?: CodeAwareStreamingTextProjection;
      runtimePerformance?: RuntimePerformanceRun;
      toolInputsByTaskId: Map<string, { toolName: string; args: Record<string, unknown> }>;
      tracePairContext?: TracePairContext;
      onToolCalled?: () => void;
      onSuppressedAnswerDelta?: (delta: string) => void;
    },
  ): string {
    const now = Date.now();
    if (event.type === 'raw_model_stream_event') {
      const data = event.data as any;
      if (data?.type === 'output_text_delta' && typeof data.delta === 'string') {
        const delta = filterOpenAiVisibleAnswerDelta(data.delta, streamContext.answerStreamFilter);
        if (!this.shouldExposeOpenAiAnswerDelta(streamContext.sessionId, streamContext.quickMode)) {
          if (delta) streamContext.onSuppressedAnswerDelta?.(delta);
          return '';
        }
        if (!delta) return '';
        const projected = streamContext.answerTextProjection?.write(delta) ?? delta;
        if (projected) {
          streamContext.runtimePerformance?.recordFirstOutput();
          this.emitUpdate({type: 'answer_token', content: {token: projected}, timestamp: now});
        }
        return delta;
      }
      return '';
    }

    if (event.type === 'agent_updated_stream_event') {
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: localize(
            outputLanguage,
            `切换到 OpenAI Agent: ${event.agent.name}`,
            `Switched to OpenAI Agent: ${event.agent.name}`,
          ),
        },
        timestamp: now,
      });
      return '';
    }

    const rawItem = (event.item as any)?.rawItem;
    if (event.name === 'tool_called') {
      streamContext.onToolCalled?.();
      const args = parseJsonObject(rawItem?.arguments) || {};
      const taskIds = [rawItem?.callId, rawItem?.call_id, rawItem?.id]
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      for (const taskId of taskIds) {
        streamContext.toolInputsByTaskId.set(taskId, {
          toolName: rawItem?.name || 'unknown',
          args,
        });
      }
      this.emitUpdate({
        type: 'agent_task_dispatched',
        content: {
          taskId: rawItem?.callId || rawItem?.id || 'unknown',
          toolName: rawItem?.name || 'unknown',
          args,
          message: formatToolCallNarration(rawItem?.name || 'unknown', args, outputLanguage, {
            tracePairContext: streamContext.tracePairContext,
          }),
        },
        timestamp: now,
      });
    } else if (event.name === 'tool_output') {
      const rawOutput = (event.item as any)?.output ?? rawItem?.output;
      const taskIds = [rawItem?.callId, rawItem?.call_id, rawItem?.id]
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const cached = taskIds
        .map(taskId => streamContext.toolInputsByTaskId.get(taskId))
        .find(Boolean);
      const toolName = cached?.toolName || rawItem?.name || 'unknown';
      const resultText = summarizeToolOutput(
        projectToolResultForExternalSurface(toolName, rawOutput),
      );
      if (cached) {
        const codeReferences = extractSourceLookupCodeReferences(cached.toolName, rawOutput);
        recordPlanOrPrePlanToolCall(this.sessionPlans.get(streamContext.sessionId), {
          toolName: cached.toolName,
          input: cached.args,
          resultText,
          returnedCodeReferences: codeReferences.length > 0,
          returnedCodeReferenceHints: codeReferences,
        });
        for (const taskId of taskIds) {
          streamContext.toolInputsByTaskId.delete(taskId);
        }
      }
      this.emitUpdate({
        type: 'agent_response',
        content: {
          taskId: rawItem?.callId || rawItem?.id || 'unknown',
          result: resultText,
        },
        timestamp: now,
      });
    } else if (event.name === 'reasoning_item_created') {
      const text = Array.isArray(rawItem?.content)
        ? rawItem.content.map((c: any) => c.text).filter(Boolean).join('\n')
        : undefined;
      if (text) {
        streamContext.runtimePerformance?.recordFirstOutput();
        this.emitUpdate({
          type: 'thought',
          content: {thought: streamContext.answerTextProjection?.projectComplete(text) ?? text},
          timestamp: now,
        });
      }
    }
    return '';
  }

  private safeSerializeRunState(state: unknown): string | undefined {
    try {
      const asSerializable = state as { toString?: () => string };
      const serialized = asSerializable?.toString?.();
      return serialized && serialized !== '[object Object]' ? serialized : undefined;
    } catch {
      return undefined;
    }
  }

  private estimateConfidence(findings: Finding[], conclusion: string): number {
    if (findings.length === 0) return conclusion.trim().length > 0 ? 0.55 : 0.25;
    const avg = findings.reduce((sum, f) => sum + (f.confidence ?? 0.5), 0) / findings.length;
    return Math.min(1, Math.max(0, avg));
  }

  private recordTurn(input: {
    query: string;
    sessionId: string;
    result: AnalysisResult;
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
    previousTurnCount: number;
    quickMode: boolean;
  }): void {
    input.sessionContext.addTurn(
      input.query,
      {
        primaryGoal: input.query,
        aspects: [],
        expectedOutputType: input.quickMode ? 'summary' : 'diagnosis',
        complexity: input.quickMode ? 'simple' : 'complex',
        followUpType: input.previousTurnCount > 0 ? 'extend' : 'initial',
      },
      {
        agentId: 'openai-agent',
        success: input.result.success,
        findings: input.result.findings,
        confidence: input.result.confidence,
        message: input.result.conclusion,
        partial: input.result.partial,
        terminationReason: input.result.terminationReason,
        terminationMessage: input.result.terminationMessage,
      },
      input.result.findings,
    );

    if (input.result.partial === true) return;
    input.sessionContext.updateWorkingMemoryFromConclusion({
      turnIndex: input.previousTurnCount,
      query: input.query,
      conclusion: input.result.conclusion,
      confidence: input.result.confidence,
    });
  }

  private buildDirectQuickEvidenceResult(input: {
    query: string;
    sessionId: string;
    options: AnalysisOptions;
    startTime: number;
    sceneType: SceneType;
    outputLanguage: OutputLanguage;
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
    previousTurns: ConversationTurn[];
    analysisRunSpec: AnalysisRunSpec;
    quickBudget: ReturnType<typeof resolveQuickTurnBudget>;
    directAnswer: RuntimeQuickEvidenceDirectAnswer;
    evidenceCounts: RuntimeQuickEvidenceCounts;
    runtimePerformance: RuntimePerformanceRun;
  }): AnalysisResult {
    const result = buildQuickDirectEvidenceAnalysisResult({
      query: input.query,
      sessionId: input.sessionId,
      options: input.options,
      startedAt: input.startTime,
      analysisRunSpec: input.analysisRunSpec,
      budget: input.quickBudget,
      directAnswer: input.directAnswer,
      evidenceCounts: input.evidenceCounts,
      previousTurns: input.previousTurns,
    });
    emitQuickDirectQualityGateIssue({
      emitUpdate: update => this.emitUpdate(update),
      module: 'openAiRuntime',
      result,
      query: input.query,
      sceneType: input.sceneType,
    });
    this.recordTurn({
      query: input.query,
      sessionId: input.sessionId,
      result,
      sessionContext: input.sessionContext,
      previousTurnCount: input.previousTurns.length,
      quickMode: true,
    });
    input.runtimePerformance.recordFirstOutput();
    emitQuickDirectAnswerEvents({
      emitUpdate: update => this.emitUpdate(update),
      result,
      startedAt: input.startTime,
      outputLanguage: input.outputLanguage,
      runtime: 'openai-agents-sdk',
      model: 'runtime-pre-evidence',
    });
    return result;
  }

  private recordPatternMemory(input: {
    sessionId: string;
    result: AnalysisResult;
    previousTurnCount: number;
    quickMode: boolean;
    sceneType: SceneType;
    architecture?: ArchitectureInfo;
    packageName?: string;
    options: AnalysisOptions;
  }): void {
    if (analysisContextUsesPrivateKnowledge(input.options)) return;
    if (input.result.partial === true || input.result.findings.length === 0) return;
    const insights = extractKeyInsights(input.result.findings, input.result.conclusion);
    if (insights.length === 0) return;

    const features = extractTraceFeatures({
      architectureType: input.architecture?.type,
      sceneType: input.sceneType,
      packageName: input.packageName,
      findingTitles: input.result.findings.map(f => f.title),
      findingCategories: input.result.findings.map(f => f.category).filter(Boolean) as string[],
    });
    const knowledgeScope = knowledgeScopeFromAnalysisOptions(input.options);
    const patternExtras = {
      status: 'provisional' as const,
      provenance: {
        sessionId: input.sessionId,
        turnIndex: input.previousTurnCount,
      },
      knowledgeScope,
    };

    if (input.quickMode) {
      saveQuickPathPattern(features, insights, input.sceneType, input.architecture?.type, patternExtras)
        .catch(err => console.warn('[OpenAIRuntime] Quick pattern save failed:', (err as Error).message));
      return;
    }

    saveAnalysisPattern(features, insights, input.sceneType, input.architecture?.type, input.result.confidence, patternExtras)
      .catch(err => console.warn('[OpenAIRuntime] Pattern save failed:', (err as Error).message));
    promoteQuickPatternIfMatching({
      fullPathFeatures: features,
      fullPathInsights: insights,
      sceneType: input.sceneType,
      architectureType: input.architecture?.type,
      verifierPassed: true,
      knowledgeScope,
    }).catch(err => console.warn('[OpenAIRuntime] Quick→full promote failed:', (err as Error).message));
  }

  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    captureSkillDisplayEntities(displayResults, entityStore, 'openai-agent');
  }

  private collectPreviousFindings(sessionContext: any, maxTurns = 3): Finding[] {
    return collectRecentFindings(sessionContext, { maxTurns, maxFindings: 5 });
  }

  private buildEntityContext(entityStore: any): string | undefined {
    return buildEntityContext(entityStore);
  }

  private toProtocolHypothesis(h: Hypothesis): ProtocolHypothesis {
    return toRuntimeProtocolHypothesis(h, 'openai');
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }
}

export function createOpenAIRuntime(
  traceProcessorService: TraceProcessorService,
  runtimeSelection?: RuntimeSelection,
): OpenAIRuntime {
  return new OpenAIRuntime(traceProcessorService, runtimeSelection);
}
