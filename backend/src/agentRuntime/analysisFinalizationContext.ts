// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import type {SourceExecutionScopeV1, SourceUseDecisionV1} from '../services/codebase/sourceUseDecision';
import type {KnowledgeUseRecord} from '../services/knowledge/knowledgeUse';
import type {ReadonlyStrategyRegistrySnapshot} from '../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {AnalysisDeliveryContext} from '../types/analysisDelivery';
import type {DataEnvelope} from '../types/dataContract';
import type {EvidenceReadRequest, EvidenceReadResolution, EvidenceReadView} from '../services/evidence/evidenceReadView';
import type {AnalysisTurnIntent} from './analysisTurnIntent';
import {validateAnalysisRunSelection, type AnalysisRunSelection} from './analysisRunSpec';
import {dispatchWithModelCallRecord, type IntentTransportInput, type IntentTransportResult} from './intentTransport';
import {runtimeProviderOrigin} from './runtimePerformance';
import {currentRuntimePerformanceRecorder} from '../services/selfEvolution/runManifestLifecycle';
import {readConclusionProtocolProjection, releaseConclusionProtocolProjection,
  claimConclusionProtocolProjection,
  type IssuedConclusionProtocolProjection, type NativeConclusionDeclaration} from '../services/security/conclusionProtocolProjection';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';
import {sanitizeSourceUseDecision} from '../services/codebase/sourceUseDecision';
import {isIssuedInvestigationEvidenceSnapshot,
  type InvestigationEvidenceSnapshot} from '../services/evidence/investigationEvidenceLedger';

export interface FinalizationProviderQuery {
  /** The query accepted by this run's provider input authorization boundary. */
  text: string;
  analysisContextFingerprint?: string;
}

export interface RuntimeFinalizationContextInput {
  runId: string;
  sessionId: string;
  /** Original absolute run deadline; finalization cannot restart the budget. */
  deadlineMs: number;
  turnIntent: AnalysisTurnIntent;
  strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  traceIdentity: {currentTraceId?: string; referenceTraceId?: string};
  /** Canonical per-run UI selection; absent only for legacy or pre-preparation fallback paths. */
  selection?: AnalysisRunSelection;
  deliveryContext: AnalysisDeliveryContext;
  providerQuery?: FinalizationProviderQuery;
  sourceUse?: SourceUseDecisionV1;
  sourceScope?: SourceExecutionScopeV1;
  /** What the run delivered from its selected knowledge bases; never evidence. */
  knowledgeUse?: KnowledgeUseRecord;
  protocolProjection?: IssuedConclusionProtocolProjection;
  /** Captured facts only. Availability is not completeness of capture. */
  capabilityEvidence?: readonly DataEnvelope[];
  evidenceReadView?: EvidenceReadView;
  /** Same pinned provider/auth, with a new no-tools request and its own cleanup. */
  dispatchText?: (input: IntentTransportInput) => Promise<IntentTransportResult>;
  /** Which provider and model `dispatchText` reaches, for its duration estimate and receipt. */
  deliveryCall?: FinalizationDeliveryCall;
}

/** Closed identity of the review transport; an origin only, never a path or credential. */
export interface FinalizationDeliveryCall {
  providerOrigin?: string;
  model?: string;
}

function closedDeliveryCall(value: FinalizationDeliveryCall | undefined): FinalizationDeliveryCall | undefined {
  if (!value) return undefined;
  const providerOrigin = runtimeProviderOrigin(value.providerOrigin);
  const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim().slice(0, 128) : undefined;
  return providerOrigin || model ? Object.freeze({...(providerOrigin ? {providerOrigin} : {}), ...(model ? {model} : {})})
    : undefined;
}

interface ContextState {
  value?: RuntimeFinalizationContextInput & {investigationEvidence?: InvestigationEvidenceSnapshot};
  controller: AbortController;
}

