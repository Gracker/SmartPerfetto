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
import {getSkillAnalysisAdapter} from '../../../services/skillEngine/skillAnalysisAdapter';
import {createArchitectureDetector} from '../../../agent/detectors/architectureDetector';
import {sessionContextManager} from '../../../agent/context/enhancedSessionContext';
import type {ConversationTurn, StreamingUpdate, Finding} from '../../../agent/types';
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
import {type SceneType} from '../../../agentv3/sceneClassifier';
import {getExtendedKnowledgeBase} from '../../../services/sqlKnowledgeBase';
import {analysisContextMemoryPartitionKey, analysisContextUsesPrivateKnowledge, assertCurrentAnalysisContextAuthorization, buildAnalysisContextAuthorizationFingerprint} from '../../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import type {AnalysisNote, AnalysisPlanV3, ClaudeAnalysisContext, Hypothesis, TracePairContext, TraceCompleteness, UncertaintyFlag} from '../../../agentv3/types';
import {recordPlanOrPrePlanToolCall, resetPrePlanToolCallsForNewRun, readToolResultFacts} from '../../../agentv3/planToolCallRecorder';
import {buildComplexityClassifierInput} from '../../../agentv3/queryComplexityContext';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {resolveRuntimeEvidenceStore} from '../../runtimeEvidenceContext';
import {activateSceneRuntime, resolveSceneProductScope} from '../../../agent/scene/sceneRuntimeBinding';
import type {ScenePacingInputs} from '../../../agent/scene/sceneProposalPacing';
import {createOpenAISnapshotEngineState, getOpenAISnapshotEngineState, projectSessionFieldsForDurableSnapshot, type SessionFieldsForSnapshot, sessionFieldsUsePrivateKnowledge, type SessionStateSnapshot} from '../../../agentv3/sessionStateSnapshot';
import {extractTraceFeatures, extractKeyInsights, saveAnalysisPattern, saveQuickPathPattern} from '../../../agentv3/analysisPatternMemory';
import {probeTraceCompleteness} from '../../../agentv3/traceCompletenessProber';
import {localize, type OutputLanguage} from '../../../agentv3/outputLanguage';
import {createCodeAwareStreamingTextProjection, type CodeAwareStreamingTextProjection} from '../../../services/security/codeAwareOutputRegistry';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import {formatToolCallNarration, formatToolResultNarration, issuePrivateToolResultNarrationReceipt, toolResultIsFailure} from '../../../agentv3/toolNarration';
import {estimateAnalysisConfidence} from '../../../agentv3/analysisTermination';
import {ReasoningThoughtBuffer} from '../../reasoningThoughtBuffer';
import {planPhaseUpdatedContent} from '../../../agentv3/planPhaseEvents';
import {loadOpenAIConfig, type OpenAIAgentConfig} from './openAiConfig';
import {buildOpenAIChatCompletionsTokenLimit} from '../../../services/providerManager/openAiChatCompletionsCompat';
import {createMimoReasoningContentFetch, shouldUseMimoReasoningContentCompat} from './mimoReasoningCompat';
import {createOpenAIToolsFromMcpDefinitions} from './openAiToolAdapter';
import {applyFinalResultQualityGate} from '../../../services/finalResultQualityGate';
import {verifyConclusion} from '../claude/claudeVerifier';
import {SDK_SESSION_FRESHNESS_MS, buildQuickRunReceipt, buildEntityContext, buildRuntimeSessionMapKey, captureSkillDisplayEntities, collectRecentFindings, createRuntimeSkillNotesBudget, getLruCacheEntry, isFreshRuntimeEntry, knowledgeScopeFromAnalysisOptions, providerScopeFromAnalysisOptions, quickStopReasonFromTermination, resolveQuickTurnBudget, setLruCacheEntry, toProtocolHypothesis as toRuntimeProtocolHypothesis} from '../../runtimeCommon';
import {createAnalysisRunSpec, type AnalysisRunSpec} from '../../analysisRunSpec';
import type {RuntimeSelection} from '../../runtimeSelection';
import {RuntimeExecutionGuard, type RuntimeExecutionLease} from '../../runtimeExecutionGuard';
import {createRuntimePerformanceRun, runtimeOutcomeFromError, type RuntimePerformanceOutcome, type RuntimePerformanceRun} from '../../runtimePerformance';
import {OPENAI_AGENT_RUNTIME_KIND} from '../../runtimeKinds';
import {extractSourceLookupCodeReferences} from '../../../services/codebase/sourceLookupTools';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../../services/codebase/sourceClaimVerifier';
import {countCompletedQuickConversationTurns} from '../../quickDirectResult';
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
  requestNativeDeclarationCompletion,
  type NativeDeclarationCompletionRequest,
} from '../../runtimeConclusionProtocol';
import type {RuntimeToolObserver} from '../../runtimeToolObserver';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext, toAnalysisHistoryTurn, type AnalysisHistoryReader} from '../../analysisHistory';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity, type AnalysisCompletion, type AnalysisDeliveryContext, type AnalysisOutputOrigin} from '../../../types/analysisDelivery';

