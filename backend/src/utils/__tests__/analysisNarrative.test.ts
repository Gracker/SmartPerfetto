// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildTriadStatement,
  parseTriadParts,
  TRIAD_LABELS,
} from '../analysisNarrative';

describe('analysisNarrative', () => {
  test('buildTriadStatement uses unified labels', () => {
    const text = buildTriadStatement({
      trigger: '主线程长耗时',
      supply: '频率不足',
      amplification: 'SF 消费端背压',
    });

    expect(text).toBe(
      `${TRIAD_LABELS.trigger}: 主线程长耗时；${TRIAD_LABELS.supply}: 频率不足；${TRIAD_LABELS.amplification}: SF 消费端背压`
    );
  });

  test('parseTriadParts supports legacy and new labels', () => {
    const legacy = '触发因子: A；供给约束: B；放大路径: C';
    const modern = '直接原因: A；资源问题: B；放大因素: C';

    expect(parseTriadParts(legacy)).toEqual({
      trigger: 'A',
      supply: 'B',
      amplification: 'C',
    });
    expect(parseTriadParts(modern)).toEqual({
      trigger: 'A',
      supply: 'B',
      amplification: 'C',
    });
  });
});
