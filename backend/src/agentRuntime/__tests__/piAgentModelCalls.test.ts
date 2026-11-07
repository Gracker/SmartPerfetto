// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {AssistantMessage, AssistantMessageEventStream} from '@earendil-works/pi-ai';
import {createPiAgentModelCallTracker, piUsageToModelCallUsage} from '../engines/pi/piAgentModelCalls';
import type {ModelExecutionPolicyReceipt} from '../modelExecutionPolicy';
import {createRuntimePerformanceRecorder} from '../runtimePerformance';

function setup() {
  let clock = 0;
  const recorder = createRuntimePerformanceRecorder({now: () => clock});
  const controller = new AbortController();
  const tracker = createPiAgentModelCallTracker(input => recorder.startModelCall(input),
    {model: 'configured-model', providerOrigin: 'https://provider.example/v1'}, controller.signal);
  return {recorder, tracker, controller, advance: (ms: number) => { clock += ms; }};
}

function deferredStream() {
  let resolve!: (message: AssistantMessage) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<AssistantMessage>((res, rej) => { resolve = res; reject = rej; });
  return {stream: {result: () => result} as unknown as AssistantMessageEventStream, resolve, reject};
}

const message = (extra: Partial<AssistantMessage> = {}) => ({role: 'assistant', model: 'configured-model',
  stopReason: 'stop', content: [], usage: {input: 10, output: 6, cacheRead: 30, cacheWrite: 0, reasoning: 4,
    totalTokens: 46}, ...extra}) as unknown as AssistantMessage;
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('createPiAgentModelCallTracker', () => {
  it('records one Agent call from dispatch to its final message', async () => {
    const {recorder, tracker, advance} = setup();
    const {stream, resolve} = deferredStream();
    expect(tracker.dispatch('answer_turn', onPolicy => {
      onPolicy({sdkEffective: {mode: 'enabled', effort: 'low'}} as unknown as ModelExecutionPolicyReceipt);
      return stream;
    })).toBe(stream);
    advance(100);
    tracker.recordFirstOutput();
    advance(50);
    tracker.recordFirstOutput();
    advance(250);
    resolve(message({responseModel: 'served-model'}));
    await flush();
    tracker.recordFirstOutput();

    expect(recorder.seal().modelCalls).toEqual([expect.objectContaining({purpose: 'answer_turn', model: 'served-model',
      modelSource: 'provider_reported', outcome: 'ok', durationMs: 400, firstOutputMs: 100, reasoning: 'enabled',
      reasoningEffort: 'low', usage: {inputTokens: 40, outputTokens: 6, reasoningTokens: 4, cachedInputTokens: 30}})]);
  });

  it('maps native stop reasons, rejected results and dispatch errors', async () => {
    const {recorder, tracker, controller} = setup();
    for (const [purpose, extra] of [['answer_turn', {stopReason: 'error'}], ['continuation', {errorMessage: 'upstream'}],
      ['declaration_repair', {stopReason: 'aborted'}]] as const) {
      const {stream, resolve} = deferredStream();
      tracker.dispatch(purpose, () => stream);
      resolve(message(extra as Partial<AssistantMessage>));
      await flush();
    }
    const rejected = deferredStream();
    tracker.dispatch('answer_turn', () => rejected.stream);
    rejected.reject(new Error('socket closed'));
    await flush();
    expect(() => tracker.dispatch('answer_turn', () => { throw new Error('invalid configuration'); })).toThrow();
    controller.abort();
    expect(() => tracker.dispatch('answer_turn', () => { throw new Error('stopped'); })).toThrow();

    expect(recorder.seal().modelCalls?.map(call => [call.purpose, call.outcome])).toEqual([
      ['answer_turn', 'error'], ['continuation', 'error'], ['declaration_repair', 'cancelled'],
      ['answer_turn', 'error'], ['answer_turn', 'error'], ['answer_turn', 'cancelled'],
    ]);
  });
});

describe('piUsageToModelCallUsage', () => {
  it('folds cache reads and writes into prompt tokens', () => {
    expect(piUsageToModelCallUsage({input: 5, output: 4, cacheRead: 20, cacheWrite: 3, totalTokens: 32,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}))
      .toEqual({inputTokens: 28, outputTokens: 4, cachedInputTokens: 20});
    expect(piUsageToModelCallUsage(undefined)).toBeUndefined();
  });
});
