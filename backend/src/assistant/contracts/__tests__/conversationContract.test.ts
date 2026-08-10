// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildConversationPrompt,
  parseConversationResponse,
} from '../conversationContract';

describe('conversation contract', () => {
  it('builds distinct attached and no-trace instructions without a short fixed budget', () => {
    const noTrace = buildConversationPrompt({
      question: '怎么定位滑动卡顿？',
      history: [],
      traceContext: {kind: 'none'},
    });
    const attached = buildConversationPrompt({
      question: '这个线程为什么阻塞？',
      history: [{role: 'user', content: '先看主线程'}],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    expect(noTrace).toContain('当前没有附加 Trace');
    expect(noTrace).toContain('不要调用 Trace 工具');
    expect(attached).toContain('当前已附加 Trace（ID: trace-1）');
    expect(attached).toContain('用户：先看主线程');
    expect(attached).not.toMatch(/15\s*秒|两轮工具|2\s*次工具/);
  });

  it('strips the control marker and returns a logical clarification pause', () => {
    expect(parseConversationResponse(
      '我可以先确认目标。\n<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"你更关心首帧还是可交互时间？"} -->',
      '原问题',
    )).toEqual({
      kind: 'needs_user_input',
      message: '我可以先确认目标。',
      question: '你更关心首帧还是可交互时间？',
      evidence: [],
    });
  });

  it('keeps a structured full-analysis handoff without upgrading', () => {
    const outcome = parseConversationResponse(
      '这个问题需要完整诊断。\n<!-- smartperfetto:conversation-control {"kind":"recommend_full","handoff":{"question":"为什么卡顿","scope":"完整滑动场景","assumptions":["关注当前应用"],"evidence":[]}} -->',
      'fallback',
      [{id: 'ev-1', label: '帧统计'}],
    );

    expect(outcome).toMatchObject({
      kind: 'recommend_full',
      message: '这个问题需要完整诊断。',
      handoff: {
        question: '为什么卡顿',
        scope: '完整滑动场景',
        assumptions: ['关注当前应用'],
        evidence: [{id: 'ev-1', label: '帧统计'}],
      },
    });
  });

  it('only accepts handoff evidence backed by the current runtime evidence', () => {
    const authoritativeEvidence = [{
      id: 'ev-1',
      label: '真实帧统计',
      source: 'runtime-finding',
    }];
    const outcome = parseConversationResponse(
      '建议进入完整分析。\n<!-- smartperfetto:conversation-control {"kind":"recommend_full","handoff":{"question":"为什么卡顿","scope":"完整滑动场景","assumptions":[],"evidence":[{"id":"ev-1","label":"模型改写的标签","source":"model-claim"},{"id":"fake-1","label":"模型编造的证据"}]}} -->',
      'fallback',
      authoritativeEvidence,
    );

    expect(outcome).toMatchObject({
      kind: 'recommend_full',
      handoff: {evidence: authoritativeEvidence},
    });
  });

  it('falls back to runtime evidence when the handoff only requests unknown ids', () => {
    const authoritativeEvidence = [{id: 'ev-1', label: '真实帧统计'}];
    const outcome = parseConversationResponse(
      '建议进入完整分析。\n<!-- smartperfetto:conversation-control {"kind":"recommend_full","handoff":{"question":"为什么卡顿","scope":"完整滑动场景","assumptions":[],"evidence":[{"id":"fake-1","label":"模型编造的证据"}]}} -->',
      'fallback',
      authoritativeEvidence,
    );

    expect(outcome).toMatchObject({
      kind: 'recommend_full',
      handoff: {evidence: authoritativeEvidence},
    });
  });
});
