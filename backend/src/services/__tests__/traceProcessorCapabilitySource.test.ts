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
import {
  TraceProcessorFactory,
  WorkingTraceProcessor,
  getTraceProcessorPath,
} from '../workingTraceProcessor';
import {
  TraceProcessorService,
  type QueryResult,
  type TraceProcessor,
} from '../traceProcessorService';

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

  it('records local or external source at all six TraceInfo creation seams', async () => {
    const service = new TraceProcessorService(tempDir);
    jest.spyOn(TraceProcessorFactory, 'create')
      .mockImplementation(async traceId => fakeProcessor(traceId) as WorkingTraceProcessor);
    jest.spyOn(TraceProcessorFactory, 'createFromExternalRpc')
      .mockImplementation(async traceId => fakeProcessor(traceId) as never);

    const uploadId = await service.initializeUpload('upload.trace', 12);
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

    for (const traceId of [uploadId, 'fixed-upload', 'stored', diskId, directId]) {
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

    expect(spawnSyncMock).toHaveBeenCalledWith(binaryA, ['--help'], expect.any(Object));
    expect(spawnMock).toHaveBeenCalledWith(binaryA, expect.arrayContaining([
      '--http-additional-cors-origins',
    ]), expect.any(Object));
    processor.destroy();
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
