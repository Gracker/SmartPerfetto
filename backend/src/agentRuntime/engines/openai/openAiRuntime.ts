// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {snapshotSceneCoverageRegistry} from '../../../agent/scene/sceneCoveragePlan';
import {EventEmitter} from 'events';
import {Agent, MaxTurnsExceededError, OpenAIProvider, Runner, setTracingDisabled, type AgentInputItem, type RunStreamEvent} from '@openai/agents';
import OpenAI from 'openai';
import {commitEvaluationSdkHandoffIfActive, recordEvaluationTokenDeltaIfPresent} from '../../../services/selfEvolution/evaluationRuntimeHooks';

import type {TraceProcessorService} from '../../../services/traceProcessorService';
import {createSkillExecutor} from '../../../services/skillEngine/skillExecutor';
import {ensureSkillRegistryInitialized, skillRegistry} from '../../../services/skillEngine/skillLoader';
import {resolveEffectiveSkillRegistryForRuntime} from '../../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import {createArchitectureDetector} from '../../../agent/detectors/architectureDetector';
import {sessionContextManager} from '../../../agent/context/enhancedSessionContext';
import type {ConversationTurn, StreamingUpdate} from '../../../agent/types';
import type {Hypothesis as ProtocolHypothesis} from '../../../agent/types/agentProtocol';
import type {AnalysisOptions, AnalysisResult, AnalysisTerminationReason, IOrchestrator} from '../../../agent/core/orchestratorTypes';
import type {ArchitectureInfo} from '../../../agent/detectors/types';
import {createClaudeMcpServer, loadLearnedSqlFixPairs} from '../../../agentv3/claudeMcpServer';
import {buildSystemPrompt} from '../../../agentv3/claudeSystemPrompt';
import {loadPromptTemplate, renderTemplate} from '../../../agentv3/strategyLoader';
import {inspectCandidateProtocol, buildCandidateProtocolDiagnostic, sanitizeCandidateProtocolDiagnostic,
  type CandidateProtocolDiagnostic} from '../../../services/canonicalAnalysisResult';
import {extractFindingsFromText} from '../../../agentv3/claudeFindingExtractor';
import {resolveFocusAppTarget} from '../../focusAppTarget';
import {registerFocusAppEvidence} from '../../focusAppEvidence';
import {type SceneType} from '../../../agentv3/sceneClassifier';
import {getExtendedKnowledgeBase} from '../../../services/sqlKnowledgeBase';
import {analysisContextMemoryPartitionKey, assertCurrentAnalysisContextAuthorization, buildAnalysisContextAuthorizationFingerprint} from '../../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import type {AnalysisNote, AnalysisPlanV3, ClaudeAnalysisContext, Hypothesis, TracePairContext, TraceCompleteness, UncertaintyFlag} from '../../../agentv3/types';
import {recordPlanOrPrePlanToolCall, resetPrePlanToolCallsForNewRun, readToolResultFacts} from '../../../agentv3/planToolCallRecorder';
import {buildComplexityClassifierInput} from '../../../agentv3/queryComplexityContext';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {resolveRuntimeEvidenceStore} from '../../runtimeEvidenceContext';
import {activateSceneRuntime, resolveSceneProductScope} from '../../../agent/scene/sceneRuntimeBinding';
import type {ScenePacingInputs} from '../../../agent/scene/sceneProposalPacing';
import {createOpenAISnapshotEngineState, projectSessionFieldsForDurableSnapshot, type SessionFieldsForSnapshot, type SessionStateSnapshot} from '../../../agentv3/sessionStateSnapshot';
import {extractTraceFeatures, extractKeyInsights, saveAnalysisPattern, saveQuickPathPattern} from '../../../agentv3/analysisPatternMemory';
import {probeTraceCompleteness} from '../../../agentv3/traceCompletenessProber';
import {localize, type OutputLanguage} from '../../../agentv3/outputLanguage';
import {createCodeAwareStreamingTextProjection, type CodeAwareStreamingTextProjection} from '../../../services/security/codeAwareOutputRegistry';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import {formatToolCallNarration, formatToolResultNarration, issuePrivateToolResultNarrationReceipt, toolResultIsFailure} from '../../../agentv3/toolNarration';
import {estimateAnalysisConfidence} from '../../../agentv3/analysisTermination';
import {
  SILENT_ANSWER_DRAFT, createAnswerDraftStream, createProjectedAnswerDraft, type ProjectedAnswerDraft,
} from '../../answerDraftStream';
import {isPlainObject} from '../../../utils/llmJson';
import {planPhaseUpdatedContent} from '../../../agentv3/planPhaseEvents';
import {loadOpenAIConfig, type OpenAIAgentConfig} from './openAiConfig';
import {buildOpenAIChatCompletionsTokenLimit} from '../../../services/providerManager/openAiChatCompletionsCompat';
import {createMimoReasoningContentFetch, shouldUseMimoReasoningContentCompat} from './mimoReasoningCompat';
import {createOpenAIToolsFromMcpDefinitions, openAiToolCallKey} from './openAiToolAdapter';
import {applyFinalResultQualityGate} from '../../../services/finalResultQualityGate';
import {verifyConclusion} from '../claude/claudeVerifier';
import {buildQuickRunReceipt, captureSkillDisplayEntities, createRuntimeSkillNotesBudget, getLruCacheEntry, knowledgeScopeFromAnalysisOptions, providerScopeFromAnalysisOptions, quickStopReasonFromTermination, resolveQuickTurnBudget, setLruCacheEntry, toProtocolHypothesis as toRuntimeProtocolHypothesis} from '../../runtimeCommon';
import {createAnalysisRunSpec, type AnalysisRunSpec} from '../../analysisRunSpec';
import type {RuntimeSelection} from '../../runtimeSelection';
import {RuntimeExecutionGuard, type RuntimeExecutionLease} from '../../runtimeExecutionGuard';
import {createRuntimePerformanceRun, runtimeOutcomeFromError, type RuntimeModelCallPurpose, type RuntimeModelCallSpan,
  type RuntimeModelCallTrigger, type RuntimePerformanceOutcome, type RuntimePerformanceRun} from '../../runtimePerformance';
import {OPENAI_AGENT_RUNTIME_KIND} from '../../runtimeKinds';
import {extractSourceLookupCodeReferences} from '../../../services/codebase/sourceLookupTools';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../../services/codebase/sourceClaimVerifier';
import {countCompletedQuickConversationTurns} from '../../quickBudget';
import {
  buildComparisonIdentity,
  buildRuntimeTracePairComparisonContext,
  detectRunFocusApps,
} from '../../runtimePromptContext';
import {createDeadlineRuntimeTimeout, createProgressAwareRunDeadline, createResettableRuntimeTimeout, resolveFullRequestTimeoutMs,
  serializedByteLength, summarizeExternalToolResult} from '../../runtimeLimits';

import {randomUUID} from 'node:crypto';
import {TransformStream} from 'node:stream/web';
import {createAnalysisTurnIntentResolver, type AnalysisTurnIntent} from '../../analysisTurnIntent';
import {resolveRuntimeTurnPolicy, usesLightweightToolCatalog, type RuntimeTurnPolicy} from '../../runtimeTurnPolicy';
import {runOpenAiIntentTransport} from './openAiIntentTransport';
import {attachFinalizationContext, reportReviewUsesRemainingBudget} from '../../analysisFinalizationContext';
import {buildRuntimeTracePairIdentityContext} from '../../runtimePromptContext';
import {createRuntimeTurnCloseoutTape, resolveRuntimeTurnBudget} from '../../runtimeTurnCloseout';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  appendRelationProposalRecoveryFragment,
  INVALID_NATIVE_DECLARATION,
  MISSING_NATIVE_DECLARATION,
  requestNativeDeclarationCompletion,
  type NativeDeclarationCompletionRequest,
} from '../../runtimeConclusionProtocol';
import type {RuntimeToolObserver} from '../../runtimeToolObserver';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext, toAnalysisHistoryTurn, type AnalysisHistoryReader} from '../../analysisHistory';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity, type AnalysisCompletion, type AnalysisDeliveryContext, type AnalysisOutputOrigin} from '../../../types/analysisDelivery';
import {analysisHasPrivateContext} from '../../../services/security/analysisPrivateContext';
import {resolveDurableLearningPermission} from '../../../services/security/durableLearning';

interface OpenAiChatTerminal {
  responseId?: string;
  finishReason?: string;
  refused?: boolean;
  invalid?: boolean;
  /** Internal performance facts only; never part of the completion decision. */
  model?: string;
  usage?: unknown;
}

