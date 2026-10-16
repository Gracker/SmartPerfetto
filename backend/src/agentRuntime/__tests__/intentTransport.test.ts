// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {
  intentTransportErrorReason,
  intentTransportTextResult,
  openAiTextRequestPurposeFor,
  runIntentTransport,
  sdkResultFailureReason,
  type IntentTransportInput,
} from '../intentTransport';

function input(): IntentTransportInput {
  return {prompt: 'classify', systemPrompt: 'system', deadlineMs: Date.now() + 50, outputByteLimit: 100};
}

describe('intent transport deadline and cleanup', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  it('does not dispatch an expired or already cancelled request', async () => {
    const execute = jest.fn<Parameters<typeof runIntentTransport>[1]>();
    await expect(runIntentTransport({...input(), deadlineMs: Date.now()}, execute))
      .resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    const controller = new AbortController();
    controller.abort(new Error('private parent reason'));
    await expect(runIntentTransport({...input(), signal: controller.signal}, execute))
      .rejects.toMatchObject({name: 'AbortError', message: 'Intent classification cancelled'});
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a fixed unavailable reason without exposing provider exceptions', async () => {
    await expect(runIntentTransport(input(), async () => {throw new Error('SECRET_KEY_CANARY');}))
      .resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
  });

  it('rejects a same-tick late result before the timeout callback has run', async () => {
    const request = input();
    await expect(runIntentTransport(request, async () => {
      jest.setSystemTime(request.deadlineMs + 1);
      return {status: 'ok', text: '{}'};
    })).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
  });

  it('attempts every registered cleanup once even if an earlier cleanup never settles', async () => {
    const stuck = jest.fn(() => new Promise<void>(() => undefined));
    const close = jest.fn(async () => undefined);
    const result = runIntentTransport(input(), async scope => {
      scope.onCleanup(close);
      scope.onCleanup(stuck);
      return {status: 'ok', text: '{}'};
    });
    await jest.advanceTimersByTimeAsync(1001);
    await expect(result).resolves.toEqual({status: 'ok', text: '{}'});
    expect(stuck).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cleans up a resource that arrives after the timeout and ignores its late result', async () => {
    let resolveResource!: () => void;
    const resource = new Promise<void>(resolve => {resolveResource = resolve;});
    const close = jest.fn(async () => {throw new Error('late cleanup private failure');});
    const result = runIntentTransport(input(), async scope => {
      await resource;
      scope.onCleanup(close);
      scope.throwIfInactive();
      return {status: 'ok', text: 'late'};
    });
    await jest.advanceTimersByTimeAsync(51);
    await expect(result).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    resolveResource();
    await jest.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('propagates parent cancellation even after the provider returned and cleanup began', async () => {
    const controller = new AbortController();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => {finishCleanup = resolve;});
    const result = runIntentTransport({...input(), signal: controller.signal}, async scope => {
      scope.onCleanup(() => cleanup);
      return {status: 'ok', text: '{}'};
    });
    const rejected = expect(result).rejects.toMatchObject({name: 'AbortError'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    finishCleanup();
    await rejected;
  });

  it('rejects oversized UTF-8 output rather than truncating a classifier object', () => {
    expect(intentTransportTextResult('中文', {outputByteLimit: 5}))
      .toEqual({status: 'unavailable', reason: 'output_limit'});
    expect(intentTransportTextResult('中文', {outputByteLimit: 6}))
      .toEqual({status: 'ok', text: '中文'});
  });
});

describe('intent transport purpose mapping and failure reasons', () => {
  it('maps every model-call purpose to one closed request purpose; an answer turn has none', () => {
    expect(openAiTextRequestPurposeFor('classification')).toBe('classification');
    expect(openAiTextRequestPurposeFor('review')).toBe('final_semantic');
    expect(openAiTextRequestPurposeFor('declaration_repair')).toBe('declaration_repair');
    expect(openAiTextRequestPurposeFor('continuation')).toBe('continuation');
    expect(openAiTextRequestPurposeFor('answer_turn')).toBeUndefined();
  });

  it('reads a timeout only from structured error names and codes along the cause chain', () => {
    expect(intentTransportErrorReason(Object.assign(new TypeError('fetch failed'),
      {cause: {code: 'UND_ERR_HEADERS_TIMEOUT'}}))).toBe('timeout');
    expect(intentTransportErrorReason({cause: {cause: {code: 'UND_ERR_BODY_TIMEOUT'}}})).toBe('timeout');
    expect(intentTransportErrorReason(new DOMException('late', 'TimeoutError'))).toBe('timeout');
    expect(intentTransportErrorReason(Object.assign(new Error('x'), {code: 'ETIMEDOUT'}))).toBe('timeout');
    // Message wording never decides it.
    expect(intentTransportErrorReason(new Error('request timed out'))).toBe('provider_error');
    expect(intentTransportErrorReason(Object.assign(new Error('x'), {code: 'ECONNRESET'}))).toBe('provider_error');
    expect(intentTransportErrorReason(undefined)).toBe('provider_error');
  });

  it('classifies a thrown timeout inside the deadline as a timeout', async () => {
    jest.useFakeTimers({now: 1000});
    try {
      await expect(runIntentTransport(input(), async () => {
        throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'UND_ERR_HEADERS_TIMEOUT'}});
      })).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    } finally { jest.useRealTimers(); }
  });

  it('reads SDK result failures from structured fields only', () => {
    expect(sdkResultFailureReason({subtype: 'success', is_error: true})).toBe('provider_error');
    expect(sdkResultFailureReason({subtype: 'error_during_execution', is_error: true})).toBe('provider_error');
    expect(sdkResultFailureReason({subtype: 'success', is_error: false, stop_reason: 'refusal'})).toBe('invalid_response');
    expect(sdkResultFailureReason({subtype: 'error_max_turns', is_error: true})).toBe('invalid_response');
    expect(sdkResultFailureReason({})).toBe('invalid_response');
  });
});
