// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import * as childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {resetPortPool} from '../portPool';
import {traceProcessorConfig} from '../../config';
import {
  TraceProcessorFactory,
  WorkingTraceProcessor,
  ExternalRpcProcessor,
  buildTraceProcessorHttpServerLaunch,
  getTraceProcessorPath,
  normalizeTraceProcessorRpcPort,
} from '../workingTraceProcessor';
import {
  TraceProcessorService,
  type QueryResult,
  type TraceProcessor,
} from '../traceProcessorService';
import * as nativeIdentity from '../capabilityManifestRuntimeIdentity';
import * as nativeDocs from '../perfettoSqlDocs';
import * as leaseModule from '../traceProcessorLeaseStore';
import {readRawSqlCaptureFields} from '../evidence/rawSqlNativeProvenance';
import {encodeQueryResult} from '../traceProcessorProtobuf';

jest.mock('child_process', () => ({
  ...jest.requireActual<typeof import('child_process')>('child_process'),
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

function writeFile(filePath: string, contents = 'trace bytes'): string {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function fakeProcessor(traceId: string): TraceProcessor {
  const result: QueryResult = {
    columns: ['startTime', 'endTime', 'numEvents'],
    rows: [[1, 2, 1]],
    durationMs: 1,
  };
  return {
    id: `processor-${traceId}`,
    traceId,
    status: 'ready',
    activeQueries: 0,
    query: jest.fn(async () => result),
    queryRaw: jest.fn(async (body: Buffer) => body),
    destroy: jest.fn(),
  };
}

function fakeChildProcess(): childProcess.ChildProcess {
  const process = new EventEmitter() as childProcess.ChildProcess;
  Object.assign(process, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(() => true),
  });
  return process;
}

describe('trace processor capability source', () => {
  let tempDir: string;
  let originalTraceProcessorPath: string | undefined;
  let originalSmartPerfettoHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-capability-source-'));
    originalTraceProcessorPath = process.env.TRACE_PROCESSOR_PATH;
    originalSmartPerfettoHome = process.env.SMARTPERFETTO_HOME;
    const actualChildProcess = jest.requireActual<typeof import('child_process')>('child_process');
    const spawnMock = childProcess.spawn as unknown as jest.Mock;
    const spawnSyncMock = childProcess.spawnSync as unknown as jest.Mock;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      throw new Error('Unexpected real-process boundary in capability-source test');
    });
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation(actualChildProcess.spawnSync as never);
  });

  afterEach(() => {
    if (originalTraceProcessorPath === undefined) {
      delete process.env.TRACE_PROCESSOR_PATH;
    } else {
      process.env.TRACE_PROCESSOR_PATH = originalTraceProcessorPath;
    }
    if (originalSmartPerfettoHome === undefined) {
      delete process.env.SMARTPERFETTO_HOME;
    } else {
      process.env.SMARTPERFETTO_HOME = originalSmartPerfettoHome;
    }
    jest.restoreAllMocks();
    jest.clearAllMocks();
    TraceProcessorFactory.cleanup();
    resetPortPool();
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('records local or external source at all five TraceInfo creation seams', async () => {
    const service = new TraceProcessorService(tempDir);
    jest.spyOn(TraceProcessorFactory, 'create')
      .mockImplementation(async traceId => fakeProcessor(traceId) as WorkingTraceProcessor);
    jest.spyOn(TraceProcessorFactory, 'createFromExternalRpc')
      .mockImplementation(async traceId => fakeProcessor(traceId) as never);

    await service.initializeUploadWithId('fixed-upload', 'fixed.trace', 13);

    const storedPath = writeFile(path.join(tempDir, 'stored-source.pftrace'));
    service.registerStoredTrace({
      id: 'stored',
      filename: 'stored-source.pftrace',
      size: 0,
      filePath: storedPath,
    });

    const diskId = 'disk-trace';
    writeFile(path.join(tempDir, `${diskId}.trace`));
    await expect(service.loadTraceFromDisk(diskId)).resolves.toMatchObject({id: diskId});

    const directPath = writeFile(path.join(tempDir, 'direct-source.pftrace'));
    const directId = await service.loadTraceFromFilePath(directPath);

    await service.registerExternalRpc('external', 19001, 'external trace');

    for (const traceId of ['fixed-upload', 'stored', diskId, directId]) {
      expect(service.getTraceSourceKind(traceId)).toBe('local_file');
    }
    expect(service.getTraceSourceKind('external')).toBe('external_rpc');

    expect(service.unregisterStoredTrace('stored', storedPath)).toBe(true);
    expect(service.getTraceSourceKind('stored')).toBeUndefined();

    await service.deleteTrace('fixed-upload');
    expect(service.getTraceSourceKind('fixed-upload')).toBeUndefined();
  });

  it('freezes env-selected binary before the server-start boundary', async () => {
    const tracePath = writeFile(path.join(tempDir, 'trace.pftrace'));
    const binaryA = writeFile(path.join(tempDir, 'trace-processor-a'));
    const binaryB = writeFile(path.join(tempDir, 'trace-processor-b'));
    process.env.TRACE_PROCESSOR_PATH = binaryA;
    const processor = new WorkingTraceProcessor('trace-env', tracePath);
    let startSelection: unknown;

    jest.spyOn(processor as any, 'startHttpServer').mockImplementation(async (selection: unknown) => {
      startSelection = selection;
      process.env.TRACE_PROCESSOR_PATH = binaryB;
    });
    jest.spyOn(processor as any, 'executeHttpQuery').mockResolvedValue({
      columns: ['test'],
      rows: [[1]],
      durationMs: 1,
    });

    await processor.initialize();

    expect(startSelection).toEqual({
      source: 'local_binary',
      selectedPath: binaryA,
      selectionOrigin: 'env_override',
    });
    expect(processor.getRuntimeBinarySelection()).toEqual(startSelection);
    const returned = processor.getRuntimeBinarySelection();
    returned.selectedPath = binaryB;
    expect(processor.getRuntimeBinarySelection().selectedPath).toBe(binaryA);
    processor.destroy();
  });

  it('keeps a warming factory processor tainted when a port is disclosed before ready', async () => {
    const tracePath = writeFile(path.join(tempDir, 'warming.pftrace'));
    process.env.TRACE_PROCESSOR_PATH = writeFile(path.join(tempDir, 'mock-binary'));
    const revision = 'a'.repeat(40);
    let resolveIdentity!: (value: Awaited<ReturnType<typeof nativeIdentity.resolveCapabilityTraceProcessorIdentity>>) => void;
    let identityStarted!: () => void;
    const started = new Promise<void>(resolve => {identityStarted = resolve;});
    jest.spyOn(nativeIdentity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision}).mockImplementationOnce(async () => {
      identityStarted();
      return new Promise(resolve => {resolveIdentity = resolve;});
    });
    jest.spyOn(nativeDocs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {},
      entries: [{id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '', columns: [{name: 'dur', type: 'DURATION'}]}]});
    const processor = new WorkingTraceProcessor('warming', tracePath);
    (processor as any).sqlWorker.rawExecutor = async () => encodeQueryResult({columnNames: ['dur'], rows: [[42]]});
    jest.spyOn(processor as any, 'startHttpServer').mockImplementation(async () => {(processor as any).serverReady = true;});
    (TraceProcessorFactory as any).processors.set('warming', processor);
    const service = new TraceProcessorService(tempDir);
    try {
      const initialization = processor.initialize();
      await started;
      expect(processor.status).toBe('initializing');
      service.exposeNativePort(processor.httpPort);
      resolveIdentity({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
      await initialization;
      expect(processor.status).toBe('ready');
      const result = await processor.query('SELECT dur FROM slice');
      expect(result.rows).toEqual([[42]]);
      expect(readRawSqlCaptureFields(result)).toBeUndefined();
    } finally {processor.destroy();}
  });

  it.each(['SQL mutation', 'port exposure'])('handles same-port replacement after %s without resetting exposure', async cause => {
    jest.replaceProperty(traceProcessorConfig, 'portRange', {min: 48000, max: 48999});
    resetPortPool();
    const tracePath = writeFile(path.join(tempDir, 'reuse.trace'));
    process.env.TRACE_PROCESSOR_PATH = writeFile(path.join(tempDir, 'mock-reuse-binary'));
    const revision = 'a'.repeat(40);
    jest.spyOn(nativeIdentity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    jest.spyOn(nativeDocs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {},
      entries: [{id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '', columns: [{name: 'dur', type: 'DURATION'}]}]});
    const create = (id: string) => {
      const processor = new WorkingTraceProcessor(id, tracePath);
      (processor as any).sqlWorker.rawExecutor = async () => encodeQueryResult({columnNames: ['dur'], rows: [[42]]});
      jest.spyOn(processor as any, 'startHttpServer').mockImplementation(async () => {(processor as any).serverReady = true;});
      (TraceProcessorFactory as any).processors.set(id, processor);
      return processor;
    };
    const first = create('reuse-first');
    await first.initialize();
    expect(readRawSqlCaptureFields(await first.query('SELECT dur FROM slice'))?.dur.unit).toBe('ns');
    const port = first.httpPort;
    if (cause === 'port exposure') TraceProcessorFactory.exposeNativePort(port);
    else await first.query('CREATE TABLE changed AS SELECT 1');
    expect(readRawSqlCaptureFields(await first.query('SELECT dur FROM slice'))).toBeUndefined();
    first.destroy();
    jest.replaceProperty(traceProcessorConfig, 'portRange', {min: port, max: port});
    resetPortPool();
    const replacement = create('reuse-second');
    expect(replacement.httpPort).toBe(port);
    await replacement.initialize();
    const fields = readRawSqlCaptureFields(await replacement.query('SELECT dur FROM slice'));
    if (cause === 'port exposure') expect(fields).toBeUndefined();
    else expect(fields?.dur.unit).toBe('ns');
  });

  it('checks the pinned identity before launch and only revokes when the launch snapshot changes', async () => {
    const tracePath = writeFile(path.join(tempDir, 'changed-launch.trace'));
    process.env.TRACE_PROCESSOR_PATH = writeFile(path.join(tempDir, 'changed-launch-binary'));
    const revision = 'a'.repeat(40);
    const phases: string[] = [];
    let launched = false;
    jest.spyOn(nativeIdentity, 'resolveCapabilityTraceProcessorIdentity').mockImplementation(async () => {
      phases.push('identity');
      return launched ? {source: 'custom', binarySha256: 'b'.repeat(64)}
        : {source: 'bundled', gitRevision: revision, stdlibRevision: revision};
    });
    jest.spyOn(nativeDocs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {},
      entries: [{id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '', columns: [{name: 'dur', type: 'DURATION'}]}]});
    // Use a fresh port rather than a prior test's intentionally exposed port.
    jest.replaceProperty(traceProcessorConfig, 'portRange', {min: 49000, max: 49999});
    resetPortPool();
    const processor = new WorkingTraceProcessor('changed-launch', tracePath);
    (processor as any).sqlWorker.rawExecutor = async () => encodeQueryResult({columnNames: ['dur'], rows: [[42]]});
    jest.spyOn(processor as any, 'startHttpServer').mockImplementation(async () => {
      expect(phases).toEqual(['identity']);
      phases.push('launch'); launched = true; (processor as any).serverReady = true;
    });
    try {
      await processor.initialize();
      expect(phases).toEqual(['identity', 'launch', 'identity']);
      expect(readRawSqlCaptureFields(await processor.query('SELECT dur FROM slice'))).toBeUndefined();
    } finally {processor.destroy();}
  });

  it.each(['number', 'string'])('invalidates an owned processor before its %s port is registered as an external alias', async encoding => {
    const processor = new WorkingTraceProcessor('owned', writeFile(path.join(tempDir, 'owned.trace')));
    (TraceProcessorFactory as any).processors.set('owned', processor);
    const invalidation = jest.spyOn(processor, 'invalidateNativeProvenance');
    jest.spyOn(ExternalRpcProcessor.prototype, 'queryHealth').mockImplementation(async () => {
      expect(invalidation).toHaveBeenCalledTimes(1);
      return {ok: true, durationMs: 0};
    });
    await TraceProcessorFactory.createFromExternalRpc('external-alias',
      (encoding === 'string' ? String(processor.httpPort) : processor.httpPort) as number);
    expect(invalidation).toHaveBeenCalledTimes(1);
  });

  it.each([true, [], ['9100'], {}, '', ' ', '0x238c', '9100.5', 0, 65536, Infinity])('rejects invalid RPC port input %j before alias registration', async input => {
    const service = new TraceProcessorService(tempDir);
    expect(() => normalizeTraceProcessorRpcPort(input)).toThrow('Invalid trace processor RPC port');
    await expect(service.registerExternalRpc('bad-port', input as number, 'bad')).rejects.toThrow('Invalid trace processor RPC port');
    expect(service.getTrace('bad-port')).toBeUndefined();
  });

  it('reports the actual shared eligibility without reviving taint or confusing explicit lease queries', async () => {
    jest.replaceProperty(traceProcessorConfig, 'portRange', {min: 50000, max: 50999});
    resetPortPool();
    const tracePath = writeFile(path.join(tempDir, 'policy.trace'));
    process.env.TRACE_PROCESSOR_PATH = writeFile(path.join(tempDir, 'policy-binary'));
    const revision = 'a'.repeat(40);
    jest.spyOn(nativeIdentity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    jest.spyOn(nativeDocs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {},
      entries: [{id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '', columns: [{name: 'dur', type: 'DURATION'}]}]});
    const service = new TraceProcessorService(tempDir);
    await service.initializeUploadWithId('policy', 'policy.trace', 1, tracePath);
    const processor = new WorkingTraceProcessor('policy', tracePath);
    (processor as any).sqlWorker.rawExecutor = async () => encodeQueryResult({columnNames: ['dur'], rows: [[42]]});
    jest.spyOn(processor as any, 'startHttpServer').mockImplementation(async () => {(processor as any).serverReady = true;});
    (TraceProcessorFactory as any).processors.set('policy', processor);
    (service as any).processors.set('policy', processor);
    expect(service.getAnalysisRunProcessorPolicy('policy').reason).toBe('not_ready');
    await processor.initialize();
    expect(service.getAnalysisRunProcessorPolicy('policy')).toEqual({sourceKind: 'local_file', requiresIsolation: false, reason: 'trusted'});
    processor.invalidateNativeProvenance();
    expect(service.getAnalysisRunProcessorPolicy('policy')).toEqual({sourceKind: 'local_file', requiresIsolation: true, reason: 'shared_tainted'});
    expect(readRawSqlCaptureFields(await processor.query('SELECT dur FROM slice'))).toBeUndefined();
    expect(service.getAnalysisRunProcessorPolicy('policy', {leaseId: 'other', leaseMode: 'isolated'}).reason).toBe('not_ready');
    jest.mocked(nativeIdentity.resolveCapabilityTraceProcessorIdentity).mockResolvedValue({source: 'custom', binarySha256: 'b'.repeat(64)});
    const custom = new WorkingTraceProcessor('custom', tracePath);
    (custom as any).sqlWorker.rawExecutor = async () => encodeQueryResult({columnNames: ['dur'], rows: [[42]]});
    jest.spyOn(custom as any, 'startHttpServer').mockImplementation(async () => {(custom as any).serverReady = true;});
    await service.initializeUploadWithId('custom', 'custom.trace', 1, tracePath);
    (TraceProcessorFactory as any).processors.set('custom', custom);
    await custom.initialize(); custom.invalidateNativeProvenance();
    expect(service.getAnalysisRunProcessorPolicy('custom')).toEqual({sourceKind: 'local_file', requiresIsolation: false, reason: 'untrusted_binary'});
  });

  it('observes only the actual ready service instance and registration without exposing a port or reviving authority', async () => {
    const tracePath = writeFile(path.join(tempDir, 'observation.trace'));
    const service = new TraceProcessorService(tempDir);
    await service.initializeUploadWithId('observed', 'observation.trace', 1, tracePath);
    const processor = new WorkingTraceProcessor('observed', tracePath);
    const replacement = new WorkingTraceProcessor('observed', tracePath);
    for (const value of [processor, replacement]) {
      jest.spyOn(value, 'getRuntimeBinarySelection').mockReturnValue({source: 'local_binary', selectedPath: '/actual/pinned/tp', selectionOrigin: 'default'});
      jest.spyOn(value, 'getNativeProvenanceSnapshot').mockReturnValue({status: 'trusted', nativeSchemaEligible: true});
      value.status = 'ready';
    }
    (TraceProcessorFactory as any).processors.set('observed', replacement);
    expect(service.getRunningNativeProcessorObservation('observed')).toBeUndefined(); // Factory is not the dispatch map.
    (service as any).processors.set('observed', processor);
    const first = service.getRunningNativeProcessorObservation('observed')!;
    const second = service.getRunningNativeProcessorObservation('observed')!;
    expect(first).toMatchObject({instanceId: processor.id, traceId: 'observed', status: 'trusted', nativeSchemaEligible: true});
    expect(first.instanceToken).toBe(second.instanceToken);
    expect(first.registrationToken).toBe(second.registrationToken);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.instanceToken)).toBe(true);
    expect(Object.isFrozen(first.registrationToken)).toBe(true);
    expect(Object.isFrozen(first.binarySelection)).toBe(true);
    expect(first).not.toHaveProperty('port');
    expect(first).not.toHaveProperty('processor');
    expect(JSON.parse(JSON.stringify(first)).instanceToken).not.toBe(first.instanceToken);
    jest.mocked(processor.getNativeProvenanceSnapshot).mockReturnValue({status: 'tainted', nativeSchemaEligible: true});
    const tainted = service.getRunningNativeProcessorObservation('observed')!;
    expect(tainted.status).toBe('tainted');
    expect(tainted.instanceToken).toBe(first.instanceToken);
    (service as any).processors.set('observed', replacement);
    const replaced = service.getRunningNativeProcessorObservation('observed')!;
    expect(replaced.instanceToken).not.toBe(first.instanceToken);
    expect(replaced.registrationToken).toBe(first.registrationToken);
    await service.initializeUploadWithId('observed', 'new-registration.trace', 1, tracePath);
    const registered = service.getRunningNativeProcessorObservation('observed')!;
    expect(registered.instanceToken).toBe(replaced.instanceToken);
    expect(registered.registrationToken).not.toBe(first.registrationToken);
    replacement.status = 'initializing';
    expect(service.getRunningNativeProcessorObservation('observed')).toBeUndefined();
    replacement.status = 'ready';
    const scope = {tenantId: 'tenant', workspaceId: 'workspace'};
    jest.spyOn(leaseModule, 'getTraceProcessorLeaseStore').mockReturnValue({getLeaseById: () => undefined} as unknown as leaseModule.TraceProcessorLeaseStore);
    await expect(service.runWithLeases([{traceId: 'observed', leaseId: 'released', mode: 'isolated', leaseScope: scope,
      holder: {holderType: 'agent_run', holderRef: 'run'}}], async () => service.getRunningNativeProcessorObservation('observed')))
      .rejects.toThrow('Trace processor lease owner is no longer active');
    processor.destroy();
  });

  it('latches private analysis from the actual scoped lease before publishing a warming processor', async () => {
    const tracePath = writeFile(path.join(tempDir, 'private.trace'));
    const service = new TraceProcessorService(tempDir);
    await service.initializeUploadWithId('private', 'private.trace', 1, tracePath);
    const scope = {tenantId: 'tenant', workspaceId: 'workspace'};
    const lease: leaseModule.TraceProcessorLeaseRecord = {id: 'run-lease', traceId: 'private', mode: 'isolated',
      ...scope, state: 'starting', rssBytes: null, heartbeatAt: null, expiresAt: null, holderCount: 1, holders: [
        {id: 'holder', leaseId: 'run-lease', holderType: 'agent_run', holderRef: 'run', windowId: null,
          heartbeatAt: null, expiresAt: null, createdAt: 1, metadata: {analysisRunPrivate: true}},
      ]};
    const getLeaseById = jest.fn((_scope: unknown, _leaseId: string) => lease);
    jest.spyOn(leaseModule, 'getTraceProcessorLeaseStore').mockReturnValue({getLeaseById} as unknown as leaseModule.TraceProcessorLeaseStore);
    jest.spyOn(TraceProcessorFactory, 'create').mockImplementation(async (traceId, filePath, options) => {
      const processor = new WorkingTraceProcessor(traceId, filePath, options);
      (TraceProcessorFactory as any).processors.set(options!.processorKey, processor);
      expect(service.isPrivateAnalysisProcessorKey(options!.processorKey!)).toBe(true);
      expect(processor.status).toBe('initializing');
      processor.status = 'ready';
      return processor;
    });
    const processor = await service.ensureProcessorForLease('private', lease.id, lease.mode, scope) as WorkingTraceProcessor;
    expect(getLeaseById).toHaveBeenCalledWith(scope, lease.id);
    lease.holders = [];
    expect(service.isPrivateAnalysisProcessorKey('private:lease:run-lease')).toBe(true);
    expect(service.getTraceWithLeasePort('private', lease.id, lease.mode)?.port).toBeUndefined();
    expect(service.getLeaseProcessorSnapshot('private', lease.id, lease.mode)?.port).toBeUndefined();
    const invalidation = jest.spyOn(processor, 'invalidateNativeProvenance');
    await expect(service.registerExternalRpc('alias', String(processor.httpPort) as unknown as number, 'private alias')).rejects.toThrow('Private analysis processor');
    expect(service.getTrace('alias')).toBeUndefined();
    await expect(TraceProcessorFactory.createFromExternalRpc('alias-direct', processor.httpPort)).rejects.toThrow('Private analysis processor');
    expect(invalidation).not.toHaveBeenCalled();
    service.cleanupLeaseProcessor('private', lease.id, lease.mode);
    expect(service.isPrivateAnalysisProcessorKey('private:lease:run-lease')).toBe(false);
  });

  it.each(['frontend', 'other_trace', 'missing_scope'])('does not create private authority from %s lease metadata', async kind => {
    const tracePath = writeFile(path.join(tempDir, 'nonprivate.trace'));
    const service = new TraceProcessorService(tempDir);
    await service.initializeUploadWithId('nonprivate', 'nonprivate.trace', 1, tracePath);
    const getLeaseById = jest.fn(() => ({id: 'untrusted-lease', traceId: kind === 'other_trace' ? 'other' : 'nonprivate',
      tenantId: 'tenant', workspaceId: 'workspace', mode: 'isolated', state: 'active', expiresAt: null,
      holders: [{holderType: kind === 'frontend' ? 'frontend_http_rpc' : 'agent_run',
        holderRef: 'holder', expiresAt: null, metadata: {analysisRunPrivate: true}}]}));
    jest.spyOn(leaseModule, 'getTraceProcessorLeaseStore').mockReturnValue({getLeaseById} as unknown as leaseModule.TraceProcessorLeaseStore);
    const create = jest.spyOn(TraceProcessorFactory, 'create').mockImplementation(async traceId => fakeProcessor(traceId) as WorkingTraceProcessor);
    const creation = service.ensureProcessorForLease('nonprivate', 'untrusted-lease', 'isolated',
      kind === 'missing_scope' ? undefined : {tenantId: 'tenant', workspaceId: 'workspace'});
    if (kind === 'other_trace') {
      await expect(creation).rejects.toMatchObject({code: 'TRACE_PROCESSOR_QUERY_CANCELLED'});
      expect(create).not.toHaveBeenCalled();
    } else {
      await creation;
      expect(create.mock.calls[0][2]).not.toHaveProperty('analysisRunPrivate');
    }
  });

  it('passes one captured binary path to both the CORS probe and spawn', async () => {
    const tracePath = writeFile(path.join(tempDir, 'trace.pftrace'));
    const binaryA = writeFile(path.join(tempDir, 'trace-processor-a'));
    const binaryB = writeFile(path.join(tempDir, 'trace-processor-b'));
    const child = fakeChildProcess();
    const spawnMock = childProcess.spawn as unknown as jest.Mock;
    const spawnSyncMock = childProcess.spawnSync as unknown as jest.Mock;
    spawnSyncMock.mockReturnValue({
      stdout: '--http-additional-cors-origins',
      stderr: '',
      status: 0,
    });
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.stderr?.emit('data', Buffer.from('Starting HTTP server')));
      return child;
    });
    process.env.TRACE_PROCESSOR_PATH = binaryB;
    const processor = new WorkingTraceProcessor('trace-spawn', tracePath);
    const selection = {
      source: 'local_binary' as const,
      selectedPath: binaryA,
      selectionOrigin: 'env_override' as const,
    };

    await (processor as any).startHttpServer(selection);

    expect(spawnSyncMock).toHaveBeenCalledWith(binaryA, ['help', 'server'], expect.any(Object));
    expect(spawnSyncMock).toHaveBeenCalledWith(binaryA, ['--help'], expect.any(Object));
    // No owner-bound `server http` in this help: the classic form is kept.
    expect(spawnMock).toHaveBeenCalledWith(binaryA, expect.arrayContaining([
      '--httpd',
      '--http-additional-cors-origins',
    ]), expect.any(Object));
    processor.destroy();
  });

  it('starts an owner-bound server http when the binary supports it', async () => {
    const tracePath = writeFile(path.join(tempDir, 'trace.pftrace'));
    const binary = writeFile(path.join(tempDir, 'trace-processor-owner-bound'));
    const child = fakeChildProcess();
    const spawnMock = childProcess.spawn as unknown as jest.Mock;
    const spawnSyncMock = childProcess.spawnSync as unknown as jest.Mock;
    spawnSyncMock.mockImplementation((...call: unknown[]) => ({
      stdout: (call[1] as string[])[0] === 'help'
        ? '--port\n--additional-cors-origins\n--idle-timeout\n--idle-start\n'
        : '',
      stderr: '',
      status: 0,
    }));
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.stderr?.emit('data', Buffer.from('Starting HTTP server')));
      return child;
    });
    const processor = new WorkingTraceProcessor('trace-owner-bound', tracePath);

    await (processor as any).startHttpServer({
      source: 'local_binary' as const,
      selectedPath: binary,
      selectionOrigin: 'env_override' as const,
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 4)).toEqual(['server', 'http', '--port', String(processor.httpPort)]);
    expect(args).toEqual(expect.arrayContaining(['--idle-start', 'orphaned', '--additional-cors-origins']));
    expect(args[args.indexOf('--idle-timeout') + 1]).toMatch(/^\d+s$/);
    expect(args).not.toContain('--httpd');
    expect(args[args.length - 1]).toBe(tracePath);
    processor.destroy();
  });

  it('binds the server to its owner only on POSIX with an owner other than PID 1', () => {
    const binary = writeFile(path.join(tempDir, 'trace-processor-owner-selection'));
    (childProcess.spawnSync as unknown as jest.Mock).mockReturnValue({
      stdout: '--port\n--additional-cors-origins\n--idle-timeout\n--idle-start\n',
      stderr: '',
      status: 0,
    });
    const launch = {binaryPath: binary, port: 9100, tracePath: '/trace', corsOrigins: 'http://localhost:10000'};
    // Not owner-bound: the same `server http` without idle flags, which never
    // reaps itself, as the classic launch.
    const unbound = {
      ownerBound: false,
      args: ['server', 'http', '--port', '9100', '--additional-cors-origins', 'http://localhost:10000', '/trace'],
    };

    expect(buildTraceProcessorHttpServerLaunch({...launch, ownerPid: 4242, platform: 'darwin'}).ownerBound).toBe(true);
    expect(buildTraceProcessorHttpServerLaunch({...launch, ownerPid: 4242, platform: 'linux'}).ownerBound).toBe(true);
    // No Windows run evidence yet: a failed parent-handle open would make a
    // live backend's processor look ownerless and reap it after idling.
    expect(buildTraceProcessorHttpServerLaunch({...launch, ownerPid: 4242, platform: 'win32'})).toEqual(unbound);
    // The server reads a parent of PID 1 as "no owner" and would reap a live
    // container-init backend's processor whenever it idles.
    expect(buildTraceProcessorHttpServerLaunch({...launch, ownerPid: 1, platform: 'linux'})).toEqual(unbound);
  });

  it('keeps the classic --httpd launch only for a binary without server http', () => {
    const binary = writeFile(path.join(tempDir, 'trace-processor-classic'));
    (childProcess.spawnSync as unknown as jest.Mock).mockImplementation((...call: unknown[]) => ({
      // A pre-subcommand binary: `help` is not a command, `--help` lists the
      // classic flags.
      stdout: (call[1] as string[])[0] === '--help'
        ? '-D, --httpd\n--http-port PORT\n--http-additional-cors-origins origin1,origin2\n'
        : 'Could not open help\n',
      stderr: '',
      status: (call[1] as string[])[0] === '--help' ? 0 : 1,
    }));

    expect(buildTraceProcessorHttpServerLaunch({
      binaryPath: binary, port: 9100, tracePath: '/trace', corsOrigins: 'http://localhost:10001', ownerPid: 4242, platform: 'linux',
    })).toEqual({
      ownerBound: false,
      args: ['--httpd', '--http-port', '9100', '--http-additional-cors-origins', 'http://localhost:10001', '/trace'],
    });
  });

  it('records the default binary selection when no env override is active', async () => {
    delete process.env.TRACE_PROCESSOR_PATH;
    process.env.SMARTPERFETTO_HOME = tempDir;
    const tracePath = writeFile(path.join(tempDir, 'trace.pftrace'));
    const executableName = process.platform === 'win32'
      ? 'trace_processor_shell.exe'
      : 'trace_processor_shell';
    writeFile(path.join(tempDir, 'bin', executableName));
    const defaultPath = getTraceProcessorPath();
    const processor = new WorkingTraceProcessor('trace-default', tracePath);
    jest.spyOn(processor as any, 'startHttpServer').mockResolvedValue(undefined);
    jest.spyOn(processor as any, 'executeHttpQuery').mockResolvedValue({
      columns: ['test'],
      rows: [[1]],
      durationMs: 1,
    });

    await processor.initialize();

    expect(processor.getRuntimeBinarySelection()).toEqual({
      source: 'local_binary',
      selectedPath: defaultPath,
      selectionOrigin: 'default',
    });
    processor.destroy();
  });

  it('resolves the processor selected by the current lease context', async () => {
    const service = new TraceProcessorService(tempDir);
    const traceId = 'leased-trace';
    const leaseId = 'lease-a';
    const localProcessor = Object.create(WorkingTraceProcessor.prototype) as WorkingTraceProcessor;
    jest.spyOn(localProcessor, 'getRuntimeBinarySelection').mockReturnValue({
      source: 'local_binary',
      selectedPath: '/frozen/trace_processor_shell',
      selectionOrigin: 'default',
    });
    (service as any).processors.set(`${traceId}:lease:${leaseId}`, localProcessor);

    await service.runWithLease(
      {traceId, leaseId, mode: 'isolated'},
      async () => {
        expect(service.getRunningCapabilityTraceProcessorInput(traceId)).toEqual({
          source: 'local_binary',
          selectedPath: '/frozen/trace_processor_shell',
          selectionOrigin: 'default',
        });
      },
    );

    expect(service.getRunningCapabilityTraceProcessorInput(traceId)).toBeUndefined();
  });

  it('reports external proxies and absent processors without consulting env', () => {
    const service = new TraceProcessorService(tempDir);
    process.env.TRACE_PROCESSOR_PATH = '/must/not/be/consulted';
    (service as any).processors.set('external', fakeProcessor('external'));

    expect(service.getRunningCapabilityTraceProcessorInput('external')).toEqual({
      source: 'external_rpc',
    });
    expect(service.getRunningCapabilityTraceProcessorInput('missing')).toBeUndefined();
  });
});
