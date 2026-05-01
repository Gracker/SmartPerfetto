// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type OutputLanguage = 'zh-CN' | 'en';

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'zh-CN';

export function parseOutputLanguage(value: unknown): OutputLanguage {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_OUTPUT_LANGUAGE;

  if (['en', 'en-us', 'en_us', 'english'].includes(normalized)) {
    return 'en';
  }

  if ([
    'zh',
    'zh-cn',
    'zh_cn',
    'cn',
    'chinese',
    'simplified-chinese',
    'simplified_chinese',
  ].includes(normalized)) {
    return 'zh-CN';
  }

  return DEFAULT_OUTPUT_LANGUAGE;
}

export function outputLanguageDisplayName(language: OutputLanguage): string {
  return language === 'en' ? 'English' : '简体中文';
}

export function localize(language: OutputLanguage, zh: string, en: string): string {
  return language === 'en' ? en : zh;
}
