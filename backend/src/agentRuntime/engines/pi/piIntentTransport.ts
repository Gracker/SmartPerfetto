// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {PiAgentCoreProviderRuntime} from './piAgentCoreProvider';
import {intentTransportTextResult, runIntentTransport, type IntentTransportInput} from '../../intentTransport';
import type {RuntimeModelCallPurpose} from '../../runtimePerformance';

export interface PiIntentTransportInput extends IntentTransportInput {
  providerRuntime: Pick<PiAgentCoreProviderRuntime, 'model' | 'streamFn' | 'streamFnForPurpose'>;
  purpose?: RuntimeModelCallPurpose;
  maxOutputTokens?: number;
}

/**
 * Output token cap for a call that states only a byte limit: 4 bytes per
 * token rounded up, plus 25% headroom, at most the model's own cap. Without
 * one, an OpenAI-completions provider applies its own default output cap, and
 * a GLM review then stopped at `length` (`incomplete_output`).
 */
export function piOutputTokensForByteLimit(outputByteLimit: number, modelMaxTokens: number): number {
  return Math.max(1, Math.min(Math.ceil(Math.ceil(outputByteLimit / 4) * 1.25), Math.floor(modelMaxTokens)));
}

/** Reuses the resolved Pi provider and its captured auth without creating an Agent. */
export function runPiIntentTransport(input: PiIntentTransportInput) {
  return runIntentTransport(input, async scope => {
    const {model} = input.providerRuntime;
    if ((input.maxOutputTokens !== undefined
      && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0))
      || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    let streamFn: PiAgentCoreProviderRuntime['streamFn'];
    try {
      streamFn = input.providerRuntime.streamFnForPurpose?.(input.purpose ?? 'review')
        ?? input.providerRuntime.streamFn;
    } catch {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const result = await streamFn(model, {
      systemPrompt: input.systemPrompt,
      messages: [{role: 'user', content: input.prompt, timestamp: Date.now()}],
      tools: [],
    }, {
      signal: scope.signal,
      timeoutMs: scope.remainingMs(),
      maxRetries: 0,
      maxTokens: input.maxOutputTokens !== undefined ? Math.min(input.maxOutputTokens, model.maxTokens)
        : piOutputTokensForByteLimit(input.outputByteLimit, model.maxTokens),
      cacheRetention: 'none',
    }).result();
    scope.throwIfInactive();
    if (result.content.some(part => part.type === 'toolCall') || result.stopReason === 'toolUse') {
      return {status: 'unavailable', reason: 'tool_use'};
    }
    if (result.stopReason !== 'stop' || result.deferred !== undefined || result.errorMessage) {
      return {status: 'unavailable', reason: result.stopReason === 'length' ? 'incomplete_output' : 'invalid_response'};
    }
    const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
    return intentTransportTextResult(text, input, {
      actualModel: result.responseModel ?? result.model,
      finishReason: result.stopReason,
    });
  });
}
