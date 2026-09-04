// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {substituteDisplayTitleParameters} from '../skillLocalization';

describe('substituteDisplayTitleParameters', () => {
  /**
   * The executor substitutes display titles, then localization replaces the
   * title with the catalog string — which is the same unsubstituted template.
   * Users saw `启动 #${startup_id} 详情` in the default language.
   */
  it('fills a placeholder the localized catalog title still carries', () => {
    expect(substituteDisplayTitleParameters('启动 #${startup_id} 详情', {startup_id: 2}))
      .toBe('启动 #2 详情');
  });

  it('fills every placeholder in a title', () => {
    expect(substituteDisplayTitleParameters(
      '区间 ${session_id} - ${phase} 阶段',
      {session_id: 7, phase: 'Fling'},
    )).toBe('区间 7 - Fling 阶段');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(substituteDisplayTitleParameters('启动 #${startup_id} 详情', {other: 1}))
      .toBe('启动 #${startup_id} 详情');
  });

  it('leaves an empty-valued placeholder visible', () => {
    expect(substituteDisplayTitleParameters('区间 ${session_id}', {session_id: ''}))
      .toBe('区间 ${session_id}');
  });

  it('passes through titles without placeholders untouched', () => {
    expect(substituteDisplayTitleParameters('滑动性能概览', {session_id: 3}))
      .toBe('滑动性能概览');
  });

  it('is a no-op when no parameters were resolved', () => {
    expect(substituteDisplayTitleParameters('启动 #${startup_id} 详情', undefined))
      .toBe('启动 #${startup_id} 详情');
  });
});
