// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions, AnalysisResult, IOrchestrator} from '../../agent/core/orchestratorTypes';
import {takeFinalizationContext, type RuntimeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {CodeLookupLedger} from './codeLookupLedger';
import {getDefaultCodebaseRegistry} from './defaultCodebaseServices';
import {finalizeAnalysisResult} from '../finalizeAnalysisResult';
import {assertCurrentAnalysisContextAuthorization, buildAnalysisContextAuthorizationFingerprint,
  type AnalysisContextSelection} from '../resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../scopedKnowledgeStore';
import {registerPrivateAnalysisQueryForEcho, revokeCodeAwareOutputGuards} from '../security/codeAwareOutputRegistry';
import {projectOwnerAnalysisResult} from '../security/privateAnalysisProjection';

export interface AnalysisSourceSupplementMetrics {
  searchCalls: number;
  readCalls: number;
  durationMs: number;
}

export interface AnalysisSourceSupplementOutcome {
  message: string;
  metrics: AnalysisSourceSupplementMetrics;
  finalResult?: AnalysisResult;
}

/** Preserves old consumers' failure branch without exposing raw provider errors. */
export class AnalysisSourceSupplementFailure extends Error {
  readonly code = 'analysis_source_supplement_failed';
  constructor(readonly finalResult: AnalysisResult, readonly metrics: AnalysisSourceSupplementMetrics) {
    super('analysis_source_supplement_failed');
    this.name = 'AnalysisSourceSupplementFailure';
  }
}

interface ActiveSupplement {
  runId: string;
  runtimeSessionId: string;
  controller: AbortController;
  context?: RuntimeFinalizationContext;
  nativeFinished?: boolean;
  cleanupFinished?: boolean;
  abortFinished?: boolean;
  cleanup?: Promise<void>;
  abort?: Promise<void>;
}

const activeSupplements = new WeakMap<IOrchestrator, Map<string, ActiveSupplement>>();
const reservedRuntimeSessions = new WeakMap<IOrchestrator, Map<string, ActiveSupplement>>();

function releaseSupplementReservation(orchestrator: IOrchestrator, entry: ActiveSupplement): void {
  if (!entry.nativeFinished || !entry.cleanupFinished || (entry.abort && !entry.abortFinished)) return;
  const reserved = reservedRuntimeSessions.get(orchestrator);
  if (reserved?.get(entry.runtimeSessionId) === entry) reserved.delete(entry.runtimeSessionId);
}

function cleanupSupplement(orchestrator: IOrchestrator, entry: ActiveSupplement): Promise<void> {
  return entry.cleanup ??= Promise.resolve().then(() => orchestrator.cleanupSession?.(entry.runtimeSessionId))
    .then(() => undefined).catch(() => undefined).finally(() => {
      entry.cleanupFinished = true;
      releaseSupplementReservation(orchestrator, entry);
    });
}

function abortSupplement(orchestrator: IOrchestrator, entry: ActiveSupplement): Promise<void> {
  entry.controller.abort(new DOMException('Source supplement cancelled', 'AbortError'));
  entry.context?.dispose();
  return entry.abort ??= Promise.resolve().then(() => orchestrator.abortSession?.(entry.runtimeSessionId))
    .then(() => undefined).catch(() => undefined).finally(() => {
      entry.abortFinished = true;
      releaseSupplementReservation(orchestrator, entry);
    });
}

export function analysisSourceSupplementRuntimeSessionId(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}:analysis-source-enrichment`;
}

export async function runAnalysisSourceSupplement(input: {
  orchestrator: IOrchestrator;
  sessionId: string;
  runId: string;
  traceId: string;
  question: string;
  primaryConclusion: string;
  analysisOptions: AnalysisOptions;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  assertAuthorized?: () => void;
}): Promise<AnalysisSourceSupplementOutcome> {
  const {orchestrator, sessionId} = input;
  const runtimeSessionId = analysisSourceSupplementRuntimeSessionId(sessionId, input.runId);
  const supplementRunId = `${input.runId}:analysis-source-enrichment`;
  const analysisOptions: AnalysisOptions = {...input.analysisOptions,
    codebaseIds: input.analysisOptions.codebaseIds ? [...input.analysisOptions.codebaseIds] : undefined,
    knowledgeSourceIds: input.analysisOptions.knowledgeSourceIds ? [...input.analysisOptions.knowledgeSourceIds] : undefined};
  const selection: AnalysisContextSelection = {codeAwareMode: analysisOptions.codeAwareMode,
    codebaseIds: analysisOptions.codebaseIds, knowledgeSourceIds: analysisOptions.knowledgeSourceIds};
  const scope = resolveKnowledgeScope(analysisOptions);
  const expectedFingerprint = analysisOptions.analysisContextFingerprint ??
    buildAnalysisContextAuthorizationFingerprint(selection, scope);
  const sourceSelection = {...selection, knowledgeSourceIds: undefined};
  let sourceFingerprint: string | undefined;
  const assertAuthorized = () => {
    input.assertAuthorized?.();
    assertCurrentAnalysisContextAuthorization(selection, scope, expectedFingerprint);
    if (selection.codeAwareMode !== 'metadata_only' && selection.codeAwareMode !== 'provider_send') {
      throw new Error('analysis_source_supplement_source_not_authorized');
    }
    if (!selection.codebaseIds?.length) throw new Error('analysis_source_supplement_source_not_authorized');
    const registry = getDefaultCodebaseRegistry();
    for (const id of selection.codebaseIds) {
      const ref = registry.get(id, scope);
      if (!ref || ref.lifecycleState === 'deleting' ||
        (selection.codeAwareMode === 'provider_send' && !ref.consent.sendToProvider)) {
        throw new Error('analysis_source_supplement_source_not_authorized');
      }
    }
    if (sourceFingerprint) assertCurrentAnalysisContextAuthorization(sourceSelection, scope, sourceFingerprint);
  };
  // A rejected caller cannot supersede a running supplement or alter its guard.
  input.signal?.throwIfAborted();
  if (input.isCurrent && !input.isCurrent()) throw new DOMException('Source supplement is no longer current', 'AbortError');
  assertAuthorized();
  sourceFingerprint = buildAnalysisContextAuthorizationFingerprint(sourceSelection, scope);
  const template = loadPromptTemplate('analysis-source-deep-supplement');
  if (!template) throw new Error('analysis_source_supplement_prompt_missing');
  const prompt = renderTemplate(template, {question: input.question, primaryConclusion: input.primaryConclusion});
  const active = activeSupplements.get(orchestrator) ?? new Map<string, ActiveSupplement>();
  const reserved = reservedRuntimeSessions.get(orchestrator) ?? new Map<string, ActiveSupplement>();
  if (reserved.has(runtimeSessionId)) throw new Error('analysis_source_supplement_already_running');
  const controller = new AbortController();
  const entry: ActiveSupplement = {runId: input.runId, runtimeSessionId, controller};
  const previous = active.get(sessionId);
  active.set(sessionId, entry);
  reserved.set(runtimeSessionId, entry);
  activeSupplements.set(orchestrator, active);
  reservedRuntimeSessions.set(orchestrator, reserved);
  if (previous) void abortSupplement(orchestrator, previous);
  const parentAbort = () => {void abortSupplement(orchestrator, entry);};
  input.signal?.addEventListener('abort', parentAbort, {once: true});
  if (input.signal?.aborted) parentAbort();
  const owner = {runId: supplementRunId, analysisContextFingerprint: sourceFingerprint, signal: controller.signal,
    isCurrent: () => active.get(sessionId) === entry && (!input.isCurrent || input.isCurrent()), assertAuthorized};
  const assertCurrent = () => {
    owner.signal.throwIfAborted();
    if (!owner.isCurrent()) throw new DOMException('Source supplement is no longer current', 'AbortError');
    owner.assertAuthorized();
  };
  const startedAt = Date.now();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, {once: true});
  if (controller.signal.aborted) onAbort();
  registerPrivateAnalysisQueryForEcho(runtimeSessionId, input.question);
  const native = Promise.resolve().then(() => {
    assertCurrent();
    return orchestrator.analyze(prompt, runtimeSessionId, input.traceId, {...analysisOptions,
      // A deep supplement exists to read mechanism, whatever its fast budget.
      analysisMode: 'fast', runId: supplementRunId, sourceUsePolicy: {phase: 'deep_enrichment'}, sourceDepth: 'mechanism',
      analysisContextFingerprint: sourceFingerprint, knowledgeSourceIds: undefined});
  }).then(result => {
    // Take before any success/protocol check, including results delivered after cancel.
    const context = takeFinalizationContext(result);
    entry.context = context;
    try {assertCurrent();} catch (error) {context?.dispose(); throw error;}
    return {result, context};
  }).finally(() => {entry.nativeFinished = true; releaseSupplementReservation(orchestrator, entry);});
  try {
    const {result, context} = await Promise.race([native, aborted]);
    assertCurrent();
    const finalized = await Promise.race([finalizeAnalysisResult({result, context, owner, query: prompt}), aborted]);
    assertCurrent();
    const finalResult = projectOwnerAnalysisResult(runtimeSessionId, finalized.result, analysisOptions.outputLanguage ?? 'zh-CN');
    const executed = CodeLookupLedger.restore(runtimeSessionId, 2).getEntries()
      .filter(entry => entry.outcome !== 'budget_exceeded');
    const metrics: AnalysisSourceSupplementMetrics = {
      searchCalls: executed.filter(entry => entry.toolName === 'search_codebase').length,
      readCalls: executed.filter(entry => entry.toolName === 'read_codebase_file').length,
      durationMs: Date.now() - startedAt,
    };
    assertCurrent();
    if (!finalResult.success) throw new AnalysisSourceSupplementFailure(finalResult, metrics);
    return {message: finalResult.conclusion, metrics, finalResult};
  } finally {
    entry.context?.dispose();
    input.signal?.removeEventListener('abort', parentAbort);
    controller.signal.removeEventListener('abort', onAbort);
    if (active.get(sessionId) === entry) active.delete(sessionId);
    revokeCodeAwareOutputGuards(runtimeSessionId);
    // Native take/dispose and every already-started SDK mutation must settle
    // before this runtime identity can be reused by another attempt.
    void cleanupSupplement(orchestrator, entry);
  }
}

export async function cancelAnalysisSourceSupplement(orchestrator: IOrchestrator, sessionId: string, runId: string): Promise<void> {
  const runtimeSessionId = analysisSourceSupplementRuntimeSessionId(sessionId, runId);
  const reserved = reservedRuntimeSessions.get(orchestrator) ?? new Map<string, ActiveSupplement>();
  let entry = reserved.get(runtimeSessionId);
  if (!entry) {
    // Even a legacy cancellation has pending SDK mutations. Fence reuse until
    // those acknowledgements settle; no native helper operation is owned here.
    entry = {runId, runtimeSessionId, controller: new AbortController(), nativeFinished: true};
    reserved.set(runtimeSessionId, entry);
    reservedRuntimeSessions.set(orchestrator, reserved);
  }
  void abortSupplement(orchestrator, entry);
  void cleanupSupplement(orchestrator, entry);
  revokeCodeAwareOutputGuards(runtimeSessionId);
}
