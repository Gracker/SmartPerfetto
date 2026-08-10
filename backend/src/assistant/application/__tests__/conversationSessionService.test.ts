// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import {
  ConversationSessionService,
  type ConversationRuntimeAdapter,
  type ConversationRuntimeInput,
  type ConversationRuntimeOutcome,
} from '../conversationSessionService';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return {promise, resolve};
}

function createService(adapter: ConversationRuntimeAdapter) {
  let sequence = 0;
  return new ConversationSessionService({
    createRuntime: () => adapter,
    createId: (prefix) => `${prefix}-${++sequence}`,
    now: () => 1_777_000_000_000 + sequence,
  });
}

describe('ConversationSessionService', () => {
  it('requires a new session when a trace is attached after a no-Trace turn', async () => {
    const inputs: ConversationRuntimeInput[] = [];
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (
        input: ConversationRuntimeInput,
      ): Promise<ConversationRuntimeOutcome> => {
        inputs.push(input);
        return {kind: 'answered', message: `answer-${inputs.length}`};
      }),
      cancel: jest.fn(async () => undefined),
    };
    const service = createService(adapter);

    const first = service.startTurn({query: 'Discuss the requirement'});
    await first.completion;
    expect(() => service.startTurn({
      sessionId: first.sessionId,
      query: 'Now inspect this trace',
      traceContext: {kind: 'attached', traceId: 'trace-a'},
    })).toThrow('Start a new conversation after changing the attached Trace');

    expect(inputs[0].traceContext).toEqual({kind: 'none'});
    expect(inputs).toHaveLength(1);
  });

  it('requires a new session when an attached Trace changes', async () => {
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (): Promise<ConversationRuntimeOutcome> => ({
        kind: 'answered',
        message: 'answer',
      })),
      cancel: jest.fn(async () => undefined),
    };
    const service = createService(adapter);
    const first = service.startTurn({
      query: 'Inspect trace A',
      traceContext: {kind: 'attached', traceId: 'trace-a'},
    });
    await first.completion;

    expect(() => service.startTurn({
      sessionId: first.sessionId,
      query: 'Switch to trace B',
      traceContext: {kind: 'attached', traceId: 'trace-b'},
    })).toThrow('Start a new conversation after changing the attached Trace');
    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  it('forwards the latest selection context independently for every turn', async () => {
    const inputs: ConversationRuntimeInput[] = [];
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (
        input: ConversationRuntimeInput,
      ): Promise<ConversationRuntimeOutcome> => {
        inputs.push(input);
        return {kind: 'answered', message: `answer-${inputs.length}`};
      }),
      cancel: jest.fn(async () => undefined),
    };
    const service = createService(adapter);
    const firstSelection = {
      kind: 'track_event' as const,
      source: 'track_event_selection' as const,
      trackUri: '/process_1/thread_2',
      eventId: 42,
      ts: 1000,
      dur: 250,
      name: 'monitor contention',
      processName: 'com.example.app',
    };
    const secondSelection = {
      kind: 'area' as const,
      source: 'area_selection' as const,
      startNs: 2000,
      endNs: 5000,
      durationNs: 3000,
      tracks: [],
      trackCount: 0,
    };

    const first = service.startTurn({
      query: 'Analyze the selected slice',
      runtimeOptions: {selectionContext: firstSelection},
    });
    await first.completion;
    const second = service.startTurn({
      sessionId: first.sessionId,
      query: 'Now analyze this area',
      runtimeOptions: {selectionContext: secondSelection},
    });
    await second.completion;
    const third = service.startTurn({
      sessionId: first.sessionId,
      query: 'Continue without a selection',
    });
    await third.completion;

    expect(inputs[0].selectionContext).toEqual(firstSelection);
    expect(inputs[1].selectionContext).toEqual(secondSelection);
    expect(inputs[2].selectionContext).toBeUndefined();
  });

  it('physically ends a clarification run and resumes the same session next turn', async () => {
    const inputs: ConversationRuntimeInput[] = [];
    const outcomes: ConversationRuntimeOutcome[] = [
      {
        kind: 'needs_user_input',
        message: 'I need one detail before continuing.',
        question: 'Which process should I focus on?',
      },
      {kind: 'answered', message: 'Continuing with com.example.app.'},
    ];
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (
        input: ConversationRuntimeInput,
      ): Promise<ConversationRuntimeOutcome> => {
        inputs.push(input);
        return outcomes.shift()!;
      }),
      cancel: jest.fn(async () => undefined),
    };
    const service = createService(adapter);

    const first = service.startTurn({query: 'Why is it slow?'});
    await first.completion;
    expect(service.getSession(first.sessionId)).toMatchObject({
      status: 'awaiting_user',
      activeRun: undefined,
      pendingQuestion: 'Which process should I focus on?',
    });

    const followUp = service.startTurn({
      sessionId: first.sessionId,
      query: 'Use com.example.app',
    });
    await followUp.completion;

    expect(inputs[1].history[inputs[1].history.length - 1]).toEqual({
      role: 'assistant',
      content: 'I need one detail before continuing.',
    });
    expect(service.getSession(first.sessionId)?.status).toBe('completed');
  });

  it('steers by awaiting cancellation before starting the replacement run', async () => {
    const firstRun = deferred<ConversationRuntimeOutcome>();
    const events: string[] = [];
    let runCount = 0;
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (
        input: ConversationRuntimeInput,
      ): Promise<ConversationRuntimeOutcome> => {
        runCount++;
        events.push(`run:${input.query}`);
        if (runCount === 1) return firstRun.promise;
        return {kind: 'answered', message: 'steered answer'};
      }),
      cancel: jest.fn(async (_sessionId: string, runId: string) => {
        events.push(`cancel:${runId}`);
        firstRun.resolve({
          kind: 'cancelled',
          message: 'Stopped for user steering.',
          evidence: [{id: 'evidence-before-steer', label: 'Retained fact'}],
        });
      }),
    };
    const service = createService(adapter);

    const first = service.startTurn({query: 'Explore everything'});
    const replacement = await service.steer({
      sessionId: first.sessionId,
      query: 'Only inspect startup',
    });
    await replacement.completion;

    expect(events).toEqual([
      'run:Explore everything',
      `cancel:${first.runId}`,
      'run:Only inspect startup',
    ]);
    expect(service.getSession(first.sessionId)?.evidence).toContainEqual({
      id: 'evidence-before-steer',
      label: 'Retained fact',
    });
  });

  it('stores a structured full-analysis handoff without auto-upgrading', async () => {
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (): Promise<ConversationRuntimeOutcome> => ({
        kind: 'recommend_full',
        message: 'This needs a full causal analysis.',
        handoff: {
          question: 'Why are frames janky?',
          scope: 'selected scroll gesture',
          assumptions: ['com.example.app is the target'],
          evidence: [{id: 'trace:e1', label: 'FrameTimeline spike'}],
        },
      })),
      cancel: jest.fn(async () => undefined),
    };
    const service = createService(adapter);

    const receipt = service.startTurn({query: 'Find the complete root cause'});
    await receipt.completion;

    expect(service.getSession(receipt.sessionId)).toMatchObject({
      status: 'completed',
      recommendedFullAnalysis: true,
    });
    expect(service.buildFullAnalysisHandoff(receipt.sessionId)).toEqual({
      question: 'Why are frames janky?',
      scope: 'selected scroll gesture',
      assumptions: ['com.example.app is the target'],
      evidence: [{id: 'trace:e1', label: 'FrameTimeline spike'}],
    });
  });

  it('reserves before runtime work, settles once, and retains ordered replay events', async () => {
    const order: string[] = [];
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (
        input: ConversationRuntimeInput,
      ): Promise<ConversationRuntimeOutcome> => {
        order.push('runtime');
        input.onUpdate?.({type: 'progress'});
        return {kind: 'answered', message: 'done'};
      }),
      cancel: jest.fn(async () => undefined),
    };
    let sequence = 0;
    const service = new ConversationSessionService({
      createRuntime: () => adapter,
      createId: (prefix) => `${prefix}-${++sequence}`,
      onRunStarted: () => order.push('reserved'),
      onRunSettled: () => order.push('settled'),
    });

    const receipt = service.startTurn({query: 'question'});
    await receipt.completion;

    expect(order).toEqual(['reserved', 'runtime', 'settled']);
    const events = service.getSession(receipt.sessionId)?.runs[0].events ?? [];
    expect(events.map(event => event.type)).toEqual([
      'run_started',
      'runtime_update',
      'run_completed',
    ]);
    expect(events.map(event => event.seqId)).toEqual([1, 2, 3]);
  });

  it('does not start model work when run reservation fails', () => {
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (): Promise<ConversationRuntimeOutcome> => ({
        kind: 'answered',
        message: 'unexpected',
      })),
      cancel: jest.fn(async () => undefined),
    };
    const service = new ConversationSessionService({
      createRuntime: () => adapter,
      onRunStarted: () => {
        throw new Error('reservation failed');
      },
    });

    expect(() => service.startTurn({query: 'question'})).toThrow('reservation failed');
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it('preserves the prior handoff state when a follow-up reservation fails', async () => {
    const handoff = {
      question: 'Inspect the trace?',
      scope: 'startup',
      assumptions: [],
      evidence: [],
    };
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (): Promise<ConversationRuntimeOutcome> => ({
        kind: 'recommend_full',
        message: 'A trace is required.',
        handoff,
      })),
      cancel: jest.fn(async () => undefined),
    };
    let reservations = 0;
    const service = new ConversationSessionService({
      createRuntime: () => adapter,
      onRunStarted: () => {
        reservations += 1;
        if (reservations > 1) throw new Error('reservation failed');
      },
    });

    const first = service.startTurn({query: 'Find the startup bottleneck'});
    await first.completion;
    expect(() => service.startTurn({
      sessionId: first.sessionId,
      query: 'Continue',
    })).toThrow('reservation failed');

    const session = service.getSession(first.sessionId);
    expect(session?.status).toBe('completed');
    expect(session?.recommendedFullAnalysis).toBe(true);
    expect(session?.fullAnalysisHandoff).toEqual(handoff);
  });

  it('cancels and disposes abandoned non-terminal sessions during cleanup', async () => {
    const pending = deferred<ConversationRuntimeOutcome>();
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async () => pending.promise),
      cancel: jest.fn(async () => undefined),
      dispose: jest.fn(async () => undefined),
    };
    let now = 100;
    const service = new ConversationSessionService({
      createRuntime: () => adapter,
      now: () => now,
    });
    const receipt = service.startTurn({query: 'question'});
    now = 10_000;

    expect(service.cleanupIdleSessions({
      terminalMaxIdleMs: 1_000,
      nonTerminalMaxIdleMs: 1_000,
      now,
    })).toEqual([receipt.sessionId]);
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.cancel).toHaveBeenCalledWith(receipt.sessionId, receipt.runId);
    expect(adapter.dispose).toHaveBeenCalled();
    expect(service.getSession(receipt.sessionId)).toBeUndefined();
    pending.resolve({kind: 'cancelled', message: ''});
    await receipt.completion;
  });

  it('disposes an abandoned awaiting-user session after the non-terminal idle window', async () => {
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (): Promise<ConversationRuntimeOutcome> => ({
        kind: 'needs_user_input',
        message: 'I need one detail before continuing.',
        question: 'Which process should I inspect?',
      })),
      cancel: jest.fn(async () => undefined),
      dispose: jest.fn(async () => undefined),
    };
    let now = 100;
    const service = new ConversationSessionService({
      createRuntime: () => adapter,
      now: () => now,
    });
    const receipt = service.startTurn({query: 'question'});
    await receipt.completion;
    expect(service.getSession(receipt.sessionId)?.status).toBe('awaiting_user');
    now = 10_000;

    expect(service.cleanupIdleSessions({
      terminalMaxIdleMs: 60_000,
      nonTerminalMaxIdleMs: 1_000,
      now,
    })).toEqual([receipt.sessionId]);
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalled();
    expect(service.getSession(receipt.sessionId)).toBeUndefined();
  });
});
