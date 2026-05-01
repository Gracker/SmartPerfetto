// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { localize, parseOutputLanguage } from '../outputLanguage';

describe('outputLanguage', () => {
  it('defaults to Simplified Chinese', () => {
    expect(parseOutputLanguage(undefined)).toBe('zh-CN');
    expect(parseOutputLanguage('')).toBe('zh-CN');
    expect(parseOutputLanguage('unsupported')).toBe('zh-CN');
  });

  it('accepts common English aliases', () => {
    expect(parseOutputLanguage('en')).toBe('en');
    expect(parseOutputLanguage('en-US')).toBe('en');
    expect(parseOutputLanguage('english')).toBe('en');
  });

  it('accepts common Chinese aliases', () => {
    expect(parseOutputLanguage('zh')).toBe('zh-CN');
    expect(parseOutputLanguage('zh-CN')).toBe('zh-CN');
    expect(parseOutputLanguage('simplified_chinese')).toBe('zh-CN');
  });

  it('selects localized text', () => {
    expect(localize('zh-CN', '中文', 'English')).toBe('中文');
    expect(localize('en', '中文', 'English')).toBe('English');
  });
});
