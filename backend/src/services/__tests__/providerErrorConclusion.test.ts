// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  looksLikeProviderErrorConclusion,
  runProducedAnalysisEvidence,
  terminationReasonForProviderFailure,
  type AnalysisRunEvidence,
} from '../finalResultQualityGate';

/** A run that never got off the ground — the shape a provider failure leaves. */
const NO_EVIDENCE: AnalysisRunEvidence = {
  toolCallCount: 0,
  evidenceFindingCount: 0,
  streamedAnswerChars: 0,
};
/** A run that queried the trace and got answers back. */
const WITH_EVIDENCE: AnalysisRunEvidence = {
  toolCallCount: 7,
  evidenceFindingCount: 3,
  streamedAnswerChars: 1840,
};

describe('runProducedAnalysisEvidence', () => {
  it('counts tool calls, evidence findings, or streamed prose', () => {
    expect(runProducedAnalysisEvidence(NO_EVIDENCE)).toBe(false);
    expect(runProducedAnalysisEvidence({ ...NO_EVIDENCE, toolCallCount: 1 })).toBe(true);
    expect(runProducedAnalysisEvidence({ ...NO_EVIDENCE, evidenceFindingCount: 1 })).toBe(true);
    expect(runProducedAnalysisEvidence({ ...NO_EVIDENCE, streamedAnswerChars: 1 })).toBe(true);
  });
});

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
  ])('recognises %s from a run that produced nothing', (text) => {
    expect(looksLikeProviderErrorConclusion(text, NO_EVIDENCE)).toBe(true);
  });

  /**
   * The decisive case. This product analyses traces, so `ECONNRESET`,
   * `socket hang up` and `Connection error` are things a trace *contains*.
   * A short answer about them is indistinguishable from a transport failure by
   * wording alone, which is why the run's own evidence decides authorship: a
   * run that dispatched tools and collected findings wrote this itself.
   */
  it.each([
    'ECONNRESET 出现 12 次，集中在 okhttp 线程的 socket 读取阶段。',
    'Connection error 在 3 处 binder 事务中被记录，均来自 NetworkStack。',
    'socket hang up 是本次抓取中最频繁的网络异常，共 47 次。',
    'ETIMEDOUT 占网络错误的 62%，主要发生在冷启动的首屏请求。',
    'rate limit exceeded 出现在应用自身的日志里，与 trace 采集无关。',
  ])('does not flag %s when the run collected evidence', (text) => {
    expect(looksLikeProviderErrorConclusion(text, WITH_EVIDENCE)).toBe(false);
  });

  it('treats tool calls alone as enough to establish authorship', () => {
    // A query can return no rows and still prove the model was working: it
    // dispatched the query. Only a run that did nothing could have had its
    // conclusion written for it.
    const text = 'ECONNRESET 出现 12 次，集中在 okhttp 线程的 socket 读取阶段。';
    expect(
      looksLikeProviderErrorConclusion(text, { ...NO_EVIDENCE, toolCallCount: 4 }),
    ).toBe(false);
    expect(looksLikeProviderErrorConclusion(text, NO_EVIDENCE)).toBe(true);
  });

  /**
   * An explanation of an error needs no tools and yields no findings, so
   * evidence counts alone would still misread it. The model streamed it, and a
   * failed provider streams nothing — that is the difference.
   */
  it.each([
    'ECONNRESET 表示对端重置了连接，通常出现在服务端主动关闭长连接时。',
    'Connection error 在 Android 上一般由网络切换或代理中断触发。',
    'socket hang up 指连接在收到响应前被关闭。',
  ])('does not flag the explanatory answer %s', (text) => {
    expect(
      looksLikeProviderErrorConclusion(text, { ...NO_EVIDENCE, streamedAnswerChars: text.length }),
    ).toBe(false);
  });

  it('still flags an error delivered whole, with nothing streamed', () => {
    // The terminal result carried the error; no tokens ever arrived.
    expect(
      looksLikeProviderErrorConclusion('Failed to authenticate: OAuth session expired.', NO_EVIDENCE),
    ).toBe(true);
  });

  it('does not flag a real report that discusses authentication', () => {
    const report = [
      '## 综合结论',
      '',
      '启动慢的根因是主线程在 bindApplication 阶段同步等待鉴权服务返回。',
      'Authentication failed 的重试被记录了 3 次，每次退避 800ms，共占用 2.4s。',
      '建议把鉴权改为异步，并对失败路径设置上限。',
    ].join('\n');
    expect(looksLikeProviderErrorConclusion(report, NO_EVIDENCE)).toBe(false);
  });

  it('does not flag a long narrative even without a heading', () => {
    expect(looksLikeProviderErrorConclusion('Connection error. '.repeat(40), NO_EVIDENCE)).toBe(false);
  });

  it('does not flag an ordinary conclusion', () => {
    expect(
      looksLikeProviderErrorConclusion('## 综合结论\n\n主线程负载过重导致掉帧。', NO_EVIDENCE),
    ).toBe(false);
  });

  it('does not flag empty text', () => {
    expect(looksLikeProviderErrorConclusion('', NO_EVIDENCE)).toBe(false);
    expect(looksLikeProviderErrorConclusion('   ', NO_EVIDENCE)).toBe(false);
  });
});

describe('terminationReasonForProviderFailure', () => {
  /**
   * A provider that dies mid-run leaves the plan unfinished and the turns
   * unspent, so these are already set by the time the failure is recognised.
   * Reporting them names the symptom and blames the run for the transport.
   */
  it.each(['plan_incomplete', 'max_turns', 'quality_gate_failed'] as const)(
    'replaces the consequence reason %s',
    (reason) => {
      expect(terminationReasonForProviderFailure(reason)).toBe('execution_error');
    },
  );

  it('replaces no reason at all', () => {
    expect(terminationReasonForProviderFailure(undefined)).toBe('execution_error');
  });

  /** These name a limit the run genuinely reached; the provider is not the cause. */
  it.each([
    'timeout',
    'max_budget_usd',
    'max_structured_output_retries',
    'execution_error',
  ] as const)('keeps the real limit %s', (reason) => {
    expect(terminationReasonForProviderFailure(reason)).toBe(reason);
  });
});
