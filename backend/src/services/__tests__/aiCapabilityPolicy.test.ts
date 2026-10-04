// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  AI_CAPABILITY_ENV_KEY,
  AiDisabledError,
  assertAiFeatureEnabled,
  isAiFeatureEnabled,
  resolveAiCapabilityPolicy,
} from '../aiCapabilityPolicy';

describe('aiCapabilityPolicy', () => {
  test('defaults to enabled when SMARTPERFETTO_AI_ENABLED is absent', () => {
    const policy = resolveAiCapabilityPolicy({});

    expect(policy).toMatchObject({
      schemaVersion: 1,
      aiEnabled: true,
      source: 'system_default',
    });
    expect(policy.blockedFeatures).toEqual([]);
    expect(isAiFeatureEnabled('agent_analyze', policy)).toBe(true);
    expect(isAiFeatureEnabled('critical_path_ai_summary', policy)).toBe(true);
  });

  test.each(['1', 'true', 'yes', 'on', 'enabled', ' TRUE '])(
    'accepts enabled value %s',
    (rawValue) => {
      const policy = resolveAiCapabilityPolicy({ [AI_CAPABILITY_ENV_KEY]: rawValue });

      expect(policy.aiEnabled).toBe(true);
      expect(policy.source).toBe('env');
      expect(policy.env).toEqual({
        key: AI_CAPABILITY_ENV_KEY,
        rawValue,
        valid: true,
      });
      expect(policy.blockedFeatures).toEqual([]);
    },
  );

  test.each(['0', 'false', 'no', 'off', 'disabled', ' OFF '])(
    'accepts disabled value %s and blocks model-backed features',
    (rawValue) => {
      const policy = resolveAiCapabilityPolicy({ [AI_CAPABILITY_ENV_KEY]: rawValue });

      expect(policy.aiEnabled).toBe(false);
      expect(policy.source).toBe('env');
      expect(policy.env).toEqual({
        key: AI_CAPABILITY_ENV_KEY,
        rawValue,
        valid: true,
      });
      expect(isAiFeatureEnabled('execute_sql', policy)).toBe(true);
      expect(isAiFeatureEnabled('invoke_deterministic_skill', policy)).toBe(true);
      expect(isAiFeatureEnabled('agent_analyze', policy)).toBe(false);
      expect(isAiFeatureEnabled('critical_path_ai_summary', policy)).toBe(false);
    },
  );

  test.each(['sometimes', '', '   '])(
    'fails closed for invalid explicit env value %s',
    (rawValue) => {
      const policy = resolveAiCapabilityPolicy({ [AI_CAPABILITY_ENV_KEY]: rawValue });

      expect(policy.aiEnabled).toBe(false);
      expect(policy.env).toEqual({
        key: AI_CAPABILITY_ENV_KEY,
        rawValue,
        valid: false,
      });
      expect(policy.disabledReason).toContain('invalid value');
    },
  );

  test('assertAiFeatureEnabled throws a stable AI_DISABLED error', () => {
    const policy = resolveAiCapabilityPolicy({ [AI_CAPABILITY_ENV_KEY]: 'false' });

    expect(() => assertAiFeatureEnabled('provider_test', policy)).toThrow(AiDisabledError);
    try {
      assertAiFeatureEnabled('provider_test', policy);
    } catch (error) {
      expect(error).toBeInstanceOf(AiDisabledError);
      const aiError = error as AiDisabledError;
      expect(aiError.code).toBe('AI_DISABLED');
      expect(aiError.retryable).toBe(false);
      expect(aiError.feature).toBe('provider_test');
      expect(aiError.policy.aiEnabled).toBe(false);
    }
  });
});
