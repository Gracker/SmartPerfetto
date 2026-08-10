// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import {listProductionRuntimeKinds} from '../../../agentRuntime/runtimeKinds';
import type {AnalysisOptions, AnalysisResult, IOrchestrator} from '../../../agent/core/orchestratorTypes';
import {OrchestratorConversationRuntimeAdapter} from '../orchestratorConversationRuntimeAdapter';

function createOrchestrator(
  analyze: (options: AnalysisOptions) => Promise<AnalysisResult>,
): IOrchestrator {
  const emitter = new EventEmitter() as unknown as IOrchestrator;
  emitter.analyze = jest.fn(async (_query, _sessionId, _traceId, options = {}) => analyze(options));
  emitter.reset = jest.fn();
  emitter.abortSession = jest.fn();
  return emitter;
}

function result(conclusion: string): AnalysisResult {
  return {
    sessionId: 'runtime-session',
    success: true,
    findings: [{
      id: 'ev-1',
      severity: 'info',
      title: 'Trace evidence',
      description: 'evidence',
      source: 'sql',
    }],
    hypotheses: [],
    conclusion,
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 10,
  };
}

describe('OrchestratorConversationRuntimeAdapter', () => {
  it.each(listProductionRuntimeKinds())(
    'applies the same conversation contract to %s',
    async () => {
      let receivedOptions: AnalysisOptions | undefined;
      const orchestrator = createOrchestrator(async (options) => {
        receivedOptions = options;
        return result('可以先看主线程。\n<!-- smartperfetto:conversation-control {"kind":"answered"} -->');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator);

      await expect(adapter.run({
        sessionId: 'conversation-1',
        runId: 'run-1',
        query: '怎么分析？',
        history: [],
        traceContext: {kind: 'none'},
      })).resolves.toEqual({
        kind: 'answered',
        message: '可以先看主线程。',
        evidence: [{id: 'ev-1', label: 'Trace evidence', source: 'sql'}],
      });
      expect(receivedOptions).toMatchObject({
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        runId: 'run-1',
      });
    },
  );

  it('uses the per-turn selection and clears a stale constructor selection', async () => {
    const receivedOptions: AnalysisOptions[] = [];
    const orchestrator = createOrchestrator(async (options) => {
      receivedOptions.push(options);
      return result('回答');
    });
    const initialSelection = {
      kind: 'track_event' as const,
      eventId: 1,
      ts: 100,
      name: 'old slice',
    };
    const currentSelection = {
      kind: 'track_event' as const,
      source: 'track_event_selection' as const,
      trackUri: '/process_1/thread_2',
      eventId: 42,
      ts: 1000,
      dur: 250,
      name: 'current slice',
    };
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {
      analysisOptions: {selectionContext: initialSelection},
    });

    await adapter.run({
      sessionId: 'conversation-1',
      runId: 'run-1',
      query: 'Analyze the selected slice',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
      selectionContext: currentSelection,
    });
    await adapter.run({
      sessionId: 'conversation-1',
      runId: 'run-2',
      query: 'Continue without a selection',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    expect(receivedOptions[0].selectionContext).toEqual(currentSelection);
    expect(receivedOptions[1].selectionContext).toBeUndefined();
  });

  it('cancels the exact physical runtime run', async () => {
    let rejectRun: ((error: Error) => void) | undefined;
    const orchestrator = createOrchestrator(() => new Promise((_resolve, reject) => {
      rejectRun = reject;
    }));
    orchestrator.abortSession = jest.fn(() => rejectRun?.(new Error('Analysis aborted')));
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator);
    const completion = adapter.run({
      sessionId: 'conversation-1',
      runId: 'run-1',
      query: '继续查',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    await adapter.cancel('conversation-1', 'run-1');

    await expect(completion).resolves.toEqual({kind: 'cancelled', message: ''});
    expect(orchestrator.abortSession).toHaveBeenCalledWith('conversation-1:run-1');
  });

  it('projects private runtime updates and terminal outcomes before publishing them', async () => {
    const privateQuery = 'private pasted source line';
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.analyze = jest.fn(async () => {
      emitter.emit('update', {
        type: 'progress',
        content: {message: privateQuery},
        timestamp: Date.now(),
      });
      return result(`Answer repeats ${privateQuery}`);
    });
    emitter.reset = jest.fn();
    emitter.abortSession = jest.fn();
    const updates: unknown[] = [];
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {
      analysisOptions: {
        outputLanguage: 'en',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-app'],
      },
    });

    const outcome = await adapter.run({
      sessionId: 'conversation-private',
      runId: 'run-private',
      query: privateQuery,
      history: [],
      traceContext: {kind: 'none'},
      onUpdate: update => updates.push(update),
    });

    expect(JSON.stringify(updates)).not.toContain(privateQuery);
    expect(JSON.stringify(outcome)).not.toContain(privateQuery);
    expect(outcome.message).toContain('[PRIVATE_QUERY_REFERENCE]');
  });

  it('keeps private user queries from earlier turns guarded for the whole current run', async () => {
    const previousPrivateQuery = 'private source pasted in the previous turn';
    const currentPrivateQuery = 'continue reviewing that source';
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.analyze = jest.fn(async () => {
      emitter.emit('update', {
        type: 'progress',
        content: {message: previousPrivateQuery},
        timestamp: Date.now(),
      });
      return result(`Answer repeats ${previousPrivateQuery}`);
    });
    emitter.reset = jest.fn();
    emitter.abortSession = jest.fn();
    const updates: unknown[] = [];
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {
      analysisOptions: {
        outputLanguage: 'en',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-app'],
      },
    });

    const outcome = await adapter.run({
      sessionId: 'conversation-private',
      runId: 'run-private-second-turn',
      query: currentPrivateQuery,
      history: [
        {role: 'user', content: previousPrivateQuery},
        {role: 'assistant', content: 'Projected prior answer'},
      ],
      traceContext: {kind: 'none'},
      onUpdate: update => updates.push(update),
    });

    expect(JSON.stringify(updates)).not.toContain(previousPrivateQuery);
    expect(JSON.stringify(outcome)).not.toContain(previousPrivateQuery);
    expect(outcome.message).toContain('[PRIVATE_QUERY_REFERENCE]');
  });
});