export interface RuntimeFinalizationContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly deadlineMs: number;
  readonly turnIntent: AnalysisTurnIntent;
  readonly strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  readonly traceIdentity: Readonly<RuntimeFinalizationContextInput['traceIdentity']>;
  readonly deliveryContext: AnalysisDeliveryContext;
  readonly sourceUse?: SourceUseDecisionV1;
  readonly sourceScope?: Readonly<SourceExecutionScopeV1>;
  readonly knowledgeUse?: Readonly<KnowledgeUseRecord>;
  readonly capabilityEvidence?: readonly DataEnvelope[];
  readonly investigationEvidence?: InvestigationEvidenceSnapshot;
  readonly hasSemanticTransport: boolean;
  readonly deliveryCall?: FinalizationDeliveryCall;
  /** Input-role selection view; never evidence or a serializable result field. */
  getSelection(signal: AbortSignal): AnalysisRunSelection | undefined;
  /** Input-role view, never a general exemption from output privacy projection. */
  getProviderQuery(signal: AbortSignal): Readonly<FinalizationProviderQuery> | undefined;
  getNativeDeclaration(result: AnalysisResult, signal: AbortSignal): NativeConclusionDeclaration | undefined;
  resolveReferences(requests: readonly EvidenceReadRequest[], signal: AbortSignal): Promise<readonly EvidenceReadResolution[]>;
  dispatchText(input: IntentTransportInput & {signal: AbortSignal}): Promise<IntentTransportResult>;
  /** Cancels in-flight operations and drops closures; does not replace a product run lease. */
  dispose(): void;
}

/**
 * A report's quality gate fails without its semantic review, so a run that will
 * make that review may spend the rest of its budget on it. Eligibility, not the
 * projected body, decides: an ineligible declaration skips the review entirely.
 */
export function reportReviewUsesRemainingBudget(input: {
  semanticCall: boolean;
  turnIntent?: AnalysisTurnIntent;
  result: Pick<AnalysisResult, 'conclusionContract'>;
}): boolean {
  return input.semanticCall && input.turnIntent?.status === 'resolved' &&
    input.turnIntent.deliverable === 'report' &&
    input.result.conclusionContract?.bindingEligibility !== 'ineligible';
}

/** The run's source and knowledge accessor, as every runtime holds it from its MCP server. */
interface RunSourceAccessor {
  getSourceUseDecision(): SourceUseDecisionV1 | undefined;
  getSourceExecutionScope?(): SourceExecutionScopeV1 | undefined;
  getKnowledgeUse?(): KnowledgeUseRecord | undefined;
}

/** The context fields a runtime reads from its run's source accessor, in one place. */
export function sourceUseFinalizationFields(
  accessor: RunSourceAccessor | undefined,
): Pick<RuntimeFinalizationContextInput, 'sourceUse' | 'sourceScope' | 'knowledgeUse'> {
  return {
    sourceUse: accessor?.getSourceUseDecision(),
    sourceScope: accessor?.getSourceExecutionScope?.(),
    knowledgeUse: accessor?.getKnowledgeUse?.(),
  };
}

/**
 * What a run delivered, kept on a result it returns without a finalization
 * context (a failure or interruption before an accepted answer): what reached
 * the model did, whether or not there is an answer to finalize.
 */
export interface RunDeliveryRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly knowledgeUse: Readonly<KnowledgeUseRecord>;
}

const contexts = new WeakMap<AnalysisResult, ContextState>();
const issuedContexts = new WeakSet<RuntimeFinalizationContext>();
const deliveryRecords = new WeakMap<AnalysisResult, RunDeliveryRecord>();

/**
 * Keep the run's delivery record on a result that carries no finalization
 * context. A no-op when one is attached (it carries the same record) or when
 * the run recorded nothing (no knowledge base was selected). Finalization
 * takes it from the result object it is handed, bound to the owner's run, and
 * starts none of its answer semantics from it. Like the context, it never
 * enters JSON or snapshots.
 */
export function attachRunDeliveryRecord(result: AnalysisResult, input: {
  runId: string | undefined;
  sessionId: string;
  knowledgeUse: KnowledgeUseRecord | undefined;
}): void {
  if (contexts.has(result) || !input.knowledgeUse || !input.runId) return;
  if (deliveryRecords.has(result)) throw new Error('run_delivery_record_already_attached');
  if (result.sessionId !== input.sessionId) throw new Error('run_delivery_record_identity_mismatch');
  deliveryRecords.set(result, freezeSnapshot({runId: input.runId, sessionId: input.sessionId,
    knowledgeUse: input.knowledgeUse}));
}

