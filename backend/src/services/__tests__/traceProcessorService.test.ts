// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * TraceProcessorService Unit Tests
 *
 * Tests for:
 * - Trace loading (loadTraceFromFilePath, loadTraceFromBuffer, loadTraceFromDisk)
 * - Trace ID generation
 * - Port pool management (9100-9900)
 * - SQL query execution
 * - Trace lifecycle (touch, delete, cleanup)
 * - Process spawning for trace_processor_shell
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { uuidv4 } from '../../utils/uuid';
import { TraceProcessorService, TraceInfo } from '../traceProcessorService';
import { PortPool, getPortPool, resetPortPool } from '../portPool';
import {
  TraceProcessorFactory,
  WorkingTraceProcessor,
  getBackendBinTraceProcessorPath,
  getTraceProcessorPath,
  isTraceProcessorPathPlaceholder,
  isFatalTraceProcessorListenFailure,
  isTraceProcessorReadyMessage,
  killOrphanProcessors,
  supportsTraceProcessorCorsOriginsFlag,
} from '../workingTraceProcessor';
import { isTraceProcessorQueryCancelledError } from '../traceProcessorCancellation';
import * as traceFormatDetector from '../traceFormatDetector';
import { listTraceCases, resolveTraceCase } from '../../../tests/helpers/traceCorpus';

// =============================================================================
// Test Environment Detection
// =============================================================================

