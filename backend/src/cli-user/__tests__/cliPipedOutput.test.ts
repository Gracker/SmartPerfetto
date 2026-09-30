// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {spawn, spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The CLI exits explicitly after each command. On a POSIX pipe stdout is
 * asynchronous, so exiting without flushing dropped everything past the pipe
 * buffer: this query wrote 2.4 MB to a file but only 64 KB through a pipe,
 * exit 0. The test goes through the real entry point with a reader that starts
 * late, so the buffer is full when the command finishes.
 */

const backendRoot = path.resolve(__dirname, '../../..');
const trace = path.resolve(backendRoot, '../Trace/real/android-startup-light/trace.pftrace');
const tsx = path.join(backendRoot, 'node_modules/.bin/tsx');
const bin = path.join(backendRoot, 'src/cli-user/bin.ts');
const SQL = 'SELECT id, ts, dur, name FROM slice ORDER BY id LIMIT 20000';
const describeWithTrace = fs.existsSync(trace) && fs.existsSync(tsx) && process.platform !== 'win32'
  ? describe : describe.skip;

function queryArgs(sessionDir: string): string[] {
  return [bin, '--session-dir', sessionDir, 'query', trace, '--sql', SQL, '--format', 'json'];
}

/** Deterministic part of the query payload: per-load ids and timings differ between runs. */
function comparable(payload: any): unknown {
  const {traceId: _traceId, durationMs: _durationMs, ...rest} = payload;
  const result = rest.result ? (({durationMs: _d, ...r}) => r)(rest.result) : undefined;
  return {...rest, ...(result ? {result} : {})};
}

describeWithTrace('CLI output through a pipe', () => {
  it('delivers the whole query result to a reader that starts late', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-pipe-'));
    try {
      const file = spawnSync(tsx, queryArgs(sessionDir), {cwd: backendRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
      expect(file.status).toBe(0);
      const expected = JSON.parse(file.stdout);
      expect(expected.result.rows.length).toBe(20_000);

      const child = spawn(tsx, queryArgs(sessionDir), {cwd: backendRoot, stdio: ['ignore', 'pipe', 'ignore']});
      child.stdout.pause();
      const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
      // Let the command finish while nothing reads, so the pipe buffer is full at exit.
      // Long enough for teardown (trace_processor exit) to log while the flush waits.
      await new Promise(resolve => setTimeout(resolve, 8_000));
      const chunks: Buffer[] = [];
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.stdout.resume();
      await new Promise(resolve => child.stdout.once('end', resolve));
      expect(await exited).toBe(0);

      // Strict parse: trailing teardown log lines on stdout would fail it too.
      const piped = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      expect(piped.result.rows.length).toBe(20_000);
      expect(comparable(piped)).toEqual(comparable(expected));
    } finally {
      fs.rmSync(sessionDir, {recursive: true, force: true});
    }
  }, 180_000);
});
