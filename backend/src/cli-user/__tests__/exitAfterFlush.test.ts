// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, beforeEach} from '@jest/globals';
import {Writable} from 'stream';
import {exitAfterFlush, flushTimeoutMs, resetExitAfterFlushForTest} from '../exitAfterFlush';

/** A real Writable whose write callback is released by the test. */
function heldStream(options: {error?: Error} = {}): {stream: Writable; release: () => void} {
  let pending: ((error?: Error | null) => void) | undefined;
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      pending = callback;
    },
  });
  stream.write('queued output');
  return {stream, release: () => pending?.(options.error ?? null)};
}

function fakeConsole(): {console: Pick<Console, 'log' | 'info' | 'debug' | 'error'>; stdout: string[]; stderr: string[]} {
  const stdout: string[] = []; const stderr: string[] = [];
  return {stdout, stderr, console: {
    log: (...args: unknown[]) => { stdout.push(args.join(' ')); },
    info: (...args: unknown[]) => { stdout.push(args.join(' ')); },
    debug: (...args: unknown[]) => { stdout.push(args.join(' ')); },
    error: (...args: unknown[]) => { stderr.push(args.join(' ')); },
  }};
}

function recorder(): {codes: number[]; exit: (code: number) => void} {
  const codes: number[] = [];
  return {codes, exit: code => { codes.push(code); }};
}

describe('exitAfterFlush', () => {
  beforeEach(() => resetExitAfterFlushForTest());

  it('waits for queued output before exiting with the original code', async () => {
    const {stream, release} = heldStream();
    const {codes, exit} = recorder();
    const done = exitAfterFlush(3, {streams: [stream], timeoutMs: 5_000, exit, console: fakeConsole().console});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(codes).toEqual([]);
    release();
    await done;
    expect(codes).toEqual([3]);
  });

  it('a write error ends only that stream wait and never throws', async () => {
    const failing = heldStream({error: new Error('EPIPE')});
    const pending = heldStream();
    const {codes, exit} = recorder();
    const done = exitAfterFlush(0, {streams: [failing.stream, pending.stream], timeoutMs: 5_000, exit, console: fakeConsole().console});
    failing.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    // The other stream is still flushing: no exit yet.
    expect(codes).toEqual([]);
    pending.release();
    await done;
    expect(codes).toEqual([0]);
  });

  it('keeps a late error after the callback away from the fatal handlers', async () => {
    const {stream, release} = heldStream({error: new Error('EPIPE')});
    const {codes, exit} = recorder();
    const done = exitAfterFlush(1, {streams: [stream], timeoutMs: 5_000, exit, console: fakeConsole().console});
    release();
    await done;
    // Writable emits 'error' after the callback; an unhandled one would throw.
    await new Promise(resolve => setImmediate(resolve));
    expect(codes).toEqual([1]);
  });

  it('a stream closed without a callback still ends the wait', async () => {
    const {stream} = heldStream();
    const {codes, exit} = recorder();
    const done = exitAfterFlush(0, {streams: [stream], timeoutMs: 5_000, exit, console: fakeConsole().console});
    stream.destroy();
    await done;
    expect(codes).toEqual([0]);
  });

  it('bounds a reader that never drains', async () => {
    const {stream} = heldStream();
    const {codes, exit} = recorder();
    const started = Date.now();
    await exitAfterFlush(4, {streams: [stream], timeoutMs: 50, exit, console: fakeConsole().console});
    expect(codes).toEqual([4]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a second call during the flush exits at once with the first code', async () => {
    const {stream, release} = heldStream();
    const {codes, exit} = recorder();
    const first = exitAfterFlush(2, {streams: [stream], timeoutMs: 5_000, exit, console: fakeConsole().console});
    await exitAfterFlush(1, {streams: [stream], timeoutMs: 5_000, exit, console: fakeConsole().console});
    expect(codes).toEqual([2]);
    release();
    await first;
    expect(codes).toEqual([2, 2]);
  });

  it('moves teardown console output off stdout while it flushes', async () => {
    const {stream, release} = heldStream();
    const {codes, exit} = recorder();
    const fake = fakeConsole();
    const done = exitAfterFlush(0, {streams: [stream], timeoutMs: 5_000, exit, console: fake.console});
    // e.g. "[TraceProcessor] Process exited" logged by teardown during the wait.
    fake.console.log('[TraceProcessor] Process exited');
    fake.console.info('released port');
    release();
    await done;
    expect(fake.stdout).toEqual([]);
    expect(fake.stderr).toEqual(['[TraceProcessor] Process exited', 'released port']);
    expect(codes).toEqual([0]);
  });

  it('reads the flush bound from the environment, rejecting malformed values', () => {
    expect(flushTimeoutMs({SMARTPERFETTO_CLI_FLUSH_TIMEOUT_MS: '1500'})).toBe(1500);
    expect(flushTimeoutMs({SMARTPERFETTO_CLI_FLUSH_TIMEOUT_MS: 'soon'})).toBe(30_000);
    expect(flushTimeoutMs({})).toBe(30_000);
  });
});
