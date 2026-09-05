// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { looksLikeProviderErrorConclusion } from '../finalResultQualityGate';

describe('looksLikeProviderErrorConclusion', () => {
  /**
   * A provider can answer with an error string in the success channel, and it
   * then flows through as if it were analysis. Observed for real: an expired
   * OAuth session became the conclusion, the timeline announced a conclusion
   * had been generated, and the correction loop spent both of its attempts
   * re-asking a provider that could not answer.
   */
  it.each([
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Authentication failed: invalid credentials',
    'Invalid API key provided',
    'Insufficient quota for this request',
    'Rate limit exceeded, please retry later',
    'Claude Code returned an error result: session expired',
    'Connection error.',
    'socket hang up',
  ])('recognises %s', (text) => {
    expect(looksLikeProviderErrorConclusion(text)).toBe(true);
  });

  it('does not flag a real report that discusses authentication', () => {
    const report = [
      '## 综合结论',
      '',
      '启动慢的根因是主线程在 bindApplication 阶段同步等待鉴权服务返回。',
      'Authentication failed 的重试被记录了 3 次，每次退避 800ms，共占用 2.4s。',
      '建议把鉴权改为异步，并对失败路径设置上限。',
    ].join('\n');
    expect(looksLikeProviderErrorConclusion(report)).toBe(false);
  });

  it('does not flag a long narrative even without a heading', () => {
    expect(looksLikeProviderErrorConclusion('Connection error. '.repeat(40))).toBe(false);
  });

  it('does not flag an ordinary conclusion', () => {
    expect(looksLikeProviderErrorConclusion('## 综合结论\n\n主线程负载过重导致掉帧。')).toBe(false);
  });

  it('does not flag empty text', () => {
    expect(looksLikeProviderErrorConclusion('')).toBe(false);
    expect(looksLikeProviderErrorConclusion('   ')).toBe(false);
  });
});
