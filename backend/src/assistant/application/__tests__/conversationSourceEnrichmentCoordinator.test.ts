// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  ConversationSourceEnrichmentCoordinator,
  type ConversationSourceEnrichmentOutcome,
} from '../conversationSourceEnrichmentCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {promise, resolve, reject};
}

describe('ConversationSourceEnrichmentCoordinator', () => {
  it('publishes an independent completed lifecycle', async () => {
    const events: unknown[] = [];
    let now = 100;
    const coordinator = new ConversationSourceEnrichmentCoordinator({
      now: () => now,
      onEvent: event => events.push(event),
    });
    const completion = deferred<ConversationSourceEnrichmentOutcome>();

    const state = coordinator.start({
      sessionId: 'conversation-1',
      runId: 'run-1',
      execute: () => completion.promise,
      cancel: async () => undefined,
    });
    expect(state.status).toBe('running');
    expect(events).toEqual([expect.objectContaining({
      type: 'source_enrichment_started',
      runId: 'run-1',
    })]);

    now = 140;
    completion.resolve({
      message: '源码补充',
      evidence: [{id: 'source-1', label: 'Foo.kt:L10-L12'}],
      metrics: {searchCalls: 1, readCalls: 2, durationMs: 40},
    });
    await state.completion;

    expect(coordinator.get('run-1')).toMatchObject({
      status: 'completed',
      completedAt: 140,
      message: '源码补充',
      metrics: {searchCalls: 1, readCalls: 2, durationMs: 40},
    });
    expect(events[events.length - 1]).toEqual(expect.objectContaining({
      type: 'source_enrichment_completed',
      runId: 'run-1',
    }));
    coordinator.remove('run-1');
    expect(coordinator.get('run-1')).toBeUndefined();
  });

  it('marks cancellation immediately and ignores a late completion', async () => {
    const events: unknown[] = [];
    const cancel = jest.fn(async () => undefined);
    const completion = deferred<ConversationSourceEnrichmentOutcome>();
    const coordinator = new ConversationSourceEnrichmentCoordinator({
      onEvent: event => events.push(event),
    });
    const state = coordinator.start({
      sessionId: 'conversation-1',
      runId: 'run-1',
      execute: () => completion.promise,
      cancel,
    });

    await coordinator.cancel('run-1');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(coordinator.get('run-1')?.status).toBe('cancelled');
    expect(events[events.length - 1]).toEqual(expect.objectContaining({
      type: 'source_enrichment_cancelled',
    }));

    completion.resolve({
      message: 'LATE_SOURCE_CANARY',
      evidence: [],
      metrics: {searchCalls: 1, readCalls: 0, durationMs: 1},
    });
    await state.completion;
    expect(coordinator.get('run-1')).not.toHaveProperty('message', 'LATE_SOURCE_CANARY');
    expect(events.filter((event: any) => event.type === 'source_enrichment_completed')).toHaveLength(0);
  });

  it('projects execution failures to a safe terminal code', async () => {
    const events: unknown[] = [];
    const coordinator = new ConversationSourceEnrichmentCoordinator({
      onEvent: event => events.push(event),
    });
    const state = coordinator.start({
      sessionId: 'conversation-1',
      runId: 'run-1',
      execute: async () => {
        throw new Error('PRIVATE_SOURCE_FAILURE_CANARY');
      },
      cancel: async () => undefined,
    });

    await state.completion;
    expect(coordinator.get('run-1')).toMatchObject({
      status: 'failed',
      errorCode: 'source_enrichment_failed',
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_SOURCE_FAILURE_CANARY');
  });
});
