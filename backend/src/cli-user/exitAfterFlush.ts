// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Writable} from 'stream';

/**
 * Exit after stdout and stderr have handed their queued output to the OS.
 *
 * On POSIX, `process.stdout`/`stderr` connected to a pipe are asynchronous and
 * `process.exit()` discards whatever is still queued: `smp query … --format json`
 * wrote 2.4 MB to a file but delivered 64 KB through a pipe, exit 0. Flushing is
 * bounded best-effort, never a guarantee: a stream error (the reader closed it,
 * e.g. `| head`) or the timeout still exits with the original code, and the tail
 * may then be lost. A second call while one is in progress exits at once with the
 * first code, so a fatal error raised during the flush cannot re-enter it.
 */

const DEFAULT_FLUSH_TIMEOUT_MS = 30_000;

export interface ExitAfterFlushOptions {
  streams?: readonly Writable[];
  timeoutMs?: number;
  exit?: (code: number) => never | void;
  /** Console whose log/info/debug move to stderr for the flush; defaults to the global one. */
  console?: Pick<Console, 'log' | 'info' | 'debug' | 'error'>;
}

let exitingWith: number | undefined;

/** Resolves once `stream` has flushed what was queued before this call, failed or closed. */
function flushed(stream: Writable): Promise<void> {
  if (stream.destroyed || stream.writableEnded || stream.writableLength === 0) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      stream.off('close', done);
      resolve();
    };
    // The write callback fires after every earlier chunk was handed over (or with
    // the write error); 'close' covers a stream torn down without a callback.
    stream.once('close', done);
    stream.write('', () => done());
  });
}

function routeConsoleOutputToStderr(target: Pick<Console, 'log' | 'info' | 'debug' | 'error'>): void {
  const error = target.error.bind(target);
  target.log = error;
  target.info = error;
  target.debug = error;
}

export function flushTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SMARTPERFETTO_CLI_FLUSH_TIMEOUT_MS;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_FLUSH_TIMEOUT_MS;
}

export async function exitAfterFlush(code: number, options: ExitAfterFlushOptions = {}): Promise<never> {
  const exit = options.exit ?? ((exitCode: number) => process.exit(exitCode));
  if (exitingWith !== undefined) {
    exit(exitingWith);
    return undefined as never;
  }
  exitingWith = code;
  const streams = options.streams ?? [process.stdout, process.stderr];
  // The command's output is complete. While the flush waits, teardown still runs
  // (a trace_processor child exiting logs "[TraceProcessor] Process exited");
  // it goes to stderr so stdout keeps only the command output, e.g. pure JSON.
  routeConsoleOutputToStderr(options.console ?? console);
  // A late EPIPE after the write callback must not reach the fatal handlers.
  for (const stream of streams) stream.on('error', () => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, options.timeoutMs ?? flushTimeoutMs());
  });
  await Promise.race([Promise.all(streams.map(flushed)), timeout]);
  if (timer) clearTimeout(timer);
  exit(code);
  return undefined as never;
}

/** @internal Test seam: forget a previous exit so each case starts clean. */
export function resetExitAfterFlushForTest(): void {
  exitingWith = undefined;
}