/** Called by finalization only, on the result object an owner hands it. */
export function takeRunDeliveryRecord(result: AnalysisResult): RunDeliveryRecord | undefined {
  const record = deliveryRecords.get(result);
  deliveryRecords.delete(result);
  return record;
}

export function isIssuedFinalizationContext(context: RuntimeFinalizationContext): boolean {
  return issuedContexts.has(context);
}

function freezeSnapshot<T>(value: T): T {
  const copied = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    Object.values(node).forEach(freeze);
    Object.freeze(node);
  };
  freeze(copied);
  return copied;
}

class FinalizationDeadlineError extends Error {}

/** Limit the wait even when a provider/reader ignores the signal it receives. */
async function boundedOperation<T>(input: {
  signal: AbortSignal; lifetimeSignal: AbortSignal; deadlineMs: number;
  execute: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const deadlineController = new AbortController();
  const signal = AbortSignal.any([input.signal, input.lifetimeSignal, deadlineController.signal]);
  signal.throwIfAborted();
  if (Date.now() >= input.deadlineMs) throw new FinalizationDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    const remaining = input.deadlineMs - Date.now();
    if (remaining <= 0) deadlineController.abort(new FinalizationDeadlineError());
    else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
  };
  expire();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, {once: true});
  if (signal.aborted) onAbort();
  try {
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return input.execute(signal);
    });
    const result = await Promise.race([operation, aborted]);
    signal.throwIfAborted();
    if (Date.now() >= input.deadlineMs) throw new FinalizationDeadlineError();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Only runtime code can attach this sidecar. It never enters JSON or snapshots. */
export function attachFinalizationContext(result: AnalysisResult, input: RuntimeFinalizationContextInput): void {
  if (contexts.has(result)) throw new Error('finalization_context_already_attached');
  if (!input.runId || !input.sessionId || result.sessionId !== input.sessionId ||
    !Number.isFinite(input.deadlineMs) ||
    input.turnIntent.registryFingerprint !== input.strategyRegistry.registryFingerprint ||
    input.deliveryContext.entry === 'historical_restore' ||
    input.deliveryContext.acceptedCandidate?.runId !== input.runId) {
    throw new Error('finalization_context_identity_mismatch');
  }
  const selection = input.selection === undefined ? undefined : validateAnalysisRunSelection(input.selection);
  if (selection?.present && selection.sideResolution.status === 'resolved' &&
    selection.sideResolution.traceId !== input.traceIdentity.currentTraceId) {
    throw new Error('finalization_context_selection_mismatch');
  }
  if (input.protocolProjection) {
    readConclusionProtocolProjection(input.protocolProjection, {
      result, candidate: input.deliveryContext.acceptedCandidate, runId: input.runId,
    });
    if (analysisDeliveryFingerprint(sanitizeSourceUseDecision(input.sourceUse)) !==
      analysisDeliveryFingerprint(result.sourceUseDecision)) throw new Error('finalization_source_projection_mismatch');
    claimConclusionProtocolProjection(input.protocolProjection);
  }
  let investigationEvidence: InvestigationEvidenceSnapshot | undefined;
  try {
    const snapshot = input.evidenceReadView?.investigationEvidence?.();
    if (isIssuedInvestigationEvidenceSnapshot(snapshot) &&
      (!snapshot.currentRunId || snapshot.currentRunId === input.runId)) investigationEvidence = freezeSnapshot(snapshot);
  } catch {
    // Missing observability cannot replace the actual runtime result or grant coverage.
  }
  contexts.set(result, {controller: new AbortController(), value: {
    ...input,
    investigationEvidence,
    selection,
    turnIntent: freezeSnapshot(input.turnIntent),
    traceIdentity: freezeSnapshot(input.traceIdentity),
    deliveryContext: freezeSnapshot(input.deliveryContext),
    providerQuery: input.providerQuery ? freezeSnapshot(input.providerQuery) : undefined,
    sourceUse: input.sourceUse ? freezeSnapshot(input.sourceUse) : undefined,
    sourceScope: input.sourceScope ? freezeSnapshot(input.sourceScope) : undefined,
    knowledgeUse: input.knowledgeUse ? freezeSnapshot(input.knowledgeUse) : undefined,
    capabilityEvidence: input.capabilityEvidence ? freezeSnapshot(input.capabilityEvidence) : undefined,
    deliveryCall: closedDeliveryCall(input.deliveryCall),
  }});
}

