// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveRuntimePerformanceRecorder} from '../../runtimePerformanceContext';
import {createModelRequestMetricsFetch} from '../../modelRequestMetrics';

import {collectSceneEvidenceForPrompt, collectSelectedEvidenceForPrompt} from '../../sceneEntryEvidence';
import {shouldCollectSelectedEvidenceFoundation} from '../../selectedEvidenceFoundation';
import {snapshotSceneCoverageRegistry} from '../../../agent/scene/sceneCoveragePlan';
import {EventEmitter} from 'events';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Agent, MaxTurnsExceededError, OpenAIProvider, Runner, StreamedRunResult, setTracingDisabled, type AgentInputItem, type ModelSettings, type RunStreamEvent} from '@openai/agents';
import type {Model, ModelProvider, ModelRequest} from '@openai/agents';
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
import {renderRequiredLocalizedStrategyTemplate} from '../../../agentv3/localizedStrategyTemplate';
import {inspectCandidateProtocol, buildCandidateProtocolDiagnostic} from '../../../services/canonicalAnalysisResult';
import {extractFindingsFromText} from '../../../agentv3/claudeFindingExtractor';
import {resolveFocusAppTarget} from '../../focusAppTarget';
import {registerFocusAppEvidence} from '../../focusAppEvidence';
import {type SceneType} from '../../../agentv3/sceneClassifier';
import {getExtendedKnowledgeBase} from '../../../services/sqlKnowledgeBase';
import {analysisContextMemoryPartitionKey} from '../../../services/resolvedAnalysisContext';
import {createRuntimeRunAuthorization, throwIfRunAuthorizationRevoked, type RunAuthorizationCheck} from '../../runAuthorizationFence';
import {ensureRuntimeAdmission, assertRuntimeTaskWorkRemaining, RuntimeTaskDeadlineExceededError} from '../../runtimeTaskDeadline';
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
import {budgetTerminationReason, estimateAnalysisConfidence} from '../../../agentv3/analysisTermination';
import {
  SILENT_ANSWER_DRAFT, createAnswerDraftStream, createProjectedAnswerDraft, type ProjectedAnswerDraft,
} from '../../answerDraftStream';
import {
  createAnswerReasoningFilterState, filterAnswerReasoningDelta, type AnswerReasoningFilterState,
} from '../../answerReasoningFilter';
import {isPlainObject} from '../../../utils/llmJson';
import {planPhaseUpdatedContent} from '../../../agentv3/planPhaseEvents';
import {loadOpenAIConfig, resolveOpenAiClassifierOutputLimit, type OpenAIAgentConfig} from './openAiConfig';
import {withOpenAITextPurposeOptions} from './openAiModelSettings';
import {
  buildOpenAIChatCompletionsTokenLimit,
  resolveOpenAITextRequestPurpose,
  OpenAITextPolicyConfigurationError,
  type OpenAITextRequestPurposeOptions,
} from '../../../services/providerManager/openAiChatCompletionsCompat';
import {resolveModelExecutionProfile, type ResolvedModelExecutionProfile} from '../../../services/providerManager/modelExecutionProfile';
import {resolveModelExecutionPolicy} from '../../modelExecutionPolicy';
import {admitDeliveryCall, deliveryCallFailsOpen} from '../../../services/runtimeCallStats';
import {createMimoReasoningContentFetch, shouldUseMimoReasoningContentCompat} from './mimoReasoningCompat';
import {createOpenAIToolsFromMcpDefinitions, openAiToolCallKey} from './openAiToolAdapter';
import {buildQuickRunReceipt, captureSkillDisplayEntities, createRuntimeSkillNotesBudget, getLruCacheEntry, knowledgeScopeFromAnalysisOptions, providerScopeFromAnalysisOptions, quickStopReasonFromTermination, resolveQuickTurnBudget, setLruCacheEntry, toProtocolHypothesis as toRuntimeProtocolHypothesis} from '../../runtimeCommon';
import {createAnalysisRunSpec, type AnalysisRunSpec} from '../../analysisRunSpec';
import type {RuntimeSelection} from '../../runtimeSelection';
import {RuntimeExecutionGuard, type RuntimeExecutionLease} from '../../runtimeExecutionGuard';
import {createRuntimePerformanceRun, recordRuntimeModelExecutionPolicy, runtimeModelCallInputBytesBucket, runtimeOutcomeFromError, type RuntimeModelDispatchPurpose, type RuntimeModelCallSpan,
  type RuntimeModelCallTrigger, type RuntimeModelCallStart, type RuntimeModelCallEnd, type RuntimePerformanceOutcome, type RuntimePerformanceRun} from '../../runtimePerformance';
import {buildRuntimeAppliedModelControls, buildRuntimeCommonModelConfig, buildRuntimeExecutionProfileObservation,
  recordRuntimeFinalTransportEvent, runtimeObservationHash, runtimeCandidateObservationKey, runtimeProviderOrigin,
  type RuntimeFinalTransportEventInput} from '../../runtimePerformance';
import {OPENAI_AGENT_RUNTIME_KIND} from '../../runtimeKinds';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../../services/codebase/sourceClaimVerifier';
import {countCompletedQuickConversationTurns} from '../../quickBudget';
import {
  buildRuntimeTracePairComparisonContext,
  detectRunFocusApps,
} from '../../runtimePromptContext';
import {createDeadlineRuntimeTimeout, createProgressAwareRunDeadline, createResettableRuntimeTimeout, resolveFullRequestTimeoutMs,
  serializedByteLength, summarizeExternalToolResult} from '../../runtimeLimits';

import {randomUUID} from 'node:crypto';
import {TransformStream} from 'node:stream/web';
import {createAnalysisTurnIntentResolver, type AnalysisTurnIntent} from '../../analysisTurnIntent';
import {resolveRunTurnPolicy, usesLightweightToolCatalog, type RuntimeTurnPolicy} from '../../runtimeTurnPolicy';
import {conversationTraceAttachedOption, runAllowedTraces, runTraceIdentity} from '../../runtimeTraceAttachment';
import {runOpenAiIntentTransport} from './openAiIntentTransport';
import {
  attachFinalizationContext,
  attachRunDeliveryRecord,
  sourceUseFinalizationFields,
} from '../../analysisFinalizationContext';
import {buildRuntimeTracePairIdentityContext} from '../../runtimePromptContext';
import {createRuntimeTurnCloseoutTape, resolveRuntimeTurnBudget} from '../../runtimeTurnCloseout';
import type {RuntimeToolObserver} from '../../runtimeToolObserver';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext, toAnalysisHistoryTurn, type AnalysisHistoryReader} from '../../analysisHistory';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity, type AnalysisCompletion, type AnalysisDeliveryContext, type AnalysisOutputOrigin} from '../../../types/analysisDelivery';
import {analysisHasPrivateContext} from '../../../services/security/analysisPrivateContext';
import {resolveDurableLearningPermission} from '../../../services/security/durableLearning';
import {runtimeSourceDepth} from '../../../services/codebase/sourceDepthPolicy';
import {createOpenAiCandidateIdentity} from '../../openAiCandidateIdentity';
import {installedOpenAiSdkIdentity} from './openAiSdkIdentity';
import {ANALYSIS_OUTPUT_CONFIG} from '../../finalSubmissionConfig';
import {projectRuntimeToolEventPayload} from '../../../services/security/runtimeToolEventProjection';
import type {RuntimeToolRole} from '../../runtimeToolSpec';

type ObservedNativeFact = Extract<RuntimeFinalTransportEventInput, {kind: 'native_terminal'}>['fact'];
/** Internal lineage receipt: the answer is one native body; continuation replaces it whole. */
interface ObservedCandidateLineage {
  terminal: {eventKey?: string};
  bodyPresent: boolean;
}

/** Observation may be unavailable, but must never change execution or ownership. */
function observeSafely<T>(observe: () => T): T | undefined {
  try {return observe();} catch {return undefined;}
}
function observedHash(value: unknown): ObservedNativeFact['response'] {
  return typeof value === 'string' && value.length ? {status: 'observed', hash: runtimeObservationHash(value)} : {status: 'unknown'};
}
function observedFinish(value: unknown): ObservedNativeFact['finish'] {
  switch (value) {
    case 'stop': case 'length': case 'tool_calls': case 'completed': case 'incomplete': case 'failed': return value;
    case undefined: return 'unknown';
    default: return 'other';
  }
}

