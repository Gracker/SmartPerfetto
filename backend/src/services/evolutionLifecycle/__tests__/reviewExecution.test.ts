// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, jest} from '@jest/globals';
import {runResolvedOneShot} from '../../oneShotModelCall';
import {executeStructuredReview} from '../reviewExecution';

jest.mock('../../oneShotModelCall', () => ({runResolvedOneShot: jest.fn()}));

const mockOneShot = runResolvedOneShot as unknown as jest.Mock<(...args: any[]) => any>;
const INPUT = {prompt: 'review', logPrefix: 'Review', timeoutMs: 5_000};

beforeEach(() => {mockOneShot.mockReset();});

describe('executeStructuredReview', () => {
  it('runs one light-tier call on the active provider and returns the first JSON object', async () => {
    mockOneShot.mockResolvedValue({ok: true, text: 'Result: {"verdict":"accept"} trailing', model: 'm'});
    await expect(executeStructuredReview(INPUT)).resolves.toEqual({ok: true, value: {verdict: 'accept'}});
    expect(mockOneShot).toHaveBeenCalledTimes(1);
    expect(mockOneShot).toHaveBeenCalledWith({prompt: 'review', tier: 'light', timeoutMs: 5_000, logLabel: 'Review'});
  });

  it.each([
    [{ok: true, text: 'no object', model: 'm'}, 'sdk_invalid', 'no JSON object in agent response'],
    [{ok: false, reason: 'empty_response'}, 'sdk_invalid', 'no JSON object in agent response'],
    [{ok: false, reason: 'timed_out'}, 'sdk_timeout', '5000ms budget exhausted'],
    [{ok: false, reason: 'credentials_missing'}, 'sdk_error', 'credentials_missing'],
    [{ok: false, reason: 'failed', runtime: 'pi-agent-core'}, 'sdk_error', 'failed'],
    [{ok: false, reason: 'runtime_not_supported', runtime: 'openai-agents-sdk'}, 'sdk_error', 'runtime_not_supported: openai-agents-sdk'],
  ])('maps %j to %s', async (outcome, reason, details) => {
    mockOneShot.mockResolvedValue(outcome);
    await expect(executeStructuredReview(INPUT)).resolves.toEqual({ok: false, reason, details});
  });
});
