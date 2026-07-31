// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * queryComplexityClassifier follow-up unit tests
 *
 * Focus: narrow keyword pre-filter (confirm-short → quick) and semantic fallback.
 * The Haiku AI fallback is mocked to make tests deterministic and fast.
 *
 * Coverage (plan §9 testing strategy + Codex Q2 fix):
 *   - CONFIRM_KEYWORDS positive cases + length boundary
 *   - Hard rules (comparison only; selection is semantic context)
 *   - Priority: pure acknowledgement runs before comparison; bounded diagnosis goes through semantic AI classification
 */

import { jest, describe, it, expect } from '@jest/globals';

// Mock the Claude Agent SDK so no real network calls happen.
// Returns 'full' from Haiku fallback unless the prompt clearly asks for a
// bounded fact lookup. This keeps tests deterministic without bypassing the
// semantic classifier path.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn((args: { prompt?: string } = {}) => ({
    [Symbol.asyncIterator]: async function* () {
      const prompt = String(args.prompt ?? '');
      const query = prompt.match(/## 用户问题\n([\s\S]*?)\n\n## 输出格式/)?.[1]?.trim() ?? prompt;
      const quick = query.includes('rcustomscroller')
        || query.includes('滑动 FPS 是多少')
        || query.includes('滑动帧率是多少')
        || query.includes('为什么这段选区频率低')
        || query.includes('这个 slice 的 dur 为什么这么长')
        || query.includes('root cause for this rcustomscroller CPU placement');
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          complexity: quick ? 'quick' : 'full',
          reason: quick ? 'bounded factual follow-up' : 'ai-fallback-mock',
        }),
      };
    },
    close: jest.fn(),
  })),
}));

import {
  classifyQueryComplexity,
  isAcknowledgementFollowupReason,
} from '../queryComplexityClassifier';
import { SCROLLING_TRIAGE_LOOKUP_REASON } from '../quickScrollingTriageIntent';
import type { ComplexityClassifierInput } from '../types';

/** Build a ComplexityClassifierInput with sensible defaults; override only what the test cares about. */
function makeInput(override: Partial<ComplexityClassifierInput>): ComplexityClassifierInput {
  return {
    query: '',
    sceneType: 'general',
    hasSelectionContext: false,
    hasReferenceTrace: false,
    hasExistingFindings: false,
    hasPriorFullAnalysis: false,
    ...override,
  };
}

