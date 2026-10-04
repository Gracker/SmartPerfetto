// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import * as authorization from '../../../services/resolvedAnalysisContext';
import type {AnalysisResult} from '../../../agent/core/orchestratorTypes';
import {toAnalysisHistoryTurn} from '../../../agentRuntime/analysisHistory';
import type {ConversationSessionDescriptor} from '../../../services/conversationSessionStore';

import {
  ConversationSessionService as ProductConversationSessionService,
  conversationRuntimeSessionId,
  type ConversationRuntimeAdapter,
  type ConversationRuntimeInput,
  type ConversationRuntimeOutcome,
  type StartConversationTurnInput,
} from '../conversationSessionService';
import {runAnalysisSelection} from '../../../services/effectiveAnalysisSelection';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import {clearAllCodeAwareOutputGuards, revokeCodeAwareOutputGuards} from '../../../services/security/codeAwareOutputRegistry';

/**
 * The product service with the caller's duty done for it: every turn states
 * its authorization fingerprint, computed as the route computes it. A
 * continuing turn keeps its session's unless a test changes it explicitly.
 */
class ConversationSessionService extends ProductConversationSessionService {
  override startTurn(input: Omit<StartConversationTurnInput, 'analysisContextFingerprint'> &
    {analysisContextFingerprint?: string}) {
    const existing = input.sessionId ? this.getSession(input.sessionId) : undefined;
    const analysisContextFingerprint = input.analysisContextFingerprint ??
      input.runtimeOptions?.analysisContextFingerprint ?? existing?.analysisContextFingerprint ??
      authorization.buildAnalysisContextAuthorizationFingerprint(runAnalysisSelection(input.runtimeOptions ?? {}),
        resolveKnowledgeScope(input.owner ?? {}));
    return super.startTurn({...input, analysisContextFingerprint});
  }
}

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
  it('hands the runtime the private-context marker it records for the run', async () => {
    const inputs: ConversationRuntimeInput[] = [];
    const service = createService({
      run: jest.fn(async (input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> => {
        inputs.push(input);
        return {kind: 'answered', message: 'ok'};
      }),
      cancel: jest.fn(async () => undefined),
    });
    await service.startTurn({query: 'Discuss the requirement'}).completion;
    expect(inputs[0].privateContext).toEqual({codebase: false, knowledge: false});
  });

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

  it('applies a requested source depth to its turn and keeps it for later turns', async () => {
    const inputs: ConversationRuntimeInput[] = [];
    const service = createService({
      run: jest.fn(async (input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> => {
        inputs.push(input);
        return {kind: 'answered', message: 'answer'};
      }),
      cancel: jest.fn(async () => undefined),
    });

    const first = service.startTurn({query: 'Locate it', runtimeOptions: {sourceDepth: 'locate'}});
    await first.completion;
    const second = service.startTurn({sessionId: first.sessionId, query: 'Explain the mechanism',
      runtimeOptions: {sourceDepth: 'mechanism'}});
    await second.completion;
    const third = service.startTurn({sessionId: first.sessionId, query: 'Continue'});
    await third.completion;

    expect(inputs.map(input => input.sourceDepth)).toEqual(['locate', 'mechanism', 'mechanism']);
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

    expect(inputs[1].history[inputs[1].history.length - 1]).toMatchObject({
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

  describe('deliver first, verify after', () => {
    /** A run that delivers its answer, then finalizes only when its review is stopped. */
    const reviewingAdapter = (events: string[], options: {ignoreStop?: boolean} = {}) => {
      const reviewed = deferred<ConversationRuntimeOutcome>();
      let runCount = 0;
      const adapter: ConversationRuntimeAdapter = {
        run: jest.fn(async (input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> => {
          runCount++;
          events.push(`run:${input.query}`);
          if (runCount > 1) return {kind: 'answered', message: 'second answer'};
          input.onProvisionalAnswer?.({message: 'first answer'});
          input.reviewStopSignal?.addEventListener('abort', () => {
            events.push('review_stopped');
            // The review ends and finalization completes the same answer with its verdict.
            if (!options.ignoreStop) queueMicrotask(() => reviewed.resolve({kind: 'answered', message: 'first answer'}));
          }, {once: true});
          return reviewed.promise;
        }),
        cancel: jest.fn(async (_sessionId: string, runId: string) => {events.push(`cancel:${runId}`);}),
      };
      return {adapter, reviewed};
    };
    const serviceWith = (adapter: ConversationRuntimeAdapter, extra: Partial<ConstructorParameters<
      typeof ConversationSessionService>[0]> = {}) => {
      let sequence = 0;
      return new ConversationSessionService({createRuntime: () => adapter,
        createId: prefix => `${prefix}-${++sequence}`, reviewStopWatchdogMs: 30, ...extra});
    };
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));

    it('answers the first stop at once, stops only the review and settles the answered turn', async () => {
      const events: string[] = [];
      const {adapter} = reviewingAdapter(events);
      const service = serviceWith(adapter);
      const published: string[] = [];
      const first = service.startTurn({query: 'trace 时长'});
      service.subscribe(first.sessionId, event => published.push(event.type));
      await Promise.resolve();
      const session = service.getSession(first.sessionId)!;
            expect(session.activeRun?.events.map(event => event.type)).toEqual(['run_started', 'provisional_answer']);
      expect(session.activeRun?.events[1]).toMatchObject({message: 'first answer', verification: 'pending'});

      const stopping = service.cancelRun(first.sessionId, first.runId);
      // Non-blocking: the answer to the stop does not wait for the commit.
      await expect(stopping).resolves.toEqual({status: 'review_stop_requested'});
      expect(published).not.toContain('run_completed');
      await first.completion;
      expect(events).toEqual(['run:trace 时长', 'review_stopped']);
      expect(adapter.cancel).not.toHaveBeenCalled();
      expect(published).toContain('run_completed');
      expect(session.runs[0]).toMatchObject({status: 'completed'});
      expect(session.history.map(message => [message.role, message.content])).toEqual([
        ['user', 'trace 时长'], ['assistant', 'first answer']]);
    });

    it('a new turn waits for the provisional run to commit before starting', async () => {
      const events: string[] = [];
      const {adapter} = reviewingAdapter(events);
      const service = serviceWith(adapter);
      const first = service.startTurn({query: 'trace 时长'});
      await Promise.resolve();
      const replacement = await service.steer({sessionId: first.sessionId, query: '应用包名'});
      await replacement.completion;
      expect(events).toEqual(['run:trace 时长', 'review_stopped', 'run:应用包名']);
      expect(adapter.cancel).not.toHaveBeenCalled();
      expect(service.getSession(first.sessionId)!.history.map(message => message.content))
        .toEqual(['trace 时长', 'first answer', '应用包名', 'second answer']);
    });

    it('a second stop forces: it waits for the commit, and the finalized outcome wins', async () => {
      const events: string[] = [];
      const {adapter, reviewed} = reviewingAdapter(events, {ignoreStop: true});
      const service = serviceWith(adapter, {reviewStopWatchdogMs: 5_000});
      const turn = service.startTurn({query: 'trace 时长'});
      await Promise.resolve();
      await expect(service.cancelRun(turn.sessionId, turn.runId)).resolves.toEqual({status: 'review_stop_requested'});
      const forced = service.cancelRun(turn.sessionId, turn.runId);
      // The review finished just before the save: the finalized turn is committed, not a cancel.
      reviewed.resolve({kind: 'answered', message: 'first answer'});
      await expect(forced).resolves.toEqual({status: 'settled', outcome: expect.objectContaining({kind: 'answered'})});
      expect(adapter.cancel).not.toHaveBeenCalled();
      expect(service.getSession(turn.sessionId)!.runs[0].status).toBe('completed');
    });

    it('persists the read body as an unverified partial turn with the run pins when the commit never settles', async () => {
      const events: string[] = [];
      const {adapter, reviewed} = reviewingAdapter(events, {ignoreStop: true});
      const settled: Array<{status: string; turn: unknown}> = [];
      const service = serviceWith(adapter, {onRunSettled: (session, run) => settled.push({status: run.status,
        turn: session.historyTurns.find(turn => turn.id === run.runId)})});
      const published: Array<{type: string; outcome?: unknown}> = [];
      const turn = service.startTurn({query: 'trace 时长'});
      service.subscribe(turn.sessionId, event => published.push(event as never));
      await Promise.resolve();
      await expect(service.cancelRun(turn.sessionId, turn.runId)).resolves.toEqual({status: 'review_stop_requested'});
      await new Promise(resolve => setTimeout(resolve, 60));
      const session = service.getSession(turn.sessionId)!;
      expect(session.activeRun).toBeUndefined();
      const runFingerprint = session.runs[0].analysisContextFingerprint;
      expect(runFingerprint).toEqual(expect.any(String));
      expect(settled).toEqual([{status: 'completed', turn: expect.objectContaining({answer: 'first answer',
        partial: true, completionStatus: 'incomplete', terminationReason: 'review_not_finished',
        analysisContextFingerprint: runFingerprint})}]);
      expect(session.historyTurns[0]).not.toHaveProperty('sourceDerived');
      expect(published.find(event => event.type === 'run_completed')?.outcome).toMatchObject({kind: 'answered',
        message: 'first answer', finalResult: {partial: true, terminationReason: 'review_not_finished',
          claimVerificationResult: {status: 'not_checked', notCheckedReason: 'review_not_finished'}}});
      expect(adapter.cancel).toHaveBeenCalledTimes(1);
      // The runtime's late result is ignored; the partial turn stays the only terminal write.
      reviewed.resolve({kind: 'answered', message: 'first answer'});
      await flush();
      expect(settled).toHaveLength(1);
      expect(session.history.map(message => message.content)).toEqual(['trace 时长', 'first answer']);
    });

    it('bounds a force stop by the watchdog started at the first stop', async () => {
      const {adapter} = reviewingAdapter([], {ignoreStop: true});
      const service = serviceWith(adapter);
      const turn = service.startTurn({query: 'trace 时长'});
      await Promise.resolve();
      await service.cancelRun(turn.sessionId, turn.runId);
      const started = Date.now();
      await expect(service.cancelRun(turn.sessionId, turn.runId)).resolves.toEqual({status: 'settled',
        outcome: expect.objectContaining({kind: 'answered', finalResult: expect.objectContaining({
          terminationReason: 'review_not_finished'})})});
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('a new turn after a hanging review waits one watchdog bound, not a review plus a cancel', async () => {
      const {adapter} = reviewingAdapter([], {ignoreStop: true});
      const service = serviceWith(adapter, {cancelSettleTimeoutMs: 60_000});
      const turn = service.startTurn({query: 'trace 时长'});
      await Promise.resolve();
      const started = Date.now();
      await expect(service.supersedeRun(turn.sessionId, turn.runId)).resolves.toMatchObject({kind: 'answered'});
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(service.getSession(turn.sessionId)!.activeRun).toBeUndefined();
    });

    it('keeps a private-knowledge body live-only: the fallback is a cancel', async () => {
      const {adapter} = reviewingAdapter([], {ignoreStop: true});
      const service = serviceWith(adapter);
      const turn = service.startTurn({query: 'trace 时长',
        runtimeOptions: {knowledgeSourceIds: ['knowledge-a']}});
      await Promise.resolve();
      await service.cancelRun(turn.sessionId, turn.runId);
      await new Promise(resolve => setTimeout(resolve, 60));
      const session = service.getSession(turn.sessionId)!;
      expect(session.runs[0].status).toBe('cancelled');
      expect(session.history.map(message => message.role)).toEqual(['user']);
      expect(session.historyTurns[0]).toMatchObject({answer: '', partial: true});
    });

    it('does not persist the body after authorization was revoked', async () => {
      const {adapter} = reviewingAdapter([], {ignoreStop: true});
      const service = serviceWith(adapter);
      const turn = service.startTurn({query: 'trace 时长'});
      await Promise.resolve();
      await service.cancelRun(turn.sessionId, turn.runId);
      const revoked = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
        throw new authorization.AnalysisContextAuthorizationChangedError();
      });
      try {
        await new Promise(resolve => setTimeout(resolve, 60));
      } finally {revoked.mockRestore();}
      const session = service.getSession(turn.sessionId)!;
      expect(session.runs[0].status).toBe('cancelled');
      expect(session.history.map(message => message.role)).toEqual(['user']);
    });

    it('writes nothing for a run whose session was replaced before the watchdog', async () => {
      const {adapter} = reviewingAdapter([], {ignoreStop: true});
      const settled: string[] = [];
      const service = serviceWith(adapter, {onRunSettled: (_session, run) => settled.push(run.status)});
      const turn = service.startTurn({query: 'trace 时长'});
      await Promise.resolve();
      await service.cancelRun(turn.sessionId, turn.runId);
      service.cleanupIdleSessions({terminalMaxIdleMs: 0, nonTerminalMaxIdleMs: 0, now: Number.MAX_SAFE_INTEGER});
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(settled).toEqual(['cancelled']);
    });

    it('fully cancels before the provisional answer', async () => {
      const first = deferred<ConversationRuntimeOutcome>();
      const adapter: ConversationRuntimeAdapter = {
        run: jest.fn(async () => first.promise),
        cancel: jest.fn(async () => {first.resolve({kind: 'cancelled', message: ''});}),
      };
      const service = createService(adapter);
      const turn = service.startTurn({query: 'trace 时长'});
      await expect(service.cancelRun(turn.sessionId, turn.runId)).resolves.toEqual({status: 'settled',
        outcome: {kind: 'cancelled', message: ''}});
      expect(adapter.cancel).toHaveBeenCalledTimes(1);
      expect(service.getSession(turn.sessionId)!.history.map(message => message.role)).toEqual(['user']);
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

  it('delivers answer drafts live only and never after the provisional answer', async () => {
    const gate = deferred<void>();
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> => {
        await gate.promise;
        input.onAnswerDraft?.({type: 'answer_token', content: {token: 'Draft', runId: input.runId, attempt: 0}});
        input.onAnswerDraft?.({type: 'answer_segment_reset', content: {runId: input.runId, attempt: 1}});
        input.onProvisionalAnswer?.({message: 'Answer'});
        input.onAnswerDraft?.({type: 'answer_token', content: {token: 'LATE_DRAFT', runId: input.runId, attempt: 1}});
        return {kind: 'answered', message: 'Answer'};
      }),
      cancel: jest.fn(async () => undefined),
    };
    const service = createService(adapter);
    const receipt = service.startTurn({query: 'question'});
    const live: unknown[] = [];
    service.subscribe(receipt.sessionId, event => live.push(event));
    gate.resolve();
    await receipt.completion;

    const liveDrafts = live.filter(event => (event as {type: string}).type === 'runtime_update')
      .map(event => (event as {update: unknown}).update);
    expect(liveDrafts).toEqual([
      {type: 'answer_token', content: {token: 'Draft', runId: receipt.runId, attempt: 0}},
      {type: 'answer_segment_reset', content: {runId: receipt.runId, attempt: 1}},
    ]);
    // A reconnect replays only retained events: no draft is among them.
    const retained = service.getSession(receipt.sessionId)?.runs[0].events ?? [];
    expect(retained.map(event => event.type)).toEqual(['run_started', 'provisional_answer', 'run_completed']);
    expect(JSON.stringify(retained)).not.toContain('Draft');
  });

  it('settles a run with run_completed that carries only the outcome', async () => {
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn(async (): Promise<ConversationRuntimeOutcome> => ({kind: 'answered', message: 'Primary trace answer'})),
      cancel: jest.fn(async () => undefined),
    };
    const service = createService(adapter);
    const receipt = service.startTurn({query: 'Why is startup slow?', traceContext: {kind: 'attached', traceId: 'trace-1'},
      runtimeOptions: {codeAwareMode: 'provider_send', codebaseIds: ['private-app']}});
    await receipt.completion;
    const completed = service.getSession(receipt.sessionId)!.runs[0].events.find(event => event.type === 'run_completed');
    // Clients read run_completed as the end of the run; no pending follow-up is announced.
    expect(completed).toEqual({type: 'run_completed', sessionId: receipt.sessionId, runId: receipt.runId,
      outcome: {kind: 'answered', message: 'Primary trace answer'}, seqId: expect.any(Number)});
    // A completed run cannot be cancelled again.
    await expect(service.cancelRun(receipt.sessionId, receipt.runId)).rejects.toMatchObject({
      code: 'CONVERSATION_RUN_NOT_ACTIVE'});
  });

  it('marks history from runs with private context', async () => {
    const authorizationCheck = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization')
      .mockImplementation(() => undefined);
    try {
      let turn = 0;
      const inputs: ConversationRuntimeInput[] = [];
      const adapter: ConversationRuntimeAdapter = {
        run: jest.fn(async (input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome> => {
          inputs.push(input);
          turn += 1;
          return {kind: 'answered', message: turn === 1 ? 'source answer' : turn === 2 ? 'trace answer' : 'next answer'};
        }),
        cancel: jest.fn(async () => undefined),
      };
      const service = createService(adapter);
      // A session authorized to read source makes every run in it private.
      const first = service.startTurn({query: '看看源码里的 Foo::bar',
        runtimeOptions: {codeAwareMode: 'provider_send', codebaseIds: ['app']}});
      await first.completion;
      const second = service.startTurn({sessionId: first.sessionId, query: '分析启动'});
      await second.completion;
      const third = service.startTurn({sessionId: first.sessionId, query: '继续'});
      await third.completion;

      expect(inputs[1].history).toEqual(expect.arrayContaining([
        expect.objectContaining({content: 'source answer', sourceDerived: true}),
      ]));
      expect(service.getSession(first.sessionId)!.historyTurns[0].analysisContextFingerprint).toBe(
        service.getSession(first.sessionId)!.analysisContextFingerprint);
      expect(service.getSession(first.sessionId)!.historyTurns[0].analysisContextFingerprint).toBeTruthy();
      expect(inputs[2].history).toEqual(expect.arrayContaining([
        expect.objectContaining({content: 'trace answer', sourceDerived: true}),
      ]));
    } finally {authorizationCheck.mockRestore();}
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
  it('withdraws delivery permission synchronously when cancellation wins after runtime return but before commit', async () => {
    let runtimeInput!: ConversationRuntimeInput;
    const settled = jest.fn();
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn<ConversationRuntimeAdapter['run']>(input => {runtimeInput = input; return Promise.resolve({kind: 'answered', message: 'STALE_ANSWER'});}),
      cancel: jest.fn(async () => {runtimeInput.onUpdate?.({message: 'STALE_UPDATE'});}),
    };
    const service = new ConversationSessionService({createRuntime: () => adapter, onRunSettled: settled});
    const receipt = service.startTurn({query: 'question'});
    await service.cancelRun(receipt.sessionId, receipt.runId);
    await expect(receipt.completion).resolves.toEqual({kind: 'cancelled', message: ''});
    const session = service.getSession(receipt.sessionId)!;
    expect(session.status).toBe('cancelled');
    expect(session.history.some(message => message.content === 'STALE_ANSWER')).toBe(false);
    expect(session.runs[0].events.filter(event => event.type === 'run_completed')).toHaveLength(1);
    expect(JSON.stringify(session.runs[0].events)).not.toContain('STALE_UPDATE');
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'error'] as const)('isolates late %s and updates after cancellation timeout from the next active run', async terminal => {
    jest.useFakeTimers();
    let resolveOld!: (outcome: ConversationRuntimeOutcome) => void;
    let rejectOld!: (error: Error) => void;
    const old = new Promise<ConversationRuntimeOutcome>((resolve, reject) => {resolveOld = resolve; rejectOld = reject;});
    const next = deferred<ConversationRuntimeOutcome>();
    const inputs: ConversationRuntimeInput[] = [];
    const settled = jest.fn();
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn<ConversationRuntimeAdapter['run']>(input => {inputs.push(input); return inputs.length === 1 ? old : next.promise;}),
      cancel: jest.fn(() => new Promise<void>(() => {})),
    };
    const service = new ConversationSessionService({createRuntime: () => adapter, cancelSettleTimeoutMs: 5, onRunSettled: settled});
    try {
      const first = service.startTurn({query: 'old question'});
      const cancellation = expect(service.cancelRun(first.sessionId, first.runId)).rejects.toThrow('did not settle');
      await jest.advanceTimersByTimeAsync(6);
      await cancellation;
      const session = service.getSession(first.sessionId)!;
      expect(session.status).toBe('cancelled');
      expect(session.activeRun).toBeUndefined();
      const priorEvents = session.runs[0].events.length;
      const second = service.startTurn({sessionId: first.sessionId, query: 'new question'});
      const active = session.activeRun;
      if (terminal === 'success') resolveOld({kind: 'answered', message: 'LATE_OLD_ANSWER'});
      else rejectOld(new Error('LATE_OLD_ERROR'));
      inputs[0].onUpdate?.({message: 'LATE_OLD_UPDATE'});
      await expect(first.completion).resolves.toEqual({kind: 'cancelled', message: ''});
      expect(session.activeRun).toBe(active);
      expect(session.status).toBe('running');
      expect(session.error).toBeUndefined();
      expect(session.runs[0].outcome).toEqual({kind: 'cancelled', message: ''});
      expect(session.runs[0].events).toHaveLength(priorEvents);
      expect(JSON.stringify(session.history)).not.toContain('LATE_OLD');
      next.resolve({kind: 'answered', message: 'new answer'});
      await second.completion;
      expect(settled).toHaveBeenCalledTimes(2);
    } finally {jest.useRealTimers();}
  });

  it('does not start runtime work after a reservation hook removes the session', async () => {
    const adapter: ConversationRuntimeAdapter = {run: jest.fn<ConversationRuntimeAdapter['run']>(async () => ({kind: 'answered', message: 'unexpected'})),
      cancel: jest.fn(async () => undefined), dispose: jest.fn(async () => undefined)};
    const settled = jest.fn();
    let service!: ConversationSessionService;
    service = new ConversationSessionService({createRuntime: () => adapter, now: () => 100,
      onRunStarted: () => {service.cleanupIdleSessions({terminalMaxIdleMs: 1, nonTerminalMaxIdleMs: 1, now: 1000});},
      onRunSettled: settled});
    const receipt = service.startTurn({query: 'question'});
    await expect(receipt.completion).resolves.toEqual({kind: 'cancelled', message: ''});
    expect(service.getSession(receipt.sessionId)).toBeUndefined();
    expect(adapter.run).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a new runtime after a run_started listener cancels it', async () => {
    const adapter: ConversationRuntimeAdapter = {run: jest.fn<ConversationRuntimeAdapter['run']>(async () => ({kind: 'answered', message: 'answer'})),
      cancel: jest.fn(async () => undefined)};
    const service = createService(adapter);
    const first = service.startTurn({query: 'first'});
    await first.completion;
    service.subscribe(first.sessionId, event => {
      if (event.type === 'run_started') void service.cancelRun(event.sessionId, event.runId).catch(() => undefined);
    });
    const next = service.startTurn({sessionId: first.sessionId, query: 'cancel before execution'});
    await expect(next.completion).resolves.toEqual({kind: 'cancelled', message: ''});
    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  it('does not publish an old completion after a settlement hook starts the next run', async () => {
    const next = deferred<ConversationRuntimeOutcome>();
    let calls = 0;
    const adapter: ConversationRuntimeAdapter = {
      run: jest.fn<ConversationRuntimeAdapter['run']>(() => ++calls === 1 ? Promise.resolve({kind: 'answered', message: 'first answer'}) : next.promise),
      cancel: jest.fn(async () => undefined),
    };
    let service!: ConversationSessionService;
    let replacement: ReturnType<ConversationSessionService['startTurn']> | undefined;
    service = new ConversationSessionService({createRuntime: () => adapter,
      onRunSettled: session => {if (!replacement) replacement = service.startTurn({sessionId: session.sessionId, query: 'next'});}});
    const first = service.startTurn({query: 'first'});
    await first.completion;
    const session = service.getSession(first.sessionId)!;
    expect(session.activeRun?.runId).toBe(replacement?.runId);
    expect(session.runs[0].events.some(event => event.type === 'run_completed')).toBe(false);
    next.resolve({kind: 'answered', message: 'next answer'});
    await replacement!.completion;
  });

  it('preserves finalResult through actual session state and the completed event', async () => {
    const finalResult: AnalysisResult = {sessionId: 'runtime', success: true, partial: true, findings: [], hypotheses: [],
      conclusion: '  Final body.\r\n', confidence: 0.5, rounds: 1, totalDurationMs: 1,
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'partial', policy: 'record_only', passed: false,
        checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [], issues: []}};
    const adapter: ConversationRuntimeAdapter = {run: jest.fn<ConversationRuntimeAdapter['run']>(async () => ({kind: 'answered', message: finalResult.conclusion, finalResult})),
      cancel: jest.fn(async () => undefined)};
    const service = createService(adapter);
    const receipt = service.startTurn({query: 'question'});
    const outcome = await receipt.completion;
    const session = service.getSession(receipt.sessionId)!;
    expect(outcome.finalResult).toBe(finalResult);
    expect(session.runs[0].outcome?.finalResult).toBe(finalResult);
    expect(session.history[session.history.length - 1]?.content).toBe(finalResult.conclusion);
    expect(session.runs[0].events).toContainEqual(expect.objectContaining({type: 'run_completed', outcome: {kind: 'answered',
      message: finalResult.conclusion, finalResult}}));
  });

  it('rechecks authorization at the application commit boundary', async () => {
    let revoked = false;
    const authorizationCheck = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
      if (revoked) throw new authorization.AnalysisContextAuthorizationChangedError();
    });
    try {
      const adapter: ConversationRuntimeAdapter = {run: jest.fn<ConversationRuntimeAdapter['run']>(async () => {
        revoked = true;
        return {kind: 'answered', message: 'REVOKED_ANSWER'};
      }), cancel: jest.fn(async () => undefined)};
      const service = createService(adapter);
      const receipt = service.startTurn({query: 'question'});
      await expect(receipt.completion).rejects.toThrow('analysis_context_changed_restart_required');
      const session = service.getSession(receipt.sessionId)!;
      expect(session.history.some(message => message.content === 'REVOKED_ANSWER')).toBe(false);
      expect(session.runs[0].outcome).toBeUndefined();
      expect(session.runs[0].events.some(event => event.type === 'run_completed')).toBe(false);
    } finally {authorizationCheck.mockRestore();}
  });

  it('keeps finalized partial state, uncertainties and next steps in next-turn history', async () => {
    let incoming: ConversationRuntimeInput | undefined;
    const finalResult = {sessionId: 'runtime', success: false, partial: true, findings: [], hypotheses: [],
      conclusion: 'Scheduling delay observed.', confidence: 0.4, rounds: 50, totalDurationMs: 100,
      terminationReason: 'max_turns', conclusionContract: {uncertainties: ['Wakeup missing'], nextSteps: ['Inspect wakeup']}} as unknown as AnalysisResult;
    const service = createService({run: async input => {incoming = input; return {kind: 'answered', message: finalResult.conclusion, finalResult};},
      cancel: async () => undefined});
    const first = service.startTurn({query: 'first'}); await first.completion;
    const second = service.startTurn({sessionId: first.sessionId, query: 'followup'}); await second.completion;
    expect(incoming!.getHistoryTurns!()).toEqual([expect.objectContaining({id: first.runId, query: 'first',
      partial: true, completionStatus: 'incomplete', uncertainties: ['Wakeup missing'], nextSteps: ['Inspect wakeup']})]);
  });

  describe('failure projection', () => {
    afterEach(() => {
      jest.restoreAllMocks();
      clearAllCodeAwareOutputGuards();
    });

    function failingService(fail: (input: ConversationRuntimeInput) => Error) {
      return createService({run: async input => {throw fail(input);}, cancel: async () => undefined});
    }

    async function failedTurn(service: ConversationSessionService, input: Parameters<ConversationSessionService['startTurn']>[0]) {
      const published: Array<{type: string; error?: unknown}> = [];
      const receipt = service.startTurn(input);
      const unsubscribe = service.subscribe(receipt.sessionId, event => published.push(event as {type: string; error?: unknown}));
      await receipt.completion.catch(() => undefined);
      unsubscribe();
      const session = service.getSession(receipt.sessionId)!;
      return {failed: published.find(event => event.type === 'run_failed'), session,
        run: session.runs.find(candidate => candidate.runId === receipt.runId)!};
    }

    it('stores and publishes fixed text naming the starting request for an untyped failure, never its message', async () => {
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const cause = new Error('SQLITE_IOERR: disk I/O error at /srv/conversation/private.db');
      const {failed, session, run} = await failedTurn(failingService(() => cause),
        {query: 'why is it slow', requestId: 'req-conversation-1'});

      const expected = '分析未能完成，服务端已记录错误（请求 ID：req-conversation-1）。';
      expect(failed).toMatchObject({type: 'run_failed', error: expected});
      expect(run.error).toBe(expected);
      expect(session.error).toBe(expected);
      expect(JSON.stringify(session)).not.toContain('/srv/conversation');
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({requestId: 'req-conversation-1'}), cause);
    });

    it('keeps a reason token a service threw for the owner', async () => {
      const {failed} = await failedTurn(failingService(() => new Error('analysis_history_parent_not_authorized')),
        {query: 'continue'});
      expect(failed).toMatchObject({error: 'analysis_history_parent_not_authorized'});
    });

    it('projects a private run under its runtime session guard, which the adapter has revoked by then', async () => {
      jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => undefined);
      const {failed, run} = await failedTurn(failingService(input => {
        // The adapter revokes its run's guards in `finally`, before the service sees the failure.
        revokeCodeAwareOutputGuards(conversationRuntimeSessionId(input.sessionId, input.runId));
        return new authorization.AnalysisContextAuthorizationChangedError();
      }), {query: 'read the source', runtimeOptions: {codeAwareMode: 'metadata_only', codebaseIds: ['cb-private']}});

      expect(run.privateContext).toMatchObject({codebase: true});
      expect(failed).toMatchObject({error: '[PRIVATE_OUTPUT_SUPPRESSED]'});
    });
  });

  it('inherits the same failed query and incomplete state before and after restart', async () => {
    const {descriptor, input} = recoveryFixture();
    let calls = 0;
    let sequence = 0;
    let followupHistory: ReturnType<typeof toAnalysisHistoryTurn>[] | undefined;
    const service = new ConversationSessionService({createId: prefix => prefix === 'conversation' ? descriptor.sessionId : `failure-run-${++sequence}`,
      createRuntime: () => ({run: async incoming => {
        if (++calls === 1) throw new Error('provider failed');
        followupHistory = [...incoming.getHistoryTurns!()];
        return {kind: 'answered', message: 'followup answer'};
      }, cancel: async () => undefined})});
    const first = service.startTurn({...input, sessionId: undefined, query: 'failed question'});
    await expect(first.completion).rejects.toThrow('provider failed');
    const failed = structuredClone(service.getSession(first.sessionId)!.historyTurns[0]);
    expect(failed).toMatchObject({query: 'failed question', answer: '', partial: true, completionStatus: 'incomplete',
      terminationReason: 'execution_error', analysisContextFingerprint: input.analysisContextFingerprint});
    const followup = service.startTurn({...input, sessionId: first.sessionId, query: 'continue the failed question'});
    await followup.completion;
    expect(followupHistory).toEqual([failed]);
    const restarted = createService({run: async () => ({kind: 'answered', message: 'restored'}), cancel: async () => undefined});
    const restored = restarted.restoreSession({...descriptor, status: 'failed', lastOutcome: undefined,
      lastRun: {...descriptor.lastRun, runId: first.runId, query: 'failed question', status: 'failed'}}, [failed], input);
    expect(restored.historyTurns).toEqual(followupHistory);
    expect(restored.history[0].turn).toEqual(failed);
  });

  it('returns an observable unavailable recovery state when finalized persistence fails', async () => {
    const service = new ConversationSessionService({createRuntime: () => ({run: async () => ({kind: 'answered', message: 'Delivered answer'}),
      cancel: async () => undefined}), onRunSettled: () => {throw new Error('sqlite disk failure');}});
    const receipt = service.startTurn({query: 'question'});
    const outcome = await receipt.completion;
    expect(outcome).toMatchObject({message: 'Delivered answer', recoveryStatus: 'unavailable'});
    expect(service.getSession(receipt.sessionId)?.recoveryStatus).toBe('unavailable');
    expect(service.getSession(receipt.sessionId)?.runs[0].events).toContainEqual(expect.objectContaining({
      type: 'run_completed', outcome: expect.objectContaining({recoveryStatus: 'unavailable'})}));
  });

  function recoveryFixture() {
    const owner = {tenantId: 'tenant-recovery', workspaceId: 'workspace-recovery', userId: 'user-recovery'};
    const fingerprint = authorization.buildAnalysisContextAuthorizationFingerprint({}, owner);
    const descriptor: ConversationSessionDescriptor = {version: 1, ...owner, sessionId: 'restore-conversation',
      traceContext: {kind: 'none'}, providerId: null, providerFollowsActive: false, runtimeKind: 'openai-agents-sdk',
      providerSnapshotHash: 'provider-hash', analysisContextFingerprint: fingerprint, status: 'completed',
      createdAt: 1, lastActivityAt: 2, lastRun: {runId: 'old-run', turnIndex: 0, query: 'first query', status: 'completed', startedAt: 1},
      lastOutcome: {kind: 'answered', message: 'Prior incomplete answer'}};
    const input = {query: '', sessionId: descriptor.sessionId, owner, traceContext: descriptor.traceContext,
      providerId: descriptor.providerId, runtimeKind: descriptor.runtimeKind, providerSnapshotHash: descriptor.providerSnapshotHash,
      analysisContextFingerprint: fingerprint};
    const turn = toAnalysisHistoryTurn({id: 'old-run', turnIndex: 0, query: 'first query',
      traceId: 'conversation-no-trace:restore-conversation', timestamp: 2,
      result: {conclusion: 'Prior incomplete answer', partial: true, terminationReason: 'max_turns'}});
    return {descriptor, input, turn};
  }

  it('restores finalized logical history into a fresh adapter and continues the same session', async () => {
    const {descriptor, input, turn} = recoveryFixture();
    const received: ConversationRuntimeInput[] = [];
    const factory = jest.fn((): ConversationRuntimeAdapter => ({run: async incoming => {
      received.push(incoming); return {kind: 'answered', message: 'continued'};}, cancel: async () => undefined}));
    const service = new ConversationSessionService({createRuntime: factory});
    const restored = service.restoreSession(descriptor, [turn], input);
    expect(restored.activeRun).toBeUndefined();
    expect(restored.historyTurns).toEqual([turn]);
    expect(factory).toHaveBeenCalledTimes(1);
    const receipt = service.startTurn({...input, query: 'followup'}); await receipt.completion;
    expect(receipt.sessionId).toBe(descriptor.sessionId);
    expect(receipt.isNewSession).toBe(false);
    expect(received[0].getHistoryTurns!()).toEqual([turn]);
  });

  it('restores a crashed running descriptor as interrupted without a phantom active run', () => {
    const {descriptor, input, turn} = recoveryFixture();
    const service = createService({run: async () => ({kind: 'answered', message: ''}), cancel: async () => undefined});
    const restored = service.restoreSession({...descriptor, status: 'running',
      lastRun: {...descriptor.lastRun, status: 'running'}}, [{...turn, answer: ''}], input);
    expect(restored).toMatchObject({status: 'failed', recoveryStatus: 'interrupted', runs: []});
    expect(restored.activeRun).toBeUndefined();
    expect(restored.historyTurns[0]).toMatchObject({partial: true, completionStatus: 'incomplete',
      terminationMessage: 'conversation_run_interrupted_before_final_commit'});
  });

  it('refuses to recover a descriptor stamped with a pre-acf2 fingerprint; the user starts a new conversation', () => {
    const {descriptor, input, turn} = recoveryFixture();
    expect(input.analysisContextFingerprint).toMatch(/^acf2:/);
    // The descriptor stored before the format change holds a bare digest; it is never re-stamped.
    const legacy = {...descriptor, analysisContextFingerprint: input.analysisContextFingerprint.slice('acf2:'.length)};
    const factory = jest.fn((): ConversationRuntimeAdapter => ({run: async () => ({kind: 'answered', message: ''}), cancel: async () => undefined}));
    const service = new ConversationSessionService({createRuntime: factory});
    expect(() => service.restoreSession(legacy, [turn], input))
      .toThrow(expect.objectContaining({code: 'CONVERSATION_RECOVERY_UNAVAILABLE', status: 409}));
    expect(factory).not.toHaveBeenCalled();
    expect(legacy.analysisContextFingerprint).not.toMatch(/^acf2:/);
  });

  it('denies changed owner, provider hash and revoked sources before recreating an adapter', () => {
    const {descriptor, input, turn} = recoveryFixture();
    const factory = jest.fn((): ConversationRuntimeAdapter => ({run: async () => ({kind: 'answered', message: ''}), cancel: async () => undefined}));
    const service = new ConversationSessionService({createRuntime: factory});
    expect(() => service.restoreSession(descriptor, [turn], {...input, owner: {...input.owner, userId: 'another-user'}})).toThrow(expect.objectContaining({code: 'CONVERSATION_RECOVERY_UNAVAILABLE', status: 409}));
    expect(() => service.restoreSession(descriptor, [turn], {...input, providerSnapshotHash: 'changed'})).toThrow(expect.objectContaining({code: 'CONVERSATION_RECOVERY_UNAVAILABLE', status: 409}));
    const check = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
      throw new authorization.AnalysisContextAuthorizationChangedError();
    });
    try {expect(() => service.restoreSession(descriptor, [turn], input)).toThrow('analysis_context_changed_restart_required');}
    finally {check.mockRestore();}
    expect(factory).not.toHaveBeenCalled();
  });

});
