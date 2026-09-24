// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {AsyncLocalStorage} from 'node:async_hooks';
import {createAnalysisHistoryReader, withAnalysisHistoryReader} from '../../agentRuntime/analysisHistory';
import type {AnalysisOptions, AnalysisResult, IOrchestrator} from '../../agent/core/orchestratorTypes';
import type {StreamingUpdate} from '../../agent';
import {
  registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards,
} from '../../services/security/codeAwareOutputRegistry';
import {projectOwnerCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {
  projectOwnerAnalysisError,
  projectOwnerStructuredValue,
  projectOwnerAnalysisResult,
} from '../../services/security/privateAnalysisProjection';
import {analysisContextUsesPrivateKnowledge, AnalysisContextAuthorizationChangedError,
  buildAnalysisContextAuthorizationFingerprint, assertCurrentAnalysisContextAuthorization} from '../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {createRuntimeEvidenceContext, type RuntimeEvidenceBinding, type RuntimeEvidenceContext} from '../../agentRuntime/runtimeEvidenceContext';
import {finalizeAnalysisResult, type FinalizedAnalysisResult} from '../../services/finalizeAnalysisResult';
import {finalReviewProgressUpdate} from '../../services/finalizationProgress';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import {AnalysisNarrativeStreamProjection} from '../../services/analysisNarrativeStreamProjection';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {validateDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import {
  buildConversationPrompt,
  conversationMessagesToHistoryTurns,
  type ConversationEvidenceRef,
  type ConversationRuntimeOutcome,
} from '../contracts/conversationContract';
import {resolvePrimaryConversationSourceUse} from './conversationSourcePolicy';
import type {
  ConversationRuntimeAdapter,
  ConversationRuntimeInput,
} from '../application/conversationSessionService';

export interface OrchestratorConversationRuntimeOptions {
  analysisOptions?: Omit<AnalysisOptions, 'analysisMode' | 'runId'>;
}

function projectEvidence(result: Awaited<ReturnType<IOrchestrator['analyze']>>): ConversationEvidenceRef[] {
  return result.findings.flatMap((finding): ConversationEvidenceRef[] => {
    const id = String(finding.id || '').trim();
    const label = String(finding.title || '').trim();
    if (!id || !label) return [];
    const source = String(finding.source || '').trim();
    return [{id, label, ...(source ? {source} : {})}];
  });
}

interface ConversationExecution {
  runId: string;
  runtimeSessionId: string;
  controller: AbortController;
  assertAuthorized(): void;
  release(): void;
  abortRuntime(): Promise<void>;
  analysisContextFingerprint?: string;
}

/** Owns the product run until the shared finalizer has returned an authorized result. */
export class OrchestratorConversationRuntimeAdapter implements ConversationRuntimeAdapter {
  private readonly runtimeSessions = new Map<string, ConversationExecution>();
  private readonly currentSessionRuns = new Map<string, ConversationExecution>();
  private readonly evidenceContexts = new Map<string, RuntimeEvidenceContext>();
  private readonly updateExecution = new AsyncLocalStorage<ConversationExecution>();
  private disposed = false;

  constructor(
    private readonly orchestrator: IOrchestrator,
    private readonly options: OrchestratorConversationRuntimeOptions = {},
  ) {}

  resolvePrimarySourceUse(query: string) {
    return resolvePrimaryConversationSourceUse({
      query, codeAwareMode: this.options.analysisOptions?.codeAwareMode,
      codebaseIds: this.options.analysisOptions?.codebaseIds,
    });
  }

  private createExecution(input: ConversationRuntimeInput): ConversationExecution {
    if (this.disposed) throw new DOMException('Conversation adapter disposed', 'AbortError');
    const analysisOptions = this.options.analysisOptions ?? {};
    const selection = {codeAwareMode: analysisOptions.codeAwareMode,
      codebaseIds: analysisOptions.codebaseIds ? [...analysisOptions.codebaseIds] : undefined,
      knowledgeSourceIds: analysisOptions.knowledgeSourceIds ? [...analysisOptions.knowledgeSourceIds] : undefined};
    const scope = resolveKnowledgeScope(analysisOptions);
    const expectedFingerprint = analysisOptions.analysisContextFingerprint ??
      buildAnalysisContextAuthorizationFingerprint(selection, scope);
    const controller = new AbortController();
    const runId = input.runId;
    const runtimeSessionId = `${input.sessionId}:${input.runId}`;
    let abortPromise: Promise<void> | undefined;
    const abortRuntime = () => abortPromise ??= Promise.resolve()
      .then(() => this.orchestrator.abortSession?.(runtimeSessionId)).then(() => undefined).catch(() => undefined);
    const abort = () => { void abortRuntime(); };
    controller.signal.addEventListener('abort', abort, {once: true});
    const state: ConversationExecution = {runId, runtimeSessionId, controller, abortRuntime,
      analysisContextFingerprint: analysisOptions.analysisContextFingerprint,
      assertAuthorized: () => assertCurrentAnalysisContextAuthorization(selection, scope, expectedFingerprint),
      release: () => controller.signal.removeEventListener('abort', abort)};
    this.runtimeSessions.get(input.runId)?.controller.abort(new DOMException('Conversation run superseded', 'AbortError'));
    this.runtimeSessions.set(input.runId, state);
    const previous = this.currentSessionRuns.get(input.sessionId);
    previous?.controller.abort(new DOMException('Conversation run superseded', 'AbortError'));
    this.currentSessionRuns.set(input.sessionId, state);
    return state;
  }

  private isCurrent(input: ConversationRuntimeInput, state: ConversationExecution): boolean {
    const current = this.currentSessionRuns.get(input.sessionId);
    return !this.disposed && current?.runId === input.runId && current === state;
  }

  private assertActive(input: ConversationRuntimeInput, state: ConversationExecution): void {
    state.controller.signal.throwIfAborted();
    if (!this.isCurrent(input, state)) throw new DOMException('Conversation run is no longer current', 'AbortError');
    state.assertAuthorized();
  }

  private async awaitExecution<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, {once: true});
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  private async finalizeRuntimeResult(result: AnalysisResult, input: ConversationRuntimeInput,
    state: ConversationExecution, dataEnvelopes: DataEnvelope[],
    onRuntimeSettled?: () => void, outputLanguage: OutputLanguage = 'zh-CN',
  ): Promise<FinalizedAnalysisResult> {
    const context = takeFinalizationContext(result);
    let transferred = false;
    try {
      onRuntimeSettled?.();
      this.assertActive(input, state);
      if (context && context.runId !== state.runId) throw new Error('finalization_run_identity_mismatch');
      transferred = true;
      const finalized = await finalizeAnalysisResult({result, context, query: input.query, dataEnvelopes,
        owner: {runId: state.runId, signal: state.controller.signal,
          ...(state.analysisContextFingerprint !== undefined ? {analysisContextFingerprint: state.analysisContextFingerprint} : {}),
          isCurrent: () => this.isCurrent(input, state), assertAuthorized: state.assertAuthorized},
        caseRetrieval: {status: 'not_checked', recommendations: []},
        conversation: {fallbackQuestion: input.query, evidence: projectEvidence(result)},
        onProgress: event => {
          if (this.isCurrent(input, state)) input.onUpdate?.(finalReviewProgressUpdate(event, outputLanguage));
        },
      });
      this.assertActive(input, state);
      if (!finalized.conversationOutcome) throw new Error('conversation_finalization_outcome_missing');
      return finalized;
    } finally {
      if (!transferred) context?.dispose();
    }
  }

  async run(input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> {
    const state = this.createExecution(input);
    const {runtimeSessionId} = state;
    const analysisOptions = this.options.analysisOptions ?? {};
    const primarySourceUse = this.resolvePrimarySourceUse(input.query);
    // Registered knowledge is independently enabled by the authorized selection.
    const includeSourceDerived = primarySourceUse !== 'dormant' || Boolean(analysisOptions.knowledgeSourceIds?.length);
    const privateKnowledge = analysisContextUsesPrivateKnowledge(analysisOptions);
    const outputLanguage = analysisOptions.outputLanguage ?? 'zh-CN';
    // Filter whole turns, including source-bearing user queries, on every read.
    const historyReader = createAnalysisHistoryReader({
      assertActive: () => this.assertActive(input, state),
      getTurns: () => {
        const turns = input.getHistoryTurns?.() ?? conversationMessagesToHistoryTurns(input.history);
        return turns.filter(turn => !turn.sourceDerived || (includeSourceDerived &&
          Boolean(turn.analysisContextFingerprint) &&
          turn.analysisContextFingerprint === state.analysisContextFingerprint));
      },
    });
    const traceId = input.traceContext.kind === 'attached' ? input.traceContext.traceId : `conversation-no-trace:${input.sessionId}`;
    const narrative = new AnalysisNarrativeStreamProjection();
    let evidenceBinding: RuntimeEvidenceBinding | undefined;
    let evidenceContext: RuntimeEvidenceContext | undefined;
    const dataEnvelopes: DataEnvelope[] = [];
    const onUpdate = (update: StreamingUpdate) => {
      // A superseded SDK can still emit on this shared EventEmitter. Accept only
      // the async execution that produced this run's update, never consumer state alone.
      if (this.updateExecution.getStore() !== state) return;
      try { this.assertActive(input, state); } catch (error) { state.controller.abort(error); return; }
      if (update.type === 'data') {
        const values = Array.isArray(update.content) ? update.content : [update.content];
        dataEnvelopes.push(...values.filter((value): value is DataEnvelope =>
          Boolean(value && typeof value === 'object' && validateDataEnvelope(value).length === 0)));
      }
      this.assertActive(input, state);
      const safeUpdate = projectOwnerCodeAwareStreamingUpdate(runtimeSessionId, update, privateKnowledge, outputLanguage);
      const projected = safeUpdate ? narrative.project(safeUpdate) : null;
      if (projected) input.onUpdate?.(projected);
    };
    this.orchestrator.on('update', onUpdate);
    try {
      this.assertActive(input, state);
      if (privateKnowledge) {
        const queries = [...historyReader.getTurns().map(turn => turn.query), input.query];
        for (const query of new Set(queries)) registerPrivateAnalysisQueryForEcho(runtimeSessionId, query);
      }
      const options: AnalysisOptions = {...analysisOptions, selectionContext: input.selectionContext, analysisMode: 'fast',
        assistantSurface: 'conversation', conversationTraceAttached: input.traceContext.kind === 'attached', runId: input.runId};
      const scope = {logicalSessionId: input.sessionId, traceId, options};
      evidenceContext = this.evidenceContexts.get(input.sessionId);
      if (!evidenceContext?.matches(scope)) {
        evidenceContext?.dispose();
        evidenceContext = createRuntimeEvidenceContext(scope);
        this.evidenceContexts.set(input.sessionId, evidenceContext);
      }
      evidenceBinding = evidenceContext.bind(options, {runtimeSessionId, runId: input.runId,
        signal: state.controller.signal, assertAuthorized: () => this.assertActive(input, state)});
      const artifacts = await evidenceBinding.describeArtifacts();
      this.assertActive(input, state);
      let prompt = buildConversationPrompt({question: input.query, history: [], historyTurns: [],
        traceContext: input.traceContext, outputLanguage});
      if (artifacts.artifacts.length > 0) {
        const template = loadPromptTemplate('prompt-conversation-evidence-context');
        if (!template) throw new Error('Conversation evidence context template is not configured');
        const projectedArtifacts = privateKnowledge ? projectOwnerStructuredValue(runtimeSessionId, artifacts) : artifacts;
        prompt += `\n\n${renderTemplate(template, {retainedEvidenceContext: JSON.stringify({
          context: 'retained_artifacts', ...projectedArtifacts,
        })})}`;
      }
      const runtimeOptions = withAnalysisHistoryReader(evidenceBinding.options, historyReader, {includeSourceDerived});
      const analysis = this.updateExecution.run(state, () => this.orchestrator.analyze(prompt,
        runtimeSessionId, traceId, runtimeOptions))
        .then(result => this.finalizeRuntimeResult(result, input, state, dataEnvelopes,
          () => {
            this.orchestrator.off('update', onUpdate);
            this.assertActive(input, state);
            const tail = narrative.finish();
            if (tail) input.onUpdate?.(tail);
          }, outputLanguage))
        .finally(() => {
          evidenceBinding?.release();
          // Physical sessions are unique: late cleanup cannot touch a newer turn.
          // Cleanup must not delay delivery or Stop if an SDK ignores cancellation.
          void Promise.resolve().then(() => this.orchestrator.cleanupSession?.(runtimeSessionId)).catch(() => undefined);
        });
      const finalized = await this.awaitExecution(analysis, state.controller.signal);
      this.assertActive(input, state);
      const finalResult = privateKnowledge ? projectOwnerAnalysisResult(runtimeSessionId, finalized.result, outputLanguage) : finalized.result;
      const {finalResult: _previousResult, ...outcome} = finalized.conversationOutcome!;
      const safeOutcome = privateKnowledge ? projectOwnerStructuredValue(runtimeSessionId, outcome) : outcome;
      this.assertActive(input, state);
      return {...safeOutcome, message: finalResult.conclusion, finalResult};
    } catch (error) {
      if (error instanceof AnalysisContextAuthorizationChangedError) {
        if (this.isCurrent(input, state)) {
          evidenceContext ??= this.evidenceContexts.get(input.sessionId);
          evidenceContext?.dispose();
          if (this.evidenceContexts.get(input.sessionId) === evidenceContext) this.evidenceContexts.delete(input.sessionId);
        } else if (evidenceContext && this.evidenceContexts.get(input.sessionId) !== evidenceContext) {
          evidenceContext.dispose();
        }
      }
      if (!(error instanceof AnalysisContextAuthorizationChangedError) &&
        (state.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))) {
        return {kind: 'cancelled', message: ''};
      }
      if (privateKnowledge) throw new Error(projectOwnerAnalysisError(runtimeSessionId, error, outputLanguage));
      throw error;
    } finally {
      this.orchestrator.off('update', onUpdate);
      evidenceBinding?.release();
      narrative.reset();
      revokeCodeAwareOutputGuards(runtimeSessionId);
      state.release();
      if (this.runtimeSessions.get(input.runId) === state) this.runtimeSessions.delete(input.runId);
      if (this.currentSessionRuns.get(input.sessionId) === state) this.currentSessionRuns.delete(input.sessionId);
    }
  }

  async cancel(sessionId: string, runId: string): Promise<void> {
    const state = this.runtimeSessions.get(runId) ?? this.currentSessionRuns.get(sessionId);
    if (state?.runId === runId) {
      state.controller.abort(new DOMException('Conversation cancelled', 'AbortError'));
      await state.abortRuntime();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const state of new Set([...this.runtimeSessions.values(), ...this.currentSessionRuns.values()])) {
      state.controller.abort(new DOMException('Conversation adapter disposed', 'AbortError'));
    }
    this.currentSessionRuns.clear();
    for (const context of this.evidenceContexts.values()) context.dispose();
    this.evidenceContexts.clear();
    this.orchestrator.reset();
    this.orchestrator.removeAllListeners();
  }
}
