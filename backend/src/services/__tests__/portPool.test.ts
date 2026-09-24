// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {EventEmitter} from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as portPoolModule from '../portPool';
import {PortPool, randomPortScanOrigin} from '../portPool';
import {TraceProcessorFactory, WorkingTraceProcessor} from '../workingTraceProcessor';

const always = () => true;

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
  exit(): void {
    this.exitCode = 0;
    this.emit('close', 0);
  }
}

function usePool(pool: PortPool): void {
  jest.spyOn(portPoolModule, 'getPortPool').mockReturnValue(pool);
}

afterEach(() => {
  jest.restoreAllMocks();
  TraceProcessorFactory.cleanup();
});

describe('PortPool ownership-safe release', () => {
  it('frees the key at retirement but keeps the port reserved until the old process exits', () => {
    const pool = new PortPool(9100, 9103, always);
    const released = jest.fn();
    pool.on('released', released);
    expect(pool.allocate('k')).toBe(9100);
    const finish = pool.retire('k', 9100)!;
    expect(finish).toEqual(expect.any(Function));
    expect(pool.getPort('k')).toBeNull();
    expect(pool.isAvailable(9100)).toBe(false);
    expect(pool.getStats()).toMatchObject({allocated: 0, retiring: 1});

    // A retry under the same key receives a different port.
    expect(pool.allocate('k')).toBe(9101);
    // The late exit returns only the retired port, once.
    finish();
    finish();
    expect(pool.getPort('k')).toBe(9101);
    expect(pool.isAvailable(9100)).toBe(true);
    expect(pool.isAvailable(9101)).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledWith({port: 9100, traceId: 'k'});
  });

  it('does not retire a port the key does not own', () => {
    const pool = new PortPool(9100, 9103, always);
    pool.allocate('k');
    expect(pool.retire('k', 9101)).toBeNull();
    expect(pool.retire('other', 9100)).toBeNull();
    expect(pool.getPort('k')).toBe(9100);
  });

  it('keeps a port blocked when it is blocked during retirement', () => {
    const pool = new PortPool(9100, 9103, always);
    pool.allocate('k');
    const finish = pool.retire('k', 9100)!;
    pool.blockPort(9100);
    finish();
    expect(pool.isAvailable(9100)).toBe(false);
    expect(pool.getStats()).toMatchObject({blocked: 1, retiring: 0});
    expect(pool.releaseByPort(9100)).toBe(false);
  });

  it('does not force-release an untracked retiring port', () => {
    const pool = new PortPool(9100, 9103, always);
    pool.allocate('k');
    pool.retire('k', 9100);
    expect(pool.releaseByPort(9100)).toBe(false);
    expect(pool.isAvailable(9100)).toBe(false);
  });
});

describe('PortPool scan origin', () => {
  it('defaults to the lowest free port', () => {
    const pool = new PortPool(9100, 9109, always);
    expect(pool.getScanOrigin()).toBe('lowest');
    expect(pool.allocate('a')).toBe(9100);
  });

  it('starts at the origin, skips occupied ports and wraps to the lowest', () => {
    const occupied = new Set([9108]);
    const pool = new PortPool(9100, 9109, port => !occupied.has(port));
    pool.setScanOrigin(9107);
    expect(pool.allocate('a')).toBe(9107);
    expect(pool.allocate('b')).toBe(9109); // 9108 is held by another process.
    expect(pool.allocate('c')).toBe(9100); // Wraps.
    expect(pool.getStats().blocked).toBe(1);
  });

  it('gives processes with different origins disjoint first ports', () => {
    const first = new PortPool(9100, 9900, always);
    const second = new PortPool(9100, 9900, always);
    first.setScanOrigin(9150);
    second.setScanOrigin(9600);
    expect(first.allocate('trace')).toBe(9150);
    expect(second.allocate('trace')).toBe(9600);
  });

  it('rejects an origin outside the pool', () => {
    const pool = new PortPool(9100, 9109, always);
    expect(() => pool.setScanOrigin(9099)).toThrow('outside the pool');
    expect(() => pool.setScanOrigin(9110)).toThrow('outside the pool');
    expect(() => pool.setScanOrigin(9100.5)).toThrow('outside the pool');
  });

  it('draws random origins inside the range', () => {
    for (let i = 0; i < 200; i++) {
      const origin = randomPortScanOrigin(9100, 9105);
      expect(origin).toBeGreaterThanOrEqual(9100);
      expect(origin).toBeLessThanOrEqual(9105);
    }
  });

  it('applies the per-process origin to the singleton and keeps it across a reset', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolated = require('../portPool') as typeof portPoolModule;
      expect(isolated.getPortPool().getScanOrigin()).toBe('lowest');
      const origin = isolated.usePerProcessPortScanOrigin();
      expect(typeof origin).toBe('number');
      expect(isolated.getPortPool().getScanOrigin()).toBe(origin);
      expect(isolated.usePerProcessPortScanOrigin()).toBe(origin); // Drawn once per process.
      isolated.resetPortPool();
      expect(isolated.getPortPool().getScanOrigin()).toBe(origin);
    });
  });
});

