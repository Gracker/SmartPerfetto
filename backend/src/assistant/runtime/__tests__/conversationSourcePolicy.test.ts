// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  CONVERSATION_SOURCE_ENRICHMENT_BUDGET,
  resolvePrimaryConversationSourceUse,
  shouldStartAutomaticSourceEnrichment,
} from '../conversationSourcePolicy';

describe('conversationSourcePolicy', () => {
  it.each([
    '为什么这次启动很慢？',
    '分析主线程卡顿的主要原因',
    'What caused the startup slowdown?',
    '这个数据的来源是什么？',
  ])('keeps authorized source dormant for an ordinary analysis question: %s', (query) => {
    expect(resolvePrimaryConversationSourceUse({
      query,
      hasAuthorizedCodebase: true,
    })).toBe('dormant');
  });

  it.each([
    '结合源码看看 Choreographer#doFrame 为什么慢',
    '这个函数的调用链是什么？',
    'Which source file implements recoverDatabase?',
    'Show me the code path for Foo::bar',
    'recoverRetryProbeDatabase 为什么返回 restore snapshot？',
    'android.view.Choreographer#doFrame 是在哪里实现的？',
  ])('uses bounded source for an explicit source question: %s', (query) => {
    expect(resolvePrimaryConversationSourceUse({
      query,
      hasAuthorizedCodebase: true,
    })).toBe('explicit');
  });

  it('does not activate source when no codebase is authorized', () => {
    expect(resolvePrimaryConversationSourceUse({
      query: '看看源码里的 Foo#bar',
      hasAuthorizedCodebase: false,
    })).toBe('dormant');
  });

  it('starts automatic enrichment only for a narrow trace-backed code anchor', () => {
    const common = {
      hasAuthorizedCodebase: true,
      traceAttached: true,
      primarySourceUse: 'dormant' as const,
      outcomeKind: 'answered' as const,
    };

    expect(shouldStartAutomaticSourceEnrichment({
      ...common,
      evidence: [{id: 'ev-1', label: 'android.view.Choreographer#doFrame', source: 'sql'}],
    })).toBe(true);
    expect(shouldStartAutomaticSourceEnrichment({
      ...common,
      evidence: [{id: 'ev-2', label: 'Main thread busy', source: 'sql'}],
    })).toBe(false);
    expect(shouldStartAutomaticSourceEnrichment({
      ...common,
      traceAttached: false,
      evidence: [{id: 'ev-3', label: 'Foo::bar', source: 'trace'}],
    })).toBe(false);
    expect(shouldStartAutomaticSourceEnrichment({
      ...common,
      primarySourceUse: 'explicit',
      evidence: [{id: 'ev-4', label: 'Foo::bar', source: 'trace'}],
    })).toBe(false);
    expect(shouldStartAutomaticSourceEnrichment({
      ...common,
      evidence: [{id: 'ev-5', label: 'com.example.app startup regression', source: 'trace'}],
    })).toBe(false);
    expect(shouldStartAutomaticSourceEnrichment({
      ...common,
      evidence: [{id: 'ev-6', label: 'Main thread in com.tencent.mm is blocked', source: 'trace'}],
    })).toBe(false);
    expect(shouldStartAutomaticSourceEnrichment({
      ...common,
      evidence: [{id: 'ev-7', label: 'app/src/Foo.kt:L42', source: 'trace'}],
    })).toBe(true);
  });

  it.each(['needs_user_input', 'recommend_full', 'cancelled'] as const)(
    'does not start automatic enrichment for a %s primary outcome',
    (outcomeKind) => {
      expect(shouldStartAutomaticSourceEnrichment({
        hasAuthorizedCodebase: true,
        traceAttached: true,
        primarySourceUse: 'dormant',
        outcomeKind,
        evidence: [{id: 'ev-1', label: 'Foo#bar', source: 'trace'}],
      })).toBe(false);
    },
  );

  it('uses the agreed hard source enrichment budget', () => {
    expect(CONVERSATION_SOURCE_ENRICHMENT_BUDGET).toEqual({
      maxSearchCalls: 1,
      maxReadCalls: 2,
      maxDurationMs: 6_000,
    });
  });
});