/** Preserve native terminal facts that the Agents SDK chat adapter drops. */
function createOpenAiTerminalFetch(
  fetchImpl: typeof fetch,
  onRequest: (terminal: OpenAiChatTerminal) => void,
): typeof fetch {
  return async (input, init) => {
    const terminal: OpenAiChatTerminal = {};
    onRequest(terminal);
    const response = await fetchImpl(input, init);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData: string[] = [];
    let done = false;
    const dispatch = () => {
      if (!eventData.length) return;
      const data = eventData.join('\n');
      eventData = [];
      if (done) {terminal.invalid = true; return;}
      if (data === '[DONE]') {done = true; return;}
      try {
        const value = JSON.parse(data);
        if (value.error != null) terminal.invalid = true;
        if (typeof value.model === 'string' && value.model) terminal.model ??= value.model;
        if (isPlainObject(value.usage)) terminal.usage = value.usage;
        if (typeof value.id === 'string' && value.id.length > 0) {
          if (terminal.responseId !== undefined && terminal.responseId !== value.id) terminal.invalid = true;
          terminal.responseId ??= value.id;
        } else if (Array.isArray(value.choices) && value.choices.length > 0) terminal.invalid = true;
        if (!Array.isArray(value.choices)) return;
        for (const choice of value.choices) {
          if (choice.index !== 0) {terminal.invalid = true; continue;}
          const delta = choice.delta;
          const addsOutput = delta && typeof delta === 'object' && Object.values(delta).some(value =>
            value != null && value !== '' && (!Array.isArray(value) || value.length > 0));
          // A terminal receipt cannot certify bytes or calls emitted after it.
          if (terminal.finishReason !== undefined && addsOutput) terminal.invalid = true;
          if (typeof choice.finish_reason === 'string') {
            if (terminal.finishReason && terminal.finishReason !== choice.finish_reason) terminal.invalid = true;
            terminal.finishReason = choice.finish_reason;
          }
          if (choice.delta?.refusal) terminal.refused = true;
        }
      } catch {terminal.invalid = true;}
    };
    const consume = (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        terminal.invalid = true;
        buffer = '';
        eventData = [];
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) dispatch();
        else if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
      }
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {consume(decoder.decode(chunk, {stream: true})); controller.enqueue(chunk);},
      flush() {
        consume(decoder.decode());
        // SSE dispatch requires the wire's blank line. EOF is not an event delimiter.
        if (buffer || eventData.length) terminal.invalid = true;
      },
    }));
    return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
  };
}

function resolveOpenAiNativeCompletion(input: {
  protocol: OpenAIAgentConfig['protocol'];
  response: unknown;
  chatTerminal: OpenAiChatTerminal;
  streamCompleted: boolean;
  conclusion: string;
}): Pick<AnalysisCompletion, 'status' | 'reason' | 'sdkFinishReason'> {
  if (!input.streamCompleted) return {status: 'unknown'};
  const response = input.response as {id?: string; output?: Array<{type?: string; role?: string; status?: string; content?: Array<{type?: string; text?: string}>}>; providerData?: {status?: string; incomplete_details?: {reason?: string}; error?: unknown}} | undefined;
  const messages = response?.output?.filter(item => item.type === 'message' && item.role === 'assistant');
  const message = messages?.[messages.length - 1];
  const nativeBody = message?.content?.filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
  // A terminal event from an earlier tool round must never certify a different finalOutput.
  if (!message || nativeBody !== input.conclusion) return {status: 'unknown'};
  if (input.protocol === 'chat_completions') {
    const {responseId, finishReason, refused, invalid} = input.chatTerminal;
    if (invalid || !responseId || response?.id !== responseId) return {status: 'unknown', ...(finishReason ? {sdkFinishReason: finishReason} : {})};
    if (finishReason === 'length') return {status: 'incomplete', reason: 'output_limit', sdkFinishReason: finishReason};
    if (refused || finishReason === 'content_filter') return {status: 'failed', reason: 'provider_error', ...(finishReason ? {sdkFinishReason: finishReason} : {})};
    return finishReason === 'stop' ? {status: 'completed', sdkFinishReason: finishReason} : {status: 'unknown', ...(finishReason ? {sdkFinishReason: finishReason} : {})};
  }
  const data = response?.providerData;
  if (data?.status === 'incomplete') return {status: 'incomplete',
    ...(data.incomplete_details?.reason === 'max_output_tokens' ? {reason: 'output_limit' as const} : {}), sdkFinishReason: data.status};
  if (data?.error != null || data?.status === 'failed') return {status: 'failed', reason: 'provider_error', sdkFinishReason: data?.status};
  return data?.status === 'completed' && data.incomplete_details == null && message.status === 'completed'
    ? {status: 'completed', sdkFinishReason: data.status} : {status: 'unknown', ...(data?.status ? {sdkFinishReason: data.status} : {})};
}

function openAiTerminationReason(reason: NonNullable<AnalysisCompletion['reason']>): AnalysisTerminationReason | undefined {
  switch (reason) {
    case 'timeout': return 'timeout';
    case 'turn_limit': return 'max_turns';
    case 'budget_limit': return 'max_budget_usd';
    case 'output_limit': return undefined;
    default: return 'execution_error';
  }
}

/**
 * Only provider output can extend an elapsed run deadline: answer text,
 * reasoning or tool-call arguments. Agent bookkeeping events and chunks with
 * empty deltas prove nothing about whether the model is still working.
 */
function openAiStreamEventCarriesOutput(event: unknown): boolean {
  if (!event || typeof event !== 'object' || (event as {type?: unknown}).type !== 'raw_model_stream_event') return false;
  const data = (event as {data?: any}).data;
  const nonEmpty = (value: unknown) => typeof value === 'string' && value.length > 0;
  if (data?.type === 'output_text_delta') return nonEmpty(data.delta);
  if (data?.type !== 'model') return false;
  const raw = data.event;
  // Responses protocol: typed streaming events such as response.output_text.delta.
  if (typeof raw?.type === 'string') return raw.type.endsWith('.delta') && nonEmpty(raw.delta);
  // Chat Completions protocol: the raw chunk.
  const delta = Array.isArray(raw?.choices) ? raw.choices.find((choice: any) => choice?.index === 0)?.delta : undefined;
  return Boolean(delta) && (nonEmpty(delta.content) || nonEmpty(delta.reasoning_content) || nonEmpty(delta.reasoning) ||
    (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call: any) =>
      nonEmpty(call?.function?.arguments) || nonEmpty(call?.function?.name))));
}

/** Bind native authorship before any privacy projection can replace the body. */
function finalizeOpenAiCandidate(input: {
  result: AnalysisResult;
  runId: string;
  attemptId: string;
  finish: Pick<AnalysisCompletion, 'status' | 'reason' | 'sdkFinishReason'>;
  outputOrigin: AnalysisOutputOrigin;
  sourceUse?: ReturnType<typeof createClaudeMcpServer>['sourceUse'];
}) {
  const {result, runId, attemptId} = input;
  const nativeEmpty = result.conclusion.trim().length === 0;
  const acceptedCandidate: AnalysisCandidateIdentity = {
    runId, attemptId, candidateRef: `${runId}:${attemptId}`,
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion),
  };
  result.outputOrigin = input.outputOrigin;
  result.completion = {schemaVersion: 1, runtimeKind: OPENAI_AGENT_RUNTIME_KIND, ...acceptedCandidate,
    ...input.finish, ...(nativeEmpty && input.finish.status === 'completed' ? {status: 'unknown' as const} : {})};
  if (nativeEmpty) {
    result.success = false;
    result.partial = true;
    result.confidence = 0;
    result.terminationReason ??= 'quality_gate_failed';
  }
  const nativeContext: AnalysisDeliveryContext = {entry: 'runtime_draft', acceptedCandidate,
    completion: result.completion, outputOrigin: input.outputOrigin, turnIntent: result.turnIntent};
  const finalized = finalizeOwnerSourceAwareAnalysisResultWithProjection(result, input.sourceUse, {
    context: nativeContext,
  });
  if (finalized.result.quickRun) {
    finalized.result.quickRun.stopReason = quickStopReasonFromTermination({
      partial: finalized.result.partial, terminationReason: finalized.result.terminationReason,
      actualTurns: finalized.result.quickRun.actualTurns, targetTurns: finalized.result.quickRun.targetTurns,
      hardCapTurns: finalized.result.quickRun.hardCapTurns,
    });
  }
  if (!finalized.deliveryContext) throw new Error('OpenAI candidate projection omitted delivery context');
  return {...finalized, deliveryContext: finalized.deliveryContext};
}

type OpenAIAnalysisSessionState = {
  artifactStore: ArtifactStore;
  notes: AnalysisNote[];
  analysisPlan: { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] };
  hypotheses: Hypothesis[];
  uncertaintyFlags: UncertaintyFlag[];
};

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

function buildOpenAIModelSettings(
  config: Pick<OpenAIAgentConfig, 'maxOutputTokens' | 'protocol'>,
  model: string,
) {
  const chatCompletionsTokenLimit = config.protocol === 'chat_completions' && config.maxOutputTokens !== undefined
    ? buildOpenAIChatCompletionsTokenLimit(model, config.maxOutputTokens)
    : undefined;
  const usesMaxCompletionTokens = chatCompletionsTokenLimit
    && 'max_completion_tokens' in chatCompletionsTokenLimit;

  return {
    ...(usesMaxCompletionTokens
      ? { providerData: chatCompletionsTokenLimit }
      : config.maxOutputTokens !== undefined ? { maxTokens: config.maxOutputTokens } : {}),
    parallelToolCalls: false,
    // Every run starts from fresh physical context; no response is ever resumed.
    store: false,
  };
}