describe('WorkingTraceProcessor port release', () => {
  it('a destroyed attempt cannot release the port of a later processor with the same key', () => {
    const pool = new PortPool(9100, 9103, always);
    usePool(pool);
    const first = new WorkingTraceProcessor('trace', '/nonexistent.trace', {processorKey: 'key'});
    const firstProcess = new FakeChildProcess();
    (first as any).process = firstProcess;
    expect(first.httpPort).toBe(9100);

    // initialize() failure destroys, then the factory destroys the same attempt again.
    first.destroy();
    first.destroy();
    expect(firstProcess.signals).toEqual(['SIGTERM']);
    expect(pool.getPort('key')).toBeNull();

    const second = new WorkingTraceProcessor('trace', '/nonexistent.trace', {processorKey: 'key'});
    expect(second.httpPort).toBe(9101);
    firstProcess.exit();
    expect(pool.getPort('key')).toBe(9101);
    expect(pool.isAvailable(9101)).toBe(false);
    expect(pool.isAvailable(9100)).toBe(true);

    second.destroy();
    expect(pool.isAvailable(9101)).toBe(true);
  });

  it('returns the port immediately when the process has already exited', () => {
    const pool = new PortPool(9100, 9103, always);
    usePool(pool);
    const processor = new WorkingTraceProcessor('trace', '/nonexistent.trace', {processorKey: 'key'});
    const exited = new FakeChildProcess();
    exited.exitCode = 1;
    (processor as any).process = exited;
    processor.destroy();
    expect(pool.isAvailable(9100)).toBe(true);
    expect(pool.getStats().retiring).toBe(0);
  });

  it('keeps the retry port when the PORT_IN_USE attempt exits after the retry started', async () => {
    const pool = new PortPool(9100, 9103, always);
    usePool(pool);
    const tracePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-port-retry-')), 'trace.pftrace');
    fs.writeFileSync(tracePath, 'x');
    const processes: FakeChildProcess[] = [];
    let attempt = 0;
    jest.spyOn(WorkingTraceProcessor.prototype, 'initialize').mockImplementation(async function(this: WorkingTraceProcessor) {
      const child = new FakeChildProcess();
      processes.push(child);
      (this as any).process = child;
      if (++attempt === 1) {
        // Mirrors initialize(): the failed attempt destroys itself before rethrowing.
        this.status = 'error';
        this.destroy();
        throw new Error(`PORT_IN_USE:${this.httpPort}`);
      }
      this.status = 'ready';
    });
    try {
      const processor = await TraceProcessorFactory.create('trace', tracePath, {processorKey: 'key'});
      expect(attempt).toBe(2);
      expect(processor.httpPort).toBe(9101);
      processes[0].exit();
      expect(pool.getPort('key')).toBe(9101);
      expect(pool.isAvailable(9101)).toBe(false);
      expect(pool.isAvailable(9100)).toBe(false); // Another process owns it.
      expect(pool.getStats().blocked).toBe(1);
    } finally {
      fs.rmSync(path.dirname(tracePath), {recursive: true, force: true});
    }
  });

  it('blocks the attempt port when the PORT_IN_USE message carries no port', async () => {
    const pool = new PortPool(9100, 9103, always);
    usePool(pool);
    const tracePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-port-retry-')), 'trace.pftrace');
    fs.writeFileSync(tracePath, 'x');
    let attempt = 0;
    jest.spyOn(WorkingTraceProcessor.prototype, 'initialize').mockImplementation(async function(this: WorkingTraceProcessor) {
      if (++attempt === 1) {
        this.destroy();
        throw new Error('PORT_IN_USE:unknown');
      }
      this.status = 'ready';
    });
    try {
      const processor = await TraceProcessorFactory.create('trace', tracePath, {processorKey: 'key'});
      expect(processor.httpPort).toBe(9101);
      expect(pool.isAvailable(9100)).toBe(false);
      expect(pool.getStats().blocked).toBe(1);
    } finally {
      fs.rmSync(path.dirname(tracePath), {recursive: true, force: true});
    }
  });
});