/** Call immediately after analyze(), before any result copy or display projection. */
export function takeFinalizationContext(result: AnalysisResult): RuntimeFinalizationContext | undefined {
  const state = contexts.get(result);
  if (!state?.value) return undefined;
  contexts.delete(result);
  const current = (): NonNullable<ContextState['value']> => {
    if (!state.value) throw new Error('finalization_context_disposed');
    return state.value;
  };
  const active = (signal: AbortSignal): RuntimeFinalizationContextInput => {
    signal.throwIfAborted();
    state.controller.signal.throwIfAborted();
    return current();
  };
  const context: RuntimeFinalizationContext = Object.freeze({
    get runId() { return current().runId; },
    get sessionId() { return current().sessionId; },
    get deadlineMs() { return current().deadlineMs; },
    get turnIntent() { return current().turnIntent; },
    get strategyRegistry() { return current().strategyRegistry; },
    get traceIdentity() { return current().traceIdentity; },
    get deliveryContext() { return current().deliveryContext; },
    get sourceUse() { return current().sourceUse; },
    get sourceScope() { return current().sourceScope; },
    get knowledgeUse() { return current().knowledgeUse; },
    get capabilityEvidence() { return current().capabilityEvidence; },
    get investigationEvidence() { return current().investigationEvidence; },
    get hasSemanticTransport() { return Boolean(current().dispatchText); },
    get deliveryCall() { return current().deliveryCall; },
    getSelection(signal: AbortSignal) { return active(signal).selection; },
    getProviderQuery(signal: AbortSignal) { return active(signal).providerQuery; },
    getNativeDeclaration(result: AnalysisResult, signal: AbortSignal) {
      const value = active(signal);
      return value.protocolProjection ? readConclusionProtocolProjection(value.protocolProjection, {
        result, candidate: value.deliveryContext.entry === 'historical_restore' ? undefined : value.deliveryContext.acceptedCandidate,
        runId: value.runId,
      }) : undefined;
    },
    async resolveReferences(requests: readonly EvidenceReadRequest[], signal: AbortSignal): Promise<readonly EvidenceReadResolution[]> {
      const value = active(signal);
      const reader = value.evidenceReadView;
      if (!reader) return requests.map(({key}) => ({key, status: 'missing', reason: 'capture_unavailable'}));
      try {
        return await boundedOperation({signal, lifetimeSignal: state.controller.signal,
          deadlineMs: value.deadlineMs,
          execute: boundedSignal => reader.resolveReferences(requests, boundedSignal)});
      } catch (error) {
        if (!(error instanceof FinalizationDeadlineError)) throw error;
        return requests.map(({key}) => ({key, status: 'incomplete', reason: 'deadline_exceeded'}));
      }
    },
    async dispatchText(input: IntentTransportInput & {signal: AbortSignal}): Promise<IntentTransportResult> {
      const value = active(input.signal);
      if (!value.dispatchText) return {status: 'unavailable', reason: 'invalid_configuration'};
      const deadlineMs = Math.min(value.deadlineMs, input.deadlineMs);
      if (!Number.isFinite(deadlineMs)) return {status: 'unavailable', reason: 'invalid_configuration'};
      if (Date.now() >= deadlineMs) return {status: 'unavailable', reason: 'timeout'};
      const dispatch = value.dispatchText;
      try {
        // The finalizer runs inside the run's manifest scope; its one review is a model call of that run.
        const recorder = currentRuntimePerformanceRecorder();
        return await boundedOperation({signal: input.signal, lifetimeSignal: state.controller.signal,
          deadlineMs, execute: signal => dispatchWithModelCallRecord(recorder, {purpose: 'review', ...value.deliveryCall},
            {...input, signal, deadlineMs}, dispatch)});
      } catch (error) {
        if (!(error instanceof FinalizationDeadlineError)) throw error;
        return {status: 'unavailable', reason: 'timeout'};
      }
    },
    dispose() {
      issuedContexts.delete(context);
      if (state.value?.protocolProjection) releaseConclusionProtocolProjection(state.value.protocolProjection);
      state.controller.abort(new DOMException('Finalization context disposed', 'AbortError'));
      state.value = undefined;
    },
  });
  issuedContexts.add(context);
  return context;
}
