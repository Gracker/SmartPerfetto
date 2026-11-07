// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, jest} from '@jest/globals';

const mockCreateRuntime = jest.fn<(...args: any[]) => any>();
const mockTransport = jest.fn<(...args: any[]) => any>();
jest.mock('../../../agentRuntime/engines/pi/piAgentCoreProvider', () => ({
  createPiAgentCoreProviderRuntime: (...args: unknown[]) => mockCreateRuntime(...args),
}));
jest.mock('../../../agentRuntime/engines/pi/piIntentTransport', () => ({
  runPiIntentTransport: (...args: unknown[]) => mockTransport(...args),
}));

import {testProviderConnection} from '../connectionTester';
import type {ProviderConfig} from '../types';

function deepseekPi(connection: Partial<ProviderConfig['connection']> = {}): ProviderConfig {
  return {
    id: 'p', name: 'DeepSeek Pi', category: 'official', type: 'deepseek', isActive: false,
    createdAt: '', updatedAt: '', models: {primary: 'deepseek-flash', light: 'deepseek-flash'},
    connection: {apiKey: 'sk-test', agentRuntime: 'pi-agent-core', openaiBaseUrl: 'https://api.deepseek.com/v1', ...connection},
  };
}

describe('Pi catalog-backed connection test', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateRuntime.mockResolvedValue({model: {id: 'deepseek-flash'}});
  });

  it('sends one real request through the Pi path analysis uses', async () => {
    mockTransport.mockResolvedValue({status: 'ok', text: 'OK'});

    const result = await testProviderConnection(deepseekPi());

    expect(result).toMatchObject({success: true, modelVerified: true});
    const [config, env] = mockCreateRuntime.mock.calls[0];
    expect(config).toMatchObject({catalog: {providers: ['deepseek'], id: 'deepseek-flash'}, apiKeyEnv: 'DEEPSEEK_API_KEY'});
    expect(env).toMatchObject({DEEPSEEK_API_KEY: 'sk-test'});
    expect(mockTransport).toHaveBeenCalledWith(expect.objectContaining({purpose: 'review', systemPrompt: ''}));
  });

  it('fails with the transport reason, and treats a blank model JSON as the catalog route', async () => {
    mockTransport.mockResolvedValue({status: 'unavailable', reason: 'provider_error'});

    const result = await testProviderConnection(deepseekPi({piAgentCoreModelJson: '   '}));

    expect(result).toMatchObject({success: false, error: expect.stringContaining('provider_error')});
    expect(mockCreateRuntime).toHaveBeenCalledTimes(1);
  });
});
