// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  buildQuickRunReceipt,
  hasBroadDiagnosticIntent,
  hasResolvedBoundedTarget,
  resolveQuickRunProfile,
  resolveQuickTurnBudget,
} from '../quickBudget';

const BUDGET = resolveQuickTurnBudget();

function profileFor(query: string, conversationTurns = 0, extended = false) {
  return resolveQuickRunProfile({query, conversationTurns, extended});
}

describe('hasBroadDiagnosticIntent', () => {
  it('detects why/root-cause/optimization asks in both languages', () => {
    expect(hasBroadDiagnosticIntent('为什么滑动卡')).toBe(true);
    expect(hasBroadDiagnosticIntent('what is the root cause')).toBe(true);
    expect(hasBroadDiagnosticIntent('怎么优化')).toBe(true);
  });

  it('does not fire on a plain factual lookup', () => {
    expect(hasBroadDiagnosticIntent('trace 时长是多少')).toBe(false);
    expect(hasBroadDiagnosticIntent('前台应用的包名是什么')).toBe(false);
  });
});

describe('hasResolvedBoundedTarget', () => {
  it('accepts an identifier carried by the query itself', () => {
    expect(hasResolvedBoundedTarget('frame 123 为什么卡顿', 0)).toBe(true);
    expect(hasResolvedBoundedTarget('why is `RecyclerView#onBind` slow', 0)).toBe(true);
  });

  it('accepts an anaphor only when prior turns can resolve it', () => {
    const query = '刚才那个最慢的帧，主线程哪个 slice 耗时最多？';
    expect(hasResolvedBoundedTarget(query, 1)).toBe(true);
    // Same words with no history are a dangling reference, not a boundary.
    expect(hasResolvedBoundedTarget(query, 0)).toBe(false);
  });

  it('does not treat a quoted scene word as a bounded target', () => {
    // Quoting a topic is not naming an occurrence.
    expect(hasResolvedBoundedTarget('why is "scrolling" slow', 0)).toBe(false);
    expect(hasResolvedBoundedTarget('分析"滑动"为什么慢', 0)).toBe(false);
    // A quoted symbol still counts.
    expect(hasResolvedBoundedTarget('why is `CustomScrollAdapter_continuousLoad` slow', 0))
      .toBe(true);
  });

  it('does not let a process or thread id bound a whole-run question', () => {
    // A pid says which process, not how much of the run is in scope.
    expect(hasResolvedBoundedTarget('process 123 为什么慢', 0)).toBe(false);
    expect(hasResolvedBoundedTarget('thread 17 root cause', 0)).toBe(false);
  });

  it('rejects a question with no entity noun to scope to', () => {
    expect(hasResolvedBoundedTarget('这个 trace 为什么卡', 3)).toBe(false);
    expect(hasResolvedBoundedTarget('为什么滑动卡', 3)).toBe(false);
  });
});

describe('resolveQuickRunProfile', () => {
  it('marks scene-wide diagnostics as triage', () => {
    expect(profileFor('这个 trace 为什么卡', 3)).toBe('triage');
    expect(profileFor('为什么滑动卡', 0)).toBe('triage');
    expect(profileFor('分析启动为什么慢', 0)).toBe('triage');
  });

  it('treats a whole-run thread question as scene-wide, not bounded', () => {
    // "主线程为什么慢" names an entity but scopes to the entire run.
    expect(profileFor('主线程为什么慢', 0)).toBe('triage');
  });

  it('keeps a bounded drill out of triage even though it says 慢', () => {
    // The real regression: a scoped follow-up was capped at the triage budget
    // purely because the substring 慢 appeared, then failed the quality gate.
    expect(profileFor('刚才那个最慢的帧，主线程具体在哪个 slice 上耗时最多？', 1))
      .toBe('normal');
    expect(profileFor('frame 123 为什么卡顿', 0)).toBe('normal');
  });

  it('keeps a quoted scene word in triage', () => {
    expect(profileFor('why is "scrolling" slow', 0)).toBe('triage');
  });

  it('keeps a whole-process diagnosis in triage even with a pid', () => {
    expect(profileFor('process 123 为什么慢', 0)).toBe('triage');
    expect(profileFor('thread 17 root cause', 2)).toBe('triage');
  });

  it('falls back to triage when the same drill has no history to anchor to', () => {
    expect(profileFor('刚才那个最慢的帧，主线程具体在哪个 slice 上耗时最多？', 0))
      .toBe('triage');
  });

  it('lets an explicit completeness request outrank a bounded target', () => {
    expect(profileFor('全面分析 frame 123', 1)).toBe('triage');
    expect(profileFor('给 frame 123 做完整诊断', 1)).toBe('triage');
    expect(profileFor('comprehensive analysis of frame 123', 1)).toBe('triage');
  });

  it('leaves non-diagnostic questions on the normal/extended track', () => {
    expect(profileFor('trace 时长是多少', 0)).toBe('normal');
    expect(profileFor('trace 时长是多少', 0, true)).toBe('extended');
  });

  it('ignores an empty or whitespace-only query', () => {
    expect(profileFor('   ', 0)).toBe('normal');
  });
});

describe('buildQuickRunReceipt profile resolution', () => {
  const base = {
    requestedMode: 'auto' as const,
    budget: BUDGET,
    actualTurns: 1,
    elapsedMs: 10,
    stopReason: 'answered' as const,
  };

  it('resolves the profile from the query and injected conversation turns', () => {
    expect(buildQuickRunReceipt({
      ...base,
      query: '刚才那个最慢的帧，主线程哪个 slice 耗时最多？',
      contextInjected: {conversationTurns: 2},
    }).profile).toBe('normal');

    expect(buildQuickRunReceipt({
      ...base,
      query: '刚才那个最慢的帧，主线程哪个 slice 耗时最多？',
    }).profile).toBe('triage');
  });

  it('still honors an explicitly supplied profile', () => {
    expect(buildQuickRunReceipt({
      ...base,
      profile: 'triage',
      query: 'trace 时长是多少',
    }).profile).toBe('triage');
  });

  it('defaults to normal when no query is supplied', () => {
    expect(buildQuickRunReceipt(base).profile).toBe('normal');
  });
});
