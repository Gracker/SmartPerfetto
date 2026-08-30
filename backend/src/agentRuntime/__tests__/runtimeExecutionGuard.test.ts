// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { RuntimeExecutionGuard } from '../runtimeExecutionGuard';

describe('RuntimeExecutionGuard', () => {
  it('rejects a duplicate canonical execution key while the first lease is active', () => {
    const guard = new RuntimeExecutionGuard();
    const key = {
      runtime: 'claude-agent-sdk' as const,
      sessionId: 'session-1',
      referenceTraceId: 'reference-1',
      runId: 'run-1',
    };

    const lease = guard.begin(key);

    expect(() => guard.begin({ ...key })).toThrow(/already in progress/i);
    lease.settle();
  });

  it('uses reference trace and run ids as diagnostics, not ownership partitions', () => {
    const guard = new RuntimeExecutionGuard();

    const claudeLease = guard.begin({
      runtime: 'claude-agent-sdk',
      sessionId: 'session-1',
      referenceTraceId: 'reference-1',
      runId: 'run-1',
    });
    const openAiLease = guard.begin({
      runtime: 'openai-agents-sdk',
      sessionId: 'session-1',
      referenceTraceId: 'reference-1',
      runId: 'run-1',
    });

    expect(() => guard.begin({
      runtime: 'claude-agent-sdk',
      sessionId: 'session-1',
      referenceTraceId: 'reference-2',
      runId: 'run-1',
    })).toThrow(/already in progress/i);
    expect(() => guard.begin({
      runtime: 'claude-agent-sdk',
      sessionId: 'session-1',
      referenceTraceId: 'reference-1',
      runId: 'run-2',
    })).toThrow(/already in progress/i);

    expect(claudeLease.signal.aborted).toBe(false);
    expect(openAiLease.signal.aborted).toBe(false);
  });

  it('keeps different sessions independent for the same runtime', () => {
    const guard = new RuntimeExecutionGuard();
    const first = guard.begin({ runtime: 'qoder-agent-sdk', sessionId: 'session-1' });
    const second = guard.begin({ runtime: 'qoder-agent-sdk', sessionId: 'session-2' });

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it('fans out session abort to every active key for that logical session', async () => {
    const guard = new RuntimeExecutionGuard();
    const first = guard.begin({ runtime: 'pi-agent-core', sessionId: 'session-1', runId: 'run-1' });
    const second = guard.begin({ runtime: 'opencode', sessionId: 'session-1', runId: 'run-2' });
    const isolated = guard.begin({ runtime: 'qoder-agent-sdk', sessionId: 'session-2', runId: 'run-1' });

    await expect(guard.abortSession('session-1', 'cancelled')).resolves.toBe(2);
    await expect(guard.abortSession('session-1', 'cancelled again')).resolves.toBe(0);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(() => first.throwIfAborted()).toThrow(/aborted|cancelled/i);
    expect(isolated.signal.aborted).toBe(false);
  });

  it('retains aborted ownership until the outer lease settles', async () => {
    const guard = new RuntimeExecutionGuard();
    const key = { runtime: 'pi-agent-core' as const, sessionId: 'session-1' };
    const lease = guard.begin(key);

    await expect(guard.abortSession('session-1')).resolves.toBe(1);
    await expect(guard.abortSession('session-1')).resolves.toBe(0);

    expect(() => guard.begin(key)).toThrow(/already in progress/i);
    lease.settle();
    expect(() => guard.begin(key)).not.toThrow();
  });

  it('allows the same key to be reused after the active lease settles', () => {
    const guard = new RuntimeExecutionGuard();
    const key = { runtime: 'openai-agents-sdk' as const, sessionId: 'session-1' };

    guard.begin(key).settle();
    const next = guard.begin(key);

    expect(next.signal.aborted).toBe(false);
  });

  it('does not let an old lease settle remove a newer token', () => {
    const guard = new RuntimeExecutionGuard();
    const key = { runtime: 'claude-agent-sdk' as const, sessionId: 'session-1' };
    const first = guard.begin(key);

    first.settle();
    const second = guard.begin(key);
    first.settle();

    expect(() => guard.begin(key)).toThrow(/already in progress/i);
    second.settle();
  });

  it('clears active leases by signalling without releasing ownership before settle', () => {
    const guard = new RuntimeExecutionGuard();
    const first = guard.begin({ runtime: 'claude-agent-sdk', sessionId: 'session-1' });
    const second = guard.begin({ runtime: 'openai-agents-sdk', sessionId: 'session-2' });

    guard.clear();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(() => guard.begin({ runtime: 'claude-agent-sdk', sessionId: 'session-1' })).toThrow(/already in progress/i);
    first.settle();
    expect(() => guard.begin({ runtime: 'claude-agent-sdk', sessionId: 'session-1' })).not.toThrow();
  });
});
