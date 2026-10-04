// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import {getDefaultCodebaseRegistry, resetDefaultCodebaseRegistryForTests} from '../../services/codebase/defaultCodebaseServices';
import {StoreUnreadableError} from '../../utils/storedData';
import {RuntimeExecutionGuard} from '../runtimeExecutionGuard';
import {createRuntimeRunAuthorization, throwIfRunAuthorizationRevoked} from '../runAuthorizationFence';

const PRIVATE = {codeAwareMode: 'provider_send' as const, codebaseIds: ['cb-private']};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
let runs = 0;
function run(options: Record<string, unknown> = PRIVATE, stopNative = jest.fn<() => void | Promise<unknown>>()) {
  const lease = new RuntimeExecutionGuard().begin({runtime: 'claude-agent-sdk', sessionId: `s-${++runs}`});
  return {lease, stopNative, ...createRuntimeRunAuthorization({options: options as any, executionLease: lease, stopNative})};
}
const revokeAll = () => jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization')
  .mockImplementation(() => { throw new contextAuthorization.AnalysisContextAuthorizationChangedError(); });

describe('run authorization fence', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('is a no-op for a run without private context', () => {
    const read = revokeAll();
    const {fence, lease} = run({});
    expect(fence.enforced).toBe(false);
    expect(() => fence.assertCurrent()).not.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(lease.signal.aborted).toBe(false);
  });

  it('ends only its own run once on a revoke, and every later check throws without reading again', () => {
    const {fence, lease, stopNative} = run();
    const read = revokeAll();
    let first: unknown;
    try { fence.assertCurrent(); } catch (error) { first = error; }
    expect(first).toBeInstanceOf(contextAuthorization.AnalysisContextAuthorizationChangedError);
    expect(lease.signal.reason).toBe(first);
    expect(stopNative).toHaveBeenCalledTimes(1);
    expect(() => fence.assertCurrent()).toThrow(first as Error);
    expect(() => fence.revoke()).toThrow(first as Error);
    expect(stopNative).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(() => throwIfRunAuthorizationRevoked(lease.signal)).toThrow(first as Error);
  });

  it('reads afresh at every dispatch; tool-boundary checks share one read within an event-loop turn', async () => {
    const {fence} = run();
    const read = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => undefined);
    fence.assertCurrent();
    fence.assertCurrent();
    expect(read).toHaveBeenCalledTimes(2);
    fence.assertCurrentInTurn();
    fence.assertCurrentInTurn();
    expect(read).toHaveBeenCalledTimes(2);
    await nextTurn();
    fence.assertCurrentInTurn();
    fence.assertCurrentInTurn();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('refuses one dispatch for an unreadable store without ending the run', async () => {
    const {fence, lease, stopNative} = run();
    const read = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization')
      .mockImplementationOnce(() => { throw new StoreUnreadableError('codebase registry'); })
      .mockImplementation(() => undefined);
    expect(() => fence.assertCurrent()).toThrow(StoreUnreadableError);
    expect(lease.signal.aborted).toBe(false);
    expect(stopNative).not.toHaveBeenCalled();
    expect(() => fence.assertCurrent()).not.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a revoke another reader saw ends the run the same way', () => {
    const {fence, lease, stopNative} = run();
    expect(() => fence.revoke()).toThrow('analysis_context_changed_restart_required');
    expect(lease.signal.aborted).toBe(true);
    expect(stopNative).toHaveBeenCalledTimes(1);
  });

  it('settles only after the native stop it started has finished', async () => {
    let finish!: () => void;
    const stopped = new Promise<void>(resolve => { finish = resolve; });
    const {fence} = run(PRIVATE, jest.fn(() => stopped));
    revokeAll();
    expect(() => fence.assertCurrent()).toThrow('analysis_context_changed_restart_required');
    let settled = false;
    const waiting = fence.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await waiting;
    expect(settled).toBe(true);
  });

  it('after its lease settled, a revoke only refuses: it stops nothing', () => {
    const {fence, lease, stopNative} = run();
    lease.settle();
    revokeAll();
    expect(() => fence.assertCurrent()).toThrow('analysis_context_changed_restart_required');
    expect(lease.signal.aborted).toBe(false);
    expect(stopNative).not.toHaveBeenCalled();
  });

  describe('against the real codebase registry file', () => {
    let directory: string;
    let previousLogDir: string | undefined;
    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'run-authorization-fence-'));
      previousLogDir = process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
      process.env.SMARTPERFETTO_BACKEND_LOG_DIR = directory;
      resetDefaultCodebaseRegistryForTests();
    });
    afterEach(() => {
      if (previousLogDir === undefined) delete process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
      else process.env.SMARTPERFETTO_BACKEND_LOG_DIR = previousLogDir;
      resetDefaultCodebaseRegistryForTests();
      fs.rmSync(directory, {recursive: true, force: true});
    });

    it('a tool-boundary check sees an in-process revoke made in the same event-loop turn', () => {
      const root = fs.mkdtempSync(path.join(directory, 'root-'));
      const registry = getDefaultCodebaseRegistry();
      const ref = registry.register({kind: 'app_source', displayName: 'App', rootPath: root, sendToProvider: true});
      const {fence, lease} = run({codeAwareMode: 'provider_send', codebaseIds: [ref.codebaseId]});
      fence.assertCurrentInTurn();
      // An HTTP request handled in this same turn withdraws consent.
      registry.setProviderConsent(ref.codebaseId, {}, false, 'owner');
      expect(() => fence.assertCurrentInTurn()).toThrow('analysis_context_changed_restart_required');
      expect(lease.signal.aborted).toBe(true);
    });

    it('refuses the dispatch while the file is unreadable, proceeds once it is readable, and ends the run on a real revoke', async () => {
      const root = fs.mkdtempSync(path.join(directory, 'root-'));
      const registry = getDefaultCodebaseRegistry();
      const ref = registry.register({kind: 'app_source', displayName: 'App', rootPath: root, sendToProvider: true});
      const registryFile = path.join(directory, 'codebase_registry.json');
      const readable = fs.readFileSync(registryFile, 'utf8');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const {fence, lease, stopNative} = run({codeAwareMode: 'provider_send', codebaseIds: [ref.codebaseId]});
      expect(() => fence.assertCurrent()).not.toThrow();

      await nextTurn();
      fs.writeFileSync(registryFile, '{"schemaVersion": 2, "codebases": [');
      let refused: unknown;
      try { fence.assertCurrent(); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(StoreUnreadableError);
      expect(String((refused as Error).message)).not.toContain('codebases');
      expect(lease.signal.aborted).toBe(false);
      expect(stopNative).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();

      await nextTurn();
      fs.writeFileSync(registryFile, readable);
      expect(() => fence.assertCurrent()).not.toThrow();

      await nextTurn();
      registry.setProviderConsent(ref.codebaseId, {}, false, 'owner');
      expect(() => fence.assertCurrent()).toThrow('analysis_context_changed_restart_required');
      expect(lease.signal.aborted).toBe(true);
      expect(stopNative).toHaveBeenCalledTimes(1);
    });
  });
});