/** Keep the complete current-run transcript or decline recovery; never trim evidence. */
function buildOpenAiOutputLimitRecoveryInput(
  history: AgentInputItem[],
  maxHistoryBytes: number,
  observedToolCalls: number,
  turnIntent: AnalysisTurnIntent,
  language: OutputLanguage,
  recoveryReason: 'output_limit' | 'empty_body' | 'invalid_protocol' | 'turn_limit' |
    typeof MISSING_NATIVE_DECLARATION | typeof INVALID_NATIVE_DECLARATION,
  candidateDiagnostic: CandidateProtocolDiagnostic,
  declarationRequest?: NativeDeclarationCompletionRequest,
): AgentInputItem[] | undefined {
  if (!Array.isArray(history) || !history.some(item => 'role' in item && item.role === 'user')) return undefined;
  const pendingCalls = new Set<string>();
  let completedCalls = 0;
  for (const item of history) {
    if (item.type === 'function_call') pendingCalls.add(item.callId);
    if (item.type === 'function_call_result') {
      if (!pendingCalls.delete(item.callId)) return undefined;
      completedCalls++;
    }
  }
  if (pendingCalls.size || completedCalls < observedToolCalls) return undefined;
  let prompt: string;
  if (recoveryReason === MISSING_NATIVE_DECLARATION || recoveryReason === INVALID_NATIVE_DECLARATION) {
    if (declarationRequest?.reason !== recoveryReason) return undefined;
    try {
      prompt = buildNativeDeclarationCompletionPrompt({request: declarationRequest, intent: turnIntent,
        outputLanguage: language});
    } catch {
      // Optional protocol completion cannot invalidate an already completed
      // native candidate when its external template is unavailable.
      return undefined;
    }
  } else {
    let template: string | undefined;
    try { template = loadPromptTemplate(`prompt-openai-final-report-continuation-${language === 'en' ? 'en' : 'zh'}`); }
    catch { return undefined; }
    if (!template?.trim()) return undefined;
    const basePrompt = renderTemplate(template.replace(/<!--[\s\S]*?-->/g, '').trim(), {
      turn_intent: JSON.stringify(turnIntent),
      completion_reason: recoveryReason,
      candidate_protocol_diagnostic: JSON.stringify(sanitizeCandidateProtocolDiagnostic(candidateDiagnostic) ?? null),
    });
    try { prompt = appendRelationProposalRecoveryFragment(basePrompt, candidateDiagnostic, language); }
    catch { return undefined; }
  }
  const input: AgentInputItem[] = [...history, {role: 'user', content: prompt}];
  return serializedByteLength(input) <= maxHistoryBytes ? input : undefined;
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
  createOpenAiReasoningFilterState,
  filterOpenAiVisibleAnswerDelta,
  compactProviderErrorMessage,
  commitAfterProviderClose,
  buildOpenAIModelSettings,
  createOpenAiTerminalFetch,
  resolveOpenAiNativeCompletion,
  finalizeOpenAiCandidate,
  openAiStreamEventCarriesOutput,
};

