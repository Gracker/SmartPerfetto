// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {AsyncLocalStorage} from 'async_hooks';
import {EventEmitter} from 'events';
import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {analysisRunTraceProcessorFailureSide, prepareAnalysisRunTraceProcessorLeases,
  type AnalysisRunProcessorPolicy, type AnalysisRunTraceProcessorService} from '../analysisRunTraceProcessorLease';
import type {TraceProcessorLeaseRecord} from '../traceProcessorLeaseStore';
import type {TraceInfo, TraceProcessorLeaseQueryContext} from '../traceProcessorService';
import type {TraceMetadata} from '../traceMetadataStore';
import type {RunOwnedOriginalTraceReader} from '../originalTraceEvidence';

const scope = {tenantId: 'personal', workspaceId: 'default', userId: 'local'};
function fixture() {
  const events: string[] = [];
  const traces = new Map<string, TraceInfo>(['current', 'reference'].map(id => [id,
    {id, filename: `${id}.trace`, size: 1, uploadTime: new Date(0), status: 'ready'}]));
  const policies = new Map<string, AnalysisRunProcessorPolicy>();
  const records = new Map<string, TraceProcessorLeaseRecord>();
  const als = new AsyncLocalStorage<TraceProcessorLeaseQueryContext[]>();
  const nativeAls = new AsyncLocalStorage<RunOwnedOriginalTraceReader>();
  const controller = new AbortController();
  const emitter = new EventEmitter();
  const getPolicy = jest.fn((id: string, options?: {leaseId?: string}) => options?.leaseId
    ? {sourceKind: 'local_file', requiresIsolation: false, reason: 'trusted'} as AnalysisRunProcessorPolicy
    : policies.get(id) ?? {sourceKind: 'local_file', requiresIsolation: true, reason: 'shared_tainted'});
  const ensure = jest.fn(async (id: string) => {events.push(`create:${id}`); return {} as any;});
  const cleanup = jest.fn((_traceId: string, _leaseId: string, _mode: string) => true);
  const prepareReader = jest.fn<AnalysisRunTraceProcessorService['prepareOriginalTraceEvidenceReader']>((_context, owner) =>
    async (_traceId, _sql, options) => {
      owner.assertCurrent(); options.assertAuthorized();
      const child = owner.acquireChild(); owner.childReady(child);
      return {columns: ['lease'], rows: [[child.leaseId]], durationMs: 1};
    });
  const service = Object.assign(emitter, {
    getTrace: (id: string) => traces.get(id),
    getTraceFilePath: (id: string) => `/registered/${id}.trace`,
    getTraceSourceKind: (id: string) => policies.get(id)?.sourceKind === 'external_rpc' ? 'external_rpc' : 'local_file',
    getAnalysisRunProcessorPolicy: getPolicy,
    ensureProcessorForLease: ensure,
    cleanupLeaseProcessor: cleanup,
    runWithLeases: jest.fn(async <T>(contexts: TraceProcessorLeaseQueryContext[], fn: () => Promise<T>) => als.run(contexts, fn)),
    prepareOriginalTraceEvidenceReader: prepareReader,
    runWithOriginalTraceReader: <T>(reader: RunOwnedOriginalTraceReader, fn: () => Promise<T>) => nativeAls.run(reader, fn),
  }) as unknown as AnalysisRunTraceProcessorService;
  const acquire = jest.fn((_scope: unknown, id: string, holder: any, options: any) => {
    events.push(`acquire:${id}`);
    const leaseId = `lease-${id}${holder.metadata?.executionContext === 'original_trace' ? '-original' : ''}`;
    const lease: TraceProcessorLeaseRecord = {id: leaseId, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      traceId: id, mode: options.mode, state: 'pending', rssBytes: null, heartbeatAt: 0, expiresAt: null,
      holderCount: 1, holders: [{id: `holder-${id}`, leaseId: `lease-${id}`, holderType: holder.holderType,
        holderRef: holder.holderRef, windowId: null, heartbeatAt: 0, expiresAt: null, createdAt: 0, metadata: holder.metadata}]};
    records.set(lease.id, lease);
    return lease;
  });
  const transition = (state: TraceProcessorLeaseRecord['state']) => jest.fn((_scope: unknown, id: string) => {
    const updated = {...records.get(id)!, state}; records.set(id, updated); return updated;
  });
  const store = {acquireHolder: acquire, releaseHolder: jest.fn((_scope: unknown, id: string) => {
    events.push(`release:${id}`); return records.get(id)!;
  }), markStarting: transition('starting'), markReady: transition('ready'), markFailed: transition('failed'),
  beginDraining: transition('released'), heartbeatHolder: jest.fn((_scope: unknown, id: string) => records.get(id)!)};
  const ensureBackingMetadata = jest.fn((_metadata: TraceMetadata, _scope: unknown) => undefined);
  const readMetadata = jest.fn(async (id: string): Promise<TraceMetadata | null> => ({id, filename: id, size: 0,
    uploadedAt: new Date(0).toISOString(), status: 'ready', externalRpc: true, port: 9178}));
  const input = {service, scope, runId: 'run', sessionId: 'session', currentTraceId: 'current',
    signal: controller.signal, assertCurrent: jest.fn(), onInvalidated: (error: Error) => controller.abort(error), store, ensureBackingMetadata, readMetadata};
  return {input, events, traces, policies, getPolicy, records, controller, emitter, ensure, cleanup, store, als,
    nativeAls, prepareReader, ensureBackingMetadata, readMetadata};
}
afterEach(() => {jest.useRealTimers();});