describe('TraceProcessorService cancellation', () => {
  it('does not wait for shared auto-recovery when the query signal aborts', async () => {
    const service = new TraceProcessorService(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-tp-cancel-')));
    const traceId = 'trace-cancel-recovery';
    const processorKey = (service as any).processorKeyForLease(traceId);
    (service as any).processors.set(processorKey, {
      id: 'processor-cancel-recovery',
      traceId,
      status: 'error',
      activeQueries: 0,
      query: jest.fn(),
      queryRaw: jest.fn(),
      destroy: jest.fn(),
    });
    (service as any).recoveryInProgress.set(
      processorKey,
      new Promise(() => undefined),
    );
    const controller = new AbortController();
    const query = service.query(traceId, 'SELECT 1', {
      signal: controller.signal,
    });

    controller.abort();

    try {
      await query;
      throw new Error('Expected query to reject with cancellation');
    } catch (error) {
      expect(isTraceProcessorQueryCancelledError(error)).toBe(true);
    }
  });
});

// Path to trace_processor_shell binary
const TRACE_PROCESSOR_PATH = process.env.TRACE_PROCESSOR_PATH ||
  path.resolve(__dirname, '../../../../perfetto/out/ui/trace_processor_shell');

// Check if trace_processor_shell is available
function isTraceProcessorAvailable(): boolean {
  return fs.existsSync(TRACE_PROCESSOR_PATH);
}

// Check if test traces are available
function isTestTracesAvailable(): boolean {
  try {
    return listTraceCases().some(entry => entry.trace.materialization === 'committed');
  } catch {
    return false;
  }
}

// Get a test trace file path
function getTestTracePath(): string | null {
  if (!isTestTracesAvailable()) return null;

  const traceCase = listTraceCases().find(entry => entry.trace.materialization === 'committed');
  return traceCase ? resolveTraceCase(traceCase.id) : null;
}

// =============================================================================
// Test Utilities
// =============================================================================

// Clean up a temporary file
function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

describe('trace_processor startup stderr parsing', () => {
  it('does not treat trace loading as HTTP readiness', () => {
    expect(isTraceProcessorReadyMessage('[501.806] processor_shell.cc:2151 Trace loaded: 19.23 MB')).toBe(false);
    expect(isTraceProcessorReadyMessage('[501.806] http_server.cc:67 [HTTP] Starting HTTP server on 127.0.0.1:9100')).toBe(true);
  });

  it('does not treat Docker IPv6 loopback listen failure as a port conflict', () => {
    const stderr = '[567.342]       http_server.cc:83 Failed to listen on IPv6 socket: "[::1]:9187" (errno: 99, Cannot assign requested address)';

    expect(isFatalTraceProcessorListenFailure(stderr)).toBe(false);
  });

  it('does not treat bracketed IPv6 listen failures as a port conflict', () => {
    const stderr = '[567.342]       http_server.cc:83 Failed to listen on [::1]:9187 (errno: 99, Cannot assign requested address)';

    expect(isFatalTraceProcessorListenFailure(stderr)).toBe(false);
  });

  it('does not treat Windows errno 0 listen warning as a port conflict', () => {
    const stderr = '[841.673]       http_server.cc:72 Failed to listen on IPv4 socket: "127.0.0.1:9800" (errno: 0, No error)';

    expect(isFatalTraceProcessorListenFailure(stderr)).toBe(false);
  });

  it('treats non-IPv6 listen failures as a port conflict', () => {
    const stderr = '[567.342]       http_server.cc:83 Failed to listen on 127.0.0.1:9187 (errno: 98, Address already in use)';

    expect(isFatalTraceProcessorListenFailure(stderr)).toBe(true);
  });

  it('treats mixed IPv4 and IPv6 listen failures as a port conflict', () => {
    const stderr = [
      '[501.807]       http_server.cc:72 Failed to listen on IPv4 socket: "127.0.0.1:9100" (errno: 48, Address already in use)',
      '[501.807]       http_server.cc:83 Failed to listen on IPv6 socket: "[::1]:9100" (errno: 48, Address already in use)',
    ].join('\n');

    expect(isFatalTraceProcessorListenFailure(stderr)).toBe(true);
  });

  it('detects trace_processor_shell CORS origin flag support from help output', () => {
    const script = path.join(os.tmpdir(), `trace-processor-help-${uuidv4()}.sh`);
    fs.writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "--http-additional-cors-origins"\n');
    fs.chmodSync(script, 0o755);

    try {
      expect(supportsTraceProcessorCorsOriginsFlag(script)).toBe(true);
    } finally {
      cleanupTempFile(script);
    }
  });

  it('treats missing CORS origin flag help as unsupported', () => {
    const script = path.join(os.tmpdir(), `trace-processor-help-${uuidv4()}.sh`);
    fs.writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "--httpd"\n');
    fs.chmodSync(script, 0o755);

    try {
      expect(supportsTraceProcessorCorsOriginsFlag(script)).toBe(false);
    } finally {
      cleanupTempFile(script);
    }
  });

  it('detects placeholder TRACE_PROCESSOR_PATH values', () => {
    expect(isTraceProcessorPathPlaceholder('/path/to/trace_processor_shell')).toBe(true);
    expect(isTraceProcessorPathPlaceholder('C:\\path\\to\\trace_processor_shell')).toBe(true);
    expect(isTraceProcessorPathPlaceholder('/absolute/path/to/trace_processor_shell')).toBe(true);
    expect(isTraceProcessorPathPlaceholder('/opt/path/to/trace_processor_shell')).toBe(false);
    expect(isTraceProcessorPathPlaceholder('/opt/perfetto/trace_processor_shell')).toBe(false);
  });

  it('falls back to backend/bin when TRACE_PROCESSOR_PATH is an example placeholder', () => {
    const originalTraceProcessorPath = process.env.TRACE_PROCESSOR_PATH;
    const backendBinPath = getBackendBinTraceProcessorPath();
    const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => (
      path.resolve(String(candidate)) === backendBinPath
    ));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      process.env.TRACE_PROCESSOR_PATH = '/path/to/trace_processor_shell';
      expect(getTraceProcessorPath()).toBe(backendBinPath);
    } finally {
      if (originalTraceProcessorPath === undefined) {
        delete process.env.TRACE_PROCESSOR_PATH;
      } else {
        process.env.TRACE_PROCESSOR_PATH = originalTraceProcessorPath;
      }
      existsSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// =============================================================================
// Unit Tests (mocked, no real trace_processor_shell)
// =============================================================================

describe('TraceProcessorService - Unit Tests (Mocked)', () => {
  let service: TraceProcessorService;
  let uploadDir: string;

  beforeEach(() => {
    // Create a temporary upload directory for each test
    uploadDir = path.join(os.tmpdir(), `smartperfetto-test-${uuidv4()}`);
    fs.mkdirSync(uploadDir, { recursive: true });
    service = new TraceProcessorService(uploadDir);
  });

  afterEach(() => {
    // Cleanup uploaded traces
    try {
      const traces = service.getAllTraces();
      for (const trace of traces) {
        service.deleteTrace(trace.id);
      }
      // Remove temp directory
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Trace Initialization', () => {
    it('resolves current/reference lease contexts by trace id inside runWithLeases', async () => {
      const currentLease = {
        traceId: 'trace-current',
        leaseId: 'lease-current',
        mode: 'shared',
      };
      const referenceLease = {
        traceId: 'trace-reference',
        leaseId: 'lease-reference',
        mode: 'isolated',
      };

      await service.runWithLeases([currentLease, referenceLease], async () => {
        expect((service as any).resolveLeaseQueryContext('trace-current')).toEqual(currentLease);
        expect((service as any).resolveLeaseQueryContext('trace-reference')).toEqual(referenceLease);
        expect((service as any).resolveLeaseQueryContext('trace-missing')).toBeUndefined();
      });
    });

    it('should use SMARTPERFETTO_TRACE_UPLOAD_DIR for the default upload directory', () => {
      const previous = process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR;
      const envUploadDir = path.join(os.tmpdir(), `smartperfetto-env-upload-${uuidv4()}`);

      try {
        process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR = envUploadDir;
        const envService = new TraceProcessorService();

        expect(envService.getTraceFilePath('trace-env')).toBe(path.join(envUploadDir, 'trace-env.trace'));
        expect(fs.existsSync(envUploadDir)).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR;
        } else {
          process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR = previous;
        }
        fs.rmSync(envUploadDir, { recursive: true, force: true });
      }
    });

    it('should initialize upload with unique traceId', async () => {
      const traceId = await service.initializeUpload('test.trace', 1000);

      expect(traceId).toBeDefined();
      expect(typeof traceId).toBe('string');
      expect(traceId.length).toBeGreaterThan(0);

      const trace = service.getTrace(traceId);
      expect(trace).toBeDefined();
      expect(trace?.filename).toBe('test.trace');
      expect(trace?.size).toBe(1000);
      expect(trace?.status).toBe('uploading');
    });

    it('should generate unique traceIds for each upload', async () => {
      const traceId1 = await service.initializeUpload('test1.trace', 1000);
      const traceId2 = await service.initializeUpload('test2.trace', 2000);

      expect(traceId1).not.toBe(traceId2);
    });

    it('should initialize upload with specific ID', async () => {
      const specificId = 'my-custom-trace-id';
      await service.initializeUploadWithId(specificId, 'custom.trace', 500);

      const trace = service.getTrace(specificId);
      expect(trace).toBeDefined();
      expect(trace?.id).toBe(specificId);
      expect(trace?.filename).toBe('custom.trace');
    });

    it('should emit trace-initialized event', async () => {
      const eventPromise = new Promise<TraceInfo>((resolve) => {
        service.on('trace-initialized', resolve);
      });

      const traceId = await service.initializeUpload('event-test.trace', 100);
      const emittedTrace = await eventPromise;

      expect(emittedTrace.id).toBe(traceId);
      expect(emittedTrace.filename).toBe('event-test.trace');
    });
  });

  describe('Trace Info Management', () => {
    it('should return undefined for non-existent trace', () => {
      const trace = service.getTrace('non-existent-id');
      expect(trace).toBeUndefined();
    });

    it('should list all traces', async () => {
      await service.initializeUpload('trace1.trace', 100);
      await service.initializeUpload('trace2.trace', 200);
      await service.initializeUpload('trace3.trace', 300);

      const traces = service.getAllTraces();
      expect(traces.length).toBe(3);
    });

    it('should track upload and process times', async () => {
      const beforeTime = new Date();
      const traceId = await service.initializeUpload('time-test.trace', 100);
      const afterTime = new Date();

      const trace = service.getTrace(traceId);
      expect(trace?.uploadTime.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(trace?.uploadTime.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe('Touch Trace (Access Time Tracking)', () => {
    it('should update lastAccessTime on touch', async () => {
      const traceId = await service.initializeUpload('touch-test.trace', 100);
      const trace = service.getTrace(traceId);

      // Initially, lastAccessTime is undefined
      expect(trace?.lastAccessTime).toBeUndefined();

      // Touch the trace
      service.touchTrace(traceId);

      const touchedTrace = service.getTrace(traceId);
      expect(touchedTrace?.lastAccessTime).toBeDefined();
      expect(touchedTrace?.lastAccessTime).toBeInstanceOf(Date);
    });

    it('should not throw for non-existent trace on touch', () => {
      expect(() => service.touchTrace('non-existent')).not.toThrow();
    });

    it('should update lastAccessTime each time touched', async () => {
      const traceId = await service.initializeUpload('multi-touch.trace', 100);

      service.touchTrace(traceId);
      const firstTouch = service.getTrace(traceId)?.lastAccessTime?.getTime();

      // Wait a small bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      service.touchTrace(traceId);
      const secondTouch = service.getTrace(traceId)?.lastAccessTime?.getTime();

      expect(secondTouch).toBeGreaterThanOrEqual(firstTouch!);
    });
  });

  describe('Trace Activity Detection', () => {
    it('should detect active trace (recently accessed)', async () => {
      const traceId = await service.initializeUpload('active-test.trace', 100);
      service.touchTrace(traceId);

      // With default 30 minute timeout, should be active
      const isActive = service.isTraceActive(traceId);
      expect(isActive).toBe(true);
    });

    it('should detect inactive trace based on old upload time', async () => {
      const traceId = await service.initializeUpload('inactive-test.trace', 100);

      // Manually set old upload time to simulate an old trace
      const trace = service.getTrace(traceId);
      if (trace) {
        (trace as any).uploadTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      }

      // With 30 second timeout, trace without lastAccessTime uses uploadTime
      // Since uploadTime is 1 hour ago, it should be inactive
      const isActive = service.isTraceActive(traceId, 30 * 1000);
      expect(isActive).toBe(false);
    });

    it('should return false for non-existent trace', () => {
      const isActive = service.isTraceActive('non-existent');
      expect(isActive).toBe(false);
    });
  });

  describe('Delete Trace', () => {
    it('should delete trace from memory', async () => {
      const traceId = await service.initializeUpload('delete-test.trace', 100);
      expect(service.getTrace(traceId)).toBeDefined();

      await service.deleteTrace(traceId);
      expect(service.getTrace(traceId)).toBeUndefined();
    });

    it('should emit trace-deleted event', async () => {
      const traceId = await service.initializeUpload('delete-event.trace', 100);

      const eventPromise = new Promise<string>((resolve) => {
        service.on('trace-deleted', resolve);
      });

      await service.deleteTrace(traceId);
      const deletedId = await eventPromise;

      expect(deletedId).toBe(traceId);
    });

    it('should handle deleting non-existent trace gracefully', async () => {
      // Should not throw
      await expect(service.deleteTrace('non-existent')).resolves.not.toThrow();
    });
  });

  describe('Cleanup Logic', () => {
    it('should cleanup old and idle traces', async () => {
      const traceId = await service.initializeUpload('cleanup-test.trace', 100);

      // Manually set old upload time
      const trace = service.getTrace(traceId);
      if (trace) {
        (trace as any).uploadTime = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
      }

      // Cleanup with maxAge = 1 hour, idleTimeout = 1ms
      await service.cleanup(1 * 60 * 60 * 1000, 1);

      expect(service.getTrace(traceId)).toBeUndefined();
    });

    it('should skip active traces during cleanup', async () => {
      const traceId = await service.initializeUpload('active-cleanup.trace', 100);

      // Set old upload time but touch recently
      const trace = service.getTrace(traceId);
      if (trace) {
        (trace as any).uploadTime = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
        (trace as any).lastAccessTime = new Date(); // Just accessed
      }

      // Cleanup with maxAge = 1 hour, idleTimeout = 30 minutes
      await service.cleanup(1 * 60 * 60 * 1000, 30 * 60 * 1000);

      // Trace should still exist because it's recently accessed
      expect(service.getTrace(traceId)).toBeDefined();
    });

    it('should skip young traces during cleanup', async () => {
      const traceId = await service.initializeUpload('young-trace.trace', 100);

      // Default upload time is now - should not be cleaned
      await service.cleanup(1 * 60 * 60 * 1000, 1);

      expect(service.getTrace(traceId)).toBeDefined();
    });
  });

  describe('Load Trace From Disk', () => {
    const androidTrace = Buffer.concat([
      Buffer.from([0x0a, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x12, 0x51]),
      Buffer.from('google/raven_beta/raven:CinnamonBun/CP31.260508.005.A1/15421647:user/release-keys', 'latin1'),
    ]);

    // Older metadata may carry an OS label from the former substring detector.
    function persistLegacyTrace(traceId: string): void {
      fs.writeFileSync(path.join(uploadDir, `${traceId}.trace`), androidTrace);
      fs.writeFileSync(path.join(uploadDir, `${traceId}.json`), JSON.stringify({
        filename: 'legacy.trace',
        size: androidTrace.length,
        uploadedAt: new Date().toISOString(),
        traceOs: 'harmonyos',
        traceFormat: 'atrace_text',
      }));
    }

    beforeEach(() => {
      jest.spyOn(TraceProcessorFactory, 'create').mockImplementation(async (traceId: string) => ({
        id: `processor-${traceId}`,
        traceId,
        status: 'ready',
        activeQueries: 0,
        query: jest.fn(async () => ({columns: [], rows: [], durationMs: 0})),
        queryRaw: jest.fn(async (body: Buffer) => body),
        destroy: jest.fn(),
      }) as unknown as WorkingTraceProcessor);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('re-detects OS and format from the file instead of trusting persisted values', async () => {
      persistLegacyTrace('legacy-harmony-label');

      await expect(service.loadTraceFromDisk('legacy-harmony-label')).resolves.toMatchObject({
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      });
    });

    it('resets both detection fields to unknown when detection fails', async () => {
      persistLegacyTrace('legacy-detection-failure');
      jest.spyOn(traceFormatDetector, 'detectTraceFormat').mockRejectedValue(new Error('forced read failure'));
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(service.loadTraceFromDisk('legacy-detection-failure')).resolves.toMatchObject({
        traceOs: 'unknown',
        traceFormat: 'unknown',
      });
    });
  });

  describe('Register External RPC', () => {
    it('should register external RPC connection', async () => {
      const traceId = 'external-trace-id';
      const port = 9500;

      // Mock the TraceProcessorFactory to avoid actual HTTP calls
      const originalCreate = TraceProcessorFactory.createFromExternalRpc;
      const mockProcessor = {
        id: 'mock-processor',
        traceId,
        status: 'ready' as const,
        httpPort: port,
        query: async () => ({ columns: ['test'], rows: [[1]], durationMs: 1 }),
        destroy: () => {},
      };
      (TraceProcessorFactory as any).createFromExternalRpc = async () => mockProcessor;

      try {
        await service.registerExternalRpc(traceId, port, 'external.trace');

        const trace = service.getTrace(traceId);
        expect(trace).toBeDefined();
        expect(trace?.id).toBe(traceId);
        expect(trace?.filename).toBe('external.trace');
        expect(trace?.status).toBe('ready');
        expect(trace?.size).toBe(0); // Unknown size for external
      } finally {
        (TraceProcessorFactory as any).createFromExternalRpc = originalCreate;
      }
    });
  });

  describe('Get Trace With Port', () => {
    it('should return trace info without port when no processor', async () => {
      const traceId = await service.initializeUpload('no-port.trace', 100);

      const result = service.getTraceWithPort(traceId);
      expect(result).toBeDefined();
      expect(result?.id).toBe(traceId);
      expect(result?.port).toBeUndefined();
    });

    it('should return undefined for non-existent trace', () => {
      const result = service.getTraceWithPort('non-existent');
      expect(result).toBeUndefined();
    });
  });
});

// =============================================================================
// Port Pool Tests
// =============================================================================

describe('PortPool - Unit Tests', () => {
  let pool: PortPool;

  beforeEach(() => {
    // Create a small pool for testing
    pool = new PortPool(9100, 9105, () => true); // Only 6 ports
  });

  afterEach(() => {
    pool.releaseAll();
  });

  describe('Port Allocation', () => {
    it('should allocate ports from the pool', () => {
      const port1 = pool.allocate('trace-1');
      expect(port1).toBe(9100); // Should get lowest port first

      const port2 = pool.allocate('trace-2');
      expect(port2).toBe(9101);
    });

    it('should skip a port already bound by another process', () => {
      const probe = jest.fn((port: number) => port !== 9100);
      const crossProcessPool = new PortPool(9100, 9102, probe);

      expect(crossProcessPool.allocate('trace-cross-process')).toBe(9101);
      expect(probe).toHaveBeenCalledWith(9100);
      expect(probe).toHaveBeenCalledWith(9101);
      expect(crossProcessPool.getStats().blocked).toBe(1);

      crossProcessPool.releaseAll();
    });

    it('should return same port for same traceId', () => {
      const port1 = pool.allocate('same-trace');
      const port2 = pool.allocate('same-trace');

      expect(port1).toBe(port2);
    });

    it('should throw when port pool exhausted', () => {
      // Allocate all 6 ports
      for (let i = 0; i < 6; i++) {
        pool.allocate(`trace-${i}`);
      }

      // Next allocation should throw
      expect(() => pool.allocate('trace-overflow')).toThrow('No available ports');
    });

    it('should track allocations correctly', () => {
      pool.allocate('trace-1');
      pool.allocate('trace-2');

      const stats = pool.getStats();
      expect(stats.allocated).toBe(2);
      expect(stats.available).toBe(4); // 6 - 2
    });
  });

  describe('Port Release', () => {
    it('should release port back to pool', () => {
      const port = pool.allocate('trace-1');
      expect(pool.isAvailable(port)).toBe(false);

      const released = pool.release('trace-1');
      expect(released).toBe(true);
      expect(pool.isAvailable(port)).toBe(true);
    });

    it('should return false when releasing non-existent trace', () => {
      const released = pool.release('non-existent');
      expect(released).toBe(false);
    });

    it('should allow reuse of released ports', () => {
      const port1 = pool.allocate('trace-1');
      pool.release('trace-1');

      const port2 = pool.allocate('trace-2');
      expect(port2).toBe(port1); // Should reuse lowest available
    });

    it('should release by port number', () => {
      const port = pool.allocate('trace-1');
      const released = pool.releaseByPort(port);

      expect(released).toBe(true);
      expect(pool.isAvailable(port)).toBe(true);
    });

    it('should release all ports', () => {
      pool.allocate('trace-1');
      pool.allocate('trace-2');
      pool.allocate('trace-3');

      pool.releaseAll();

      const stats = pool.getStats();
      expect(stats.allocated).toBe(0);
      expect(stats.available).toBe(6);
    });
  });

  describe('Port Blocking', () => {
    it('should block port permanently', () => {
      const port = pool.allocate('trace-1');
      pool.blockPort(port);

      // Release should still work but port won't be available
      pool.release('trace-1');
      expect(pool.isAvailable(port)).toBe(false);

      const stats = pool.getStats();
      expect(stats.blocked).toBe(1);
    });

    it('should not allocate blocked ports', () => {
      pool.blockPort(9100);
      const port = pool.allocate('trace-1');

      expect(port).toBe(9101); // Should skip blocked port
    });
  });

  describe('Port Lookup', () => {
    it('should get port by traceId', () => {
      const port = pool.allocate('trace-1');
      expect(pool.getPort('trace-1')).toBe(port);
    });

    it('should return null for unknown traceId', () => {
      expect(pool.getPort('unknown')).toBeNull();
    });
  });

  describe('Stale Cleanup', () => {
    it('should cleanup stale allocations', () => {
      const port = pool.allocate('stale-trace');

      // Get the allocation and backdate it
      const stats = pool.getStats();
      const allocation = stats.allocations.find(a => a.traceId === 'stale-trace');
      if (allocation) {
        (allocation as any).allocatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      }

      // Cleanup with 1 hour max age
      const cleaned = pool.cleanupStale(1 * 60 * 60 * 1000);

      expect(cleaned).toBe(1);
      expect(pool.isAvailable(port)).toBe(true);
    });
  });

  describe('Event Emission', () => {
    it('should emit allocated event', (done) => {
      pool.on('allocated', ({ port, traceId }) => {
        expect(port).toBe(9100);
        expect(traceId).toBe('event-trace');
        done();
      });

      pool.allocate('event-trace');
    });

    it('should emit released event', (done) => {
      pool.allocate('release-event');

      pool.on('released', ({ traceId }) => {
        expect(traceId).toBe('release-event');
        done();
      });

      pool.release('release-event');
    });

    it('should emit blocked event', (done) => {
      pool.on('blocked', ({ port }) => {
        expect(port).toBe(9100);
        done();
      });

      pool.blockPort(9100);
    });
  });
});

// =============================================================================
// Integration Tests (requires trace_processor_shell)
// =============================================================================

describe('TraceProcessorService - Integration Tests', () => {
  const shouldRunIntegration = isTraceProcessorAvailable() && isTestTracesAvailable();
  const testTracePath = getTestTracePath();

  if (!shouldRunIntegration) {
    it.skip('Integration tests skipped: trace_processor_shell or test traces not available', () => {
      // This test is skipped
    });
    return;
  }

  let service: TraceProcessorService;
  let uploadDir: string;
  let loadedTraceIds: string[] = [];

  beforeAll(() => {
    // Kill any orphan processes from previous runs
    killOrphanProcessors();
    // Reset port pool to clean state
    resetPortPool();
  });

  beforeEach(() => {
    uploadDir = path.join(os.tmpdir(), `smartperfetto-integration-${uuidv4()}`);
    fs.mkdirSync(uploadDir, { recursive: true });
    service = new TraceProcessorService(uploadDir);
    loadedTraceIds = [];
  });

  afterEach(async () => {
    // Cleanup all loaded traces
    for (const traceId of loadedTraceIds) {
      try {
        await service.deleteTrace(traceId);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove temp directory
    try {
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore
    }
  });

  afterAll(() => {
    // Cleanup factory processors
    TraceProcessorFactory.cleanup();
    resetPortPool();
  });

  describe('Load Trace From File Path', () => {
    it('should load trace and generate unique traceId', async () => {
      const traceId = await service.loadTraceFromFilePath(testTracePath!);
      loadedTraceIds.push(traceId);

      expect(traceId).toBeDefined();
      expect(typeof traceId).toBe('string');

      const trace = service.getTrace(traceId);
      expect(trace).toBeDefined();
      expect(trace?.status).toBe('ready');
      expect(trace?.filename).toBe(path.basename(testTracePath!));
    }, 60000);

    it('should throw error for non-existent file', async () => {
      await expect(service.loadTraceFromFilePath('/non/existent/path.trace'))
        .rejects.toThrow('File not found');
    });

    it('should copy trace file to upload directory', async () => {
      const traceId = await service.loadTraceFromFilePath(testTracePath!);
      loadedTraceIds.push(traceId);

      const copiedPath = path.join(uploadDir, `${traceId}.trace`);
      expect(fs.existsSync(copiedPath)).toBe(true);
    }, 60000);
  });

  describe('SQL Query Execution', () => {
    let traceId: string;

    beforeEach(async () => {
      traceId = await service.loadTraceFromFilePath(testTracePath!);
      loadedTraceIds.push(traceId);
    }, 60000);

    it('should execute simple query and return columns/rows', async () => {
      const result = await service.query(traceId, 'SELECT 1 as test_col');

      expect(result.columns).toContain('test_col');
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0][0]).toBe(1);
      expect(result.durationMs).toBeDefined();
    }, 30000);

    it('should execute query against trace data', async () => {
      const result = await service.query(traceId, 'SELECT COUNT(*) as cnt FROM slice LIMIT 1');

      expect(result.columns).toContain('cnt');
      expect(result.rows.length).toBe(1);
      expect(typeof result.rows[0][0]).toBe('number');
    }, 30000);

    it('should handle SQL syntax errors gracefully', async () => {
      const result = await service.query(traceId, 'INVALID SQL SYNTAX');

      expect(result.error).toBeDefined();
      expect(result.columns).toEqual([]);
      expect(result.rows).toEqual([]);
    }, 30000);

    it('should return empty results for no matches', async () => {
      const result = await service.query(
        traceId,
        "SELECT * FROM slice WHERE name = 'this_slice_does_not_exist_xyz123'"
      );

      expect(result.error).toBeUndefined();
      expect(result.rows).toEqual([]);
    }, 30000);

    it('should throw for unloaded trace', async () => {
      await expect(service.query('non-existent-trace', 'SELECT 1'))
        .rejects.toThrow('No processor for trace');
    });

    it('should update lastAccessTime on query', async () => {
      // Touch should be called internally by query
      const beforeQuery = service.getTrace(traceId)?.lastAccessTime;

      await service.query(traceId, 'SELECT 1');

      const afterQuery = service.getTrace(traceId)?.lastAccessTime;
      expect(afterQuery).toBeDefined();

      // If beforeQuery was undefined, afterQuery should be set
      if (beforeQuery) {
        expect(afterQuery!.getTime()).toBeGreaterThanOrEqual(beforeQuery.getTime());
      }
    }, 30000);
  });

  describe('Processor Port Management', () => {
    let traceId: string;

    beforeEach(async () => {
      traceId = await service.loadTraceFromFilePath(testTracePath!);
      loadedTraceIds.push(traceId);
    }, 60000);

    it('should expose HTTP port for ready processor', async () => {
      const port = service.getProcessorPort(traceId);

      expect(port).toBeDefined();
      expect(port).toBeGreaterThanOrEqual(9100);
      expect(port).toBeLessThanOrEqual(9900);
    });

    it('should include port in getTraceWithPort', () => {
      const result = service.getTraceWithPort(traceId);

      expect(result).toBeDefined();
      expect(result?.port).toBeDefined();
      expect(result?.processor?.status).toBe('ready');
    });

    it('should release port on delete', async () => {
      const port = service.getProcessorPort(traceId)!;
      const portPool = getPortPool();

      expect(portPool.isAvailable(port)).toBe(false);

      await service.deleteTrace(traceId);
      loadedTraceIds = loadedTraceIds.filter(id => id !== traceId);

      // Wait for process cleanup
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(portPool.isAvailable(port)).toBe(true);
    });
  });

  describe('Trace Lifecycle', () => {
    it('should handle full upload -> process -> query -> delete lifecycle', async () => {
      // 1. Initialize upload
      const traceId = await service.initializeUpload('lifecycle-test.trace', 1000);
      expect(service.getTrace(traceId)?.status).toBe('uploading');

      // 2. Load from file (simulates completing upload)
      const actualTraceId = await service.loadTraceFromFilePath(testTracePath!);
      loadedTraceIds.push(actualTraceId);
      expect(service.getTrace(actualTraceId)?.status).toBe('ready');

      // 3. Query
      const result = await service.query(actualTraceId, 'SELECT 1');
      expect(result.rows.length).toBeGreaterThan(0);

      // 4. Delete
      await service.deleteTrace(actualTraceId);
      loadedTraceIds = loadedTraceIds.filter(id => id !== actualTraceId);
      expect(service.getTrace(actualTraceId)).toBeUndefined();
    }, 90000);
  });

  describe('Multiple Traces', () => {
    it('should handle multiple traces simultaneously', async () => {
      // Load the same trace twice with different IDs
      const traceId1 = await service.loadTraceFromFilePath(testTracePath!);
      loadedTraceIds.push(traceId1);

      const traceId2 = await service.loadTraceFromFilePath(testTracePath!);
      loadedTraceIds.push(traceId2);

      expect(traceId1).not.toBe(traceId2);

      // Both should be queryable
      const result1 = await service.query(traceId1, 'SELECT 1');
      const result2 = await service.query(traceId2, 'SELECT 2');

      expect(result1.rows[0][0]).toBe(1);
      expect(result2.rows[0][0]).toBe(2);

      // Different ports
      const port1 = service.getProcessorPort(traceId1);
      const port2 = service.getProcessorPort(traceId2);
      expect(port1).not.toBe(port2);
    }, 120000);
  });
});

// =============================================================================
// WorkingTraceProcessor Tests (requires trace_processor_shell)
// =============================================================================

describe('WorkingTraceProcessor - Integration Tests', () => {
  const shouldRun = isTraceProcessorAvailable() && isTestTracesAvailable();
  const testTracePath = getTestTracePath();

  if (!shouldRun) {
    it.skip('WorkingTraceProcessor tests skipped: trace_processor_shell or test traces not available', () => {
      // Skipped
    });
    return;
  }

  beforeAll(() => {
    killOrphanProcessors();
    resetPortPool();
  });

  afterAll(() => {
    TraceProcessorFactory.cleanup();
    resetPortPool();
  });

  describe('Process Lifecycle', () => {
    let processor: WorkingTraceProcessor | null = null;
    const traceId = `test-processor-${uuidv4()}`;

    afterEach(async () => {
      if (processor) {
        processor.destroy();
        processor = null;
      }
      // Give time for process cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    it('should spawn trace_processor_shell process', async () => {
      processor = new WorkingTraceProcessor(traceId, testTracePath!);
      await processor.initialize();

      expect(processor.status).toBe('ready');
      expect(processor.httpPort).toBeGreaterThanOrEqual(9100);
    }, 60000);

    it('should destroy process on destroy()', async () => {
      processor = new WorkingTraceProcessor(traceId, testTracePath!);
      await processor.initialize();

      const port = processor.httpPort;
      processor.destroy();
      processor = null;

      // Wait for process cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Port should be released
      expect(getPortPool().isAvailable(port)).toBe(true);
    }, 60000);
  });

  describe('TraceProcessorFactory', () => {
    const traceId = `factory-test-${uuidv4()}`;

    afterEach(() => {
      TraceProcessorFactory.remove(traceId);
    });

    it('should create processor via factory', async () => {
      const processor = await TraceProcessorFactory.create(traceId, testTracePath!);

      expect(processor).toBeDefined();
      expect(processor.status).toBe('ready');
    }, 60000);

    it('should reuse existing processor', async () => {
      const processor1 = await TraceProcessorFactory.create(traceId, testTracePath!);
      const processor2 = await TraceProcessorFactory.create(traceId, testTracePath!);

      expect(processor1).toBe(processor2);
    }, 60000);

    it('should get processor by traceId', async () => {
      await TraceProcessorFactory.create(traceId, testTracePath!);
      const retrieved = TraceProcessorFactory.get(traceId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.traceId).toBe(traceId);
    }, 60000);

    it('should report stats', async () => {
      await TraceProcessorFactory.create(traceId, testTracePath!);
      const stats = TraceProcessorFactory.getStats();

      expect(stats.count).toBeGreaterThanOrEqual(1);
      expect(stats.traceIds).toContain(traceId);
    }, 60000);
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  describe('TraceProcessorService Errors', () => {
    let service: TraceProcessorService;
    let uploadDir: string;

    beforeEach(() => {
      uploadDir = path.join(os.tmpdir(), `error-test-${uuidv4()}`);
      fs.mkdirSync(uploadDir, { recursive: true });
      service = new TraceProcessorService(uploadDir);
    });

    afterEach(() => {
      try {
        if (fs.existsSync(uploadDir)) {
          fs.rmSync(uploadDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore
      }
    });

    it('should handle chunk upload for non-existent trace', async () => {
      await expect(service.uploadChunk('non-existent', Buffer.from('test')))
        .rejects.toThrow('not found');
    });

    it('should handle complete upload for non-existent trace', async () => {
      await expect(service.completeUpload('non-existent'))
        .rejects.toThrow('not found');
    });

    it('should create upload directory if not exists', () => {
      const newDir = path.join(os.tmpdir(), `new-upload-dir-${uuidv4()}`);
      new TraceProcessorService(newDir);

      expect(fs.existsSync(newDir)).toBe(true);

      // Cleanup
      fs.rmSync(newDir, { recursive: true, force: true });
    });
  });

  describe('PortPool Errors', () => {
    it('should handle out of range port in blockPort', () => {
      const pool = new PortPool(9100, 9105);

      // Should not throw, just ignore
      expect(() => pool.blockPort(8000)).not.toThrow();
      expect(() => pool.blockPort(10000)).not.toThrow();

      const stats = pool.getStats();
      expect(stats.blocked).toBe(0);
    });
  });
});

// =============================================================================
// Singleton Tests
// =============================================================================

describe('Singleton Behavior', () => {
  it('getPortPool should return same instance', () => {
    const pool1 = getPortPool();
    const pool2 = getPortPool();

    expect(pool1).toBe(pool2);
  });

  it('resetPortPool should create new instance', () => {
    const pool1 = getPortPool();
    pool1.allocate('singleton-test');

    resetPortPool();

    const pool2 = getPortPool();
    // After reset, the allocation should be gone
    expect(pool2.getPort('singleton-test')).toBeNull();
  });
});
