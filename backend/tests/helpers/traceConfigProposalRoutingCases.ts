// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CapturePresetId} from '../../src/services/traceCaptureConfig';

/**
 * Requests whose routing the loading preset could disturb. Shared by the
 * proposal service suite and the HTTP route suite so both paths pin the same
 * table. Scoring is substring-based and a tie keeps the earlier rule, so the
 * mixed rows document which existing preset wins and why.
 */
export const LOADING_ROUTING_CASES: ReadonlyArray<{request: string; preset: CapturePresetId; why: string}> = [
  {request: '页面加载慢', preset: 'loading', why: '页面加载 + 加载慢'},
  {request: '图片加载慢', preset: 'loading', why: '图片加载 + 加载慢'},
  {request: '打开详情页白屏很久', preset: 'loading', why: '白屏 only'},
  {request: 'debug slow page load in the feed', preset: 'loading', why: 'page load'},
  {request: 'list content loads slowly', preset: 'loading', why: 'content load'},
  {request: '冷启动白屏', preset: 'startup', why: '启动 + 冷启动 outscore 白屏'},
  {request: '启动很慢首帧', preset: 'startup', why: 'startup keywords only'},
  {request: '滑动卡顿', preset: 'scrolling', why: 'scrolling keywords only'},
  {request: '列表滑动时图片加载卡顿', preset: 'scrolling', why: '滑动 + 卡顿 outscore 图片加载'},
  {request: '图片加载慢导致滑动卡顿', preset: 'scrolling', why: '2:2 tie keeps the earlier scrolling rule'},
  {request: 'loading 动画掉帧', preset: 'scrolling', why: 'no bare loading keyword; 掉帧 routes scrolling'},
  {request: 'downloading 很慢', preset: 'overview', why: 'no bare load/loading keyword'},
];
