// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  ENTERPRISE_FEATURE_FLAG_ENV,
  resolveFeatureConfig,
} from '../index';

describe('enterprise feature flag', () => {
  it('defaults enterprise mode off', () => {
    expect(resolveFeatureConfig({}).enterprise).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', 'enabled'])(
    'enables enterprise mode for %s',
    (value) => {
      expect(resolveFeatureConfig({ [ENTERPRISE_FEATURE_FLAG_ENV]: value }).enterprise).toBe(true);
    }
  );

  it.each(['0', 'false', 'FALSE', 'no', 'off', 'disabled'])(
    'keeps enterprise mode off for %s',
    (value) => {
      expect(resolveFeatureConfig({ [ENTERPRISE_FEATURE_FLAG_ENV]: value }).enterprise).toBe(false);
    }
  );

  it('does not enable enterprise mode for unknown values', () => {
    expect(resolveFeatureConfig({ [ENTERPRISE_FEATURE_FLAG_ENV]: 'enterprise' }).enterprise).toBe(false);
  });
});