describe('analysis-run TraceProcessor leases', () => {
  it('keeps lazy native holders separate from working ALS and releases both trace sides', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases({...f.input, referenceTraceId: 'reference'});
    expect(f.prepareReader).toHaveBeenCalledTimes(2);
    expect(f.store.acquireHolder).toHaveBeenCalledTimes(2); // No native resource at prepare.
    try {
      await handle.run(async () => {
        const query = f.nativeAls.getStore()!;
        const options = {assertAuthorized: jest.fn()};
        expect((await query('current', 'SELECT dur FROM slice', options)).rows).toEqual([['lease-current-original']]);
        expect((await query('current', 'SELECT dur FROM slice', options)).rows).toEqual([['lease-current-original']]);
        expect((await query('reference', 'SELECT dur FROM slice', options)).rows).toEqual([['lease-reference-original']]);
        expect(f.als.getStore()!.map(context => context.leaseId)).toEqual(['lease-current', 'lease-reference']);
        expect(f.store.acquireHolder).toHaveBeenCalledTimes(4);
      });
    } finally {handle.release();}
    expect(f.cleanup.mock.calls.map(call => call[1])).toEqual([
      'lease-reference-original', 'lease-current-original', 'lease-reference', 'lease-current']);
  });

  it('rejects foreign Trace, withdrawn authorization and escaped stale reader before native allocation', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases(f.input);
    let reader!: RunOwnedOriginalTraceReader;
    await handle.run(async () => {
      reader = f.nativeAls.getStore()!;
      await expect(reader('foreign', 'SELECT dur FROM slice', {assertAuthorized() {}}))
        .rejects.toMatchObject({executed: false, reason: 'trace_not_authorized'});
      const withdrawn = new Error('authorization withdrawn');
      await expect(reader('current', 'SELECT dur FROM slice', {assertAuthorized() {throw withdrawn;}})).rejects.toBe(withdrawn);
      expect(f.store.acquireHolder).toHaveBeenCalledTimes(1);
    });
    handle.release();
    await expect(reader('current', 'SELECT dur FROM slice', {assertAuthorized() {}})).rejects.toMatchObject({name: 'AbortError'});
    expect(f.store.acquireHolder).toHaveBeenCalledTimes(1);
  });
  it('pins both holders before admission and keeps tools/finalization in the same lease group', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases({...f.input, referenceTraceId: 'reference'});
    try {
      expect(f.events).toEqual(['acquire:current', 'acquire:reference', 'create:current', 'create:reference']);
      expect(handle.entries.map(entry => entry.lease.mode)).toEqual(['isolated', 'isolated']);
      expect(f.store.acquireHolder.mock.calls.every(call => call[2].metadata.analysisRunPrivate === true)).toBe(true);
      expect(handle.entries.map(entry => entry.context.holder)).toEqual([
        {holderType: 'agent_run', holderRef: 'run'},
        {holderType: 'agent_run', holderRef: 'run:reference'},
      ]);
      const observed: string[][] = [];
      await handle.run(async () => {
        observed.push(f.als.getStore()!.map(context => context.leaseId));
        expect(f.als.getStore()!.map(context => context.holder)).toEqual(
          f.store.acquireHolder.mock.calls.map(call => ({holderType: call[2].holderType, holderRef: call[2].holderRef})),
        );
        await Promise.resolve();
        observed.push(f.als.getStore()!.map(context => context.leaseId));
      });
      await handle.run(async () => {observed.push(f.als.getStore()!.map(context => context.leaseId));});
      expect(observed).toEqual(Array(3).fill(['lease-current', 'lease-reference']));
      expect(f.ensure).toHaveBeenCalledTimes(2);
      expect(f.store.releaseHolder).not.toHaveBeenCalled();
      expect(f.cleanup).not.toHaveBeenCalled();
    } finally {handle.release(); handle.release();}
    expect(f.cleanup).toHaveBeenCalledTimes(2);
    expect(f.store.releaseHolder).toHaveBeenCalledTimes(2);
  });

  it.each(['trusted', 'untrusted_binary', 'external_rpc'] as const)('does not create an isolated processor for %s', reason => {
    const f = fixture();
    f.policies.set('current', {sourceKind: reason === 'external_rpc' ? 'external_rpc' : 'local_file', requiresIsolation: false, reason});
    return prepareAnalysisRunTraceProcessorLeases(f.input).then(handle => {
      expect(handle.entries[0].lease.mode).toBe('shared');
      handle.release();
      expect(f.cleanup).not.toHaveBeenCalled();
    });
  });

  it('builds missing CLI local backing from the registered Trace and its actual path', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases(f.input);
    expect(f.ensureBackingMetadata).toHaveBeenCalledWith({id: 'current', filename: 'current.trace', size: 1,
      uploadedAt: new Date(0).toISOString(), status: 'ready', path: '/registered/current.trace'}, scope);
    expect(f.readMetadata).not.toHaveBeenCalled();
    handle.release();
  });

  it('preserves an external RPC port and never invents a local source', async () => {
    const f = fixture();
    f.policies.set('current', {sourceKind: 'external_rpc', requiresIsolation: false, reason: 'external_rpc'});
    const handle = await prepareAnalysisRunTraceProcessorLeases(f.input);
    expect(f.ensureBackingMetadata.mock.calls[0][0]).toMatchObject({externalRpc: true, port: 9178});
    expect(f.ensureBackingMetadata.mock.calls[0][0].path).toBeUndefined();
    expect(handle.entries[0].lease.mode).toBe('shared');
    handle.release();
  });

  it('does not create a stale holder if the Trace changes while external metadata is read', async () => {
    const f = fixture();
    f.policies.set('current', {sourceKind: 'external_rpc', requiresIsolation: false, reason: 'external_rpc'});
    const pending = prepareAnalysisRunTraceProcessorLeases(f.input);
    f.traces.set('current', {...f.traces.get('current')!});
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(f.ensureBackingMetadata).not.toHaveBeenCalled();
    expect(f.store.acquireHolder).not.toHaveBeenCalled();
  });

  it('does not downgrade correctness isolation for a low-quota shared preference', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases({...f.input,
      decideMode: () => ({mode: 'shared', reason: 'quota_low_shared', signals: {}} as any)});
    expect(handle.entries[0].lease.mode).toBe('isolated');
    handle.release();
  });

  it('deduplicates an identical current/reference Trace', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases({...f.input, referenceTraceId: 'current'});
    expect(f.ensure).toHaveBeenCalledTimes(1);
    handle.release();
  });

  it.each(['current', 'reference'] as const)('retains the exact structured RAM error from %s without shared fallback', async side => {
    const f = fixture();
    const error = Object.assign(new Error('RAM admission denied'), {code: 'TRACE_PROCESSOR_RAM_BUDGET_EXCEEDED', decision: {admitted: false}});
    f.ensure.mockImplementation(async id => {if (id === side) throw error; return {} as any;});
    await expect(prepareAnalysisRunTraceProcessorLeases({...f.input, referenceTraceId: 'reference'})).rejects.toBe(error);
    expect(analysisRunTraceProcessorFailureSide(error)).toBe(side);
    expect(f.store.acquireHolder.mock.calls.every(call => call[3].mode === 'isolated')).toBe(true);
    expect(f.cleanup).toHaveBeenCalledWith('current', 'lease-current', 'isolated');
    expect(f.cleanup).toHaveBeenCalledWith('reference', 'lease-reference', 'isolated');
    expect(f.store.releaseHolder).toHaveBeenCalledTimes(2);
  });

  it('cleans cancellation immediately and again after pending initialization settles', async () => {
    const f = fixture();
    let finish!: (value: any) => void;
    f.ensure.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    let settled = false;
    const pending = prepareAnalysisRunTraceProcessorLeases(f.input).finally(() => {settled = true;});
    await Promise.resolve();
    f.controller.abort(new DOMException('Cancelled', 'AbortError'));
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finish({});
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(f.cleanup).toHaveBeenCalledTimes(2);
    expect(f.store.releaseHolder).toHaveBeenCalledTimes(1);
  });

  it.each(['return', 'throw'] as const)('cleans late private instances after cancellation inside run, when the callback will %s', async outcome => {
    const f = fixture();
    f.policies.set('reference', {sourceKind: 'local_file', requiresIsolation: false, reason: 'trusted'});
    const handle = await prepareAnalysisRunTraceProcessorLeases({...f.input, referenceTraceId: 'reference'});
    const liveInstances = new Set(['lease-current', 'lease-reference', 'another-run-private']);
    f.cleanup.mockImplementation((_traceId, leaseId) => liveInstances.delete(leaseId));
    let rejectTier1!: (error: Error) => void;
    const tier1 = new Promise<void>((_resolve, reject) => {rejectTier1 = reject;});
    const fallbackError = new Error('Fallback failed after cancellation');
    const pending = handle.run(async () => {
      try {await tier1;} catch { /* a tool may catch cancellation and attempt its fallback */ }
      // The service guards reject this in production; also defend the outer cleanup boundary.
      liveInstances.add('lease-current');
      if (outcome === 'throw') throw fallbackError;
      return 1;
    });
    f.controller.abort(new DOMException('Cancelled during tool execution', 'AbortError'));
    expect(liveInstances.has('lease-current')).toBe(false);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    rejectTier1(new DOMException('Tier 1 cancelled', 'AbortError'));
    if (outcome === 'throw') await expect(pending).rejects.toBe(fallbackError);
    else await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(liveInstances).toEqual(new Set(['lease-reference', 'another-run-private']));
    expect(f.cleanup.mock.calls).toEqual(Array(2).fill(['current', 'lease-current', 'isolated']));
    expect(f.store.releaseHolder).toHaveBeenCalledTimes(2);
    handle.release();
    expect(f.store.releaseHolder).toHaveBeenCalledTimes(2);
  });

  it('invalidates the run if its Trace is replaced, and removes event listeners on release', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases(f.input);
    f.traces.set('current', {...f.traces.get('current')!});
    f.emitter.emit('trace-initialized', f.traces.get('current'));
    expect(f.controller.signal.aborted).toBe(true);
    await expect(handle.run(async () => 1)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.emitter.listenerCount('trace-initialized')).toBe(0);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects an isolated processor that is still untrusted, without creating another one', async () => {
    const f = fixture();
    f.getPolicy.mockReturnValue({sourceKind: 'local_file', requiresIsolation: true, reason: 'shared_tainted'});
    await expect(prepareAnalysisRunTraceProcessorLeases(f.input)).rejects.toMatchObject({code: 'TRACE_PROCESSOR_NATIVE_PROVENANCE_UNAVAILABLE'});
    expect(f.ensure).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not replace a processor when later SQL taints it within the same run', async () => {
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases(f.input);
    f.getPolicy.mockReturnValue({sourceKind: 'local_file', requiresIsolation: true, reason: 'shared_tainted'});
    await handle.run(async () => 1);
    expect(f.ensure).toHaveBeenCalledTimes(1);
    handle.release();
  });

  it('refreshes holder TTL during long runs and stops after release', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const handle = await prepareAnalysisRunTraceProcessorLeases(f.input);
    jest.advanceTimersByTime(30_000);
    expect(f.store.heartbeatHolder).toHaveBeenCalledTimes(1);
    handle.release();
    jest.advanceTimersByTime(60_000);
    expect(f.store.heartbeatHolder).toHaveBeenCalledTimes(1);
  });
});
