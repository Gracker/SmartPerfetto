// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {EnterpriseRepositoryScope} from './enterpriseRepository';
import {getTraceProcessorLeaseStore, type TraceProcessorLeaseStore, type TraceProcessorLeaseRecord,
  type TraceProcessorHolderInput} from './traceProcessorLeaseStore';
import type {TraceInfo, TraceProcessorService, TraceProcessorLeaseQueryContext,
  TraceProcessorAnalysisRunPolicy} from './traceProcessorService';
import type {TraceProcessorLeaseModeDecision} from './traceProcessorLeaseModeDecision';
import {ensureTraceProcessorLeaseBackingMetadata, readTraceMetadata, type TraceMetadata} from './traceMetadataStore';
import {OriginalTraceEvidenceRefusal, type RunOwnedOriginalTraceReader} from './originalTraceEvidence';

type TraceSide = 'current' | 'reference';
export type AnalysisRunProcessorPolicy = TraceProcessorAnalysisRunPolicy;
export type AnalysisRunTraceProcessorService = Pick<TraceProcessorService,
  'getTrace' | 'getTraceFilePath' | 'getTraceSourceKind' | 'getAnalysisRunProcessorPolicy' | 'ensureProcessorForLease' |
  'cleanupLeaseProcessor' | 'runWithLeases' | 'prepareOriginalTraceEvidenceReader' | 'runWithOriginalTraceReader' | 'on' | 'off'>;
type LeaseStore = Pick<TraceProcessorLeaseStore, 'acquireHolder' | 'releaseHolder' | 'markStarting' |
  'markReady' | 'markFailed' | 'beginDraining' | 'heartbeatHolder'>;
export interface AnalysisRunTraceProcessorLeaseEntry {
  side: TraceSide;
  lease: TraceProcessorLeaseRecord;
  context: TraceProcessorLeaseQueryContext;
  privateProcessor: boolean;
  decision: {mode: 'shared' | 'isolated'; reason: string; signals?: TraceProcessorLeaseModeDecision['signals']};
}
export interface AnalysisRunTraceProcessorLeases {
  readonly entries: readonly AnalysisRunTraceProcessorLeaseEntry[];
  run<T>(fn: () => Promise<T>): Promise<T>;
  assertCurrent(): void;
  release(): void;
}
const failures = new WeakMap<object, TraceSide>();
export function analysisRunTraceProcessorFailureSide(error: unknown): TraceSide | undefined {
  return error && typeof error === 'object' ? failures.get(error) : undefined;
}