interface OpenAiDispatchObservationScope {
  onAuthorizedDispatch(): void;
}
// Old SDK chains retain their own attempt, never a newer span.
const modelCallDispatchContext = new AsyncLocalStorage<OpenAiDispatchObservationScope>();

class OpenAiNativeDrainUnavailableError extends Error {
  readonly code = 'OPENAI_SDK_NATIVE_DRAIN_UNAVAILABLE';
  constructor() {
    super('OpenAI SDK native drain contract unavailable; restore the supported SDK and restart this process.');
    this.name = 'OpenAiNativeDrainUnavailableError';
  }
}

// Installed agents-core 0.13.0 attaches this internal promise before returning a
// streamed result. Public completed resolves on abort before the native loop ends;
// provider.close() is resource cleanup, not a substitute for this SDK contract.
type NativeLoopResult = {_getStreamLoopPromise?: () => unknown};
function assertOpenAiNativeDrainContract(): void {
  try {
    if (typeof (StreamedRunResult.prototype as NativeLoopResult)._getStreamLoopPromise === 'function') return;
  } catch { /* A broken SDK contract has one fixed, non-sensitive failure. */ }
  throw new OpenAiNativeDrainUnavailableError();
}
function requireOpenAiNativeDrain(stream: unknown): Promise<void> {
  try {
    const getter = (stream as NativeLoopResult | null)?._getStreamLoopPromise;
    if (typeof getter !== 'function') throw new OpenAiNativeDrainUnavailableError();
    const drain = getter.call(stream);
    if (!drain || typeof (drain as PromiseLike<unknown>).then !== 'function') throw new OpenAiNativeDrainUnavailableError();
    return Promise.resolve(drain).then(() => undefined);
  } catch {
    throw new OpenAiNativeDrainUnavailableError();
  }
}

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
  return reason === 'output_limit' ? undefined : budgetTerminationReason(reason) ?? 'execution_error';
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
  observeCandidate?: (input: {nativeCandidate: AnalysisCandidateIdentity;
    displayCandidate: AnalysisCandidateIdentity | undefined; productStatus: AnalysisCompletion['status']}) => void;
}) {
  const {result, runId, attemptId} = input;
  const nativeEmpty = result.conclusion.trim().length === 0;
  const acceptedCandidate = createOpenAiCandidateIdentity({
    runId, attemptId,
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion),
  });
  result.outputOrigin = input.outputOrigin;
  result.completion = {schemaVersion: 1, runtimeKind: OPENAI_AGENT_RUNTIME_KIND, ...acceptedCandidate,
    ...input.finish, ...(nativeEmpty && input.finish.status === 'completed' ? {status: 'unknown' as const} : {})};
  if (nativeEmpty) {
    result.success = false;
    result.partial = true;
    result.confidence = 0;
  }
  const nativeContext: AnalysisDeliveryContext = {entry: 'runtime_draft', acceptedCandidate,
    completion: result.completion, outputOrigin: input.outputOrigin, turnIntent: result.turnIntent};
  const finalized = finalizeOwnerSourceAwareAnalysisResultWithProjection(result, input.sourceUse, {context: nativeContext});
  if (!finalized.deliveryContext) throw new Error('OpenAI candidate projection omitted delivery context');
  observeSafely(() => input.observeCandidate?.({nativeCandidate: acceptedCandidate,
    displayCandidate: finalized.deliveryContext?.entry === 'historical_restore' ? undefined : finalized.deliveryContext?.acceptedCandidate,
    productStatus: finalized.result.completion?.status ?? 'unknown'}));
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

/** The installed Chat serializer writes reasoning_effort into providerData.
 * Give it request-local settings so that the next Runner turn cannot mistake
 * that write for inherited GPT-only defaults and strip the authored effort. */
function createRequestIsolatedOpenAiModelProvider(delegate: ModelProvider): ModelProvider {
  const copyRequestSettings = (request: ModelRequest): ModelRequest => {
    const modelSettings = {...request.modelSettings};
    if (request.modelSettings.providerData) modelSettings.providerData = {...request.modelSettings.providerData};
    return {...request, modelSettings};
  };
  return {
    async getModel(modelName): Promise<Model> {
      const model = await delegate.getModel(modelName);
      const retryAdvice = model.getRetryAdvice?.bind(model);
      const isolated: Model = {
        getResponse: request => model.getResponse(copyRequestSettings(request)),
        getStreamedResponse: request => model.getStreamedResponse(copyRequestSettings(request)),
      };
      if (retryAdvice) isolated.getRetryAdvice = args => retryAdvice({...args, request: copyRequestSettings(args.request)});
      return isolated;
    },
  };
}

