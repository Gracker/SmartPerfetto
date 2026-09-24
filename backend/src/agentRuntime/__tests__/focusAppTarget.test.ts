// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { FocusAppDetectionResult } from '../../agentv3/focusAppDetector';
import {
  buildFocusAppPromptData,
  comparisonPackageSources,
  focusAppSelectorCandidates,
  formatFocusAppTargetProgress,
  packageProvenance,
  resolveFocusAppTarget,
} from '../focusAppTarget';

const confident: FocusAppDetectionResult = {
  method: 'oom_adj',
  confidence: 'high',
  primaryApp: 'com.tracedemo.stress',
  apps: [
    {packageName: 'com.tracedemo.stress', totalDurationNs: 11_814_451_991, switchCount: 3, upid: 13, pid: 22442,
      processName: 'com.tracedemo.stress', score: 25, penalties: [],
      signals: {batteryTopNs: 0, launchCount: 0, frameCount: 0, foregroundNs: 11_814_451_991,
        runningNs: 180_321_368, mainThreadRunningNs: 151_059_323, threadSliceCount: 165}},
    {packageName: 'com.google.android.as', totalDurationNs: 10_135_213, switchCount: 1, score: 10},
  ],
  excludedNoActivity: [{packageName: 'com.android.media.module', upid: 599, reason: 'no_activity',
    foregroundNs: 11_800_000_000, maxOomScore: -700}],
};

const ambiguous: FocusAppDetectionResult = {
  method: 'oom_adj',
  confidence: 'ambiguous',
  apps: [
    {packageName: 'com.example.a', totalDurationNs: 5, switchCount: 1, score: 25},
    {packageName: 'com.example.b', totalDurationNs: 4, switchCount: 1, score: 24, pid: 42},
  ],
};

describe('resolveFocusAppTarget', () => {
  it('a user-named package always wins and keeps the ranking for context', () => {
    const target = resolveFocusAppTarget({userPackageName: ' com.user.app ', focusResult: confident});
    expect(target).toMatchObject({packageName: 'com.user.app', source: 'user', confidence: 'high', method: 'oom_adj'});
    expect(target.candidates.map(candidate => candidate.packageName))
      .toEqual(['com.tracedemo.stress', 'com.google.android.as']);
  });

  it('a confident inference becomes the effective package, tagged auto_detected', () => {
    const target = resolveFocusAppTarget({focusResult: confident});
    expect(target).toMatchObject({packageName: 'com.tracedemo.stress', source: 'auto_detected', confidence: 'high'});
    expect(packageProvenance(target.packageName, target)).toEqual({source: 'auto_detected', confidence: 'high'});
  });

  it('an ambiguous detection puts no package in effect', () => {
    const target = resolveFocusAppTarget({focusResult: ambiguous});
    expect(target.packageName).toBeUndefined();
    expect(target).toMatchObject({source: 'none', confidence: 'ambiguous'});
    expect(focusAppSelectorCandidates(target)).toEqual([
      {packageName: 'com.example.a', score: 25},
      {packageName: 'com.example.b', pid: 42, score: 24},
    ]);
  });

  it('treats a legacy result with a primary but no confidence as in effect', () => {
    const target = resolveFocusAppTarget({focusResult: {method: 'frame_timeline', primaryApp: 'com.legacy.app',
      apps: [{packageName: 'com.legacy.app', totalDurationNs: 1, switchCount: 1}]}});
    expect(target).toMatchObject({packageName: 'com.legacy.app', source: 'auto_detected'});
    expect(target.confidence).toBeUndefined();
  });

  it('has nothing in effect without a user package or detection', () => {
    expect(resolveFocusAppTarget({})).toEqual({source: 'none', method: 'none', candidates: [], excludedNoActivity: []});
    expect(buildFocusAppPromptData(resolveFocusAppTarget({}))).toBeUndefined();
  });
});

describe('focus-app consumers', () => {
  it('renders data only: status, primary, non-zero signals and exclusions', () => {
    expect(buildFocusAppPromptData(resolveFocusAppTarget({focusResult: confident}))).toEqual({
      status: 'high',
      method: 'oom_adj',
      primary: 'com.tracedemo.stress',
      candidates: [
        {packageName: 'com.tracedemo.stress', pid: 22442, score: 25, signals: {foregroundNs: 11_814_451_991,
          runningNs: 180_321_368, mainThreadRunningNs: 151_059_323, threadSliceCount: 165}},
        {packageName: 'com.google.android.as', score: 10},
      ],
      excludedNoActivity: [{packageName: 'com.android.media.module', maxOomScore: -700}],
    });
  });

  it('only a user-named package is an authoritative comparison identity', () => {
    const referenceFocusTarget = resolveFocusAppTarget({focusResult: confident});
    expect(comparisonPackageSources(resolveFocusAppTarget({focusResult: confident}), {
      referencePackageName: referenceFocusTarget.packageName,
    })).toEqual({currentPackageSource: 'auto_detected', referencePackageSource: 'auto_detected'});
    expect(comparisonPackageSources(resolveFocusAppTarget({userPackageName: 'com.user.app'}), {})).toEqual({
      currentPackageSource: 'user'});
    // A package no target produced came from the caller; the reference side has no caller.
    expect(packageProvenance('com.other.app', undefined)).toEqual({source: 'user'});
    expect(packageProvenance('com.other.app', undefined, {userMayName: false})).toEqual({source: 'auto_detected'});
  });

  it('announces inferred and ambiguous focus, never a user-named one', () => {
    expect(formatFocusAppTargetProgress(resolveFocusAppTarget({focusResult: confident}), 'en'))
      .toBe('Inferred focus app: com.tracedemo.stress (oom_adj, high confidence)');
    expect(formatFocusAppTargetProgress(resolveFocusAppTarget({focusResult: ambiguous}), 'zh-CN'))
      .toBe('焦点应用不确定，候选: com.example.a, com.example.b');
    expect(formatFocusAppTargetProgress(resolveFocusAppTarget({userPackageName: 'com.user.app',
      focusResult: confident}), 'en')).toBeUndefined();
  });
});