describe('classifyQueryComplexity — keyword pre-filter', () => {
  describe('CONFIRM_KEYWORDS in short query (<20 chars) → quick', () => {
    const cases = [
      '谢谢',
      '好的',
      '明白',
      '明白了',
      '嗯',
      '嗯嗯',
      '收到',
      '知道了',
      '了解了',
      'thanks',
      'ok',
      'OK.',
      'got it',
    ];
    it.each(cases)('classifies %p as quick even when prior full analysis exists', async (query) => {
      // hasPriorFullAnalysis=true proves the keyword pre-filter wins before semantic classification.
      const result = await classifyQueryComplexity(makeInput({ query, hasPriorFullAnalysis: true }));
      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/confirm-like follow-up/);
    });

    it('classifies pure acknowledgements as quick even in comparison sessions', async () => {
      const result = await classifyQueryComplexity(makeInput({
        query: '谢谢',
        hasReferenceTrace: true,
      }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/confirm-like follow-up/);
    });

    it.each([
      '收到，谢谢',
      '好的，谢谢',
      '收到、谢谢',
      '好的谢谢',
      'ok thanks',
      'okay, got it',
    ])('classifies pure acknowledgement sequences %p as quick', async (query) => {
      const result = await classifyQueryComplexity(makeInput({
        query,
        hasPriorFullAnalysis: true,
      }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/confirm-like follow-up/);
    });
  });

  it('long mixed confirm + diagnosis query skips confirm rule and falls through to semantic classification', async () => {
    // Contains "谢谢" (confirm) but is longer than a pure acknowledgement.
    const result = await classifyQueryComplexity(makeInput({
      query: '谢谢,请详细分析一下这次滑动卡顿的整体原因和优化方向',
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('short mixed confirm + diagnosis query skips acknowledgement rule and falls through to semantic classification', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '谢谢，为什么滑动卡',
      sceneType: 'scrolling',
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('short mixed confirm + factual follow-up does not become an acknowledgement direct answer', async () => {
    const cases = [
      '谢谢，那第几帧最卡？',
      'ok, what is the jank rate?',
      '好的，包名是什么？',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
        hasPriorFullAnalysis: true,
      }));

      expect(isAcknowledgementFollowupReason(result.reason)).toBe(false);
    }
  });

  it('long pure-confirm query (≥20 chars) skips confirm rule and falls through to semantic classification', async () => {
    const query = '非常感谢你，你的解释真的非常清楚，我完全明白了'; // 23 chars
    expect(query.length).toBeGreaterThanOrEqual(20);
    const result = await classifyQueryComplexity(makeInput({
      query,
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });
});

describe('classifyQueryComplexity — local scope rules and semantic fallback', () => {
  const neutralQuery = '随便问问'; // No drill-down or confirm keywords

  it('UI selection context is semantic context, not a local hard quick lock', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '这个 slice 的 dur 为什么这么长',
      hasSelectionContext: true,
      selectionContext: { kind: 'track_event', eventId: 123, ts: 1000 },
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/bounded factual follow-up/);
  });

  it('comparison mode (reference trace) → full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      hasReferenceTrace: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/comparison mode/);
  });

  it('classifies pure trace identity fact lookups as quick without AI classification', async () => {
    const cases = [
      '这个 trace 的应用包名和主要进程是什么？',
      '应用是什么？',
      '这个 trace 是哪个 app？',
      '这是什么 app？',
      '当前应用是谁？',
      '哪个应用在前台？',
      '这个 trace 是哪个进程？',
      '这个 trace 的进程是谁？',
      '当前进程是什么？',
      '进程是谁？',
      'package_name?',
      'canonical_package_name?',
      'process_name?',
      'main_process?',
      'main_process_name?',
      'recommended_process_name_param?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/trace identity fact lookup/);
    }
  });

  it('keeps English trace identity fact lookups on the local quick path', async () => {
    const cases = [
      'What are the package name and main process for this trace?',
      'which app is this trace from?',
      'what app is this?',
      'which application is this?',
      'what is the app package?',
      'which package?',
      'current package?',
      'what is the current package?',
      'foreground package?',
      'what is the foreground package?',
      'trace package?',
      'which process is this trace from?',
      'what process is this trace?',
      'what is the current process?',
      'current process?',
      'trace process?',
      'which package generated this trace?',
      'what package recorded this trace?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({ query }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/trace identity fact lookup/);
    }
  });

  it('separates process identity facts from process-list facts', async () => {
    const identityCases = [
      'process name?',
      'which process is this trace from?',
      'what process is this trace?',
      '进程名是什么？',
    ];
    const listCases = [
      'process names?',
      'show process names',
      'list processes',
      '进程名有哪些？',
      '有哪些进程名？',
    ];

    for (const query of identityCases) {
      const result = await classifyQueryComplexity(makeInput({ query }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/trace identity fact lookup/);
    }

    for (const query of listCases) {
      const result = await classifyQueryComplexity(makeInput({ query }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/trace fact lookup/);
    }
  });

  it('does not hard-route process diagnostic questions as identity fact lookups', async () => {
    const cases = [
      '这个主要进程为什么卡顿',
      'which app is slow?',
      'current package jank?',
      'what is the foreground package performance?',
      '为什么这个 app 卡？',
      '这个 trace 是哪个应用，有哪些问题？',
      'what app is this trace from and what problems does it have?',
      '哪个进程卡顿？',
      '当前进程为什么慢？',
      'what app is this and why is it slow?',
      'which process is slow and how many dropped frames?',
      '哪个进程卡顿，掉帧数是多少？',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route short Chinese stuckness wording as identity fact lookup', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '这个主要进程卡吗',
      sceneType: 'scrolling',
    }));

    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('classifies simple trace metric fact lookups as quick without AI classification', async () => {
    const cases = [
      '滑动 FPS 是多少',
      '这个 trace 录制时长多长？',
      '采样了多久？',
      '采样了多长时间？',
      '录屏多久？',
      '录屏时长？',
      '录屏时间范围？',
      '采样长度？',
      '这段性能数据多久？',
      'how long is this trace?',
      'how long was this trace recorded?',
      'recording length?',
      'recording duration?',
      'recording time?',
      'capture duration?',
      'trace time range?',
      'trace range?',
      '这个 trace 的起止时间是多少？',
      '这个 trace 的时间范围是多少？',
      'trace 时间范围？',
      'trace 范围？',
      'trace_bounds?',
      'trace bounds?',
      'trace_bounds 有吗？',
      'trace bounds table?',
      '这个 trace 什么时候开始？',
      'trace 开始？',
      '录制时间？',
      '采集范围？',
      '录制开始时间和结束时间是多少？',
      'what are the trace start and end timestamps?',
      '这个 trace 有采集错误吗？',
      '有没有解析错误？',
      '采集错误？',
      '解析错误？',
      'trace health?',
      'any trace health issues?',
      'how many trace errors?',
      '这个 trace 采集了哪些数据？',
      '这个 trace 有哪些数据源？',
      '有哪些数据源？',
      '有哪些表？',
      '表有哪些？',
      'available data sources?',
      'available tables?',
      'what data sources are available in this trace?',
      'slice_count?',
      'track_count?',
      'process_count?',
      'thread_count?',
      'process_track_count?',
      'thread_track_count?',
      'counter_sample_count?',
      'actual_frame_timeline_slice_count?',
      'counter_track?',
      'counter tracks?',
      'counter data?',
      'counters?',
      'counter table?',
      'counter rows?',
      'counter samples?',
      '这个 trace 有 FrameTimeline 数据吗？',
      '有 FrameTimeline 吗？',
      '有没有 actual_frame_timeline_slice 表？',
      'does this trace have FrameTimeline data?',
      'are there actual_frame_timeline_slice rows?',
      'frame_timeline rows?',
      'frame timeline count?',
      '这个 trace 观测到的刷新率是多少？',
      '当前 trace 的 VSync 周期是多少？',
      'what refresh rate is observed in this trace?',
      'what VSync period is detected in this trace?',
      'What is the refresh rate?',
      'refresh rate?',
      'VSync period?',
      'VSync?',
      'display refresh rate?',
      'screen Hz?',
      'current refresh rate?',
      'observed Hz?',
      '刷新率是多少？',
      '屏幕刷新率？',
      '检测到的刷新率？',
      '观测到的刷新率？',
      '推断刷新率？',
      '总帧数是多少？',
      '这个 trace 一共有多少帧？',
      '当前 trace 总帧数是多少？',
      'how many frames are in this trace?',
      '设备型号是什么？',
      'Android 版本是多少？',
      'Android SDK？',
      'SDK version?',
      '安卓版本是多少？',
      'SDK 版本是多少？',
      'SoC 是什么？',
      'SoC?',
      '芯片型号是什么？',
      '设备厂商是什么？',
      'device manufacturer?',
      'what is the SoC model?',
      'build fingerprint?',
      'Android build fingerprint?',
      'what is the build fingerprint?',
      'device fingerprint?',
      'build fingerprint 是什么？',
      '内核版本是多少？',
      'kernel release?',
      'system release?',
      'system machine?',
      'device architecture?',
      'CPU architecture?',
      'what architecture is this trace from?',
      '这个 trace 有没有掉帧？',
      '当前 trace 掉帧数是多少？',
      'overall trace jank rate?',
      '有没有掉帧？',
      'any jank?',
      'is there jank?',
      'was there any jank?',
      'jank present?',
      'jank detected?',
      'is there any jank in this trace?',
      'was there jank in the recording?',
      '掉帧数是多少？',
      'how many dropped frames?',
      'dropped frame count?',
      'janky frames count?',
      'jank frames?',
      'jank frame count?',
      'janky frames?',
      'dropped frames?',
      'frame drops?',
      'trace jank count?',
      'trace janky frames?',
      'trace dropped frames?',
      'trace frame drops?',
      'CPU 有几核？',
      'CPU 核心？',
      'CPU 核？',
      'cpu cores?',
      'CPU core?',
      'How many CPU cores are in this trace?',
      'cpu count?',
      'cpu rows?',
      'cpu table rows?',
      '这个 trace 有 CPU 频率数据吗？',
      '有 CPU 频率吗？',
      '有没有 cpufreq counters?',
      'does this trace have CPU frequency data?',
      '这个 trace 有功耗数据吗？',
      '有没有电量计数器？',
      'does this trace have power counters?',
      'are there battery counters?',
      'power rows?',
      'power samples?',
      'battery rows?',
      'battery samples?',
      'energy rows?',
      'charge samples?',
      '电量样本有多少？',
      '这个 trace 有内存数据吗？',
      '有没有内存计数器？',
      'does this trace have memory counters?',
      'are there memory metrics?',
      'memory rows?',
      'memory samples?',
      'rss rows?',
      'rss samples?',
      '内存样本有多少？',
      '有没有 OOM 数据？',
      '这个 trace 有调度数据吗？',
      '有没有 sched_slice 数据？',
      'sched?',
      'scheduler?',
      'sched_slice?',
      'thread_state?',
      'thread_state rows?',
      'thread_state count?',
      'runnable thread_state rows?',
      'how many runnable thread states?',
      'running thread_state count?',
      'thread_state D rows?',
      'thread_state S rows?',
      'sleeping thread_state rows?',
      'how many R+ thread states?',
      'preempted runnable thread states count?',
      'D state count?',
      'D-state count?',
      'R+ count?',
      'preempted runnable count?',
      'uninterruptible sleep count?',
      'runnable rows?',
      'D 状态行数？',
      'D 状态 thread_state 行数？',
      '睡眠 thread_state 行数？',
      'sched_slice rows?',
      'sched_slice count?',
      'sched rows?',
      'does this trace have scheduler data?',
      'are there thread_state events?',
      '这个 trace 有 GPU 数据吗？',
      '有没有 GPU counter？',
      'GPU 样本？',
      'GPU 样本数？',
      'does this trace have GPU data?',
      'are there GPU slices?',
      'gpu samples?',
      'gpu rows?',
      '这个 trace 有 slice 数据吗？',
      '有 slice 吗？',
      'slice 表有多少行？',
      'does this trace have slice rows?',
      'are there track tables?',
      '这个 trace 有网络包数据吗？',
      '有网络包吗？',
      '网络流量数据有多少？',
      'does this trace have network packets?',
      'how many android_network_packets rows are there?',
      'network traffic?',
      'network traffic data?',
      'network traffic rows?',
      'network traffic count?',
      'network data?',
      '网络数据？',
      '有没有网络数据？',
      'network events?',
      'network bytes?',
      'traffic bytes?',
      'network packet bytes?',
      '网络字节数？',
      'android network data?',
      'network rows?',
      'packet data?',
      'packets data?',
      'packet rows?',
      'packet count?',
      'packets?',
      '这个 trace 有 logcat 数据吗？',
      '有 logcat 吗？',
      'logcat 有吗？',
      'logcat 有多少条？',
      '有没有 android_logs 表？',
      'does this trace have logcat logs?',
      'how many android_logs rows are there?',
      'how many logcat errors?',
      'logcat error count?',
      'android_logs error rows?',
      'any logcat errors?',
      'logcat warnings count?',
      'errors in logcat?',
      'are there warnings in logcat?',
      'fatal in android logs?',
      'how many fatal logs?',
      'error logs?',
      '错误日志？',
      '有错误日志吗？',
      '有报错日志吗？',
      'log rows?',
      'logs?',
      '线程？',
      'threads?',
      'thread rows?',
      'thread table rows?',
      'threads count?',
      '有多少个线程？',
      '一共有多少个线程？',
      'how many threads are in this trace?',
      '焦点应用有多少线程？',
      '当前应用线程数量是多少？',
      'how many threads does the current app have?',
      '进程？',
      'processes?',
      'process rows?',
      'process table rows?',
      'processes count?',
      '这个 trace 有多少个进程？',
      '这个 trace 有哪些进程？',
      '列出进程',
      'how many processes are in this trace?',
      'which processes are in this trace?',
      'list processes',
      '焦点应用有多少进程？',
      '当前应用进程数量是多少？',
      'how many processes does the current app have?',
      'Binder 调用次数是多少？',
      'Binder 调用？',
      'Binder?',
      'android_binder_txns?',
      '有没有 Binder 调用？',
      '有 Binder 吗？',
      'how many Binder transactions?',
      'are there Binder transactions?',
      '有没有 ANR？',
      'ANR?',
      'android_anrs?',
      '有 ANR 吗？',
      'ANR 有吗？',
      'ANR 数量是多少？',
      '应用无响应？',
      '有没有应用无响应？',
      '无响应次数？',
      'how many ANRs are in this trace?',
      'are there any ANRs?',
      'app not responding?',
      'app not responding count?',
      '有没有启动事件？',
      '启动事件？',
      'android_startups?',
      '启动次数是多少？',
      'how many app launches are in this trace?',
      'app launches?',
      'are there startup events?',
      'startup events?',
      'startup data?',
      'launch data?',
      'app launch data?',
      'startup rows?',
      'startup table rows?',
      '启动时间？',
      '冷启动时间？',
      'launch time?',
      'cold launch time?',
      '启动耗时是多少？',
      '启动用了多久？',
      'launch duration?',
      'startup duration?',
      'how long did startup take?',
      '这个 trace 有几次滑动？',
      '有没有滑动？',
      '有滑动吗？',
      'scroll gestures?',
      'scroll rows?',
      'scrolls?',
      'how many scrolls?',
      'scroll table rows?',
      'swipes?',
      'swipe rows?',
      'how many scroll gestures are in this trace?',
      'are there scroll gestures?',
      '输入事件数量是多少？',
      'input 事件有多少？',
      '有没有 input 事件？',
      '有 input 事件吗？',
      '有没有触摸事件？',
      '输入事件？',
      '触摸事件？',
      '触摸次数？',
      'android_input_events?',
      'input rows?',
      'touch rows?',
      'key rows?',
      'how many input events are in this trace?',
      'are there touch events?',
      'are there key events?',
      'key presses?',
      'keyboard events?',
      '按键次数是多少？',
      '键盘事件？',
      'touches?',
      'touches count?',
      'how many touches?',
      'android input MOTION events?',
      'motion events?',
      'motion count?',
      'MOTION rows?',
      'MOTION 事件数量？',
      'how many MOTION events are in this trace?',
      '有多少个 MOTION 事件？',
      '有多少个触摸 MOTION 事件？',
      '这是什么手机？',
      '哪台手机录的？',
      'what phone model is this trace from?',
      'which phone is this?',
      '卡顿率是多少？',
      '卡顿比例是多少？',
      'jank rate?',
      'jank percentage?',
      'what is the jank rate?',
      'what percentage of frames are janky?',
      'dropped frame rate?',
      '这个 trace 掉帧吗？',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/trace fact lookup/);
    }
  });

  it('does not hard-route ambiguous timing words without trace or recording context', async () => {
    const cases = [
      'duration?',
      '多长时间？',
      '时间范围？',
      'start time?',
      'end time?',
      'recording latency?',
      'trace_bounds latency?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('classifies selected-range duration lookups as quick only when selection context exists', async () => {
    const selected = await classifyQueryComplexity(makeInput({
      query: '这个选区多长？',
      hasSelectionContext: true,
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1_000_000_000,
        endNs: 3_500_000_000,
      },
    }));

    expect(selected.complexity).toBe('quick');
    expect(selected.source).toBe('hard_rule');
    expect(selected.reason).toMatch(/trace fact lookup/);

    const unselected = await classifyQueryComplexity(makeInput({
      query: '这个选区多长？',
    }));

    expect(unselected.complexity).toBe('full');
    expect(unselected.source).toBe('ai');
    expect(unselected.reason).toMatch(/ai-fallback-mock/);
  });

  it('does not hard-route blocked-thread count questions as total thread-count facts', async () => {
    const cases = [
      '有多少个线程卡住？',
      'blocked thread count?',
      'thread count high?',
      'threads count high?',
      'too many threads?',
      '线程数过高吗？',
      'how many threads are blocked?',
      'how many D thread states are blocked?',
      'how many S thread states are blocked?',
      'how many I thread states are blocked?',
      '线程为什么卡？',
      'blocked threads?',
      'thread rows blocked?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route process diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '有多少个进程卡住？',
      '哪些进程卡顿？',
      'which process is slow?',
      'how many processes are blocked?',
      'process count high?',
      'processes count high?',
      'too many processes?',
      '进程数过高吗？',
      '进程为什么卡？',
      'blocked processes?',
      'process rows latency?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route trace health diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么 trace 有采集错误？',
      '怎么修复 trace health issue?',
      'analyze trace errors',
      'why are there trace health issues?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route trace data diagnostics as simple inventory lookups', async () => {
    const cases = [
      '这个 trace 有哪些问题？',
      '分析这个 trace 的数据源缺失原因',
      '数据源有什么问题？',
      '有哪些表为什么缺失？',
      'what data sources are missing and why is the trace slow?',
      'counter_track latency?',
      'why are counters high?',
      'counter values high?',
      'counterbalance?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route Binder diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '有没有 Binder 阻塞？',
      'how many Binder calls are blocking?',
      'Binder latency?',
      'android_binder_txns latency?',
      'Binder 为什么慢？',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route ambiguous refresh-rate policy questions as simple trace fact lookups', async () => {
    const cases = [
      'Does this device support variable refresh rate?',
      '分析刷新率策略',
      'why does refresh rate switch?',
      'display refresh rate policy?',
      'why is display refresh rate switching?',
      'screen refresh rate jank?',
      '屏幕刷新率异常吗？',
      '检测到的刷新率为什么切换？',
      '刷新率策略？',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route CPU frequency diagnostics as simple trace fact lookups', async () => {
    const cases = [
      'CPU 频率为什么低？',
      '分析 DVFS 升频不足',
      'why is CPU frequency low?',
      'diagnose cpufreq throttling',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route generic CPU diagnostics as simple trace fact lookups', async () => {
    const cases = [
      'CPU?',
      'CPU 慢？',
      'CPU 为什么慢？',
      'cpu throttling?',
      'cpu count high?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route power diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么耗电高？',
      '分析功耗',
      'power high?',
      'battery drain?',
      'power consumption high?',
      'energy consumption high?',
      'why is battery drain high?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route memory diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么内存高？',
      '分析内存泄漏',
      'memory usage?',
      'memory high?',
      'memory leak?',
      'memory pressure?',
      'rss high?',
      'why is memory usage high?',
      'OOM 原因是什么？',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route scheduler diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么调度延迟高？',
      '分析调度问题',
      'scheduler latency?',
      'why is runnable time high?',
      'runnable rows high?',
      'runnable thread_state latency?',
      'why D state?',
      'D state blocking?',
      'high D state count?',
      'thread_state latency?',
      'blocked thread_state reason?',
      'sched_slice 为什么慢？',
      'thread_state rows latency?',
      'sched rows latency?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route GPU diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么 GPU 慢？',
      '分析 GPU 瓶颈',
      'GPU jank?',
      'why is GPU utilization high?',
      'gpu rows high?',
      'GPU 样本异常吗？',
      'GPU 利用率高吗？',
      'gpu samples high?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route FrameTimeline diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么 FrameTimeline 卡顿？',
      '分析 FrameTimeline 掉帧',
      'why is FrameTimeline jank high?',
      'frame_timeline rows slow?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route generic slice diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么 slice 很慢？',
      '分析 slice 耗时',
      'why are slices slow?',
      'why is the longest slice slow?',
      '分析最长 slice 的原因',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it.each([
    'summarize top-5 longest process slices',
    'top 5 long slices in current selection',
    'show top 10 slices by longest duration',
    '列出前 5 个耗时最长的进程 slice',
    '最长 process slices 是哪些？',
  ])('hard-routes deterministic longest-slice lookup %p to quick trace facts', async (query) => {
    const result = await classifyQueryComplexity(makeInput({
      query,
      sceneType: 'general',
    }));

    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('hard_rule');
    expect(result.reason).toMatch(/trace fact lookup/);
  });

  it('does not hard-route network diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么网络慢？',
      '分析网络流量高',
      'network traffic is high',
      'network traffic high?',
      'network bytes high?',
      '网络数据慢吗？',
      '网络数据异常吗？',
      'why are requests slow?',
      'diagnose DNS TLS TTFB latency',
      'packet?',
      'network rows slow?',
      '丢包?',
      'packet loss?',
      'packet drop?',
      'dropped packets?',
      'packet retransmission?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'network',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route Logcat diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么 logcat 报错？',
      '为什么有 logcat 报错？',
      'logcat 有什么问题？',
      'analyze logcat errors',
      'diagnose logcat warnings',
      'why are there logcat errors?',
      'why errors in logcat?',
      '错误日志为什么发生？',
      '错误日志很多吗？',
      '警告日志很多吗？',
      'logcat warnings latency?',
      'warnings?',
      'logcat cause?',
      'log?',
      'log rows errors?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route phone diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '手机为什么慢？',
      'what phone is slow?',
      'Android 版本有什么问题？',
      'SDK version issue?',
      'SoC performance?',
      'what problem does this Android version cause?',
      'does build fingerprint affect performance?',
      'does this SoC support 64-bit?',
      'architecture bottleneck?',
      'does this device architecture support 64-bit?',
      'build fingerprint why?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route jank percentage diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么卡顿比例高？',
      '卡顿率高吗？',
      '掉帧率高吗？',
      'why is the jank percentage high?',
      'jank rate high?',
      'dropped frame rate high?',
      'jank frames high?',
      'janky frames normal?',
      'dropped frames high?',
      'frame drops high?',
      'is there serious jank?',
      'jank count normal?',
      'why are there dropped frames?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('hard-routes explicit scrolling triage overview questions without model classification', async () => {
    const cases = [
      'scroll jank overview and smoothness',
      'quick scroll triage',
      '快速看一下滑动卡不卡，FPS 怎么样',
      '滑动流畅度概览',
      '看一下滑动整体表现',
      'scrolling smoothness summary',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toBe(SCROLLING_TRIAGE_LOOKUP_REASON);
    }
  });

  it('keeps causal scrolling diagnostics out of the scrolling triage hard rule', async () => {
    const cases = [
      'why is scrolling janky?',
      'scrolling jank root cause',
      '为什么滑动卡顿？',
      '滑动卡顿原因是什么？',
      'diagnose scrolling jank',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route ANR diagnostics as simple trace fact lookups', async () => {
    const cases = [
      'ANR 原因是什么？',
      'ANR cause?',
      'ANR reason?',
      '有 ANR 为什么卡死？',
      '分析 ANR',
      'why did this ANR happen?',
      'android_anrs why?',
      'ANR main thread deadlock?',
      '应用无响应为什么？',
      '应用无响应原因是什么？',
      'why did app not responding happen?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'anr',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route English causal wording as simple trace fact lookups', async () => {
    const cases = [
      'binder cause?',
      'binder reason?',
      'input event cause?',
      'touch event reason?',
      'logcat cause?',
      'network packets reason?',
      'slice cause?',
      'cpu frequency reason?',
      'FrameTimeline cause?',
      'trace health reason?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'general',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route startup diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '启动耗时高吗？',
      '启动开始时间是多少？',
      '启动结束时间是多少？',
      '启动时间正常吗？',
      '分析启动性能',
      'why is startup slow?',
      'startup?',
      'launches?',
      'startup start time?',
      'startup end time?',
      'launch time normal?',
      'startup latency?',
      'startup duration high?',
      'android_startups latency?',
      'startup rows latency?',
      'app launches latency?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'startup',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route scroll diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '为什么滑动卡？',
      '分析滑动性能',
      '滑动延迟是多少？',
      'why is scrolling slow?',
      'scroll latency?',
      'scroll rows latency?',
      'scroll count high?',
      'why scrolls?',
      'scroll gestures high?',
      'scroll gestures latency?',
      'swipe rows high?',
      'why are scroll gestures slow?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route input diagnostics as simple trace fact lookups', async () => {
    const cases = [
      '输入延迟是多少？',
      '分析输入事件',
      '触摸事件为什么慢？',
      '触摸延迟多少？',
      'why are touch events slow?',
      'input latency?',
      'motion event latency?',
      'motion events latency?',
      'why motion events?',
      'motion events delayed?',
      'why are motion events slow?',
      'analyze input motion latency',
      'how many MOTION events caused dropped frames?',
      'how many motion events caused frame drops?',
      '有多少个 MOTION 事件导致掉帧？',
      'motion jank?',
      'android_input_events latency?',
      'input rows latency?',
      'touch rows latency?',
      'key rows slow?',
      'key presses latency?',
      'why key presses?',
      'keyboard events slow?',
      'touches slow?',
      'why touches?',
      'how many touches caused frame drops?',
      'tap count?',
      'button press count?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('does not hard-route trace metric diagnostics as simple fact lookups', async () => {
    const cases = [
      '分析这个 trace 的总帧数变化并给优化建议',
      'FPS low?',
      'frame rate low?',
      'is FPS low?',
      '帧率低吗？',
      '录屏时长异常吗？',
      '录屏时长为什么异常？',
      'total frames high?',
      'frame count high?',
    ];

    for (const query of cases) {
      const result = await classifyQueryComplexity(makeInput({
        query,
        sceneType: 'scrolling',
      }));

      expect(result.complexity).toBe('full');
      expect(result.source).toBe('ai');
      expect(result.reason).toMatch(/ai-fallback-mock/);
    }
  });

  it('comparison mode still wins over identity fact lookups', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '这两个 trace 的包名是什么？',
      hasReferenceTrace: true,
    }));

    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/comparison mode/);
  });

  it('prior findings are context for semantic classification, not an automatic full lock', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      hasExistingFindings: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('prior full analysis is context for semantic classification, not an automatic full lock', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('implicit frame timeline follow-up after findings is decided by semantic classification', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '能不能在timeline中标出这一帧',
      hasExistingFindings: true,
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('selection context does not inherit prior full continuity by itself', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '为什么这段选区频率低',
      hasSelectionContext: true,
      selectionContext: { kind: 'area', startNs: 100, endNs: 200 },
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/bounded factual follow-up/);
  });

  it('selection context allows broad scoped diagnosis to remain full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '分析这段滑动性能并给优化建议',
      sceneType: 'scrolling',
      hasSelectionContext: true,
      selectionContext: { kind: 'track_event', eventId: 123, ts: 1000 },
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('deterministic scene (scrolling) is decided by semantic classification', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      sceneType: 'scrolling',
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('AI classifier keeps explicit thread placement and frequency follow-up quick after prior analysis', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '上面 rcustomscroller 这个线程的核心摆放和 running 时候对应的频率是多少',
      hasPriorFullAnalysis: true,
      previousQueries: ['找到 Trace 里面 running time 排名前十的线程，从大到小排序'],
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/bounded factual follow-up/);
  });

  it('local trace fact rule keeps explicit scrolling metric lookup quick even for scrolling scene', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '滑动 FPS 是多少',
      sceneType: 'scrolling',
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('hard_rule');
    expect(result.reason).toMatch(/trace fact lookup/);
  });

  it('AI classifier keeps bounded root-cause wording quick when target is a specific thread', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: 'root cause for this rcustomscroller CPU placement',
      hasPriorFullAnalysis: true,
      previousQueries: ['上面 rcustomscroller 这个线程的核心摆放和 running 时候对应的频率是多少'],
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/bounded factual follow-up/);
  });

  it('AI classifier keeps bounded why questions quick when target is a selected range', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '为什么这段选区频率低',
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/bounded factual follow-up/);
  });

  it('AI classifier keeps bounded why questions quick when target is a concrete slice', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '这个 slice 的 dur 为什么这么长',
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/bounded factual follow-up/);
  });

  it('non-deterministic scene (memory) with no other hints → Haiku fallback', async () => {
    // Scene labels are context for the semantic classifier; they no longer
    // bypass it before the model can read the current question intent.
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      sceneType: 'memory',
    }));
    expect(result.source).toBe('ai'); // Mocked Haiku returns 'full', but via AI path.
  });
});

describe('classifyQueryComplexity — priority ordering', () => {
  it('selection context keeps bounded diagnostic wording on the semantic quick path', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '为什么这段选区频率低',
      hasSelectionContext: true,
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 100,
        endNs: 200,
      },
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('quick');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/bounded factual follow-up/);
  });

  it('comparison mode still wins over selection context', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '对比这段为什么变慢',
      hasReferenceTrace: true,
      hasSelectionContext: true,
      selectionContext: { kind: 'area', startNs: 100, endNs: 200 },
    }));
    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/comparison mode/);
  });

  it('scene-level why question is decided by semantic classification and remains full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '为什么滑动卡',
      sceneType: 'scrolling',
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('broad scrolling analysis remains full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '分析滑动性能',
      sceneType: 'scrolling',
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('ai');
    expect(result.reason).toMatch(/ai-fallback-mock/);
  });

  it('confirm keyword overrides hasPriorFullAnalysis (Codex Q2 fix)', async () => {
    // Central fix: a pure "谢谢" follow-up must not inherit full mode from the previous turn.
    const result = await classifyQueryComplexity(makeInput({
      query: '谢谢',
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('quick');
    expect(result.reason).toMatch(/confirm-like follow-up/);
  });
});
