// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {createSdkEnv, getSdkBinaryOption} from '../engines/claude/claudeConfig';
import {runClaudeStructuredReviewQuery, runClaudeTriageQuery} from '../engines/claude/claudeAuxiliaryQueries';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({query: jest.fn()}));
jest.mock('../engines/claude/claudeConfig', () => ({
  createSdkEnv: jest.fn(),
  getSdkBinaryOption: jest.fn(() => ({pathToClaudeCodeExecutable: '/pinned/claude'})),
}));

const mockQuery = sdkQuery as unknown as jest.Mock<(...args: any[]) => any>;
const mockCreateSdkEnv = createSdkEnv as unknown as jest.Mock<(...args: any[]) => any>;
const mockBinary = getSdkBinaryOption as unknown as jest.Mock<(...args: any[]) => any>;
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

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateSdkEnv.mockReturnValue(ENV);
});
afterEach(() => {jest.useRealTimers();});

describe('Claude structured-review query', () => {
  const input = {prompt: 'review', logPrefix: 'Review', model: 'light-model', maxTurns: 3, timeoutMs: 5_000};

  it('runs one tool-free query on the active provider env and keeps the last successful result', async () => {
    const response = stream([
      {type: 'result', subtype: 'success', result: 'first'},
      {type: 'result', subtype: 'error_max_turns', result: 'ignored'},
      {type: 'result', subtype: 'success', result: '{"ok":true}'},
    ]);
    mockQuery.mockReturnValue(response);
    await expect(runClaudeStructuredReviewQuery(input)).resolves.toEqual({kind: 'text', text: '{"ok":true}'});
    expect(mockCreateSdkEnv).toHaveBeenCalledWith();
    expect(mockBinary).toHaveBeenCalledWith(ENV);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const {prompt, options} = mockQuery.mock.calls[0][0];
    expect(prompt).toBe('review');
    expect(options).toEqual({
      model: 'light-model', maxTurns: 3, settingSources: [], tools: [], permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true, env: ENV, stderr: expect.any(Function),
      pathToClaudeCodeExecutable: '/pinned/claude', persistSession: false,
    });
    expect(response.close).toHaveBeenCalled();
  });

  it('reports an unreadable provider env and a failed stream as errors without a query for the env', async () => {
    const unreadable = new Error('providers unreadable');
    mockCreateSdkEnv.mockImplementationOnce(() => {throw unreadable;});
    await expect(runClaudeStructuredReviewQuery(input)).resolves.toEqual({kind: 'error', error: unreadable});
    expect(mockQuery).not.toHaveBeenCalled();

    const failure = new Error('sdk failed');
    mockQuery.mockReturnValue(stream([], {fail: failure}));
    await expect(runClaudeStructuredReviewQuery(input)).resolves.toEqual({kind: 'error', error: failure});
  });

  it('reports the deadline as a timeout and closes the stream', async () => {
    const response = stream([], {waitForClose: 'throw'});
    mockQuery.mockReturnValue(response);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(runClaudeStructuredReviewQuery({...input, timeoutMs: 10})).resolves.toEqual({kind: 'timeout'});
    } finally {
      warn.mockRestore();
    }
    expect(response.close).toHaveBeenCalled();
  });
});

describe('Claude external-issue triage query', () => {
  const input = {prompt: 'triage', model: 'pinned-light', cwd: '/pinned/cwd', env: ENV, timeoutMs: 5_000};

  it('runs one low-effort tool-free turn on the pinned env and keeps the last string result', async () => {
    mockQuery.mockReturnValue(stream([
      {type: 'result', subtype: 'success', result: 'first'},
      {type: 'result', subtype: 'error_during_execution', result: 'last'},
      {type: 'result', subtype: 'success'},
    ]));
    await expect(runClaudeTriageQuery(input)).resolves.toEqual({timedOut: false, text: 'last'});
    expect(mockCreateSdkEnv).not.toHaveBeenCalled();
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