/** Own one group for the entire physical analysis run, including finalization. */
export async function prepareAnalysisRunTraceProcessorLeases(input: {
  service: AnalysisRunTraceProcessorService;
  scope: EnterpriseRepositoryScope;
  runId: string;
  sessionId: string;
  currentTraceId: string;
  referenceTraceId?: string;
  signal: AbortSignal;
  assertCurrent(): void;
  onInvalidated?(error: Error): void;
  decideMode?(trace: TraceInfo, side: TraceSide): TraceProcessorLeaseModeDecision;
  metadata?: Record<string, unknown>;
  store?: LeaseStore;
  ensureBackingMetadata?: typeof ensureTraceProcessorLeaseBackingMetadata;
  readMetadata?: typeof readTraceMetadata;
}): Promise<AnalysisRunTraceProcessorLeases> {
  input.signal.throwIfAborted();
  input.assertCurrent();
  const {service, scope} = input;
  const store = input.store ?? getTraceProcessorLeaseStore();
  const entries: Array<AnalysisRunTraceProcessorLeaseEntry & {holder: TraceProcessorHolderInput;
    trace: TraceInfo; sourceKind: ReturnType<TraceProcessorService['getTraceSourceKind']>; integrityIsolation: boolean}> = [];
  const nativeEntries: Array<AnalysisRunTraceProcessorLeaseEntry & {holder: TraceProcessorHolderInput}> = [];
  let released = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let activeSide: TraceSide = 'current';
  const cleanupProcessor = (entry: AnalysisRunTraceProcessorLeaseEntry) => {
    if (entry.privateProcessor) service.cleanupLeaseProcessor(entry.context.traceId, entry.lease.id, entry.lease.mode);
  };
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    input.signal.removeEventListener('abort', release);
    for (const event of ['trace-initialized', 'trace-unregistered', 'trace-deleted']) service.off(event, changedTrace);
    for (const entry of [...entries, ...nativeEntries].reverse()) {
      try {store.releaseHolder(scope, entry.lease.id, 'agent_run', entry.holder.holderRef);} catch { /* already released */ }
      if (entry.privateProcessor) {
        try {store.beginDraining(scope, entry.lease.id);} catch { /* failed or already terminal */ }
        try {cleanupProcessor(entry);} catch { /* late startup cleanup is retried below */ }
      }
    }
  };
  const invalidate = (error: Error) => {
    release();
    input.onInvalidated?.(error);
  };
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    input.assertCurrent();
    if (released) throw new DOMException('Analysis TraceProcessor leases released', 'AbortError');
    if (entries.some(entry => service.getTrace(entry.context.traceId) !== entry.trace ||
      service.getTraceSourceKind(entry.context.traceId) !== entry.sourceKind)) {
      const error = new DOMException('Analysis Trace changed during execution', 'AbortError');
      invalidate(error);
      throw error;
    }
  };
  function changedTrace() {
    if (released) return;
    try {assertCurrent();} catch (error) {invalidate(error instanceof Error ? error : new Error('Analysis Trace changed'));}
  }
  input.signal.addEventListener('abort', release, {once: true});
  for (const event of ['trace-initialized', 'trace-unregistered', 'trace-deleted']) service.on(event, changedTrace);
  try {
    assertCurrent();
    const sides: Array<[TraceSide, string]> = [['current', input.currentTraceId]];
    if (input.referenceTraceId && input.referenceTraceId !== input.currentTraceId) sides.push(['reference', input.referenceTraceId]);
    // Pin both Trace holders before factory admission may evict an unleased shared processor.
    for (const [side, traceId] of sides) {
      activeSide = side;
      const trace = service.getTrace(traceId);
      if (!trace) throw new Error(`Analysis Trace ${traceId} not found`);
      const sourceKind = service.getTraceSourceKind(traceId);
      let metadata: TraceMetadata;
      if (sourceKind === 'local_file') {
        // CLI may register a file directly, without creating legacy metadata first.
        metadata = {id: trace.id, filename: trace.filename, size: trace.size,
          uploadedAt: trace.uploadTime.toISOString(), status: trace.status, path: service.getTraceFilePath(traceId)};
      } else {
        const stored = sourceKind === 'external_rpc' ? await (input.readMetadata ?? readTraceMetadata)(traceId) : null;
        if (!stored?.externalRpc || typeof stored.port !== 'number') {
          throw Object.assign(new Error('Registered Trace source metadata is unavailable'),
            {code: 'TRACE_PROCESSOR_TRACE_SOURCE_UNAVAILABLE'});
        }
        const {path: _localPath, ...externalMetadata} = stored;
        metadata = externalMetadata;
      }
      assertCurrent();
      if (service.getTrace(traceId) !== trace || service.getTraceSourceKind(traceId) !== sourceKind) {
        const error = new DOMException('Analysis Trace changed during preparation', 'AbortError');
        invalidate(error);
        throw error;
      }
      (input.ensureBackingMetadata ?? ensureTraceProcessorLeaseBackingMetadata)(metadata, scope);
      const policy = service.getAnalysisRunProcessorPolicy(traceId);
      const preferred = input.decideMode?.(trace, side);
      const integrityIsolation = sourceKind === 'local_file' && policy.requiresIsolation;
      const mode = sourceKind === 'external_rpc' ? 'shared' : integrityIsolation ? 'isolated' : preferred?.mode ?? 'shared';
      const privateProcessor = mode === 'isolated';
      const decision = {mode, reason: integrityIsolation ? policy.reason : preferred?.reason ?? policy.reason,
        ...(preferred ? {signals: preferred.signals} : {})};
      const holder: TraceProcessorHolderInput = {holderType: 'agent_run',
        holderRef: side === 'current' ? input.runId : `${input.runId}:reference`, runId: input.runId,
        sessionId: input.sessionId, metadata: {...input.metadata, traceSide: side,
          leaseModeReason: decision.reason, ...(privateProcessor ? {analysisRunPrivate: true} : {})}};
      const lease = store.acquireHolder(scope, traceId, holder, {mode});
      entries.push({side, lease, privateProcessor, integrityIsolation, decision, holder, trace, sourceKind,
        context: {traceId, leaseId: lease.id, mode, leaseScope: scope,
          holder: {holderType: holder.holderType, holderRef: holder.holderRef}}});
    }
    assertCurrent();
    heartbeat = setInterval(() => {
      try {
        assertCurrent();
        for (const entry of [...entries, ...nativeEntries]) store.heartbeatHolder(scope, entry.lease.id, entry.holder);
      } catch (error) {invalidate(error instanceof Error ? error : new Error('Analysis lease heartbeat failed'));}
    }, 30_000);
    heartbeat.unref();
    for (const entry of entries) {
      activeSide = entry.side;
      assertCurrent();
      if (entry.lease.state === 'pending') entry.lease = store.markStarting(scope, entry.lease.id);
      // Keep root run ownership while initialization settles, even after cancellation.
      try {
        await service.ensureProcessorForLease(entry.context.traceId, entry.lease.id, entry.lease.mode, scope);
      } finally {
        if (released) {
          try {cleanupProcessor(entry);} catch { /* preserve cancellation or the original admission error */ }
        }
      }
      assertCurrent();
      if (entry.integrityIsolation && service.getAnalysisRunProcessorPolicy(entry.context.traceId, {
        leaseId: entry.lease.id, leaseMode: entry.lease.mode, leaseScope: scope,
      }).reason !== 'trusted') {
        const error = new Error('Analysis TraceProcessor native provenance is unavailable');
        Object.assign(error, {code: 'TRACE_PROCESSOR_NATIVE_PROVENANCE_UNAVAILABLE'});
        throw error;
      }
      if (entry.lease.state === 'starting') entry.lease = store.markReady(scope, entry.lease.id);
    }
    const readers = new Map<string, RunOwnedOriginalTraceReader>();
    for (const entry of entries) {
      let child: typeof nativeEntries[number] | undefined;
      const reader = service.prepareOriginalTraceEvidenceReader(entry.context, {
        signal: input.signal, assertCurrent,
        acquireChild: () => {
          assertCurrent();
          if (child) return child.context;
          const holder: TraceProcessorHolderInput = {holderType: 'agent_run',
            holderRef: `${input.runId}:original_trace:${entry.side}`, runId: input.runId, sessionId: input.sessionId,
            metadata: {analysisRunPrivate: true, traceSide: entry.side, executionContext: 'original_trace'}};
          const lease = store.acquireHolder(scope, entry.context.traceId, holder, {mode: 'isolated'});
          child = {side: entry.side, lease, holder, privateProcessor: true,
            decision: {mode: 'isolated', reason: 'original_trace'},
            context: {traceId: entry.context.traceId, leaseId: lease.id, mode: 'isolated', leaseScope: scope,
              holder: {holderType: holder.holderType, holderRef: holder.holderRef}}};
          nativeEntries.push(child);
          child.lease = store.markStarting(scope, lease.id);
          return child.context;
        },
        childReady: context => {
          assertCurrent();
          if (!child || child.context !== context) throw new OriginalTraceEvidenceRefusal('processor_unavailable');
          child.lease = store.markReady(scope, child.lease.id);
        },
        childFailed: context => {
          if (!released && child?.context === context && child.lease.state === 'starting') {
            try {child.lease = store.markFailed(scope, child.lease.id);} catch { /* retain the initialization error */ }
          }
        },
      });
      readers.set(entry.context.traceId, reader);
    }
    const reader: RunOwnedOriginalTraceReader = async (traceId, sql, options) => {
      assertCurrent();
      options.signal?.throwIfAborted();
      options.assertAuthorized();
      const selected = readers.get(traceId);
      if (!selected) throw new OriginalTraceEvidenceRefusal('trace_not_authorized');
      return selected(traceId, sql, options);
    };
    return {entries, assertCurrent, release, run: async <T>(fn: () => Promise<T>) => {
      assertCurrent();
      try {
        const value = await service.runWithOriginalTraceReader(reader,
          () => service.runWithLeases(entries.map(entry => entry.context), fn));
        assertCurrent();
        return value;
      } finally {
        // Cancellation releases ownership immediately; catch any instance that settled later.
        // Normal callbacks retain the same group for subsequent finalization work.
        if (released) {
          for (const entry of [...entries, ...nativeEntries].reverse()) {
            try {cleanupProcessor(entry);} catch { /* preserve the callback's error or cancellation */ }
          }
        }
      }
    }};
  } catch (error) {
    if (error && typeof error === 'object') failures.set(error, activeSide);
    const failed = entries.find(entry => entry.side === activeSide);
    if (!released && failed && (failed.lease.state === 'pending' || failed.lease.state === 'starting')) {
      try {store.markFailed(scope, failed.lease.id);} catch { /* retain original admission error */ }
    }
    release();
    throw error;
  }
}
