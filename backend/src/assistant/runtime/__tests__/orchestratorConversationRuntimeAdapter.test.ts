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

  it('keeps authorized source dormant for ordinary analysis questions', async () => {
    let receivedOptions: AnalysisOptions | undefined;
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.analyze = jest.fn(async (_query, _sessionId, _traceId, options = {}) => {
      receivedOptions = options;
      emitter.emit('update', {
        type: 'progress',
        content: {message: 'trace-first progress'},
        timestamp: Date.now(),
      });
      return result('先基于 Trace 回答');
    });
    emitter.reset = jest.fn();
    emitter.abortSession = jest.fn();
    const updates: unknown[] = [];
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {
      analysisOptions: {
        outputLanguage: 'zh-CN',
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
        analysisContextFingerprint: 'authorized-source-fingerprint',
      },
    });

    await adapter.run({
      sessionId: 'conversation-dormant',
      runId: 'run-dormant',
      query: '为什么这次启动很慢？',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
      onUpdate: update => updates.push(update),
    });

    expect(receivedOptions).toMatchObject({
      codeAwareMode: 'off',
      assistantSurface: 'conversation',
    });
    expect(receivedOptions?.codebaseIds).toBeUndefined();
    expect(receivedOptions?.analysisContextFingerprint).toBeUndefined();
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'progress',
      content: {message: 'trace-first progress'},
    }));
  });

  it('uses the bounded source policy for an explicit source question', async () => {
    let receivedOptions: AnalysisOptions | undefined;
    const orchestrator = createOrchestrator(async (options) => {
      receivedOptions = options;
      return result('源码回答');
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {
      analysisOptions: {
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
      },
    });

    await adapter.run({
      sessionId: 'conversation-explicit',
      runId: 'run-explicit',
      query: '结合源码看看 Foo::bar 的调用链',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    expect(receivedOptions).toMatchObject({
      codeAwareMode: 'provider_send',
      codebaseIds: ['private-app'],
      sourceUsePolicy: {
        phase: 'explicit',
        maxSearchCalls: 1,
        maxReadCalls: 2,
        maxDurationMs: 6_000,
      },
    });
  });

  it('does not inject source-derived history into a dormant primary analysis', async () => {
    let receivedQuery = '';
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.analyze = jest.fn(async (query: string) => {
      receivedQuery = query;
      return result('trace answer');
    });
    emitter.reset = jest.fn();
    emitter.abortSession = jest.fn();
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {
      analysisOptions: {
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
      },
    });

    await adapter.run({
      sessionId: 'conversation-history',
      runId: 'run-history',
      query: '继续分析启动耗时',
      history: [
        {role: 'user', content: '上一轮普通问题'},
        {role: 'assistant', content: '普通 Trace 回答'},
        {role: 'assistant', content: 'PRIVATE_SOURCE_DERIVED_CANARY', sourceDerived: true},
      ],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    expect(receivedQuery).toContain('普通 Trace 回答');
    expect(receivedQuery).not.toContain('PRIVATE_SOURCE_DERIVED_CANARY');
  });

  it('never returns internal tool protocol text as a user answer', async () => {
    const orchestrator = createOrchestrator(async () => result(
      '<｜｜DSML｜｜tools_calling><｜｜DSML｜｜invoke name="bash">secret</｜｜DSML｜｜invoke>',
    ));
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator);

    const outcome = await adapter.run({
      sessionId: 'conversation-protocol',
      runId: 'run-protocol',
      query: '请搜索实现',
      history: [],
      traceContext: {kind: 'none'},
    });

    expect(outcome.kind).toBe('needs_user_input');
    expect(outcome.message).not.toContain('DSML');
    expect(outcome.message).not.toContain('invoke');
  });

  it('starts automatic source enrichment only for a narrow trace-backed anchor', () => {
    const adapter = new OrchestratorConversationRuntimeAdapter(
      createOrchestrator(async () => result('answer')),
      {
        analysisOptions: {
          codeAwareMode: 'provider_send',
          codebaseIds: ['private-app'],
        },
      },
    );
    const input = {
      sessionId: 'conversation-auto',
      runId: 'run-auto',
      query: '为什么启动慢？',
      history: [],
      traceContext: {kind: 'attached' as const, traceId: 'trace-1'},
    };

    expect(adapter.shouldStartSourceEnrichment(input, {
      kind: 'answered',
      message: 'trace answer',
      evidence: [{id: 'ev-1', label: 'Foo::bar', source: 'sql'}],
    })).toBe(true);
    expect(adapter.shouldStartSourceEnrichment(input, {
      kind: 'answered',
      message: 'trace answer',
      evidence: [{id: 'ev-2', label: 'Main thread busy', source: 'sql'}],
    })).toBe(false);
  });

  it('runs automatic source enrichment with a distinct bounded runtime phase', async () => {
    const received: Array<{sessionId: string; options: AnalysisOptions; query: string}> = [];
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.analyze = jest.fn(async (query, sessionId, _traceId, options = {}) => {
      received.push({query, sessionId, options});
      return result('补充定位到 Foo.kt:L10-L12');
    });
    emitter.reset = jest.fn();
    emitter.abortSession = jest.fn();
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {
      analysisOptions: {
        outputLanguage: 'zh-CN',
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
      },
    });

    const outcome = await adapter.runSourceEnrichment({
      sessionId: 'conversation-auto',
      runId: 'run-auto',
      query: '为什么启动慢？',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
      primaryOutcome: {
        kind: 'answered',
        message: 'Trace 指向 Foo::bar',
        evidence: [{id: 'ev-1', label: 'Foo::bar', source: 'sql'}],
      },
    });

    expect(received[0]).toMatchObject({
      sessionId: 'conversation-auto:run-auto:source-enrichment',
      options: {
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        sourceUsePolicy: {
          phase: 'automatic_enrichment',
          maxSearchCalls: 1,
          maxReadCalls: 2,
          maxDurationMs: 6_000,
        },
      },
    });
    expect(outcome.message).toContain('Foo.kt:L10-L12');
  });
});