export class OpenAIRuntime extends EventEmitter implements IOrchestrator {
  private readonly traceProcessorService: TraceProcessorService;
  private readonly architectureCache = new Map<string, ArchitectureInfo>();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private readonly sessionNotes = new Map<string, AnalysisNote[]>();
  private readonly sessionSqlErrors = new Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number; fixedSql?: string }>>();
  private readonly sessionSqlErrorPartitions = new Map<string, string>();
  private readonly sessionPlans = new Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }>();
  private readonly sessionHypotheses = new Map<string, Hypothesis[]>();
  private readonly sessionUncertaintyFlags = new Map<string, UncertaintyFlag[]>();
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

  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    setLruCacheEntry(this.architectureCache, traceId, architecture);
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
    const resolvedConfig = loadOpenAIConfig(options.providerId, providerScopeFromAnalysisOptions(options));
    const config = options.outputLanguage ? {...resolvedConfig, outputLanguage: options.outputLanguage} : resolvedConfig;
    const executionLease = this.executionGuard.begin({
      runtime: OPENAI_AGENT_RUNTIME_KIND, sessionId,
      referenceTraceId: options.referenceTraceId, runId: options.runId,
    });
    const runtimePerformance = createRuntimePerformanceRun(options.runManifestAttributionSink);
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';
    const startTime = Date.now();
    const runId = options.runId ?? randomUUID();
    // Display-only draft: revoked at every response start, at a tool call that
    // follows streamed text, and before any continuation or retry.
    const answerDraft = createAnswerDraftStream(runId, update => this.emitUpdate(update));
    const analysisAbortScope = new RuntimeAnalysisAbortScope();
    const bridgeExecutionAbort = () => analysisAbortScope.abort();
    if (executionLease.signal.aborted) bridgeExecutionAbort();
    else executionLease.signal.addEventListener('abort', bridgeExecutionAbort, {once: true});
    const unregisterAnalysisAbortHandle = this.registerAbortHandle(sessionId, analysisAbortScope);
    let sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'] | undefined;
    let turnIntent: AnalysisTurnIntent | undefined;
    let rounds = 0;
    let acceptsToolUpdates = true;
    const closeoutTape = createRuntimeTurnCloseoutTape();
    let provider: OpenAIProvider | undefined;
    try {
      executionLease.throwIfAborted();
      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const previousTurns = sessionContext.getAllTurns?.() ?? [];
      const authorizationScope = resolveKnowledgeScope(options);
      const authorizationFingerprint = options.analysisContextFingerprint ??
        buildAnalysisContextAuthorizationFingerprint(options, authorizationScope);
      const historyReader = createRuntimeAnalysisHistoryReader({options, sessionId, traceId,
        getTurns: () => sessionContext.getAnalysisHistory?.() ?? previousTurns.map(turn =>
          toAnalysisHistoryTurn({...turn, traceId, sourceDerived: turn.result?.sourceDerived})),
        assertActive: () => {
          executionLease.throwIfAborted();
          analysisAbortScope.throwIfAborted();
          assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
        },
      });
      const intentResolver = createAnalysisTurnIntentResolver({
        productRun: {options, runId, sessionId, traceId},
        context: buildComplexityClassifierInput({
          query, sceneType: 'general', selectionContext: options.selectionContext,
          hasReferenceTrace: Boolean(options.referenceTraceId), previousTurns: [], history: historyReader.getTurns(),
          requestedMode: options.analysisMode ?? 'auto',
        }),
        signal: analysisAbortScope.signal,
        deadlineMs: Date.now() + config.classifierTimeoutMs,
        dispatch: input => runOpenAiIntentTransport({...input, config, purpose: 'classification',
          maxOutputTokens: Math.min(config.maxOutputTokens ?? 2048, 2048)}),
      });
      const resolvedTurnIntent = await intentResolver.resolve();
      turnIntent = resolvedTurnIntent;
      analysisAbortScope.throwIfAborted();
      const resolvedPolicy = resolveRuntimeTurnPolicy(turnIntent, options.analysisMode);
      const policy = options.assistantSurface === 'conversation' && options.conversationTraceAttached !== true
        ? {...resolvedPolicy, allowAutomaticPrefetch: false, preflight: 'none' as const} : resolvedPolicy;
      const quickMode = policy.budgetMode === 'quick';
      const sceneType = turnIntent.sceneId;
      // A failed light-model classifier does not authorize a provider switch.
      // The already configured primary remains usable under the same budget.
      const selectedModel = quickMode && turnIntent.status === 'resolved' ? config.lightModel : config.model;
      const maxTurns = quickMode ? config.quickMaxTurns : config.maxTurns;
      const turnBudget = resolveRuntimeTurnBudget(maxTurns);
      const finalizationConfig = Object.freeze({baseURL: config.baseURL, apiKey: config.apiKey,
        protocol: config.protocol, lightModel: config.model,
        ...(config.maxOutputTokens !== undefined ? {maxOutputTokens: config.maxOutputTokens} : {})});
      const currentTraceId = traceId && (options.assistantSurface !== 'conversation' || options.conversationTraceAttached === true)
        ? traceId : undefined;
      const referenceTraceId = currentTraceId ? options.referenceTraceId : undefined;
      const allowedTraces = [
        ...(currentTraceId ? [{traceId: currentTraceId, traceSide: 'current' as const}] : []),
        ...(referenceTraceId ? [{traceId: referenceTraceId, traceSide: 'reference' as const}] : []),
      ];
      const evidenceOwnerKey = analysisDeliveryFingerprint({runId, sessionId,
        tenantId: options.tenantId, workspaceId: options.workspaceId, userId: options.userId,
        analysisContextFingerprint: options.analysisContextFingerprint,
        authorization: analysisContextMemoryPartitionKey(options)});
      const analysisRunSpec = createAnalysisRunSpec({
        query, sessionId, traceId, options, runtimeSelection: this.runtimeSelection,
        sceneType, outputLanguage: config.outputLanguage, previousTurns: [], history: historyReader.getTurns(), turnIntent,
        resolvedMode: policy.budgetMode, resolvedModel: selectedModel,
        budget: config,
      });
      const quickBudget = quickMode ? resolveQuickTurnBudget({
        hardCapTurns: maxTurns, targetTurns: config.quickTargetTurns, enforcement: 'turn_cap',
      }) : undefined;
      runtimePerformance.finishClassification(turnIntent.status === 'resolved' ? 'ok' : 'error');
      const timeoutMs = quickMode ? config.quickPathPerTurnMs * maxTurns
        : resolveFullRequestTimeoutMs(config.fullPathPerTurnMs, maxTurns, config.fullRequestTimeoutMs);
      const perTurnMs = quickMode ? config.quickPathPerTurnMs : config.fullPathPerTurnMs;
      // Only scene dispatch needs a fixed acquisition ceiling during preparation.
      const sceneRunDeadline = resolveSceneProductScope(options, {runId, sessionId, traceId})
        ? createProgressAwareRunDeadline({baseBudgetMs: timeoutMs, perTurnMs, maxRunMs: config.maxRunTimeoutMs})
        : undefined;
      const context = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        config, runId, sceneType, policy, turnIntent, strategyRegistry: intentResolver.strategyRegistry,
        analysisRunSpec, sessionContext, previousTurns, executionLease, runtimePerformance,
        historyReader, toolObserver: closeoutTape.observe,
        isActive: () => acceptsToolUpdates && !analysisAbortScope.signal.aborted &&
          (!sceneRunDeadline || Date.now() < sceneRunDeadline.current()),
        sceneDeadlineMs: sceneRunDeadline?.hardDeadlineAt, scenePacing: sceneRunDeadline,
      });
      sourceUse = context.sourceUse;
      analysisAbortScope.throwIfAborted();
      const promptPrefix = analysisRunSpec.traceContext.promptSection;
      const effectivePrompt = promptPrefix ? `${promptPrefix}\n\n${query}` : query;
      // Logical turns inherit a product-owned bounded preview, never opaque SDK history.
      const historyContext = renderAnalysisHistoryContext(historyReader.getTurns(), {outputLanguage: config.outputLanguage});
      let runInput: string | AgentInputItem[] = historyContext ? `${historyContext}\n\n${effectivePrompt}` : effectivePrompt;
      let chatTerminal: OpenAiChatTerminal = {};
      const nativeFetch = shouldUseMimoReasoningContentCompat(config)
        ? createMimoReasoningContentFetch() as typeof fetch : fetch;
      const observedFetch = config.protocol === 'chat_completions'
        ? createOpenAiTerminalFetch(nativeFetch, terminal => {chatTerminal = terminal;}) : nativeFetch;
      setTracingDisabled(true);
      const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
      let runner: Runner;
      let agent: Agent;
      try {
        provider = new OpenAIProvider({
          openAIClient: new OpenAI({apiKey: config.apiKey, baseURL: config.baseURL, fetch: observedFetch as any}),
          useResponses: config.protocol === 'responses',
        });
        runner = new Runner({modelProvider: provider, tracingDisabled: true,
          traceIncludeSensitiveData: false, workflowName: 'SmartPerfetto Analysis',
          toolExecution: {maxFunctionToolConcurrency: 1}});
        agent = new Agent({name: 'SmartPerfetto', instructions: context.systemPrompt,
          model: selectedModel, tools: context.tools, toolUseBehavior: 'run_llm_again',
          modelSettings: buildOpenAIModelSettings(config, selectedModel)});
        sdkStartPhase.end('ok');
      } catch (error) {
        sdkStartPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
      this.emitUpdate({type: 'progress', content: {
        phase: 'answering', runtime: OPENAI_AGENT_RUNTIME_KIND, model: selectedModel,
        ...(turnIntent.status === 'unavailable' ? {modelFallback: 'configured_primary'} : {}),
        message: localize(config.outputLanguage, `AI 分析引擎分析中 (${selectedModel})...`, `AI analysis engine is running (${selectedModel})...`),
      }, timestamp: Date.now()});
      // The base budget stays the initial deadline; completed tool rounds move it
      // forward on slow endpoints, never past the hard ceiling fixed here.
      const runDeadline = sceneRunDeadline ?? createProgressAwareRunDeadline({baseBudgetMs: timeoutMs, perTurnMs,
        maxRunMs: config.maxRunTimeoutMs});
      // Set only for the single no-tool delivery call admitted after a timeout.
      let deliveryDeadlineAt: number | undefined;
      // Internal diagnostics: which timeout-delivery branch this run took.
      let timeoutDelivery: 'not_needed' | 'attempted' | 'no_returned_data' | 'turn_budget_exhausted' |
        'delivery_window_too_short' | 'template_unavailable' | 'recovery_in_progress' = 'not_needed';
      let conclusion = '';
      let outputOrigin: AnalysisOutputOrigin = 'assistant_stream';
      let finish: Pick<AnalysisCompletion, 'status' | 'reason' | 'sdkFinishReason'> = {status: 'unknown'};
      let attemptId = '';
      let terminationMessage: string | undefined;
      let observedToolCalls = 0;
      let emittedAnswer = '';
      let recoveryCandidate: {
        conclusion: string; attemptId: string; outputOrigin: AnalysisOutputOrigin;
        finish: typeof finish; hadDeclarations: boolean; terminationMessage: string | undefined;
        declarationRequest?: NativeDeclarationCompletionRequest;
      } | undefined;
      // Internal performance receipt: why the next attempt's model calls are made.
      let attemptCall: {purpose: RuntimeModelCallPurpose; trigger?: RuntimeModelCallTrigger} = {purpose: 'answer_turn'};
      const restoreRecoveryCandidate = () => {
        if (!recoveryCandidate) return;
        ({conclusion, attemptId, outputOrigin, finish, terminationMessage} = recoveryCandidate);
      };
      for (;;) {
        analysisAbortScope.throwIfAborted();
        // A continuation or retry replaces what the previous attempt streamed.
        answerDraft.reset();
        const recoveringOutputLimit = Boolean(recoveryCandidate);
        // Acquisition and delivery share one absolute deadline and total budget.
        const remainingTurns = Math.max(1, maxTurns - rounds);
        const reserveDeliveryTurn = !recoveringOutputLimit && turnBudget.deliveryTurns === 1 && remainingTurns > 1;
        const attemptMaxTurns = recoveringOutputLimit ? 1 : remainingTurns - (reserveDeliveryTurn ? 1 : 0);
        attemptId = randomUUID();
        chatTerminal = {};
        const linked = analysisAbortScope.createLinkedController();
        const controller = linked.controller;
        let active = true;
        let timedOut = false;
        let rejectCancellation!: (reason: unknown) => void;
        const cancellation = new Promise<never>((_resolve, reject) => {rejectCancellation = reject;});
        const onCancellation = () => rejectCancellation(analysisAbortScope.signal.reason);
        analysisAbortScope.signal.addEventListener('abort', onCancellation, {once: true});
        if (analysisAbortScope.signal.aborted) onCancellation();
        void cancellation.catch(() => undefined);
        let runAnswer = '';
        let attemptModelTurns = 0;
        let attemptDispatched = false;
        let lastResponse: unknown;
        let streamCompleted = false;
        // One record per native model response; the first starts at dispatch so it includes connection setup.
        const startAttemptModelCall = () => runtimePerformance.startModelCall({...attemptCall, model: selectedModel,
          reasoning: 'provider_default'});
        let modelCall: RuntimeModelCallSpan | undefined;
        let modelCallResponded = false;
        const answerStreamFilter = createOpenAiReasoningFilterState();
        const answerTextProjection = analysisHasPrivateContext(options)
          ? createCodeAwareStreamingTextProjection(sessionId, `openai-answer-${attemptId}`, 'owner') : undefined;
        // A recovery candidate is delivered atomically by the final conclusion event.
        const attemptDraft = recoveringOutputLimit
          ? SILENT_ANSWER_DRAFT : createProjectedAnswerDraft(answerDraft, answerTextProjection);
        const toolInputsByTaskId = new Map<string, {toolName: string; args: Record<string, unknown>}>();
        const processedToolResultIds = new Set<string>();
        const attemptDeliveryDeadlineAt = deliveryDeadlineAt;
        const requestTimeout = createDeadlineRuntimeTimeout({
          deadlineAt: () => attemptDeliveryDeadlineAt ?? runDeadline.current(),
          ...(attemptDeliveryDeadlineAt === undefined ? {tryExtend: (now: number) => runDeadline.extendIfStreaming(now)} : {}),
          message: now => attemptDeliveryDeadlineAt === undefined
            ? `OpenAI request timeout after ${now - runDeadline.startedAt}ms without further tool progress (base budget ${timeoutMs}ms)`
            : `OpenAI delivery call timeout after ${now - runDeadline.startedAt}ms (hard limit ${runDeadline.hardDeadlineAt - runDeadline.startedAt}ms)`,
          onTimeout: () => {timedOut = true; controller.abort();}});
        const providerIdleTimeout = createResettableRuntimeTimeout({timeoutMs: config.streamIdleTimeoutMs,
          message: `OpenAI provider stream idle timeout after ${config.streamIdleTimeoutMs}ms`,
          onTimeout: () => {timedOut = true; controller.abort();}});
        void requestTimeout.promise.catch(() => undefined);
        void providerIdleTimeout.promise.catch(() => undefined);
        const providerPhase = runtimePerformance.startPhase('provider');
        try {
          if (Date.now() >= (attemptDeliveryDeadlineAt ?? runDeadline.current())) {timedOut = true; throw new Error('OpenAI request deadline elapsed');}
          if (recoveringOutputLimit) {
            executionLease.throwIfAborted();
            assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
          }
          commitEvaluationSdkHandoffIfActive();
          attemptDispatched = true;
          modelCall = startAttemptModelCall();
          const stream = await Promise.race([
            runner.run(agent, runInput, {stream: true, maxTurns: attemptMaxTurns,
              context: {signal: controller.signal}, signal: controller.signal}),
            requestTimeout.promise, providerIdleTimeout.promise, cancellation,
          ]);
          const consume = async () => {
            for await (const event of stream) {
              if (!active || controller.signal.aborted || analysisAbortScope.signal.aborted || executionLease.signal.aborted) return;
              providerIdleTimeout.reset();
              if (openAiStreamEventCarriesOutput(event)) {
                runDeadline.recordOutput();
                modelCall?.recordFirstOutput();
              }
              if (event.type === 'raw_model_stream_event') {
                const data = event.data as any;
                if (data?.type === 'response_started') {
                  if (modelCallResponded) {
                    modelCall?.end({outcome: 'ok', ...(chatTerminal.model ? {model: chatTerminal.model} : {})});
                    modelCall = startAttemptModelCall();
                  }
                  modelCallResponded = true;
                  attemptModelTurns++;
                  // Text of the previous response preceded a tool call: it was
                  // not the answer. Revoke it, including any withheld suffix.
                  attemptDraft.boundary();
                  runAnswer = '';
                  lastResponse = undefined;
                  Object.assign(answerStreamFilter, createOpenAiReasoningFilterState());
                } else if (data?.type === 'response_done') {
                  lastResponse = data.response;
                  modelCall?.markDone(data.response?.usage ?? chatTerminal.usage);
                }
              }
              const answerDelta = this.handleStreamEvent(event, config.outputLanguage, {
                sessionId, quickMode, answerStreamFilter, answerTextProjection, runtimePerformance,
                answerDraft: attemptDraft,
                toolInputsByTaskId, processedToolResultIds,
                tracePairContext: options.tracePairContext, onToolCalled: () => {observedToolCalls++;},
                onToolOutput: () => runDeadline.recordProgress(),
              });
              runAnswer += answerDelta;
              if (!recoveringOutputLimit) emittedAnswer = `${emittedAnswer}${answerDelta}`.slice(-16_000);
            }
            await stream.completed;
            if (!active || controller.signal.aborted || analysisAbortScope.signal.aborted || executionLease.signal.aborted) return;
            streamCompleted = true;
            recordEvaluationTokenDeltaIfPresent((stream as any).runContext?.usage ?? (stream as any).context?.usage ?? (stream as any).state?.usage);
          };
          await Promise.race([consume(), requestTimeout.promise, providerIdleTimeout.promise, cancellation]);
          analysisAbortScope.throwIfAborted();
          if (recoveringOutputLimit) {
            assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
          }
          attemptDraft.finish();
          // SDK currentTurn can be zero-based; every native response consumes a turn.
          rounds += Math.max(attemptModelTurns, stream.currentTurn || 0, attemptDispatched ? 1 : 0);
          const finalOutput = streamCompleted ? stream.finalOutput : undefined;
          conclusion = typeof finalOutput === 'string' ? finalOutput : finalOutput !== undefined
            ? JSON.stringify(finalOutput) : runAnswer;
          outputOrigin = streamCompleted && finalOutput !== undefined ? 'sdk_final' : 'assistant_stream';
          finish = resolveOpenAiNativeCompletion({protocol: config.protocol, response: lastResponse,
            chatTerminal, streamCompleted, conclusion});
          providerPhase.end('ok');
          const nativeProtocol = inspectCandidateProtocol(conclusion);
          modelCall?.end({outcome: 'ok', ...(chatTerminal.model ? {model: chatTerminal.model} : {}),
            output: {bodyChars: nativeProtocol.canonicalBody.length,
              sidecarChars: Math.max(0, conclusion.length - nativeProtocol.canonicalBody.length)}});
          const candidateProtocolDiagnostic = buildCandidateProtocolDiagnostic(nativeProtocol, 'native', recoveringOutputLimit ? 2 : 1);
          this.emitUpdate({type: 'progress', content: {phase: 'candidate_protocol',
            candidateProtocolDiagnostic}, timestamp: Date.now()});
          const protocolInvalid = nativeProtocol.status === 'invalid';
          const bodyEmpty = !nativeProtocol.canonicalBody.trim();
          const declarationRequest = requestNativeDeclarationCompletion({
            intent: turnIntent, completion: finish, candidate: conclusion,
            remainingDeliveryTurns: rounds < maxTurns ? turnBudget.deliveryTurns : 0,
            // A well-framed rejected declaration is repaired alone; the body is kept as delivered.
            repairInvalid: true,
          });
          const declarationRepairRejected = recoveryCandidate?.declarationRequest &&
            !acceptNativeDeclarationCompletion({request: recoveryCandidate.declarationRequest,
              completion: finish, candidate: conclusion});
          const exhaustedBudget = recoveryCandidate?.finish.reason === 'turn_limit' || recoveryCandidate?.finish.reason === 'timeout'
            ? recoveryCandidate.finish.reason : undefined;
          if (recoveringOutputLimit && (finish.status !== 'completed' || bodyEmpty || declarationRepairRejected ||
              protocolInvalid && !exhaustedBudget ||
              recoveryCandidate?.hadDeclarations && nativeProtocol.status === 'absent')) {
            restoreRecoveryCandidate();
          } else if (recoveringOutputLimit && exhaustedBudget) {
            // The new SDK candidate is real, but completing its prose does not
            // complete the investigation that exhausted its acquisition budget.
            // Retain invalid declarations for the shared quality gate rather
            // than erase an available partial body to hide its failed checks.
            finish = {...finish, status: 'incomplete', reason: exhaustedBudget};
            terminationMessage = exhaustedBudget === 'turn_limit'
              ? localize(config.outputLanguage,
                '调查轮次预算已耗尽；仅依据已返回的证据生成有限结论，未完成项仍需继续核查。',
                'The investigation turn budget was exhausted; this limited conclusion uses only returned evidence, and unfinished questions still need investigation.')
              : localize(config.outputLanguage,
                '调查时间预算已耗尽；仅依据已返回的证据生成有限结论，未完成项仍需继续核查。',
                'The investigation time budget was exhausted; this limited conclusion uses only returned evidence, and unfinished questions still need investigation.');
          } else if (!recoveringOutputLimit && (finish.status === 'incomplete' && finish.reason === 'output_limit' ||
              finish.status === 'completed' && (bodyEmpty || protocolInvalid || declarationRequest)) &&
              streamCompleted && rounds < maxTurns && Date.now() < runDeadline.current()) {
            // A declaration-only request wins over a full-answer continuation; framing
            // failures (no request) keep the continuation.
            const recoveryReason = finish.reason === 'output_limit' ? 'output_limit' : declarationRequest
              ? declarationRequest.reason : protocolInvalid ? 'invalid_protocol' : 'empty_body';
            const recoveryInput = buildOpenAiOutputLimitRecoveryInput(stream.history, config.maxHistoryBytes,
              observedToolCalls, turnIntent, config.outputLanguage, recoveryReason, candidateProtocolDiagnostic,
              declarationRequest);
            if (recoveryInput) {
              acceptsToolUpdates = false;
              attemptCall = {purpose: recoveryReason === MISSING_NATIVE_DECLARATION || recoveryReason === INVALID_NATIVE_DECLARATION
                ? 'declaration_repair' : 'continuation', trigger: recoveryReason};
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                hadDeclarations: nativeProtocol.status !== 'absent', ...(declarationRequest ? {declarationRequest} : {})};
              agent = agent.clone({tools: [], modelSettings: {...agent.modelSettings, toolChoice: 'none'}});
              runInput = recoveryInput;
              continue;
            }
          }
          break;
        } catch (error) {
          providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
          modelCall?.end({outcome: timedOut ? 'cancelled' : runtimeOutcomeFromError(error, executionLease.signal)});
          analysisAbortScope.throwIfAborted();
          conclusion = runAnswer;
          terminationMessage = compactProviderErrorMessage(error);
          outputOrigin = 'assistant_stream';
          finish = timedOut ? {status: 'incomplete', reason: 'timeout'}
            : error instanceof MaxTurnsExceededError ? {status: 'incomplete', reason: 'turn_limit'}
            : {status: 'failed', reason: 'provider_error'};
          rounds += error instanceof MaxTurnsExceededError ? Math.max(attemptMaxTurns, attemptModelTurns)
            : Math.max(attemptModelTurns, attemptDispatched ? 1 : 0);
          runtimePerformanceOutcome = timedOut ? 'cancelled' : 'error';
          if (!timedOut && error instanceof MaxTurnsExceededError && reserveDeliveryTurn &&
              rounds < maxTurns && Date.now() < runDeadline.current()) {
            let history: AgentInputItem[] | undefined;
            try { history = error.state?.history; } catch { /* Unreadable history cannot authorize recovery. */ }
            const nativeProtocol = inspectCandidateProtocol(conclusion);
            const completeRecoveryInput = history && buildOpenAiOutputLimitRecoveryInput(history,
              config.maxHistoryBytes, observedToolCalls, turnIntent, config.outputLanguage, 'turn_limit',
              buildCandidateProtocolDiagnostic(nativeProtocol, 'native', 1));
            const boundedPrompt = closeoutTape.buildPrompt({query, priorConclusion: emittedAnswer || conclusion,
              outputLanguage: config.outputLanguage});
            const boundedInput = boundedPrompt ? [{role: 'user' as const, content: boundedPrompt}] : undefined;
            const combinedInput = completeRecoveryInput && boundedInput ? [...completeRecoveryInput, ...boundedInput] : undefined;
            const recoveryInput = combinedInput && serializedByteLength(combinedInput) <= config.maxHistoryBytes
              ? combinedInput : boundedInput ?? completeRecoveryInput;
            if (recoveryInput) {
              acceptsToolUpdates = false;
              attemptCall = {purpose: 'continuation', trigger: 'turn_limit'};
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                hadDeclarations: nativeProtocol.status !== 'absent'};
              agent = agent.clone({tools: [], modelSettings: {...agent.modelSettings, toolChoice: 'none'}});
              runInput = recoveryInput;
              continue;
            }
          }
          // A timeout keeps the evidence already returned in this run. One no-tool
          // delivery call inside the reserve turns it into a limited answer; with
          // no returned data there is nothing to deliver and the empty result stands.
          const deliveryWindowMs = runDeadline.deliveryWindowMs();
          if (timedOut && deliveryDeadlineAt === undefined) {
            timeoutDelivery = recoveringOutputLimit ? 'recovery_in_progress'
              : !closeoutTape.hasReturnedData() ? 'no_returned_data'
                : rounds >= maxTurns ? 'turn_budget_exhausted'
                  : deliveryWindowMs < perTurnMs ? 'delivery_window_too_short' : 'attempted';
          }
          if (timedOut && timeoutDelivery === 'attempted' && deliveryDeadlineAt === undefined) {
            const boundedPrompt = closeoutTape.buildPrompt({query, priorConclusion: emittedAnswer || conclusion,
              outputLanguage: config.outputLanguage, budgetExhausted: 'timeout'});
            if (!boundedPrompt) timeoutDelivery = 'template_unavailable';
            if (boundedPrompt) {
              acceptsToolUpdates = false;
              attemptCall = {purpose: 'continuation', trigger: 'timeout'};
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                hadDeclarations: inspectCandidateProtocol(conclusion).status !== 'absent'};
              deliveryDeadlineAt = Date.now() + deliveryWindowMs;
              agent = agent.clone({tools: [], modelSettings: {...agent.modelSettings, toolChoice: 'none'}});
              runInput = [{role: 'user' as const, content: boundedPrompt}];
              continue;
            }
          }
          if (recoveringOutputLimit) restoreRecoveryCandidate();
          break;
        } finally {
          active = false;
          controller.abort();
          requestTimeout.clear();
          providerIdleTimeout.clear();
          linked.dispose();
          analysisAbortScope.signal.removeEventListener('abort', onCancellation);
        }
      }
      analysisAbortScope.throwIfAborted();
      acceptsToolUpdates = false;
      const budget = runDeadline.snapshot();
      if (budget.extended || timeoutDelivery !== 'not_needed') {
        const delivery = timeoutDelivery !== 'attempted' ? timeoutDelivery
          : recoveryCandidate && attemptId !== recoveryCandidate.attemptId ? 'delivered' : 'restored';
        console.warn(`[OpenAIRuntime] run budget: base=${budget.baseBudgetMs}ms max=${budget.maxRunMs}ms ` +
          `reserve=${budget.deliveryReserveMs}ms finalizationReserve=${runDeadline.finalizationReserveMs}ms ` +
          `effective=${budget.deadlineMs}ms elapsed=${budget.elapsedMs}ms ` +
          `progress=${budget.progressCount} progressExtensions=${budget.progressExtensions} ` +
          `outputExtensions=${budget.outputExtensions} recentSlowestRound=${budget.recentSlowestRoundMs}ms ` +
          `finish=${finish.reason ?? finish.status} timeoutDelivery=${delivery}`);
      }
      const findings = extractFindingsFromText(conclusion);
      const partial = finish.status !== 'completed';
      const nativeResult: AnalysisResult = {
        sessionId, success: finish.status !== 'failed', findings,
        hypotheses: context.hypotheses.map(h => this.toProtocolHypothesis(h)),
        conclusion, confidence: estimateAnalysisConfidence({findings, partial}), rounds,
        totalDurationMs: Date.now() - startTime, turnIntent, outputOrigin, terminationMessage,
        ...(partial ? {partial: true} : {}),
        ...(finish.reason ? {terminationReason: openAiTerminationReason(finish.reason)} : {}),
        quickRun: quickBudget ? buildQuickRunReceipt({requestedMode: options.analysisMode ?? 'auto',
          turnIntent, modeDecision: turnIntent.status === 'resolved' ? 'ai' : 'ai_unavailable',
          budget: quickBudget, actualTurns: rounds, elapsedMs: Date.now() - startTime,
          stopReason: quickStopReasonFromTermination({partial, terminationReason: finish.reason ? openAiTerminationReason(finish.reason) : undefined,
            actualTurns: rounds, targetTurns: quickBudget.targetTurns, hardCapTurns: quickBudget.hardCapTurns}),
          evidence: {frontendPrequeryInjected: analysisRunSpec.traceContext.datasetCount},
          contextInjected: {conversationTurns: countCompletedQuickConversationTurns(previousTurns)},
        }) : undefined,
      };
      const {result, deliveryContext, conclusionProjection, protocolProjection} = finalizeOpenAiCandidate({
        result: nativeResult, runId, attemptId, finish, outputOrigin,
        sourceUse,
      });
      // Finalization gets the deadline this run reached plus the reserved time its
      // evidence reads need; it cannot extend it and never passes the hard deadline.
      const semanticCall = result.completion?.reason !== 'turn_limit' && result.completion?.reason !== 'timeout';
      const finalizationDeadlineAt = runDeadline.finalizationDeadlineAt(Date.now(), deliveryDeadlineAt, {
        useRemainingBudget: reportReviewUsesRemainingBudget({semanticCall, turnIntent: resolvedTurnIntent, result})});
      this.emitUpdate({type: 'progress', content: {phase: 'candidate_protocol',
        candidateProtocolDiagnostic: buildCandidateProtocolDiagnostic(inspectCandidateProtocol(result.conclusion), 'runtime_projected',
          recoveryCandidate && attemptId !== recoveryCandidate.attemptId ? 2 : 1, conclusionProjection.disposition)}, timestamp: Date.now()});
      const verificationPhase = runtimePerformance.startPhase('verification');
      await verifyConclusion(result.findings, result.conclusion, {
        emitUpdate: update => this.emitUpdate(update), enableLLM: false,
        plan: this.sessionPlans.get(sessionId)?.current ?? null, hypotheses: context.hypotheses,
        sceneType, outputLanguage: config.outputLanguage, emitIssueProgress: false,
        deliveryContext,
        conclusionContract: result.conclusionContract,
      });
      verificationPhase.end('ok');
      analysisAbortScope.throwIfAborted();
      // Draft diagnostics precede contract/evidence extraction. They cannot stamp
      // terminal failure; the shared new_finalization gate evaluates the actual facts.
      // Runtime draft assessment cannot certify final evidence collected by HTTP/CLI later.
      applyFinalResultQualityGate({result, sceneType, context: deliveryContext,
        comparisonIdentity: context.comparisonIdentity, deferFocusedEvidenceFinalization: true});
      const closingProvider = provider;
      return await commitAfterProviderClose(() => closingProvider.close().catch(() => undefined), analysisAbortScope, () => {
        provider = undefined;
        this.recordTurn({query, sessionId, result, sessionContext, previousTurnCount: previousTurns.length, quickMode,
          sourceDerived: analysisHasPrivateContext(options),
          analysisContextFingerprint: options.analysisContextFingerprint});
        this.recordPatternMemory({sessionId, result, previousTurnCount: previousTurns.length, quickMode,
          sceneType, architecture: context.architecture, packageName: context.effectivePackageName, options});
        this.emitUpdate({type: 'conclusion', content: {conclusion: result.conclusion, durationMs: Date.now() - startTime, turns: rounds}, timestamp: Date.now()});
        this.emitUpdate({type: 'answer_token', content: {done: true, totalChars: result.conclusion.length}, timestamp: Date.now()});
        attachFinalizationContext(result, {
          runId, sessionId, deadlineMs: finalizationDeadlineAt, turnIntent: resolvedTurnIntent,
          providerQuery: {text: analysisRunSpec.query.text, analysisContextFingerprint: options.analysisContextFingerprint},
          strategyRegistry: intentResolver.strategyRegistry,
          selection: analysisRunSpec.selection,
          traceIdentity: {currentTraceId, referenceTraceId}, deliveryContext, protocolProjection,
          sourceUse: sourceUse?.getSourceUseDecision(),
          sourceScope: sourceUse?.getSourceExecutionScope?.(),
          evidenceReadView: this.artifactStores.get(sessionId)?.createEvidenceReadView({
            allowedTraces, ownerKey: evidenceOwnerKey, currentRunId: runId,
          }),
          // No SDK/session state survives this closure. The shared context supplies
          // the finalization caller's signal and clamps the original absolute deadline.
          dispatchText: !semanticCall
            ? undefined : input => runOpenAiIntentTransport({...input,
            config: finalizationConfig, purpose: 'final_semantic',
            ...(finalizationConfig.maxOutputTokens !== undefined
              ? {maxOutputTokens: finalizationConfig.maxOutputTokens} : {})}),
        });
        return result;
      });
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(error, executionLease.signal);
      analysisAbortScope.throwIfAborted();
      const message = compactProviderErrorMessage(error);
      const attemptId = randomUUID();
      const {result} = finalizeOpenAiCandidate({
        result: {sessionId, success: false, findings: [], hypotheses: [],
          conclusion: '', confidence: 0, rounds, totalDurationMs: Date.now() - startTime,
          turnIntent, partial: true, terminationReason: 'execution_error', terminationMessage: message},
        runId, attemptId, finish: {status: 'failed', reason: 'provider_error'},
        outputOrigin: 'runtime_fallback', sourceUse,
      });
      this.emitUpdate({type: 'error', content: {message: `AI analysis failed: ${result.terminationMessage ?? ''}`}, timestamp: Date.now()});
      return result;
    } finally {
      acceptsToolUpdates = false;
      await provider?.close().catch(() => undefined);
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      executionLease.signal.removeEventListener('abort', bridgeExecutionAbort);
      unregisterAnalysisAbortHandle();
      this.activeAnalyses.delete(sessionId);
      executionLease.settle();
      finalizationPhase.end(runtimePerformanceOutcome);
      runtimePerformance.finalize(runtimePerformanceOutcome);
    }
  }

  reset(): void {
    this.executionGuard.clear();
    this.abortAllSessions();
    this.architectureCache.clear();
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionSqlErrorPartitions.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.activeAnalyses.clear();
  }

  cleanupSession(sessionId: string): void {
    this.abortSession(sessionId);
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
    const privateKnowledge = analysisHasPrivateContext(sessionFields);
    const durableFields = projectSessionFieldsForDurableSnapshot(sessionFields);
    const planState = this.sessionPlans.get(sessionId);
    const artifactStore = this.artifactStores.get(sessionId);
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
      // No native SDK state crosses a logical turn, so only the provider pin is engine-local.
      engineState: createOpenAISnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
      }),
      agentRuntimeKind: 'openai-agents-sdk',
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
      this.architectureCache.set(traceId, snapshot.architecture);
    }
  }

  private resetAnalysisSessionState(sessionId: string, traceId: string, options: AnalysisOptions): OpenAIAnalysisSessionState {
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

    return {
      artifactStore,
      notes,
      analysisPlan,
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
      runId: string;
      sceneType: SceneType;
      policy: RuntimeTurnPolicy;
      turnIntent: AnalysisTurnIntent;
      strategyRegistry: ReadonlyStrategyRegistrySnapshot;
      analysisRunSpec: AnalysisRunSpec;
      sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns: ConversationTurn[];
      executionLease?: RuntimeExecutionLease;
      runtimePerformance?: RuntimePerformanceRun;
      historyReader?: AnalysisHistoryReader;
      toolObserver?: RuntimeToolObserver;
      isActive?: () => boolean;
      sceneDeadlineMs?: number;
      scenePacing?: ScenePacingInputs;
    },
  ) {
    const {config, sceneType, policy, analysisRunSpec, sessionContext, executionLease} = runtime;
    const knowledgeScope = analysisRunSpec.scopes.knowledge;
    const preflight = async <T>(name: Parameters<RuntimePerformanceRun['startPhase']>[0], work: () => Promise<T>): Promise<T> => {
      executionLease?.throwIfAborted();
      const phase = runtime.runtimePerformance?.startPhase(name);
      try {
        const value = await work();
        executionLease?.throwIfAborted();
        phase?.end('ok');
        return value;
      } catch (error) {
        phase?.end(runtimeOutcomeFromError(error, executionLease?.signal));
        throw error;
      }
    };
    const focusResult = await detectRunFocusApps({
      traceProcessorService: this.traceProcessorService, traceId, preflight: policy.preflight,
      selectionContext: options.selectionContext, measure: detect => preflight('focus', detect),
    });
    const focusTarget = resolveFocusAppTarget({userPackageName: options.packageName, focusResult});
    const effectivePackageName = focusTarget.packageName;
    const architecture = policy.preflight !== 'none'
      ? await preflight('architecture', () => this.detectArchitecture(traceId, effectivePackageName)) : undefined;
    executionLease?.throwIfAborted();
    const traceCompleteness = policy.preflight !== 'none'
      ? await preflight('completeness', () => this.detectCompleteness(traceId, architecture)) : undefined;
    const comparisonContext = options.referenceTraceId && policy.allowAutomaticPrefetch
      ? await preflight('comparison', () => this.buildComparisonContext(traceId, options.referenceTraceId!, config.outputLanguage, options.tracePairContext))
      : buildRuntimeTracePairIdentityContext(options);
    const knowledgeBaseContext = policy.allowAutomaticPrefetch
      ? await preflight('knowledge', async () => {
          try {return (await getExtendedKnowledgeBase()).getContextForAI(query, 8);} catch {return undefined;}
        }) : undefined;
    // Registry loading is local capability discovery, not new trace/source evidence.
    await preflight('skill_registry', () => ensureSkillRegistryInitialized());
    executionLease?.throwIfAborted();
    const {artifactStore, notes, analysisPlan, hypotheses, uncertaintyFlags} = this.resetAnalysisSessionState(sessionId, traceId, options);
    // The detector's primary app becomes citable current-run evidence.
    const citedFocusTarget = registerFocusAppEvidence({store: artifactStore, traceId, focusResult, focusTarget});
    const sqlErrorPartition = analysisContextMemoryPartitionKey(options);
    if (this.sessionSqlErrorPartitions.get(sessionId) !== sqlErrorPartition) {
      this.sessionSqlErrors.delete(sessionId);
      this.sessionSqlErrorPartitions.set(sessionId, sqlErrorPartition);
    }
    const sqlErrors = this.sessionSqlErrors.get(sessionId) ?? (policy.allowAutomaticPrefetch
      ? loadLearnedSqlFixPairs(5, knowledgeScope) : []);
    this.sessionSqlErrors.set(sessionId, sqlErrors);
    const entityStore = sessionContext.getEntityStore();
    const skillExecutor = createSkillExecutor(this.traceProcessorService);
    const effectiveSkillRegistry = resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    const sceneCoverageRegistry = resolveSceneProductScope(options, {sessionId, traceId, runId: options.runId ?? ''})
      ? snapshotSceneCoverageRegistry(effectiveSkillRegistry, runtime.strategyRegistry, runtime.turnIntent.sceneId) : undefined;
    skillExecutor.registerSkills(sceneCoverageRegistry ? [...sceneCoverageRegistry.skills] : effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(sceneCoverageRegistry ? new Map(sceneCoverageRegistry.fragments) : effectiveSkillRegistry.getFragmentCache());
    const canInvokeTool = () => runtime.isActive?.() !== false && !executionLease?.signal.aborted;
    const sceneRunContext = await activateSceneRuntime(options, {sessionId, traceId, runId: options.runId ?? '',
      deadlineMs: runtime.sceneDeadlineMs ?? 0, traceProcessorService: this.traceProcessorService,
      artifactStore, sceneCoverageRegistry, signal: executionLease?.signal, canInvokeTool, pacing: runtime.scenePacing});
    const mcp = createClaudeMcpServer({
      sceneRunContext,
      runId: runtime.runId,
      analysisHistoryReader: runtime.historyReader,
      toolObserver: runtime.toolObserver,
      canInvokeTool,
      conversationTraceAttached: options.assistantSurface === 'conversation' ? options.conversationTraceAttached === true : undefined,
      runManifestAttributionSink: options.runManifestAttributionSink,
      sessionId, traceId, userQuery: query, traceProcessorService: this.traceProcessorService, skillExecutor,
      packageName: effectivePackageName, focusTarget, emitUpdate: update => {
        if (!executionLease?.signal.aborted && runtime.isActive?.() !== false) this.emitUpdate(update);
      },
      onSkillResult: result => {
        if (!executionLease?.signal.aborted && runtime.isActive?.() !== false && result.displayResults) {
          this.captureEntitiesFromSkillDisplayResults(result.displayResults, entityStore);
        }
      },
      analysisNotes: notes, artifactStore, cachedArchitecture: architecture,
      recentSqlErrors: sqlErrors, analysisPlan, watchdogWarning: {current: null}, hypotheses, sceneType, uncertaintyFlags,
      referenceTraceId: options.referenceTraceId, comparisonContext,
      allowNewEvidence: policy.allowNewEvidence, strategyRegistry: runtime.strategyRegistry,
      skillNotesBudget: createRuntimeSkillNotesBudget(policy.budgetMode === 'quick'),
      lightweight: usesLightweightToolCatalog(policy),
      outputLanguage: config.outputLanguage, knowledgeScope,
      durableLearning: resolveDurableLearningPermission(options),
      codeAwareMode: options.codeAwareMode, codebaseIds: options.codebaseIds, knowledgeSourceIds: options.knowledgeSourceIds,
      sourceUsePolicy: options.sourceUsePolicy, analysisContextFingerprint: options.analysisContextFingerprint,
      androidInternalsPackPin: options.androidInternalsPackPin,
    });
    const traceInfo = this.traceProcessorService.getTrace(traceId);
    const promptContext: ClaudeAnalysisContext = {
      query, turnIntent: runtime.turnIntent, strategyRegistry: runtime.strategyRegistry,
      onDemandContext: policy.onDemandContext,
      // The run's own preflight, not one recomputed from the intent: a
      // conversation turn with no attached trace read no trace facts and the
      // prompt must not advertise them.
      preflight: policy.preflight,
      architecture, packageName: effectivePackageName, focusTarget: citedFocusTarget,
      knowledgeBaseContext, sceneType,
      selectionContext: options.selectionContext, comparison: comparisonContext, traceCompleteness,
      traceOs: traceInfo?.traceOs, traceFormat: traceInfo?.traceFormat,
      outputLanguage: config.outputLanguage, codeAwareMode: options.codeAwareMode, codebaseIds: options.codebaseIds,
    };
    return {
      systemPrompt: buildSystemPrompt(promptContext),
      tools: createOpenAIToolsFromMcpDefinitions(mcp.toolDefinitions), allowedTools: mcp.allowedTools,
      sessionContext, previousTurns: runtime.previousTurns, architecture, hypotheses,
      effectivePackageName, sourceUse: mcp.sourceUse,
      ...(comparisonContext ? {comparisonIdentity: buildComparisonIdentity(focusTarget, comparisonContext)} : {}),
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

  private handleStreamEvent(
    event: RunStreamEvent,
    outputLanguage: OutputLanguage,
    streamContext: {
      sessionId: string;
      quickMode: boolean;
      answerStreamFilter: OpenAiReasoningFilterState;
      answerTextProjection?: CodeAwareStreamingTextProjection;
      runtimePerformance?: RuntimePerformanceRun;
      /** The attempt's projected view of the run draft; tool calls revoke its segment. */
      answerDraft: ProjectedAnswerDraft;
      toolInputsByTaskId: Map<string, { toolName: string; args: Record<string, unknown> }>;
      processedToolResultIds?: Set<string>;
      tracePairContext?: TracePairContext;
      onToolCalled?: () => void;
      /** A tool result returned to the model: one completed investigation round. */
      onToolOutput?: () => void;
    },
  ): string {
    const now = Date.now();
    if (event.type === 'raw_model_stream_event') {
      const data = event.data as any;
      if (data?.type === 'output_text_delta' && typeof data.delta === 'string') {
        const delta = filterOpenAiVisibleAnswerDelta(data.delta, streamContext.answerStreamFilter);
        if (!delta) return '';
        if (streamContext.answerDraft.write(delta, now)) streamContext.runtimePerformance?.recordFirstOutput();
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
      const args = parseJsonObject(rawItem?.arguments) || {};
      const toolName: string = rawItem?.name || 'unknown';
      const callKey = openAiToolCallKey(rawItem);
      if (callKey && (streamContext.toolInputsByTaskId.has(callKey) || streamContext.processedToolResultIds?.has(callKey))) return '';
      streamContext.onToolCalled?.();
      // Text this response already streamed preceded a tool call, so it was
      // not the answer: revoke the draft and whatever the projection withheld.
      streamContext.answerDraft.boundary(now);
      if (callKey) streamContext.toolInputsByTaskId.set(callKey, {toolName, args});
      this.emitUpdate({
        type: 'agent_task_dispatched',
        content: {
          taskId: callKey ?? 'unknown',
          toolName,
          args,
          message: formatToolCallNarration(toolName, args, outputLanguage, {
            tracePairContext: streamContext.tracePairContext,
          }),
        },
        timestamp: now,
      });
    } else if (event.name === 'tool_output') {
      const rawOutput = (event.item as any)?.output ?? rawItem?.output;
      const callKey = openAiToolCallKey(rawItem);
      if (callKey && streamContext.processedToolResultIds?.has(callKey)) return '';
      if (callKey) streamContext.processedToolResultIds?.add(callKey);
      streamContext.onToolOutput?.();
      const cached = callKey ? streamContext.toolInputsByTaskId.get(callKey) : undefined;
      const toolName = cached?.toolName || rawItem?.name || 'unknown';
      // Read failure from the raw result: projection replaces a sensitive
      // tool's payload with a rejection envelope that has no success field.
      const resultIsFailure = toolResultIsFailure({toolName, result: rawOutput});
      const projectedOutput = projectToolResultForExternalSurface(toolName, rawOutput);
      const privateToolResultReceipt = issuePrivateToolResultNarrationReceipt({
        toolName, result: projectedOutput, isError: resultIsFailure,
      });
      const resultText = summarizeToolOutput(projectedOutput);
      // Narrate from the projected object while it is still intact; resultText
      // is byte-truncated and can end mid-JSON.
      const resultNarration = formatToolResultNarration({
        toolName,
        args: cached?.args,
        result: projectedOutput,
        isError: resultIsFailure,
        language: outputLanguage,
      });
      // Plan evidence must not depend on having observed the dispatch event.
      if (toolName !== 'unknown') {
        const codeReferences = extractSourceLookupCodeReferences(toolName, rawOutput);
        recordPlanOrPrePlanToolCall(this.sessionPlans.get(streamContext.sessionId), {
          toolName,
          toolCallId: callKey,
          onPhaseAutoCompleted: phase => this.emitUpdate({
            type: 'plan_phase_updated',
            content: planPhaseUpdatedContent({phaseId: phase.id, phaseName: phase.name, status: 'completed', summary: phase.summary, origin: 'auto'}),
            timestamp: Date.now(),
          }),
          input: cached?.args,
          resultText,
          // Read before truncation: planPhaseId and success sit after the body.
          resultFacts: readToolResultFacts(rawOutput),
          returnedCodeReferences: codeReferences.length > 0,
          returnedCodeReferenceHints: codeReferences,
        });
      }
      if (callKey) streamContext.toolInputsByTaskId.delete(callKey);
      this.emitUpdate({
        type: 'agent_response',
        content: {
          taskId: callKey ?? 'unknown',
          toolName,
          result: resultText,
          resultNarration,
          ...(privateToolResultReceipt ? {privateToolResultReceipt} : {}),
          isError: resultIsFailure,
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

  private recordTurn(input: {
    query: string;
    sessionId: string;
    result: AnalysisResult;
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
    previousTurnCount: number;
    quickMode: boolean;
    sourceDerived?: boolean;
    analysisContextFingerprint?: string;
  }): void {
    input.sessionContext.addTurn(
      input.query,
      {
        primaryGoal: input.query,
        aspects: [],
        expectedOutputType: input.result.turnIntent?.deliverable === 'report' ? 'diagnosis' : 'summary',
        complexity: input.result.turnIntent?.recommendedComplexity === 'full' ? 'complex' : 'simple',
        followUpType: input.previousTurnCount > 0 ? 'extend' : 'initial',
      },
      {
        agentId: 'openai-agent',
        success: input.result.success,
        findings: input.result.findings,
        confidence: input.result.confidence,
        message: input.result.conclusion,
        partial: input.result.partial,
        completion: input.result.completion,
        conclusionContract: input.result.conclusionContract,
        sourceDerived: input.sourceDerived || undefined,
        analysisContextFingerprint: input.analysisContextFingerprint,
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
    const durableLearning = resolveDurableLearningPermission(input.options);
    if (!durableLearning) return;
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
      learning: durableLearning,
      status: 'provisional' as const,
      provenance: {
        sessionId: input.sessionId,
        turnIndex: input.previousTurnCount,
      },
      knowledgeScope,
    };

    if (input.result.turnIntent?.scope !== 'scene_wide' || input.result.turnIntent.deliverable !== 'report') {
      saveQuickPathPattern(features, insights, input.sceneType, input.architecture?.type, patternExtras)
        .catch(err => console.warn('[OpenAIRuntime] Quick pattern save failed:', (err as Error).message));
      return;
    }

    saveAnalysisPattern(features, insights, input.sceneType, input.architecture?.type, input.result.confidence, patternExtras)
      .catch(err => console.warn('[OpenAIRuntime] Pattern save failed:', (err as Error).message));

  }

  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    captureSkillDisplayEntities(displayResults, entityStore, 'openai-agent');
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