function buildOpenAIBaseModelSettings(
  config: Pick<OpenAIAgentConfig, 'maxOutputTokens' | 'protocol'>,
  model: string,
): ModelSettings {
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

function buildOpenAIModelSettings(
  config: Pick<OpenAIAgentConfig, 'maxOutputTokens' | 'protocol' | 'analysisReasoningEffort' | 'baseURL'>,
  model: string,
  onPolicy?: (receipt: unknown) => void,
  onProfile?: (profile: ResolvedModelExecutionProfile) => void,
): ModelSettings {
  const settings = buildOpenAIBaseModelSettings(config, model);
  const effort = config.analysisReasoningEffort;
  if (effort === undefined) return settings;
  try {
    if (!config.baseURL) throw new OpenAITextPolicyConfigurationError();
    const profile = resolveModelExecutionProfile({runtimeKind: OPENAI_AGENT_RUNTIME_KIND,
      protocol: config.protocol, modelId: model, baseUrl: config.baseURL,
      sdk: {packageName: '@openai/agents-openai', version: 'unknown', adapterContractVersion: 'analysis-controls@1'},
      sdkCapabilities: {surface: config.protocol === 'chat_completions' ? 'openai_chat' : 'openai_responses',
        thinking: 'optional', efforts: config.protocol === 'chat_completions'
          ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh'],
        reasoningRoundtrip: 'unknown', source: 'contract_test'},
      effective: {authoredReasoning: effort === 'none' ? {mode: 'disabled'} : {mode: 'enabled', effort},
        ...(config.maxOutputTokens === undefined ? {} : {maxOutputTokens: config.maxOutputTokens})}});
    observeSafely(() => onProfile?.(profile));
    // SDK 0.13 serializes the string unchanged, although its type union omits
    // max. Only the known Chat profiles below admit that tested passthrough.
    if (effort === 'max' && (config.protocol !== 'chat_completions' || profile.server.efforts.status !== 'supported' ||
      !profile.server.efforts.value.includes('max'))) throw new OpenAITextPolicyConfigurationError();
    const policy = resolveModelExecutionPolicy({profile, purpose: 'answer_turn', selection: 'preserve'});
    if (policy.status === 'unsupported') throw new OpenAITextPolicyConfigurationError();
    try {onPolicy?.(policy.receipt);} catch { /* Observation never changes dispatch. */ }
    if (effort === 'max') return {...settings,
      reasoning: {effort: effort as NonNullable<ModelSettings['reasoning']>['effort']}};
    if (effort === 'none' && config.protocol === 'chat_completions' && profile.endpoint.family === 'deepseek' &&
      profile.server.thinking.status === 'supported' && profile.server.thinking.value === 'optional') {
      return {...settings, providerData: {...settings.providerData, thinking: {type: 'disabled'}}};
    }
    // Generic effort is an SDK option, not permission to inject vendor thinking.
    return {...settings, reasoning: {effort}};
  } catch {throw new OpenAITextPolicyConfigurationError();}
}

/**
 * Provider controls for timeout closeout on the main client, using the same
 * purpose mapping as the no-tool transports. Ordinary answer/continuation
 * calls keep the run's own settings.
 */
function outputOnlyProviderData(
  config: Pick<OpenAIAgentConfig, 'baseURL' | 'protocol'> & Partial<Pick<OpenAIAgentConfig, 'maxOutputTokens'>>,
  purpose: 'continuation',
  selectedModel: string,
  onPolicy?: (receipt: unknown) => void,
  onProfile?: (profile: ResolvedModelExecutionProfile) => void,
): OpenAITextRequestPurposeOptions | undefined {
  if (!config.baseURL) return undefined;
  let requestUrl: URL;
  try { requestUrl = new URL(config.baseURL); } catch { throw new OpenAITextPolicyConfigurationError(); }
  const {options, policy, profile} = resolveOpenAITextRequestPurpose({requestUrl, model: selectedModel,
    runtimeKind: OPENAI_AGENT_RUNTIME_KIND, protocol: config.protocol,
    purpose, outputOnly: true,
    sdkIdentity: {packageName: '@openai/agents-openai', version: 'unknown', adapterContractVersion: 'provider-data@1'},
    // These are adapter expression facts, not arbitrary server/model capabilities.
    sdkCapabilities: {surface: config.protocol === 'chat_completions' ? 'openai_chat' : 'openai_responses',
      thinking: 'optional', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      reasoningRoundtrip: 'unknown', source: 'contract_test'},
    effective: {...(config.maxOutputTokens === undefined ? {} : {maxOutputTokens: config.maxOutputTokens})}});
  observeSafely(() => onProfile?.(profile));
  try {if (policy) onPolicy?.(policy);} catch { /* Observation never changes dispatch. */ }
  return Object.keys(options).length > 0 ? options : undefined;
}

function outputOnlyReasoningReceipt(options: OpenAITextRequestPurposeOptions | undefined):
  Pick<RuntimeModelCallStart, 'reasoning' | 'reasoningEffort'> {
  if (options?.thinking?.type === 'disabled' || options?.reasoning?.effort === 'none') return {reasoning: 'disabled'};
  const effort = options?.reasoning_effort ?? options?.reasoning?.effort;
  return options?.thinking?.type === 'enabled' || effort
    ? {reasoning: 'enabled', ...(effort ? {reasoningEffort: effort} : {})}
    : {reasoning: 'provider_default'};
}

/** Keep the complete current-run transcript or decline recovery; never trim evidence. */
function buildOpenAiOutputLimitRecoveryInput(
  history: AgentInputItem[],
  maxHistoryBytes: number,
  observedToolCalls: number,
  turnIntent: AnalysisTurnIntent,
  language: OutputLanguage,
  recoveryReason: 'output_limit' | 'empty_body' | 'turn_limit',
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
  try {
    prompt = renderRequiredLocalizedStrategyTemplate('prompt-openai-final-report-continuation', language, {
      turn_intent: JSON.stringify(turnIntent),
      completion_reason: recoveryReason,
    });
  } catch { return undefined; }
  if (!prompt.trim()) return undefined;
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

/** @internal Test seam. */
export const __testing = {
  RuntimeAnalysisAbortScope,
  compactProviderErrorMessage,
  commitAfterProviderClose,
  buildOpenAIModelSettings,
  createRequestIsolatedOpenAiModelProvider,
  outputOnlyProviderData,
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
  // Only a post-dispatch missing native lifetime poisons this adapter instance.
  // reset/abort cannot attest unknown work; recovery requires process restart.
  private nativeDrainContractFault?: OpenAiNativeDrainUnavailableError;

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

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    if (this.nativeDrainContractFault) throw this.nativeDrainContractFault;
    assertOpenAiNativeDrainContract();
    const admittedAt = Date.now();
    const runId = options.runId ?? randomUUID();
    const resolvedConfig = loadOpenAIConfig(options.providerId, providerScopeFromAnalysisOptions(options));
    const config = options.outputLanguage ? {...resolvedConfig, outputLanguage: options.outputLanguage} : resolvedConfig;
    const executionLease = this.executionGuard.begin({
      runtime: OPENAI_AGENT_RUNTIME_KIND, sessionId,
      referenceTraceId: options.referenceTraceId, runId,
    });
    const runtimePerformance = createRuntimePerformanceRun(options.runManifestAttributionSink);
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';
    const startTime = Date.now();
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
    let nativeDrainUnknown = false;
    let admission: ReturnType<typeof ensureRuntimeAdmission<AnalysisOptions>> | undefined;
    try {
      executionLease.throwIfAborted();
      admission = ensureRuntimeAdmission(options, {runId, sessionId, admittedAt,
        assertCurrent: () => executionLease.throwIfAborted(), ownerSignal: executionLease.signal});
      options = admission.options;
      const task = admission.admission.task;
      const budgetStartedAt = admission.admission.facts.admittedAt;
      // Intent has not selected quick/full yet. Neither possible native budget
      // may restart after classification; the selected one tightens this ceiling.
      let workDeadlineAt = Math.min(task?.facts.hardDeadlineAt ?? Infinity, budgetStartedAt + Math.max(
        config.maxRunTimeoutMs, config.quickPathPerTurnMs * config.quickMaxTurns,
        resolveFullRequestTimeoutMs(config.fullPathPerTurnMs, config.maxTurns, config.fullRequestTimeoutMs)));
      const workSignal = task ? AbortSignal.any([analysisAbortScope.signal, task.deadlineSignal]) : analysisAbortScope.signal;
      const assertWorkRemaining = () => {
        executionLease.throwIfAborted();
        analysisAbortScope.throwIfAborted();
        assertRuntimeTaskWorkRemaining(task);
        if (Date.now() >= workDeadlineAt) throw new RuntimeTaskDeadlineExceededError();
      };
      assertWorkRemaining();
      const observePolicy = (receipt: unknown) => recordRuntimeModelExecutionPolicy(options.runManifestAttributionSink, receipt);
      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const previousTurns = sessionContext.getAllTurns?.() ?? [];
      // Checked before every provider HTTP request, through the one fenced
      // fetch the classifier and the main client both use (each SDK-internal
      // continuation and retry that resends earlier tool results included), and
      // around every tool call. Aborting the lease aborts the SDK run.
      const {fence: authorization, assertActive} = createRuntimeRunAuthorization({options, executionLease});
      let requestPurpose: {purpose: RuntimeModelDispatchPurpose; trigger?: RuntimeModelCallTrigger} = {purpose: 'answer_turn'};
      // Below the reasoning-compat serializer, so SDK retries and later native
      // turns are measured from the exact body sent to fetch. No response reader.
      const measuredFetch = createModelRequestMetricsFetch(fetch, {
        source: options.runManifestAttributionSink, purpose: () => requestPurpose,
      });
      const authorizedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        authorization.assertCurrent();
        assertWorkRemaining();
        observeSafely(() => modelCallDispatchContext.getStore()?.onAuthorizedDispatch());
        return measuredFetch(input, {...init, signal: init?.signal
          ? AbortSignal.any([init.signal, workSignal]) : workSignal});
      }) as typeof fetch;
      const historyReader = createRuntimeAnalysisHistoryReader({options, sessionId, traceId,
        getTurns: () => sessionContext.getAnalysisHistory?.() ?? previousTurns.map(turn =>
          toAnalysisHistoryTurn({...turn, traceId, sourceDerived: turn.result?.sourceDerived})),
        assertActive: () => {
          analysisAbortScope.throwIfAborted();
          assertActive();
        },
      });
      const intentResolver = createAnalysisTurnIntentResolver({
        productRun: {options, runId, sessionId, traceId},
        context: buildComplexityClassifierInput({
          query, sceneType: 'general', selectionContext: options.selectionContext,
          hasReferenceTrace: Boolean(options.referenceTraceId), previousTurns: [], history: historyReader.getTurns(),
          requestedMode: options.analysisMode ?? 'auto',
        }),
        signal: workSignal,
        deadlineMs: Math.min(workDeadlineAt, Date.now() + config.classifierTimeoutMs),
        modelCallAttribution: {model: config.lightModel, providerOrigin: config.baseURL},
        dispatch: input => runOpenAiIntentTransport({...input, config, purpose: 'classification',
          onExecutionPolicy: observePolicy,
          fetchImpl: authorizedFetch, maxOutputTokens: resolveOpenAiClassifierOutputLimit(config)}),
      });
      const resolvedTurnIntent = await intentResolver.resolve();
      turnIntent = resolvedTurnIntent;
      assertWorkRemaining();
      const policy = resolveRunTurnPolicy(turnIntent, options);
      const quickMode = policy.budgetMode === 'quick';
      const sceneType = turnIntent.sceneId;
      // A failed light-model classifier does not authorize a provider switch.
      // The already configured primary remains usable under the same budget.
      const selectedModel = quickMode && turnIntent.status === 'resolved' ? config.lightModel : config.model;
      const maxTurns = quickMode ? config.quickMaxTurns : config.maxTurns;
      const turnBudget = resolveRuntimeTurnBudget(maxTurns);
      const traceIdentity = runTraceIdentity(traceId, options);
      const allowedTraces = runAllowedTraces(traceIdentity);
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
      const runDeadline = createProgressAwareRunDeadline({baseBudgetMs: timeoutMs, perTurnMs,
        maxRunMs: config.maxRunTimeoutMs, now: budgetStartedAt, hardDeadlineAt: task?.facts.hardDeadlineAt});
      workDeadlineAt = runDeadline.hardDeadlineAt;
      assertWorkRemaining();
      const sceneRunDeadline = resolveSceneProductScope(options, {runId, sessionId, traceId}) ? runDeadline : undefined;
      const context = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        config, runId, sceneType, policy, turnIntent, strategyRegistry: intentResolver.strategyRegistry,
        analysisRunSpec, sessionContext, previousTurns, executionLease, runtimePerformance,
        historyReader, toolObserver: closeoutTape.observe, runAuthorization: authorization,
        assertWorkRemaining, workSignal,
        isActive: () => acceptsToolUpdates && !workSignal.aborted && Date.now() < workDeadlineAt &&
          (!sceneRunDeadline || Date.now() < sceneRunDeadline.current()),
        sceneDeadlineMs: workDeadlineAt, scenePacing: sceneRunDeadline,
      });
      sourceUse = context.sourceUse;
      assertWorkRemaining();
      const promptPrefix = analysisRunSpec.traceContext.promptSection;
      const effectivePrompt = promptPrefix ? `${promptPrefix}\n\n${query}` : query;
      // Logical turns inherit a product-owned bounded preview, never opaque SDK history.
      const historyContext = renderAnalysisHistoryContext(historyReader.getTurns(), {outputLanguage: config.outputLanguage});
      let runInput: string | AgentInputItem[] = historyContext ? `${historyContext}\n\n${effectivePrompt}` : effectivePrompt;
      let chatTerminal: OpenAiChatTerminal = {};
      const nativeFetch = shouldUseMimoReasoningContentCompat(config)
        ? createMimoReasoningContentFetch(authorizedFetch) as typeof fetch : authorizedFetch;
      const observedFetch = config.protocol === 'chat_completions'
        ? createOpenAiTerminalFetch(nativeFetch, terminal => {chatTerminal = terminal;}) : nativeFetch;
      setTracingDisabled(true);
      const observedCommonConfig = observeSafely(() => {
        return buildRuntimeCommonModelConfig(config, {runtime: OPENAI_AGENT_RUNTIME_KIND, sdk: installedOpenAiSdkIdentity()});
      });
      let observedMainProfile: ResolvedModelExecutionProfile | undefined;
      let observedStageProfile: ResolvedModelExecutionProfile | undefined;
      const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
      let runner: Runner;
      let agent: Agent;
      try {
        provider = new OpenAIProvider({
          openAIClient: new OpenAI({apiKey: config.apiKey, baseURL: config.baseURL, fetch: observedFetch as any}),
          useResponses: config.protocol === 'responses',
        });
        runner = new Runner({modelProvider: createRequestIsolatedOpenAiModelProvider(provider), tracingDisabled: true,
          traceIncludeSensitiveData: false, workflowName: 'SmartPerfetto Analysis',
          toolExecution: {maxFunctionToolConcurrency: 1}});
        agent = new Agent({name: 'SmartPerfetto', instructions: context.systemPrompt,
          model: selectedModel, tools: context.tools, toolUseBehavior: 'run_llm_again',
          modelSettings: buildOpenAIModelSettings(config, selectedModel, observePolicy,
            profile => {observedMainProfile = profile;})});
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
      // Completed tool rounds can move the original soft deadline, never its
      // admission-bound hard ceiling.
      // Set only for the single no-tool delivery call admitted after a timeout.
      let deliveryDeadlineAt: number | undefined;
      // Internal diagnostics: which timeout-delivery branch this run took.
      let timeoutDelivery: 'not_needed' | 'attempted' | 'no_returned_data' | 'turn_budget_exhausted' |
        'delivery_window_too_short' | 'template_unavailable' | 'recovery_in_progress' |
        'configuration_unsupported' = 'not_needed';
      let conclusion = '';
      let outputOrigin: AnalysisOutputOrigin = 'assistant_stream';
      let finish: Pick<AnalysisCompletion, 'status' | 'reason' | 'sdkFinishReason'> = {status: 'unknown'};
      let attemptId = '';
      let terminationMessage: string | undefined;
      let observedToolCalls = 0;
      let emittedAnswer = '';
      let retainedLineage: ObservedCandidateLineage | undefined;
      // The last native inspection, reused when projection leaves that exact text unchanged.
      let nativeInspection: {raw: string; protocol: ReturnType<typeof inspectCandidateProtocol>} | undefined;
      let recoveryCandidate: {
        conclusion: string; attemptId: string; outputOrigin: AnalysisOutputOrigin;
        finish: typeof finish; terminationMessage: string | undefined;
        observedLineage?: ObservedCandidateLineage;
      } | undefined;
      // Internal performance receipt: why the next attempt's model calls are made.
      const analysisReasoning: Pick<RuntimeModelCallStart, 'reasoning' | 'reasoningEffort'> =
        config.analysisReasoningEffort === undefined ? {reasoning: 'provider_default'}
          : config.analysisReasoningEffort === 'none' ? {reasoning: 'disabled'}
            : {reasoning: 'enabled', reasoningEffort: config.analysisReasoningEffort};
      let attemptCall: Pick<RuntimeModelCallStart, 'purpose' | 'trigger' | 'reasoning' | 'reasoningEffort'> =
        {purpose: 'answer_turn', ...analysisReasoning};
      const restoreRecoveryCandidate = () => {
        if (!recoveryCandidate) return;
        ({conclusion, attemptId, outputOrigin, finish, terminationMessage} = recoveryCandidate);
        retainedLineage = recoveryCandidate.observedLineage;
      };
      for (;;) {
        requestPurpose = {purpose: attemptCall.purpose, trigger: attemptCall.trigger};
        analysisAbortScope.throwIfAborted();
        // A continuation or retry replaces what the previous attempt streamed.
        answerDraft.reset();
        const recoveringOutputLimit = Boolean(recoveryCandidate);
        // Acquisition and delivery share one absolute hard deadline and total budget.
        const remainingTurns = Math.max(1, maxTurns - rounds);
        const reserveDeliveryTurn = !recoveringOutputLimit && turnBudget.deliveryTurns === 1 && remainingTurns > 1;
        const attemptMaxTurns = recoveringOutputLimit ? 1 : remainingTurns - (reserveDeliveryTurn ? 1 : 0);
        attemptId = randomUUID();
        const observedAttemptId = attemptId;
        const observedAttemptKey = observeSafely(() => runtimeObservationHash(JSON.stringify({runId, attemptId: observedAttemptId}))) ?? '';
        const observedPurpose = attemptCall.purpose;
        const observedAttemptProfile = observedStageProfile ?? observedMainProfile;
        const observedProfileRole = observedStageProfile ? 'stage_policy' as const : 'main_controls' as const;
        const observedTerminal: {eventKey?: string} = {};
        let frozenNativeFact: ObservedNativeFact | undefined;
        let logicalCallOrdinal = 0;
        let observedLogicalCallKey: string | undefined;
        let observedResponse: {logicalCallKey: string; response: ObservedNativeFact['response']; actualModel: ObservedNativeFact['actualModel']} | undefined;
        chatTerminal = {};
        const linked = analysisAbortScope.createLinkedController();
        const controller = linked.controller;
        let active = true;
        let timedOut = false;
        const onTaskDeadline = () => {timedOut = true; controller.abort(task?.deadlineSignal.reason);};
        task?.deadlineSignal.addEventListener('abort', onTaskDeadline, {once: true});
        if (task?.deadlineSignal.aborted) onTaskDeadline();
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
        let rawRun: Promise<unknown> | undefined;
        let nativeDrain: Promise<void> | undefined;
        let consumeWork: Promise<void> | undefined;
        let attemptContractFault: OpenAiNativeDrainUnavailableError | undefined;
        // The first span starts at SDK handoff. Later spans start at the authorized fetch after a native terminal event.
        const attemptInputBucket = runtimeModelCallInputBytesBucket(serializedByteLength(runInput) +
          Buffer.byteLength(context.systemPrompt));
        const startAttemptModelCall = () => {
          observeSafely(() => {
            observedLogicalCallKey = runtimeObservationHash(JSON.stringify({runId, attemptId: observedAttemptId, logicalCallOrdinal: ++logicalCallOrdinal}));
            observedResponse = undefined;
          });
          return runtimePerformance.startModelCall({reasoning: 'provider_default',
            ...attemptCall, model: selectedModel, providerOrigin: config.baseURL, inputBytesBucket: attemptInputBucket});
        };
        let modelCall: RuntimeModelCallSpan | undefined;
        let modelCallDone = false;
        let completedModel: string | undefined;
        const endModelCall = (input: RuntimeModelCallEnd) => {
          const model = modelCallDone ? completedModel : chatTerminal.model;
          modelCall?.end({...input, ...(model ? {model} : {})});
        };
        const advanceModelCall = () => {
          if (!modelCallDone) return; // SDK retries without a native terminal event remain one logical call.
          endModelCall({outcome: 'ok'});
          modelCall = startAttemptModelCall();
          modelCallDone = false;
          completedModel = undefined;
        };
        const observeAttemptDispatch = (): void => {
          if (!active || controller.signal.aborted || analysisAbortScope.signal.aborted || executionLease.signal.aborted ||
              modelCallDispatchContext.getStore() !== dispatchObservationScope) return;
          advanceModelCall();
          observeSafely(() => {
            const providerOrigin = runtimeProviderOrigin(config.baseURL);
            if (!providerOrigin || !observedCommonConfig || !observedLogicalCallKey ||
                observedPurpose !== 'answer_turn' && observedPurpose !== 'continuation') return;
            const profiles = [];
            if (observedAttemptProfile) {
              const profile = buildRuntimeExecutionProfileObservation(observedAttemptProfile, {role: observedProfileRole, purpose: observedPurpose});
              if (!profile) return;
              profiles.push(profile);
            }
            const controls = buildRuntimeAppliedModelControls({requestedOutput: ANALYSIS_OUTPUT_CONFIG,
              commonConfig: observedCommonConfig, appliedSettings: agent.modelSettings, profiles});
            if (!controls) return;
            recordRuntimeFinalTransportEvent(options.runManifestAttributionSink, {kind: 'main_dispatch',
              attemptKey: observedAttemptKey, logicalCallKey: observedLogicalCallKey, purpose: observedPurpose,
              configuredModelHash: runtimeObservationHash(selectedModel), providerOriginHash: runtimeObservationHash(providerOrigin), controls});
          });
        };
        const dispatchObservationScope: OpenAiDispatchObservationScope = Object.freeze({onAuthorizedDispatch: observeAttemptDispatch});
        const answerStreamFilter = createAnswerReasoningFilterState();
        const answerTextProjection = analysisHasPrivateContext(options)
          ? createCodeAwareStreamingTextProjection(sessionId, `openai-answer-${attemptId}`, 'owner') : undefined;
        // A recovery candidate is delivered atomically by the final conclusion event.
        const attemptDraft = recoveringOutputLimit
          ? SILENT_ANSWER_DRAFT : createProjectedAnswerDraft(answerDraft, answerTextProjection);
        const toolInputsByTaskId = new Map<string, {toolName: string; args: Record<string, unknown>; role?: RuntimeToolRole}>();
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
        let providerOutcome: RuntimePerformanceOutcome = 'ok';
        try {
          if (Date.now() >= (attemptDeliveryDeadlineAt ?? runDeadline.current())) {timedOut = true; throw new Error('OpenAI request deadline elapsed');}
          commitEvaluationSdkHandoffIfActive();
          attemptDispatched = true;
          modelCall = startAttemptModelCall();
          const started = modelCallDispatchContext.run(dispatchObservationScope, () => runner.run(agent, runInput, {stream: true, maxTurns: attemptMaxTurns,
            context: {signal: controller.signal}, signal: controller.signal}));
          rawRun = started;
          // Keep startup and its actual background lifetime even if the race loses
          // before a stream arrives. A known startup rejection started no loop.
          nativeDrain = started.then(stream => {
            let drain: Promise<void>;
            try { drain = requireOpenAiNativeDrain(stream); }
            catch {
              nativeDrainUnknown = true;
              attemptContractFault = this.nativeDrainContractFault = new OpenAiNativeDrainUnavailableError();
              controller.abort();
              throw attemptContractFault;
            }
            return drain;
          });
          void nativeDrain.catch(() => undefined);
          const stream = await Promise.race([
            started,
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
                  // Mock/non-fetch SDK streams expose only this boundary. A real fetch already advanced the span.
                  advanceModelCall();
                  attemptModelTurns++;
                  // Text of the previous response preceded a tool call: it was
                  // not the answer. Revoke it, including any withheld suffix.
                  attemptDraft.boundary();
                  runAnswer = '';
                  lastResponse = undefined;
                  Object.assign(answerStreamFilter, createAnswerReasoningFilterState());
                } else if (data?.type === 'response_done') {
                  lastResponse = data.response;
                  // The next chat fetch resets chatTerminal before authorizedFetch. Keep this response's facts now.
                  if (!modelCallDone) {
                    observeSafely(() => {
                      if (observedLogicalCallKey) observedResponse = Object.freeze({logicalCallKey: observedLogicalCallKey,
                        response: Object.freeze(observedHash(data.response?.id)), actualModel: Object.freeze(observedHash(chatTerminal.model))});
                    });
                    completedModel = chatTerminal.model;
                    modelCall?.markDone(data.response?.usage ?? chatTerminal.usage);
                    modelCallDone = true;
                  }
                }
              }
              const answerDelta = this.handleStreamEvent(event, config.outputLanguage, {
                sessionId, quickMode, answerStreamFilter, answerTextProjection, runtimePerformance,
                answerDraft: attemptDraft,
                toolInputsByTaskId, processedToolResultIds,
                toolRoles: context.toolRoles,
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
          consumeWork = modelCallDispatchContext.run(dispatchObservationScope, consume);
          void consumeWork.catch(() => undefined);
          await Promise.race([consumeWork, requestTimeout.promise, providerIdleTimeout.promise, cancellation]);
          analysisAbortScope.throwIfAborted();
          if (recoveringOutputLimit) {
            authorization.assertCurrent();
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
          const nativeProtocol = inspectCandidateProtocol(conclusion);
          nativeInspection = {raw: conclusion, protocol: nativeProtocol};
          observeSafely(() => {
            if (!observedLogicalCallKey) return;
            const response = observedResponse?.logicalCallKey === observedLogicalCallKey ? observedResponse : undefined;
            frozenNativeFact = Object.freeze({attemptKey: runtimeObservationHash(JSON.stringify({runId, attemptId: observedAttemptId})), logicalCallKey: observedLogicalCallKey,
              response: response?.response ?? Object.freeze({status: 'unknown' as const}),
              actualModel: response?.actualModel ?? Object.freeze({status: 'unknown' as const}),
              nativeStatus: finish.status, finish: observedFinish(finish.sdkFinishReason),
              rawMaterial: Object.freeze({status: 'observed' as const, hash: runtimeObservationHash(conclusion)}),
              nativeContract: 'openai_native_completion_observer@1', sdkStreamCompleted: streamCompleted});
            retainedLineage = {terminal: observedTerminal, bodyPresent: nativeProtocol.canonicalBody.trim().length > 0};
          });
          endModelCall({outcome: 'ok',
            output: {bodyChars: nativeProtocol.canonicalBody.length,
              sidecarChars: Math.max(0, conclusion.length - nativeProtocol.canonicalBody.length)}});
          const candidateProtocolDiagnostic = buildCandidateProtocolDiagnostic(nativeProtocol, 'native', recoveringOutputLimit ? 2 : 1);
          this.emitUpdate({type: 'progress', content: {phase: 'candidate_protocol',
            candidateProtocolDiagnostic}, timestamp: Date.now()});
          const bodyEmpty = !nativeProtocol.canonicalBody.trim();
          const exhaustedBudget = recoveryCandidate?.finish.reason === 'turn_limit' || recoveryCandidate?.finish.reason === 'timeout'
            ? recoveryCandidate.finish.reason : undefined;
          if (recoveringOutputLimit && (finish.status !== 'completed' || bodyEmpty)) {
            restoreRecoveryCandidate();
          } else if (recoveringOutputLimit && exhaustedBudget) {
            // The new SDK candidate is real, but completing its prose does not
            // complete the investigation that exhausted its acquisition budget.
            finish = {...finish, status: 'incomplete', reason: exhaustedBudget};
            terminationMessage = exhaustedBudget === 'turn_limit'
              ? localize(config.outputLanguage,
                '调查轮次预算已耗尽；仅依据已返回的证据生成有限结论，未完成项仍需继续核查。',
                'The investigation turn budget was exhausted; this limited conclusion uses only returned evidence, and unfinished questions still need investigation.')
              : localize(config.outputLanguage,
                '调查时间预算已耗尽；仅依据已返回的证据生成有限结论，未完成项仍需继续核查。',
                'The investigation time budget was exhausted; this limited conclusion uses only returned evidence, and unfinished questions still need investigation.');
          } else if (!recoveringOutputLimit &&
              (finish.status === 'incomplete' && finish.reason === 'output_limit' || finish.status === 'completed' && bodyEmpty) &&
              streamCompleted && rounds < maxTurns && Date.now() < runDeadline.current()) {
            const recoveryReason = finish.reason === 'output_limit' ? 'output_limit' : 'empty_body';
            const recoveryInput = buildOpenAiOutputLimitRecoveryInput(stream.history, config.maxHistoryBytes,
              observedToolCalls, turnIntent, config.outputLanguage, recoveryReason);
            if (recoveryInput && admitDeliveryCall(resolveRuntimePerformanceRecorder(options.runManifestAttributionSink), {
              providerOrigin: config.baseURL, model: selectedModel, purpose: 'continuation',
              inputBytes: serializedByteLength(recoveryInput) + Buffer.byteLength(context.systemPrompt),
              remainingMs: runDeadline.current() - Date.now(),
              failOpen: deliveryCallFailsOpen(turnIntent, {bodyMissing: recoveryReason === 'empty_body'})})) {
              acceptsToolUpdates = false;
              attemptCall = {purpose: 'continuation', trigger: recoveryReason, ...analysisReasoning};
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                observedLineage: retainedLineage};
              observedStageProfile = undefined;
              agent = agent.clone({tools: [], modelSettings: {...agent.modelSettings, toolChoice: 'none'}});
              runInput = recoveryInput;
              continue;
            }
          }
          break;
        } catch (error) {
          observeSafely(() => {
            if (frozenNativeFact || !observedLogicalCallKey) return;
            const response = observedResponse?.logicalCallKey === observedLogicalCallKey ? observedResponse : undefined;
            frozenNativeFact = Object.freeze({attemptKey: runtimeObservationHash(JSON.stringify({runId, attemptId: observedAttemptId})), logicalCallKey: observedLogicalCallKey,
              response: response?.response ?? Object.freeze({status: 'unknown' as const}),
              actualModel: response?.actualModel ?? Object.freeze({status: 'unknown' as const}),
              nativeStatus: 'unknown', finish: 'unknown', rawMaterial: Object.freeze({status: 'observed' as const, hash: runtimeObservationHash(runAnswer)}),
              nativeContract: 'openai_native_completion_observer@1', sdkStreamCompleted: streamCompleted});
          });
          providerOutcome = runtimeOutcomeFromError(error, executionLease.signal);
          endModelCall({outcome: timedOut ? 'cancelled' : runtimeOutcomeFromError(error, executionLease.signal)});
          analysisAbortScope.throwIfAborted();
          conclusion = runAnswer;
          retainedLineage = {terminal: observedTerminal, bodyPresent: runAnswer.trim().length > 0};
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
            const completeRecoveryInput = history && buildOpenAiOutputLimitRecoveryInput(history,
              config.maxHistoryBytes, observedToolCalls, turnIntent, config.outputLanguage, 'turn_limit');
            const boundedPrompt = closeoutTape.buildPrompt({query, priorConclusion: emittedAnswer || conclusion,
              outputLanguage: config.outputLanguage});
            const boundedInput = boundedPrompt ? [{role: 'user' as const, content: boundedPrompt}] : undefined;
            const combinedInput = completeRecoveryInput && boundedInput ? [...completeRecoveryInput, ...boundedInput] : undefined;
            const recoveryInput = combinedInput && serializedByteLength(combinedInput) <= config.maxHistoryBytes
              ? combinedInput : boundedInput ?? completeRecoveryInput;
            if (recoveryInput) {
              acceptsToolUpdates = false;
              attemptCall = {purpose: 'continuation', trigger: 'turn_limit', ...analysisReasoning};
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                observedLineage: retainedLineage};
              observedStageProfile = undefined;
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
              // The exhausted investigation cannot restart: this call only
              // renders already-returned evidence within the fixed reserve.
              let closeoutProviderData: OpenAITextRequestPurposeOptions | undefined;
              let closeoutProfile: ResolvedModelExecutionProfile | undefined;
              try { closeoutProviderData = outputOnlyProviderData(config, 'continuation', selectedModel, observePolicy,
                profile => {closeoutProfile = profile;}); }
              catch (error) {
                if (!(error instanceof OpenAITextPolicyConfigurationError)) throw error;
                timeoutDelivery = 'configuration_unsupported';
                break;
              }
              attemptCall = {purpose: 'continuation', trigger: 'timeout',
                ...outputOnlyReasoningReceipt(closeoutProviderData)};
              recoveryCandidate = {conclusion, attemptId, outputOrigin, finish, terminationMessage,
                observedLineage: retainedLineage};
              observedStageProfile = closeoutProfile;
              deliveryDeadlineAt = Date.now() + deliveryWindowMs;
              const closeoutSettings = buildOpenAIBaseModelSettings(config, selectedModel);
              agent = agent.clone({tools: [], modelSettings: withOpenAITextPurposeOptions(
                {...closeoutSettings, toolChoice: 'none'}, closeoutProviderData)});
              runInput = [{role: 'user' as const, content: boundedPrompt}];
              continue;
            }
          }
          if (recoveringOutputLimit) restoreRecoveryCandidate();
          break;
        } finally {
          // Revoke the exact callback captured by this attempt's async chain; never disable another attempt's context.
          active = false;
          controller.abort();
          requestTimeout.clear();
          providerIdleTimeout.clear();
          linked.dispose();
          task?.deadlineSignal.removeEventListener('abort', onTaskDeadline);
          analysisAbortScope.signal.removeEventListener('abort', onCancellation);
          // Rejection of one known operation must never skip draining the others.
          // In particular, a continue cannot overlap the old loop with recovery.
          const observedDrainResults = await Promise.allSettled([rawRun, nativeDrain, consumeWork]);
          observeSafely(() => {
            if (!frozenNativeFact) return;
            const drainStatus = !rawRun || !nativeDrain || !consumeWork ? 'unavailable'
              : observedDrainResults.some(outcome => outcome.status === 'rejected') ? 'rejected' : 'fulfilled';
            observedTerminal.eventKey = recordRuntimeFinalTransportEvent(options.runManifestAttributionSink,
              {kind: 'native_terminal', fact: frozenNativeFact, drainStatus});
          });
          providerPhase.end(attemptContractFault ? 'error' : providerOutcome);
          if (attemptContractFault) throw attemptContractFault;
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
      const {result, deliveryContext, conclusionProjection} = finalizeOpenAiCandidate({
        result: nativeResult, runId, attemptId, finish, outputOrigin,
        sourceUse,
        observeCandidate: ({nativeCandidate, displayCandidate, productStatus}) => {
          const terminalEventKey = retainedLineage?.terminal.eventKey;
          if (!retainedLineage || !displayCandidate || !terminalEventKey) return;
          // Declarations are retired: the answer is one body, and no declaration is classified.
          recordRuntimeFinalTransportEvent(options.runManifestAttributionSink, {kind: 'candidate_retained',
            nativeCandidateKey: runtimeCandidateObservationKey(nativeCandidate), carrier: 'assistant_text', transform: 'native',
            authors: [{role: 'body', terminalEventKey}],
            declaredBody: retainedLineage.bodyPresent ? 'present' : 'absent', declaredClaims: 'unknown', productStatus});
        },
      });
      // Finalization gets the deadline this run reached plus the reserved time its
      // evidence reads need; it cannot extend it and never passes the hard deadline.
      const finalizationDeadlineAt = runDeadline.finalizationDeadlineAt(Date.now(), deliveryDeadlineAt);
      // Report the retained candidate's protocol facts; native completion stays separate.
      this.emitUpdate({type: 'progress', content: {phase: 'candidate_protocol',
        candidateProtocolDiagnostic: buildCandidateProtocolDiagnostic(nativeInspection?.raw === result.conclusion
          ? nativeInspection.protocol : inspectCandidateProtocol(result.conclusion), 'runtime_projected',
          recoveryCandidate && attemptId !== recoveryCandidate.attemptId ? 2 : 1, conclusionProjection.disposition)},
        timestamp: Date.now()});
      analysisAbortScope.throwIfAborted();
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
          traceIdentity, deliveryContext,
          ...sourceUseFinalizationFields(sourceUse),
          evidenceReadView: this.artifactStores.get(sessionId)?.createEvidenceReadView({
            allowedTraces, ownerKey: evidenceOwnerKey, currentRunId: runId,
          }),
        });
        return result;
      });
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(error, executionLease.signal);
      throwIfRunAuthorizationRevoked(executionLease.signal);
      analysisAbortScope.throwIfAborted();
      if (error instanceof OpenAiNativeDrainUnavailableError) throw error;
      const deadlineExceeded = error instanceof RuntimeTaskDeadlineExceededError ||
        admission?.admission.task?.deadlineSignal.aborted === true;
      const message = compactProviderErrorMessage(error);
      const attemptId = randomUUID();
      const {result} = finalizeOpenAiCandidate({
        result: {sessionId, success: false, findings: [], hypotheses: [],
          conclusion: '', confidence: 0, rounds, totalDurationMs: Date.now() - startTime,
          turnIntent, partial: true, terminationReason: deadlineExceeded ? 'timeout' : 'execution_error', terminationMessage: message},
        runId, attemptId, finish: deadlineExceeded ? {status: 'incomplete', reason: 'timeout'} : {status: 'failed', reason: 'provider_error'},
        outputOrigin: 'runtime_fallback', sourceUse,
      });
      // No answer to finalize, but what the run delivered before failing still counts.
      attachRunDeliveryRecord(result, {runId, sessionId, knowledgeUse: sourceUse?.getKnowledgeUse?.()});
      this.emitUpdate({type: 'error', content: {message: `AI analysis failed: ${result.terminationMessage ?? ''}`}, timestamp: Date.now()});
      return result;
    } finally {
      acceptsToolUpdates = false;
      await provider?.close().catch(() => undefined);
      admission?.disposeOwned();
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      executionLease.signal.removeEventListener('abort', bridgeExecutionAbort);
      unregisterAnalysisAbortHandle();
      this.activeAnalyses.delete(sessionId);
      if (!nativeDrainUnknown) executionLease.settle();
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
      architecture: getLruCacheEntry(this.architectureCache, traceId),
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
      setLruCacheEntry(this.architectureCache, traceId, snapshot.architecture);
    }
  }

  private resetAnalysisSessionState(sessionId: string, traceId: string, options: AnalysisOptions,
    preparedArtifactStore?: ArtifactStore): OpenAIAnalysisSessionState {
    const artifactStore = preparedArtifactStore ?? resolveRuntimeEvidenceStore(options, {sessionId, traceId},
      () => this.artifactStores.get(sessionId) ?? new ArtifactStore());
    if (!preparedArtifactStore) this.artifactStores.set(sessionId, artifactStore);

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
      runAuthorization?: RunAuthorizationCheck;
      isActive?: () => boolean;
      assertWorkRemaining?: () => void;
      workSignal?: AbortSignal;
      sceneDeadlineMs?: number;
      scenePacing?: ScenePacingInputs;
    },
  ) {
    const {config, sceneType, policy, analysisRunSpec, sessionContext, executionLease} = runtime;
    const knowledgeScope = analysisRunSpec.scopes.knowledge;
    const selectionContext = analysisRunSpec.selection.present ? analysisRunSpec.selection.context : undefined;
    const preflight = async <T>(name: Parameters<RuntimePerformanceRun['startPhase']>[0], work: () => Promise<T>): Promise<T> => {
      executionLease?.throwIfAborted();
      runtime.assertWorkRemaining?.();
      const phase = runtime.runtimePerformance?.startPhase(name);
      try {
        const value = await work();
        executionLease?.throwIfAborted();
        runtime.assertWorkRemaining?.();
        phase?.end('ok');
        return value;
      } catch (error) {
        phase?.end(runtimeOutcomeFromError(error, executionLease?.signal));
        throw error;
      }
    };
    const canInvokeTool = () => runtime.isActive?.() !== false && !executionLease?.signal.aborted;
    const sceneEvidenceInput = {runId: runtime.runId, traceId, referenceTraceId: options.referenceTraceId,
      tracePairContext: options.tracePairContext,
      conversationTraceAttached: conversationTraceAttachedOption(options), turnIntent: runtime.turnIntent, policy,
      strategyRegistry: runtime.strategyRegistry, userPackageName: options.packageName,
      selectionContext, traceProcessorService: this.traceProcessorService,
      outputLanguage: config.outputLanguage, canInvokeTool, executionLease,
      runAuthorization: runtime.runAuthorization, deadlineMs: runtime.sceneDeadlineMs,
      runtimePerformance: runtime.runtimePerformance};
    const createEvidenceResources = (artifactStore: ArtifactStore) => {
      const skillExecutor = createSkillExecutor(this.traceProcessorService);
      const effectiveSkillRegistry = resolveEffectiveSkillRegistryForRuntime(skillRegistry);
      const sceneCoverageRegistry = resolveSceneProductScope(options, {sessionId, traceId, runId: options.runId ?? ''})
        ? snapshotSceneCoverageRegistry(effectiveSkillRegistry, runtime.strategyRegistry, runtime.turnIntent.sceneId) : undefined;
      skillExecutor.registerSkills(sceneCoverageRegistry ? [...sceneCoverageRegistry.skills] : effectiveSkillRegistry.getAllSkills());
      skillExecutor.setFragmentRegistry(sceneCoverageRegistry ? new Map(sceneCoverageRegistry.fragments) : effectiveSkillRegistry.getFragmentCache());
      return {artifactStore, skillExecutor, effectiveSkillRegistry, sceneCoverageRegistry};
    };
    let earlyResources: ReturnType<typeof createEvidenceResources> | undefined;
    let earlyEvidence: Awaited<ReturnType<typeof collectSelectedEvidenceForPrompt>> | undefined;
    if (shouldCollectSelectedEvidenceFoundation(sceneEvidenceInput)) {
      runtime.runAuthorization?.assertCurrentInTurn();
      await preflight('skill_registry', () => ensureSkillRegistryInitialized());
      runtime.runAuthorization?.assertCurrentInTurn();
      const earlyStore = resolveRuntimeEvidenceStore(options, {sessionId, traceId},
        () => this.artifactStores.get(sessionId) ?? new ArtifactStore());
      this.artifactStores.set(sessionId, earlyStore);
      earlyResources = createEvidenceResources(earlyStore);
      const selectedLease = executionLease && runtime.workSignal
        ? {signal: AbortSignal.any([executionLease.signal, runtime.workSignal])} : executionLease;
      // Native witnesses must be issued before generic focus/probe INCLUDEs taint this processor.
      earlyEvidence = await collectSelectedEvidenceForPrompt({...sceneEvidenceInput,
        artifactStore: earlyStore, skillExecutor: earlyResources.skillExecutor,
        skillRegistry: earlyResources.effectiveSkillRegistry, executionLease: selectedLease});
      executionLease?.throwIfAborted();
      runtime.assertWorkRemaining?.();
      runtime.runAuthorization?.assertCurrentInTurn();
    }
    const focusResult = await detectRunFocusApps({
      traceProcessorService: this.traceProcessorService, traceId, preflight: policy.preflight,
      selectionContext, measure: detect => preflight('focus', detect),
    });
    const focusTarget = resolveFocusAppTarget({userPackageName: options.packageName, focusResult});
    const effectivePackageName = focusTarget.packageName;
    const architecture = policy.preflight !== 'none'
      ? await preflight('architecture', () => this.detectArchitecture(traceId, effectivePackageName)) : undefined;
    executionLease?.throwIfAborted();
    runtime.assertWorkRemaining?.();
    const traceCompleteness = policy.preflight !== 'none'
      ? await preflight('completeness', () => this.detectCompleteness(traceId, architecture)) : undefined;
    const comparisonContext = options.referenceTraceId && policy.allowMemoryPrefetch
      ? await preflight('comparison', () => this.buildComparisonContext(traceId, options.referenceTraceId!, config.outputLanguage, options.tracePairContext))
      : buildRuntimeTracePairIdentityContext(options);
    const knowledgeBaseContext = policy.allowMemoryPrefetch
      ? await preflight('knowledge', async () => {
          try {return (await getExtendedKnowledgeBase()).getContextForAI(query, 8);} catch {return undefined;}
        }) : undefined;
    // Registry loading is local capability discovery, not new trace/source evidence.
    if (!earlyResources) await preflight('skill_registry', () => ensureSkillRegistryInitialized());
    executionLease?.throwIfAborted();
    const {artifactStore, notes, analysisPlan, hypotheses, uncertaintyFlags} =
      this.resetAnalysisSessionState(sessionId, traceId, options, earlyResources?.artifactStore);
    // The detector's primary app becomes citable current-run evidence.
    const citedFocusTarget = registerFocusAppEvidence({store: artifactStore, traceId, focusResult, focusTarget});
    const sqlErrorPartition = analysisContextMemoryPartitionKey(options);
    if (this.sessionSqlErrorPartitions.get(sessionId) !== sqlErrorPartition) {
      this.sessionSqlErrors.delete(sessionId);
      this.sessionSqlErrorPartitions.set(sessionId, sqlErrorPartition);
    }
    const sqlErrors = this.sessionSqlErrors.get(sessionId) ?? (policy.allowMemoryPrefetch
      ? loadLearnedSqlFixPairs(5, knowledgeScope) : []);
    this.sessionSqlErrors.set(sessionId, sqlErrors);
    const entityStore = sessionContext.getEntityStore();
    const {skillExecutor, effectiveSkillRegistry, sceneCoverageRegistry} = earlyResources ?? createEvidenceResources(artifactStore);
    // Product-owned scene entry evidence settles before any acquisition-capable MCP server exists.
    const sceneEvidence = earlyEvidence?.handled ? earlyEvidence.data
      : await collectSceneEvidenceForPrompt({...sceneEvidenceInput,
        skillRegistry: effectiveSkillRegistry, skillExecutor, artifactStore, focusTarget});
    executionLease?.throwIfAborted();
    const sceneRunContext = await activateSceneRuntime(options, {sessionId, traceId, runId: options.runId ?? '',
      deadlineMs: runtime.sceneDeadlineMs ?? 0, traceProcessorService: this.traceProcessorService,
      artifactStore, sceneCoverageRegistry, signal: runtime.workSignal ?? executionLease?.signal, canInvokeTool, pacing: runtime.scenePacing});
    const mcp = createClaudeMcpServer({
      sceneRunContext,
      runId: runtime.runId,
      analysisHistoryReader: runtime.historyReader,
      toolObserver: runtime.toolObserver,
      canInvokeTool,
      runAuthorization: runtime.runAuthorization,
      conversationTraceAttached: conversationTraceAttachedOption(options),
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
      analysisContextFingerprint: options.analysisContextFingerprint,
      sourceDepthDecision: runtimeSourceDepth(policy, options),
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
      ...(sceneEvidence ? {sceneEvidence} : {}),
      knowledgeBaseContext, sceneType,
      selectionContext, comparison: comparisonContext, traceCompleteness,
      traceOs: traceInfo?.traceOs, traceFormat: traceInfo?.traceFormat,
      outputLanguage: config.outputLanguage, codeAwareMode: options.codeAwareMode, codebaseIds: options.codebaseIds,
      sourceAuthorization: mcp.sourceAuthorization,
    };
    const tools = createOpenAIToolsFromMcpDefinitions(mcp.toolDefinitions);
    const toolRoles = new Map(mcp.toolDefinitions.filter(definition => definition.role !== undefined)
      .map(definition => [definition.name, definition.role!]));
    return {
      systemPrompt: buildSystemPrompt(promptContext),
      tools, toolRoles, allowedTools: mcp.allowedTools,
      sessionContext, previousTurns: runtime.previousTurns, architecture, hypotheses,
      effectivePackageName, sourceUse: mcp.sourceUse,
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
      answerStreamFilter: AnswerReasoningFilterState;
      answerTextProjection?: CodeAwareStreamingTextProjection;
      runtimePerformance?: RuntimePerformanceRun;
      /** The attempt's projected view of the run draft; tool calls revoke its segment. */
      answerDraft: ProjectedAnswerDraft;
      toolInputsByTaskId: Map<string, { toolName: string; args: Record<string, unknown>; role?: RuntimeToolRole }>;
      toolRoles?: ReadonlyMap<string, RuntimeToolRole>;
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
        const delta = filterAnswerReasoningDelta(data.delta, streamContext.answerStreamFilter);
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
      const toolName: string = rawItem?.name || 'unknown';
      const role = streamContext.toolRoles?.get(toolName);
      const args = role === 'final_candidate_submission'
        ? projectRuntimeToolEventPayload(role, {params: {}}).params
        : parseJsonObject(rawItem?.arguments) || {};
      const callKey = openAiToolCallKey(rawItem);
      if (callKey && (streamContext.toolInputsByTaskId.has(callKey) || streamContext.processedToolResultIds?.has(callKey))) return '';
      streamContext.onToolCalled?.();
      // Text this response already streamed preceded a tool call, so it was
      // not the answer: revoke the draft and whatever the projection withheld.
      streamContext.answerDraft.boundary(now);
      if (callKey) streamContext.toolInputsByTaskId.set(callKey, {toolName, args, ...(role ? {role} : {})});
      this.emitUpdate({
        type: 'agent_task_dispatched',
        content: {
          taskId: callKey ?? 'unknown',
          toolName,
          args,
          message: role === 'final_candidate_submission'
            ? localize(outputLanguage, '正在提交答复，等待核验', 'Submitting the answer for verification.')
            : formatToolCallNarration(toolName, args, outputLanguage, {
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
      const cached = callKey ? streamContext.toolInputsByTaskId.get(callKey) : undefined;
      const toolName = cached?.toolName || rawItem?.name || 'unknown';
      const role = cached?.role ?? streamContext.toolRoles?.get(toolName);
      if (role !== 'final_candidate_submission') streamContext.onToolOutput?.();
      // Read failure from the raw result: projection replaces a sensitive
      // tool's payload with a rejection envelope that has no success field.
      const resultIsFailure = toolResultIsFailure({toolName, result: rawOutput});
      const roleOutput = projectRuntimeToolEventPayload(role, {result: rawOutput}).result;
      const projectedOutput = projectToolResultForExternalSurface(toolName, roleOutput);
      const privateToolResultReceipt = issuePrivateToolResultNarrationReceipt({
        toolName, result: projectedOutput, isError: resultIsFailure,
      });
      const resultText = summarizeToolOutput(projectedOutput);
      // Narrate from the projected object while it is still intact; resultText
      // is byte-truncated and can end mid-JSON.
      const resultNarration = role === 'final_candidate_submission'
        ? resultIsFailure
          ? localize(outputLanguage, '答复提交未被接受，核验尚未完成', 'Answer submission was rejected; verification is incomplete.')
          : localize(outputLanguage, '已收到答复，等待核验', 'Answer received; verification is pending.')
        : formatToolResultNarration({
        toolName,
        args: cached?.args,
        result: projectedOutput,
        ownerResult: role === 'final_candidate_submission' ? projectedOutput : rawOutput,
        isError: resultIsFailure,
        language: outputLanguage,
      });
      // Plan evidence must not depend on having observed the dispatch event.
      if (toolName !== 'unknown') {
        recordPlanOrPrePlanToolCall(this.sessionPlans.get(streamContext.sessionId), {
          toolName,
          ...(role ? {role} : {}),
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
