// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {runClaudeTriageQuery} from '../engines/claude/claudeAuxiliaryQueries';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({query: jest.fn()}));
jest.mock('../engines/claude/claudeConfig', () => ({
  getSdkBinaryOption: jest.fn(() => ({pathToClaudeCodeExecutable: '/pinned/claude'})),
}));

const mockQuery = sdkQuery as unknown as jest.Mock<(...args: any[]) => any>;
const ENV = {ANTHROPIC_BASE_URL: 'https://pinned.example'};

/** A closed stream ends (`end`) or fails its pending read (`throw`), as the SDK may do either. */
function stream(messages: unknown[], options: {waitForClose?: 'end' | 'throw'; fail?: Error} = {}) {
  let closed!: () => void;
  const closedPromise = new Promise<void>(resolve => {closed = resolve;});
  const close = jest.fn(() => closed());
  return {
    close,
    async *[Symbol.asyncIterator]() {
      yield* messages;
      if (options.fail) throw options.fail;
      if (options.waitForClose) {
        await closedPromise;
        if (options.waitForClose === 'throw') throw new Error('stream closed');
      }
    },
  };
}

beforeEach(() => {jest.clearAllMocks();});
afterEach(() => {jest.useRealTimers();});

describe('Claude external-issue triage query', () => {
  const input = {prompt: 'triage', model: 'pinned-light', cwd: '/pinned/cwd', env: ENV, timeoutMs: 5_000};

  it('runs one low-effort tool-free turn on the pinned env and keeps the last string result', async () => {
    mockQuery.mockReturnValue(stream([
      {type: 'result', subtype: 'success', result: 'first'},
      {type: 'result', subtype: 'error_during_execution', result: 'last'},
      {type: 'result', subtype: 'success'},
    ]));
    await expect(runClaudeTriageQuery(input)).resolves.toEqual({timedOut: false, text: 'last'});
    expect(mockQuery.mock.calls[0][0]).toEqual({prompt: 'triage', options: {
      model: 'pinned-light', maxTurns: 1, includePartialMessages: false, settingSources: [], tools: [],
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, cwd: '/pinned/cwd',
      effort: 'low', env: ENV, pathToClaudeCodeExecutable: '/pinned/claude', persistSession: false,
    }});
  });

  it('propagates stream failures and reports the deadline', async () => {
    const failure = new Error('sdk failed');
    const failed = stream([], {fail: failure});
    mockQuery.mockReturnValue(failed);
    await expect(runClaudeTriageQuery(input)).rejects.toBe(failure);
    expect(failed.close).toHaveBeenCalled();

    mockQuery.mockReturnValue(stream([], {waitForClose: 'end'}));
    await expect(runClaudeTriageQuery({...input, timeoutMs: 10})).resolves.toEqual({timedOut: true, text: ''});
  });
});