interface OpenAiChatTerminal {
  responseId?: string;
  finishReason?: string;
  refused?: boolean;
  invalid?: boolean;
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

function isMissingOpenAIPreviousResponseError(error: unknown, previousResponseId?: string): boolean {
  if (!previousResponseId || !error || typeof error !== 'object') return false;
  const outer = error as {status?: number; code?: unknown; param?: unknown; error?: {code?: unknown; param?: unknown}};
  const code = outer.code ?? outer.error?.code;
  const param = outer.param ?? outer.error?.param;
  return param === 'previous_response_id' && (outer.status === 404 || code === 'response_not_found');
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

interface OpenAIRunInputResolution {
  input: string | AgentInputItem[];
  effectivePrompt: string;
  previousResponseId?: string;
  shouldPersistRemoteSession: boolean;
}

function resolveOpenAIRunInput(params: {
  effectivePrompt: string;
  historyContext?: string;
}): OpenAIRunInputResolution {
  // Logical turns inherit a product-owned bounded preview. Opaque SDK history
  // would silently bypass that bound even when the remote response is fresh.
  const historyContext = params.historyContext;
  const effectivePrompt = historyContext ? `${historyContext}\n\n${params.effectivePrompt}` : params.effectivePrompt;
  return {
    input: effectivePrompt,
    effectivePrompt,
    shouldPersistRemoteSession: false,
  };
}

function buildOpenAIModelSettings(
  config: Pick<OpenAIAgentConfig, 'maxOutputTokens' | 'protocol'>,
  model: string,
  allowRemotePersistence: boolean,
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
    store: allowRemotePersistence,
  };
}

/** Keep the complete current-run transcript or decline recovery; never trim evidence. */
function buildOpenAiOutputLimitRecoveryInput(
  history: AgentInputItem[],
  maxHistoryBytes: number,
  observedToolCalls: number,
  turnIntent: AnalysisTurnIntent,
  language: OutputLanguage,
  recoveryReason: 'output_limit' | 'empty_body' | 'invalid_protocol' | 'turn_limit' | 'missing_declaration',
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
  if (recoveryReason === 'missing_declaration') {
    if (!declarationRequest) return undefined;
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
  isMissingOpenAIPreviousResponseError,
  createOpenAiReasoningFilterState,
  filterOpenAiVisibleAnswerDelta,
  resolveOpenAIRunInput,
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
        config, sceneType, policy, turnIntent, strategyRegistry: intentResolver.strategyRegistry,
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
      let runInput = resolveOpenAIRunInput({
        effectivePrompt,
        historyContext: renderAnalysisHistoryContext(historyReader.getTurns(), {outputLanguage: config.outputLanguage}) ?? '',
      });
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
          modelSettings: buildOpenAIModelSettings(config, selectedModel, false)});
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
      let finalHistory: AgentInputItem[] | undefined;
      let finalLastResponseId: string | undefined;
      let finalRunState: string | undefined;
      let observedToolCalls = 0;
      let emittedAnswer = '';
      let recoveryCandidate: {
        conclusion: string; attemptId: string; outputOrigin: AnalysisOutputOrigin;
        finish: typeof finish; hadDeclarations: boolean; terminationMessage: string | undefined;
        finalHistory: AgentInputItem[] | undefined; finalLastResponseId: string | undefined;
        finalRunState: string | undefined;
        declarationRequest?: NativeDeclarationCompletionRequest;
      } | undefined;
      const restoreRecoveryCandidate = () => {
        if (!recoveryCandidate) return;
        ({conclusion, attemptId, outputOrigin, finish, terminationMessage,
          finalHistory, finalLastResponseId, finalRunState} = recoveryCandidate);
      };
      for (;;) {
        analysisAbortScope.throwIfAborted();
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
        const answerStreamFilter = createOpenAiReasoningFilterState();
        const answerTextProjection = analysisContextUsesPrivateKnowledge(options)
          ? createCodeAwareStreamingTextProjection(sessionId, `openai-answer-${attemptId}`, 'owner') : undefined;
        const toolInputsByTaskId = new Map<string, {toolName: string; args: Record<string, unknown>}>();
        const processedToolResultIds = new Set<string>();
        const reasoningThoughts = new ReasoningThoughtBuffer();
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
          const stream = await Promise.race([
            runner.run(agent, runInput.input, {stream: true, maxTurns: attemptMaxTurns,
              context: {signal: controller.signal}, signal: controller.signal,
              ...(runInput.previousResponseId ? {previousResponseId: runInput.previousResponseId} : {})}),
            requestTimeout.promise, providerIdleTimeout.promise, cancellation,
          ]);
          const consume = async () => {
            for await (const event of stream) {
              if (!active || controller.signal.aborted || analysisAbortScope.signal.aborted || executionLease.signal.aborted) return;
              providerIdleTimeout.reset();
              if (openAiStreamEventCarriesOutput(event)) runDeadline.recordOutput();
              if (event.type === 'raw_model_stream_event') {
                const data = event.data as any;
                if (data?.type === 'response_started') {
                  attemptModelTurns++;
                  runAnswer = '';
                  lastResponse = undefined;
                  Object.assign(answerStreamFilter, createOpenAiReasoningFilterState());
                } else if (data?.type === 'response_done') lastResponse = data.response;
              }
              const answerDelta = this.handleStreamEvent(event, config.outputLanguage, {
                sessionId, quickMode, answerStreamFilter, answerTextProjection, runtimePerformance,
                suppressAnswerTokens: recoveringOutputLimit,
                toolInputsByTaskId, processedToolResultIds, reasoningThoughts,
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
          const projectedTail = answerTextProjection?.flush();
          if (projectedTail && !recoveringOutputLimit) this.emitUpdate({type: 'answer_token', content: {token: projectedTail}, timestamp: Date.now()});
          // SDK currentTurn can be zero-based; every native response consumes a turn.
          rounds += Math.max(attemptModelTurns, stream.currentTurn || 0, attemptDispatched ? 1 : 0);
          const finalOutput = streamCompleted ? stream.finalOutput : undefined;
          conclusion = typeof finalOutput === 'string' ? finalOutput : finalOutput !== undefined
            ? JSON.stringify(finalOutput) : runAnswer;
          outputOrigin = streamCompleted && finalOutput !== undefined ? 'sdk_final' : 'assistant_stream';
          finish = resolveOpenAiNativeCompletion({protocol: config.protocol, response: lastResponse,
            chatTerminal, streamCompleted, conclusion});
          if (streamCompleted) {
            if (serializedByteLength(stream.history) <= config.maxHistoryBytes) finalHistory = stream.history;
            finalLastResponseId = stream.lastResponseId;
            finalRunState = this.safeSerializeRunState(stream.state);
          }
          providerPhase.end('ok');
          const nativeProtocol = inspectCandidateProtocol(conclusion);
          const candidateProtocolDiagnostic = buildCandidateProtocolDiagnostic(nativeProtocol, 'native', recoveringOutputLimit ? 2 : 1);
          this.emitUpdate({type: 'progress', content: {phase: 'candidate_protocol',
            candidateProtocolDiagnostic}, timestamp: Date.now()});
          const protocolInvalid = nativeProtocol.status === 'invalid';
          const bodyEmpty = !nativeProtocol.canonicalBody.trim();
          const declarationRequest = requestNativeDeclarationCompletion({
            intent: turnIntent, completion: finish, candidate: conclusion,
            remainingDeliveryTurns: rounds < maxTurns ? turnBudget.deliveryTurns : 0,
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
              streamCompleted && rounds < maxTurns && Date.now() < runDeadline.current() && !runInput.previousResponseId) {
            const recoveryReason = finish.reason === 'output_limit' ? 'output_limit' : protocolInvalid ? 'invalid_protocol'
              : declarationRequest ? 'missing_declaration' : 'empty_body';
            const recoveryInput = buildOpenAiOutputLimitRecoveryInput(stream.history, config.maxHistoryBytes,
              observedToolCalls, turnIntent, config.outputLanguage, recoveryReason, candidateProtocolDiagnostic,
              declarationRequest);
            if (recoveryInput) {
              acceptsToolUpdates = false;
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                finalHistory, finalLastResponseId, finalRunState,
                hadDeclarations: nativeProtocol.status !== 'absent', ...(declarationRequest ? {declarationRequest} : {})};
              agent = agent.clone({tools: [], modelSettings: {...agent.modelSettings, toolChoice: 'none'}});
              runInput = {...runInput, input: recoveryInput, previousResponseId: undefined};
              continue;
            }
          }
          break;
        } catch (error) {
          providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
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
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                finalHistory, finalLastResponseId, finalRunState,
                hadDeclarations: nativeProtocol.status !== 'absent'};
              agent = agent.clone({tools: [], modelSettings: {...agent.modelSettings, toolChoice: 'none'}});
              runInput = {...runInput, input: recoveryInput, previousResponseId: undefined};
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
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                finalHistory, finalLastResponseId, finalRunState,
                hadDeclarations: inspectCandidateProtocol(conclusion).status !== 'absent'};
              deliveryDeadlineAt = Date.now() + deliveryWindowMs;
              agent = agent.clone({tools: [], modelSettings: {...agent.modelSettings, toolChoice: 'none'}});
              runInput = {...runInput, input: [{role: 'user' as const, content: boundedPrompt}], previousResponseId: undefined};
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
        allowPersistentLearning: !analysisContextUsesPrivateKnowledge(options), deliveryContext,
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
        if (runInput.shouldPersistRemoteSession && result.completion?.status === 'completed' &&
            result.outputOrigin === 'sdk_final' && !result.partial && conclusionProjection.disposition === 'preserved') {
          this.sessionMap.set(context.sessionMapKey, {history: finalHistory, lastResponseId: finalLastResponseId,
            runState: finalRunState, updatedAt: Date.now()});
        }
        this.recordTurn({query, sessionId, result, sessionContext, previousTurnCount: previousTurns.length, quickMode,
          sourceDerived: analysisContextUsesPrivateKnowledge(options) || Boolean(sourceUse?.getSourceUseDecision()),
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
    const detectedVendor = policy.preflight !== 'none'
      ? await this.detectVendor(traceId) : null;
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
    const {artifactStore, notes, analysisPlan, previousPlan, hypotheses, uncertaintyFlags} = this.resetAnalysisSessionState(sessionId, traceId, options);
    const sqlErrorPartition = analysisContextMemoryPartitionKey(options);
    if (this.sessionSqlErrorPartitions.get(sessionId) !== sqlErrorPartition) {
      this.sessionSqlErrors.delete(sessionId);
      this.sessionSqlErrorPartitions.set(sessionId, sqlErrorPartition);
    }
    const sqlErrors = this.sessionSqlErrors.get(sessionId) ?? (policy.allowAutomaticPrefetch
      ? loadLearnedSqlFixPairs(5, knowledgeScope, options) : []);
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
      analysisNotes: notes, artifactStore, cachedArchitecture: architecture, cachedVendor: detectedVendor,
      recentSqlErrors: sqlErrors, analysisPlan, watchdogWarning: {current: null}, hypotheses, sceneType, uncertaintyFlags,
      referenceTraceId: options.referenceTraceId, comparisonContext,
      allowNewEvidence: policy.allowNewEvidence, strategyRegistry: runtime.strategyRegistry,
      skillNotesBudget: createRuntimeSkillNotesBudget(policy.budgetMode === 'quick'),
      lightweight: usesLightweightToolCatalog(policy),
      outputLanguage: config.outputLanguage, knowledgeScope,
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
      architecture, packageName: effectivePackageName, focusTarget,
      knowledgeBaseContext, sceneType,
      selectionContext: options.selectionContext, comparison: comparisonContext, traceCompleteness,
      traceOs: traceInfo?.traceOs, traceFormat: traceInfo?.traceFormat,
      outputLanguage: config.outputLanguage, codeAwareMode: options.codeAwareMode, codebaseIds: options.codebaseIds,
    };
    return {
      systemPrompt: buildSystemPrompt(promptContext),
      tools: createOpenAIToolsFromMcpDefinitions(mcp.toolDefinitions), allowedTools: mcp.allowedTools,
      sessionContext, previousTurns: runtime.previousTurns, architecture, hypotheses,
      sessionMapKey: analysisRunSpec.identity.sessionMapKey,
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

  private flushReasoningThought(
    streamContext: {
      reasoningThoughts?: ReasoningThoughtBuffer;
      answerTextProjection?: CodeAwareStreamingTextProjection;
    },
    timestamp: number,
  ): void {
    const thought = streamContext.reasoningThoughts?.flush();
    if (!thought) return;
    const projected = streamContext.answerTextProjection?.projectComplete(thought) ?? thought;
    if (!projected.trim()) return;
    this.emitUpdate({type: 'thought', content: {thought: projected}, timestamp});
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
      processedToolResultIds?: Set<string>;
      tracePairContext?: TracePairContext;
      onToolCalled?: () => void;
      /** A tool result returned to the model: one completed investigation round. */
      onToolOutput?: () => void;
      onSuppressedAnswerDelta?: (delta: string) => void;
      /** Holds pre-plan model text so it can be shown as reasoning, not dropped. */
      reasoningThoughts?: ReasoningThoughtBuffer;
      /** A replacement candidate is delivered atomically by the final conclusion event. */
      suppressAnswerTokens?: boolean;
    },
  ): string {
    const now = Date.now();
    if (event.type === 'raw_model_stream_event') {
      const data = event.data as any;
      if (data?.type === 'output_text_delta' && typeof data.delta === 'string') {
        const delta = filterOpenAiVisibleAnswerDelta(data.delta, streamContext.answerStreamFilter);
        if (!delta) return '';
        const projected = streamContext.answerTextProjection?.write(delta) ?? delta;
        if (projected && !streamContext.suppressAnswerTokens) {
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
      const args = parseJsonObject(rawItem?.arguments) || {};
      const taskIds = [rawItem?.callId, rawItem?.call_id, rawItem?.id]
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id !== 'unknown');
      if (taskIds.some(id => streamContext.toolInputsByTaskId.has(id) || streamContext.processedToolResultIds?.has(id))) return '';
      streamContext.onToolCalled?.();
      this.flushReasoningThought(streamContext, now);
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
      const realTaskIds = taskIds.filter(id => id !== 'unknown');
      if (realTaskIds.some(id => streamContext.processedToolResultIds?.has(id))) return '';
      realTaskIds.forEach(id => streamContext.processedToolResultIds?.add(id));
      streamContext.onToolOutput?.();
      const cached = taskIds
        .map(taskId => streamContext.toolInputsByTaskId.get(taskId))
        .find(Boolean);
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
      if (cached) {
        const codeReferences = extractSourceLookupCodeReferences(cached.toolName, rawOutput);
        recordPlanOrPrePlanToolCall(this.sessionPlans.get(streamContext.sessionId), {
          toolName: cached.toolName,
          toolCallId: realTaskIds[0],
          onPhaseAutoCompleted: phase => this.emitUpdate({
            type: 'plan_phase_updated',
            content: planPhaseUpdatedContent({phaseId: phase.id, phaseName: phase.name, status: 'completed', summary: phase.summary, origin: 'auto'}),
            timestamp: Date.now(),
          }),
          input: cached.args,
          resultText,
          // Read before truncation: planPhaseId and success sit after the body.
          resultFacts: readToolResultFacts(rawOutput),
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

  private safeSerializeRunState(state: unknown): string | undefined {
    try {
      const asSerializable = state as { toString?: () => string };
      const serialized = asSerializable?.toString?.();
      return serialized && serialized !== '[object Object]' ? serialized : undefined;
    } catch {
      return undefined;
    }
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
