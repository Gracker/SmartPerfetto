// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  PRIOR_EVIDENCE_ONLY_FOLLOWUP_REASON,
  TRACE_FACT_LOOKUP_REASON,
} from '../../agentv3/queryComplexityClassifier';
import {
  deriveRuntimeQuickPreEvidenceFlags,
  resolveRuntimeQuickMode,
} from '../quickModeResolution';

describe('resolveRuntimeQuickMode', () => {
  it('skips all new trace preflights for an explicit prior-evidence-only follow-up', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '只基于上一条已经给出的刷新率回答，不要重新分析，也不要调用工具。',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [{query: '这个 trace 的刷新率是多少？'}],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      localReason: PRIOR_EVIDENCE_ONLY_FOLLOWUP_REASON,
      quickAcknowledgementDirectAnswer: false,
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('derives mixed AI-fallback trace fact plus scrolling flags from the shared helper', () => {
    const flags = deriveRuntimeQuickPreEvidenceFlags({
      query: '总帧数是多少？整体流畅吗？',
      hasReferenceTrace: false,
      directEvidenceEligibleQuickMode: true,
      complexity: 'quick',
      reason: TRACE_FACT_LOOKUP_REASON,
    });

    expect(flags).toMatchObject({
      quickTraceFactPreEvidence: true,
      quickScrollingTriagePreEvidence: true,
      quickProcessIdentityPreEvidence: false,
      quickFocusAppPreEvidence: false,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('routes pure acknowledgement sequences to direct quick acknowledgement answers', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'ok thanks',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: true,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
    });
  });

  it('keeps conversation turns model-driven and defers all evidence lookup until requested', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'ok thanks, what should we discuss next?',
      sceneType: 'general',
      analysisMode: 'fast',
      conversationSurface: true,
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('does not treat mixed acknowledgement plus fact requests as acknowledgement direct answers', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'ok, what is the jank rate?',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
    });
  });

  it('routes English jank presence/count questions through quick trace fact pre-evidence', () => {
    for (const query of [
      'any jank?',
      'is there jank?',
      'was there any jank?',
      'jank present?',
      'jank detected?',
      'how many dropped frames?',
      'jank frames?',
      'jank frame count?',
      'janky frames?',
      'dropped frames?',
      'frame drops?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickAcknowledgementDirectAnswer: false,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes mixed identity plus metric fact questions through both direct evidence paths', () => {
    for (const query of [
      'what app is this and what is the jank rate?',
      'app and jank rate?',
      'which process and how many dropped frames?',
      '进程和掉帧数是多少？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickAcknowledgementDirectAnswer: false,
        quickProcessIdentityPreEvidence: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('keeps reference-trace comparisons off single-trace quick pre-evidence paths', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'which process and how many dropped frames?',
      sceneType: 'scrolling',
      analysisMode: 'fast',
      hasReferenceTrace: true,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps reference-trace scrolling overviews off the scrolling triage direct path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'scroll jank overview and smoothness',
      sceneType: 'scrolling',
      analysisMode: 'fast',
      hasReferenceTrace: true,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickScrollingTriagePreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes package-origin identity questions through process identity pre-evidence', () => {
    for (const query of [
      'which package generated this trace?',
      'package_name?',
      'canonical_package_name?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickAcknowledgementDirectAnswer: false,
        quickProcessIdentityPreEvidence: true,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('keeps identity-only process questions on process identity evidence only', () => {
    for (const query of [
      'process name?',
      'which process is this trace from?',
      'what process is this trace?',
      '进程名是什么？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickAcknowledgementDirectAnswer: false,
        quickProcessIdentityPreEvidence: true,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes process-list questions through trace fact evidence without process identity evidence', () => {
    for (const query of [
      'process names?',
      'show process names',
      'list processes',
      '进程名有哪些？',
      '有哪些进程名？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickAcknowledgementDirectAnswer: false,
        quickProcessIdentityPreEvidence: false,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps mixed identity plus diagnostic questions out of runtime quick mode', () => {
    for (const query of [
      'what app is this and why is it slow?',
      'which process is slow and how many dropped frames?',
      '哪个进程卡顿，掉帧数是多少？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickProcessIdentityPreEvidence: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('keeps frame and jank metric evaluation questions out of the hard-rule quick path', () => {
    for (const query of [
      'FPS low?',
      'frame rate low?',
      'is FPS low?',
      '帧率低吗？',
      'jank rate high?',
      'dropped frame rate high?',
      'jank frames high?',
      'janky frames normal?',
      'dropped frames high?',
      'frame drops high?',
      'is there serious jank?',
      'jank count normal?',
      '卡顿率高吗？',
      '掉帧率高吗？',
      'total frames high?',
      'frame count high?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes explicit trace-wide jank questions through the full preflight skip path', () => {
    for (const query of [
      '这个 trace 掉帧吗？',
      'trace jank count?',
      'trace janky frames?',
      'trace dropped frames?',
      'trace frame drops?',
      'is there any jank in this trace?',
      'was there jank in the recording?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickAcknowledgementDirectAnswer: false,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps app-scoped jank questions on the focus detection path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 的焦点应用有没有掉帧？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes explicit trace-wide frame-count questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 一共有多少帧？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('routes trace timing synonyms through trace duration pre-evidence', () => {
    for (const query of [
      'trace time range?',
      'recording time?',
      'trace 范围？',
      '录制时间？',
      '采样了多久？',
      '采样了多长时间？',
      '录屏多久？',
      '录屏时长？',
      '录屏时间范围？',
      '采样长度？',
      '这段性能数据多久？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes selected-range trace facts through scoped runtime pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 一共有多少帧？',
      sceneType: 'scrolling',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1,
        endNs: 2,
      },
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('routes selected-range duration questions through scoped runtime pre-evidence without focus detection', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个选区多长？',
      sceneType: 'general',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1_000_000_000,
        endNs: 3_500_000_000,
      },
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('does not route selected-range duration wording without a valid selection', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个选区多长？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps selected-range app-scoped trace facts on the focus detection path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个选区的焦点应用一共有多少帧？',
      sceneType: 'scrolling',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1,
        endNs: 2,
      },
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps selected-range trace facts without scoped SQL support out of runtime pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'CPU 有几核？',
      sceneType: 'general',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1,
        endNs: 2,
      },
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes selected-range focus app identity questions through scoped focus pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个选区的焦点应用是什么？',
      sceneType: 'scrolling',
      analysisMode: 'fast',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1,
        endNs: 2,
      },
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickFocusAppPreEvidence: true,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes scrolling overview questions through scrolling triage pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'scroll jank overview and smoothness',
      sceneType: 'scrolling',
      analysisMode: 'fast',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickScrollingTriagePreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps selected-range focus app diagnostics off the focus direct-answer path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个选区的焦点应用为什么掉帧？',
      sceneType: 'scrolling',
      analysisMode: 'fast',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1,
        endNs: 2,
      },
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps app-scoped frame-count questions on the focus detection path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '焦点应用一共有多少帧？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps app-scoped thread-count questions on the focus detection path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '焦点应用有多少线程？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes global thread-count questions through the full preflight skip path', () => {
    const cases = [
      '有多少个线程？',
      '线程？',
      'threads?',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps app-scoped process-count questions on the focus detection path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '焦点应用有多少进程？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes combined identity and trace fact questions through both direct evidence paths', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 的应用包名和掉帧数是多少？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickAcknowledgementDirectAnswer: false,
      quickProcessIdentityPreEvidence: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes natural process identity questions through process identity pre-evidence', () => {
    for (const query of [
      '这个 trace 是哪个进程？',
      '这个 trace 的进程是谁？',
      '当前进程是什么？',
      'current process?',
      'trace process?',
      'process_name?',
      'main_process?',
      'main_process_name?',
      'recommended_process_name_param?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickProcessIdentityPreEvidence: true,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes current foreground app identity questions through focus and process identity pre-evidence', () => {
    for (const query of [
      '当前应用是谁？',
      '哪个应用在前台？',
      'foreground package?',
      'what is the foreground package?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickFocusAppPreEvidence: true,
        quickProcessIdentityPreEvidence: true,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes bare package identity questions through process identity pre-evidence', () => {
    for (const query of [
      'which package?',
      'current package?',
      'what is the current package?',
      'trace package?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickFocusAppPreEvidence: false,
        quickProcessIdentityPreEvidence: true,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('skips focus detection but keeps trace preflight when package-scoped trace facts have explicit packageName', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '滑动 FPS 是多少？',
      sceneType: 'scrolling',
      packageName: 'com.example.app',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps global trace facts on the full preflight skip path', () => {
    const cases = [
      '这个 trace 的 CPU 有几个核心？',
      'CPU 核心？',
      'cpu cores?',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes device metadata fact questions through the full preflight skip path', () => {
    for (const query of ['这个 trace 的设备厂商和 Android 版本是多少？', 'SDK version?', 'SoC?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes observed refresh-rate fact questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 观测到的刷新率是多少？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('routes bare refresh-rate fact questions through the full preflight skip path', () => {
    for (const query of [
      'What is the refresh rate?',
      'refresh rate?',
      'VSync period?',
      'VSync?',
      'display refresh rate?',
      'screen Hz?',
      'current refresh rate?',
      '刷新率是多少？',
      '屏幕刷新率？',
      '检测到的刷新率？',
      '观测到的刷新率？',
      '推断刷新率？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps refresh-rate policy questions out of the hard-rule quick path', () => {
    for (const query of [
      'Does this device support variable refresh rate?',
      'display refresh rate policy?',
      'why is display refresh rate switching?',
      'screen refresh rate jank?',
      '屏幕刷新率异常吗？',
      '检测到的刷新率为什么切换？',
      '刷新率策略？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('keeps device metadata diagnostic questions out of the hard-rule quick path', () => {
    for (const query of ['Android 版本有什么问题？', 'SDK version issue?', 'SoC performance?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes CPU frequency data availability questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '有 CPU 频率吗？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('routes power counter availability questions through the full preflight skip path', () => {
    for (const query of ['这个 trace 有功耗数据吗？', 'battery samples?', 'charge samples?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes memory counter availability questions through the full preflight skip path', () => {
    for (const query of ['这个 trace 有内存数据吗？', 'memory samples?', 'rss rows?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes Android network packet availability questions through the full preflight skip path', () => {
    for (const query of ['有网络包吗？', '网络数据？', '有没有网络数据？', 'network bytes?', 'traffic bytes?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'network',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes total thread and process count questions through the full preflight skip path', () => {
    for (const query of ['threads count?', 'processes count?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes common trace data inventory questions through the full preflight skip path', () => {
    for (const query of [
      '这个 trace 采集了哪些数据？',
      '有哪些数据源？',
      '有哪些表？',
      '表有哪些？',
      'available data sources?',
      'available tables?',
      'slice_count?',
      'track_count?',
      'process_count?',
      'thread_count?',
      'process_track_count?',
      'thread_track_count?',
      'counter_sample_count?',
      'actual_frame_timeline_slice_count?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps trace data diagnostic questions out of the hard-rule quick path', () => {
    for (const query of ['这个 trace 有哪些问题？', '有哪些表为什么缺失？']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('keeps power diagnostics out of the hard-rule quick path', () => {
    for (const query of ['为什么耗电高？', 'power high?', 'battery drain?', 'energy consumption high?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('keeps memory diagnostics out of the hard-rule quick path', () => {
    for (const query of ['分析内存泄漏', 'memory high?', 'memory pressure?', 'rss high?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes scheduler data availability questions through the full preflight skip path', () => {
    const cases = [
      '这个 trace 有调度数据吗？',
      'sched_slice?',
      'thread_state?',
      'D state count?',
      'D-state count?',
      'R+ count?',
      'preempted runnable count?',
      'uninterruptible sleep count?',
      'runnable rows?',
      'D 状态行数？',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps scheduler diagnostics out of the hard-rule quick path', () => {
    const cases = [
      '为什么调度延迟高？',
      'why D state?',
      'D state blocking?',
      'high D state count?',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes GPU data availability questions through the full preflight skip path', () => {
    const cases = [
      '这个 trace 有 GPU 数据吗？',
      'GPU 样本？',
      'GPU 样本数？',
      'gpu samples?',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps GPU diagnostics out of the hard-rule quick path', () => {
    const cases = [
      '为什么 GPU 慢？',
      'GPU 样本异常吗？',
      'GPU 利用率高吗？',
      'gpu samples high?',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes FrameTimeline data availability questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '有 FrameTimeline 吗？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('keeps FrameTimeline diagnostics out of the hard-rule quick path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '为什么 FrameTimeline 卡顿？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes generic slice data availability questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '有 slice 吗？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('keeps generic slice diagnostics out of the hard-rule quick path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '为什么 slice 很慢？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes Logcat availability questions through the full preflight skip path', () => {
    for (const query of [
      '有 logcat 吗？',
      'errors in logcat?',
      'are there warnings in logcat?',
      '错误日志？',
      '有错误日志吗？',
      '有报错日志吗？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps Logcat diagnostics out of the hard-rule quick path', () => {
    for (const query of [
      '为什么 logcat 报错？',
      'why errors in logcat?',
      'warnings?',
      '错误日志为什么发生？',
      '错误日志很多吗？',
      '警告日志很多吗？',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes global process-count questions through the full preflight skip path', () => {
    const cases = [
      '这个 trace 有多少个进程？',
      '进程？',
      'processes?',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('routes process-list questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 有哪些进程？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('keeps process diagnostic list questions out of the hard-rule quick path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '哪些进程卡顿？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes Binder transaction count questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '有 Binder 吗？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('routes bare Binder presence questions through the full preflight skip path', () => {
    for (const query of ['Binder?', 'Binder 调用？']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickAcknowledgementDirectAnswer: false,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps Binder diagnostic questions out of the hard-rule quick path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '有没有 Binder 阻塞？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes trace health issue questions through the full preflight skip path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 有采集错误吗？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });

  it('keeps trace health diagnostic questions out of the hard-rule quick path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '为什么 trace 有采集错误？',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes ANR existence questions through the full preflight skip path', () => {
    for (const query of [
      '有 ANR 吗？',
      'ANR?',
      '应用无响应？',
      '有没有应用无响应？',
      'app not responding?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'anr',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps ANR diagnostic questions out of the hard-rule quick path', () => {
    for (const query of [
      'ANR 原因是什么？',
      '应用无响应为什么？',
      '应用无响应原因是什么？',
      'why did app not responding happen?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'anr',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes app startup event fact questions through the full preflight skip path', () => {
    const cases = [
      '启动次数是多少？',
      '启动事件？',
      'startup events?',
      '启动时间？',
      '冷启动时间？',
      'launch time?',
      'cold launch time?',
      '启动耗时是多少？',
      '启动用了多久？',
      'launch duration?',
      'startup duration?',
      'how long did startup take?',
    ];

    for (const query of cases) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'startup',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps startup diagnostic questions out of the hard-rule quick path', () => {
    for (const query of [
      '分析启动性能',
      '启动耗时高吗？',
      '启动开始时间是多少？',
      '启动结束时间是多少？',
      '启动时间正常吗？',
      'startup start time?',
      'startup end time?',
      'launch time normal?',
      'startup duration high?',
      'why is startup slow?',
    ]) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'startup',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes scroll gesture count questions through the full preflight skip path', () => {
    for (const query of ['这个 trace 有几次滑动？', 'scrolls?', 'how many scrolls?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps scroll diagnostic questions out of the hard-rule quick path', () => {
    for (const query of ['为什么滑动卡？', 'scroll count high?', 'why scrolls?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes input event count questions through the full preflight skip path', () => {
    for (const query of ['input 事件有多少？', 'motion events?', 'motion count?', 'touches?', '触摸次数？', 'MOTION 事件数量？', 'key presses?', 'keyboard events?', '按键次数是多少？']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'general',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: true,
        quickTraceFactPreEvidence: true,
        skipFocusDetection: true,
        skipTracePreflightDetection: true,
      });
    }
  });

  it('keeps input latency questions out of the hard-rule quick path', () => {
    for (const query of ['输入延迟是多少？', '触摸延迟多少？', 'motion events latency?', 'why motion events?', 'motion events delayed?', 'key presses latency?', 'why key presses?', 'touches slow?', 'tap count?']) {
      const resolution = resolveRuntimeQuickMode({
        query,
        sceneType: 'scrolling',
        hasReferenceTrace: false,
        previousTurns: [],
      });

      expect(resolution).toMatchObject({
        quickMode: false,
        quickTraceFactPreEvidence: false,
        skipFocusDetection: false,
        skipTracePreflightDetection: false,
      });
    }
  });

  it('routes natural app identity questions through quick process identity pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'which app is this trace from?',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickProcessIdentityPreEvidence: true,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps selected-range identity questions out of runtime global process identity pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个选区的应用包名和主要进程是什么？',
      sceneType: 'scrolling',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 1,
        endNs: 2,
      },
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('routes compound app identity plus trace fact questions through combined quick pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 的应用包名和录制时长是多少？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickProcessIdentityPreEvidence: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: true,
    });
  });

  it('routes compound app identity plus trace timing bounds through combined quick pre-evidence', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 的应用包名和起止时间是多少？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      quickProcessIdentityPreEvidence: true,
      quickTraceFactPreEvidence: true,
      skipFocusDetection: false,
      skipTracePreflightDetection: true,
    });
  });

  it('keeps app diagnostics out of the hard-rule quick process identity path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: 'which app is slow?',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps compound app identity plus broad problem questions on the full path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '这个 trace 是哪个应用，有哪些问题？',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('keeps package-scoped comparison questions on the full path', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '滑动 FPS 是多少？',
      sceneType: 'scrolling',
      packageName: 'com.example.app',
      hasReferenceTrace: true,
      previousTurns: [],
    });

    expect(resolution).toMatchObject({
      quickMode: false,
      quickTraceFactPreEvidence: false,
      skipFocusDetection: false,
      skipTracePreflightDetection: false,
    });
  });

  it('reuses prior evidence without trace preflight in a retained reference-trace session', () => {
    const resolution = resolveRuntimeQuickMode({
      query: '只基于上一条已经给出的刷新率回答，不要重新分析，也不要调用工具。',
      sceneType: 'scrolling',
      hasReferenceTrace: true,
      previousTurns: [{
        query: '对比两条 trace 的刷新率。',
      }],
    });

    expect(resolution).toMatchObject({
      quickMode: true,
      localReason: PRIOR_EVIDENCE_ONLY_FOLLOWUP_REASON,
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  });
});
