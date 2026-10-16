// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterAll, beforeAll, describe, expect, it, jest} from '@jest/globals';
import {spawn, type ChildProcess} from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {delay, waitForCondition} from '../../../tests/utils';
import {
  buildTraceProcessorHttpServerLaunch,
  getTraceProcessorPath,
  isProcessAlive,
} from '../workingTraceProcessor';
import {canBindLoopbackPort} from '../portPool';

// Each owner is a separate real process running the production factory
// against the pinned binary; see buildTraceProcessorHttpServerLaunch. Windows
// does not bind the server to its owner, so only POSIX runs the owner cases.

jest.setTimeout(120_000);

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.resolve(BACKEND_ROOT, '../Trace/.generated/constructed/source-analysis-semantic/trace.pftrace');
const OWNER_SCRIPT = path.join(BACKEND_ROOT, 'tests/helpers/traceProcessorOwnerProcess.cjs');
const OWNER_READY_TIMEOUT_MS = 60_000;
const CONNECTIONS_CLOSED_TIMEOUT_MS = 30_000;
const REAP_DEADLINE_MS = 15_000;
// Outside the ranges other suites and gates pin (9345, 9456, 9600-9699, 9800-9999);
// 9740-9769 for the owners, 9770-9779 for the unbound server.
const PORT_BASE = 9740;

interface Owner {
  child: ChildProcess;
  output: () => string;
  ownerPid?: number;
  processorPid?: number;
}

const owners: Owner[] = [];

function waitUntilGone(pid: number, what: string): Promise<void> {
  return waitForCondition(() => !isProcessAlive(pid), {
    timeoutMs: REAP_DEADLINE_MS,
    intervalMs: 100,
    timeoutMessage: `${what} ${pid} is still running`,
  });
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Wait until the processor has no open HTTP connection. While the readiness
 * query's keep-alive connection is open, the owner's death closes it, the
 * server logs the disconnect into a stderr pipe nobody reads any more and dies
 * of SIGPIPE. With every connection closed and logged, the server writes
 * nothing more, so only its own owner watch can end it.
 */
function waitForClosedConnections(owner: Owner): Promise<void> {
  return waitForCondition(() => {
    const log = owner.output();
    const opened = countOf(log, '[HTTP] New connection');
    return opened > 0 && countOf(log, '[HTTP] Client disconnected') === opened;
  }, {
    timeoutMs: CONNECTIONS_CLOSED_TIMEOUT_MS,
    intervalMs: 100,
    timeoutMessage: 'processor kept an HTTP connection open',
  });
}

function startOwner(portMin: number): Promise<Owner> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Not a test environment, so the factory relays the processor's stderr.
    NODE_ENV: 'development',
    TP_PORT_MIN: String(portMin),
    TP_PORT_MAX: String(portMin + 9),
  };
  delete env.JEST_WORKER_ID;
  const child = spawn(process.execPath, ['--import', 'tsx', OWNER_SCRIPT, FIXTURE], {
    cwd: BACKEND_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const owner: Owner = {child, output: () => stdout};
  owners.push(owner);
  child.stdout!.on('data', chunk => {stdout += String(chunk);});
  child.stderr!.on('data', chunk => {stderr += String(chunk);});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`owner not ready in ${OWNER_READY_TIMEOUT_MS}ms: ${stderr}`)),
      OWNER_READY_TIMEOUT_MS);
    const onData = (): void => {
      const match = /OWNER_READY (\{.*\})/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      child.stdout!.off('data', onData);
      Object.assign(owner, JSON.parse(match[1]) as {ownerPid: number; processorPid: number});
      resolve(owner);
    };
    child.stdout!.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`owner exited (${code}) before its processor was ready: ${stderr}`));
    });
  });
}

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('a trace processor does not outlive its owner', () => {
  let killed: Owner;
  let terminated: Owner;
  let exited: Owner;

  beforeAll(async () => {
    expect(fs.existsSync(FIXTURE)).toBe(true);
    // The pinned binary is what makes the guarantee; an older override has no
    // owner-bound server and falls back to the startup orphan sweep.
    expect(buildTraceProcessorHttpServerLaunch({
      binaryPath: getTraceProcessorPath(), port: 1, tracePath: FIXTURE, corsOrigins: '',
    }).ownerBound).toBe(true);
    [killed, terminated, exited] = await Promise.all([
      startOwner(PORT_BASE),
      startOwner(PORT_BASE + 10),
      startOwner(PORT_BASE + 20),
    ]);
    await Promise.all([killed, terminated, exited].map(waitForClosedConnections));
    // A misfiring owner watch would reap by the second 2s tick after the
    // 2s idle timeout (about 4s); wait past that before checking a live owner.
    await delay(5_500);
  });

  afterAll(() => {
    for (const owner of owners) {
      for (const pid of [owner.child.pid, owner.ownerPid, owner.processorPid]) {
        if (pid !== undefined && isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('keeps the processor of a live owner past the orphan idle timeout', () => {
    expect(isProcessAlive(killed.ownerPid!)).toBe(true);
    expect(isProcessAlive(killed.processorPid!)).toBe(true);
  });

  it('reaps the processor after its owner is killed with SIGKILL', async () => {
    process.kill(killed.ownerPid!, 'SIGKILL');
    await waitUntilGone(killed.processorPid!, 'processor');
  });

  it('reaps the processor after its owner dies of an unhandled SIGTERM', async () => {
    process.kill(terminated.ownerPid!, 'SIGTERM');
    await waitUntilGone(terminated.processorPid!, 'processor');
  });

  it('reaps the processor after its owner calls process.exit, as jest --forceExit does', async () => {
    exited.child.stdin!.write('exit\n');
    await waitUntilGone(exited.ownerPid!, 'owner');
    await waitUntilGone(exited.processorPid!, 'processor');
  });
});

function statusForOrigin(port: number, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get({host: '127.0.0.1', port, path: '/status', headers: {Origin: origin}, agent: false}, response => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
  });
}

describe('a server that is not owner-bound', () => {
  it('accepts every configured CORS origin, not only the last', async () => {
    const port = Array.from({length: 10}, (_, index) => PORT_BASE + 30 + index).find(canBindLoopbackPort);
    if (port === undefined) throw new Error('no free loopback port');
    const origins = ['http://localhost:47000', 'http://127.0.0.1:47000'];
    // The launch Windows and a PID 1 backend get, on the pinned binary.
    const launch = buildTraceProcessorHttpServerLaunch({
      binaryPath: getTraceProcessorPath(), port, tracePath: FIXTURE, corsOrigins: origins.join(','), platform: 'win32',
    });
    expect(launch.ownerBound).toBe(false);
    const server = spawn(getTraceProcessorPath(), launch.args, {stdio: 'ignore'});
    try {
      await waitForCondition(
        () => statusForOrigin(port, origins[0]).then(() => true, () => false),
        {timeoutMs: 30_000, intervalMs: 100, timeoutMessage: 'server did not listen'},
      );
      for (const origin of origins) {
        expect(await statusForOrigin(port, origin)).toBe(200);
      }
      expect(await statusForOrigin(port, 'http://unlisted.example')).toBe(403);
    } finally {
      server.kill('SIGKILL');
    }
  });
});
