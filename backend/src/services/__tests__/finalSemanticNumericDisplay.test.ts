// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {locatedNumbersShowDeclaredRounding} from '../finalSemanticNumericDisplay';

const eq = (value: number | string, unit: string) => ({operator: 'eq', value, unit});
/** A catalog-style location: the whole line. */
const line = (text: string, numeric: ReturnType<typeof eq> | undefined) =>
  locatedNumbersShowDeclaredRounding(text, [{start: 0, end: text.length}], numeric);
/** An exact-quote location inside a longer body (first occurrence). */
const quote = (body: string, text: string, numeric: ReturnType<typeof eq>) => {
  const start = body.indexOf(text);
  return locatedNumbersShowDeclaredRounding(body, [{start, end: start + text.length}], numeric);
};

describe('locatedNumbersShowDeclaredRounding', () => {
  // Declarations and table rows from the critical-path E2E rounds 3 and 4.
  it('accepts a bare rounding at the displayed precision after an exact unit conversion', () => {
    expect(line('| S（可中断睡眠） | 33 | 5,844.24 ms | **97.25%** |', eq(5844240564, 'ns'))).toBe(true);
    expect(line('D 合计 19 us', eq(18961, 'ns'))).toBe(true);
    expect(line('占 97.25%', eq(97.25389910893621, 'percent'))).toBe(true);
    expect(line('约 200 ms', eq(200015209, 'ns'))).toBe(true);
    expect(line('回收 17.901 MiB', eq('17.901', 'MiB'))).toBe(true);
    expect(line('captured value is 49.', eq(49, 'count'))).toBe(true);
    expect(quote('| 778794324 | 37.29ms | LockWorker-3 |', '37.29ms', eq(37291667, 'ns'))).toBe(true);
    expect(quote('最长的单段阻塞等待为 **213.96 ms**(thread_state 71014)', '213.96 ms', eq(213960938, 'ns'))).toBe(true);
    expect(quote('| cpu0 585,089.89 kHz（cpu1–3 约 5 成） |', '585,089.89 kHz', eq('585089.8868793148', 'kHz'))).toBe(true);
  });

  it('keeps the mismatch for a wrong digit, a wrong half-up rounding or a wrong unit family', () => {
    expect(line('5,844.25 ms', eq(5844240564, 'ns'))).toBe(false);
    expect(line('301.9 ms', eq(301839437, 'ns'))).toBe(false);
    expect(line('5844.24 MiB', eq(5844240564, 'ns'))).toBe(false);
    expect(line('captured value is 50.', eq(49, 'count'))).toBe(false);
  });

  it('keeps the mismatch when any selected same-family number disagrees, or none is selected', () => {
    expect(line('5,844.24 ms，另一段 6,000 ms', eq(5844240564, 'ns'))).toBe(false);
    expect(line('一直睡眠到 trace 结束', eq(5844240564, 'ns'))).toBe(false);
    expect(line('共 33 段', eq(5844240564, 'ns'))).toBe(false);
  });

  // An exact quote selects the number; its line still decides.
  it('reads a quoted number with the context around it', () => {
    expect(quote('主线程等待超过 6 s', '6 s', eq(5840000000, 'ns'))).toBe(false);
    expect(quote('等待 60–45 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('偏差 −45 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('单次 145 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('合计 5,844.24 ms', '44.24 ms', eq(44.24, 'ms'))).toBe(false);
    // CJK written right against the number, with no space.
    expect(quote('偏差−45 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('偏差-45 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('耗时从60–45 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('耗时60~45 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('cpu1-45 ms', '45 ms', eq(45, 'ms'))).toBe(false);
    expect(quote('耗时5,844.24 ms', '5,844.24 ms', eq(5844240564, 'ns'))).toBe(true);
    expect(quote('约~45 ms', '45 ms', eq(45, 'ms'))).toBe(true);
    expect(quote('P90 为 60 ms，P50 为 45 ms', '45 ms', eq(45, 'ms'))).toBe(true);
    expect(quote('P90 为 60 ms，P50 为 45 ms', '60 ms', eq(45, 'ms'))).toBe(false);
  });

  it('fails closed on adjacent numbers, emphasis, ranges, lists and comparisons', () => {
    expect(line('P90 60 ms，均值 45 ms', eq(45, 'ms'))).toBe(false);
    expect(line('**60** ms（均值 45 ms）', eq(45, 'ms'))).toBe(false);
    expect(line('60–45 ms', eq(45, 'ms'))).toBe(false);
    expect(line('60~45 ms', eq(45, 'ms'))).toBe(false);
    expect(line('12/45 ms', eq(45, 'ms'))).toBe(false);
    expect(line('3、4、6 ms', eq(6, 'ms'))).toBe(false);
    for (const span of ['超过 6 s', '45 ± 2 ms', 'at least 6 s', 'exceeds 6 s', '少于 6 s', 'greater than 6 s', '将近 6 s']) {
      expect(line(span, eq(6, 's'))).toBe(false);
    }
  });

  it('fails closed on units and magnitudes outside the closed mapping and on case-shifted units', () => {
    for (const span of ['耗时 6000 毫秒（5,844.24 ms）', '1.2 万 ms，5,844.24 ms', '3 倍，5,844.24 ms', '6 秒；5,844.24 ms']) {
      expect(line(span, eq(5844240564, 'ns'))).toBe(false);
    }
    expect(line('18 GB', eq('17.9', 'MB'))).toBe(false);
    expect(line('6 min', eq('5.84', 'sec'))).toBe(false);
    expect(line('49 GB', eq(49, 'count'))).toBe(false);
    expect(line('5 S', eq(5, 's'))).toBe(false);
    expect(line('5 MS', eq(5, 'ms'))).toBe(false);
    expect(quote('共 3 千帧', '3 千帧', eq(3, 'frames'))).toBe(false);
    expect(quote('共 49 百次', '49 百次', eq(49, 'count'))).toBe(false);
    expect(quote('占 5 成（97.25%）', '5 成（97.25%）', eq('97.25', 'percent'))).toBe(false);
  });

  it('fails closed on symbol units followed by text, wide spacing and Unicode minus signs', () => {
    expect(line('占 60%的时间（97.25%）', eq('97.25', 'percent'))).toBe(false);
    expect(line('占 60％（97.25%）', eq('97.25', 'percent'))).toBe(false);
    expect(line('60  ms（45 ms）', eq(45, 'ms'))).toBe(false);
    expect(line('60 ms（45 ms）', eq(45, 'ms'))).toBe(false);
    expect(line('60 ms（45 ms）', eq(45, 'ms'))).toBe(false);
    expect(line('−45 ms', eq(45, 'ms'))).toBe(false);
    expect(line('−45 ms', eq(-45, 'ms'))).toBe(true);
    expect(line('| 45 ms |', eq(45, 'ms'))).toBe(true);
    expect(line('97.25%的时间在睡眠', eq('97.25', 'percent'))).toBe(true);
  });

  it('fails closed on bare decimals of a unit family, malformed grouping and absence-shaped zeros', () => {
    expect(line('P90 为 60.5，P50 为 45 ms', eq(45, 'ms'))).toBe(false);
    expect(line('1,2345 ms，即 45 ms', eq(45, 'ms'))).toBe(false);
    expect(line('12,5 ms（45 ms）', eq(45, 'ms'))).toBe(false);
    expect(line('0 ms', eq(400000, 'ns'))).toBe(false);
    expect(line('0%', eq('0.3', 'percent'))).toBe(false);
    expect(line('0 ms', eq(0, 'ns'))).toBe(true);
  });

  it('reads negative values and identifiers without guessing', () => {
    expect(line('偏差 -3.46 ms', eq(-3456000, 'ns'))).toBe(true);
    expect(line('utid 630，等待 213.96 ms', eq(213960938, 'ns'))).toBe(true);
    expect(line('utid 630 等待 213.96 ms', eq(213960938, 'ns'))).toBe(true);
    expect(line('utid630 213.96 ms', eq(213960938, 'ns'))).toBe(true);
  });

  it('rejects hostile declared literals, invalid locations and non-equality declarations', () => {
    expect(line('5 ms', eq('1e999999999', 'ms'))).toBe(false);
    expect(line('5 ms', eq(`5${'0'.repeat(600)}`, 'ms'))).toBe(false);
    expect(locatedNumbersShowDeclaredRounding('5 ms', [{start: 3, end: 99}], eq(5, 'ms'))).toBe(false);
    expect(locatedNumbersShowDeclaredRounding('5 ms', [], eq(5, 'ms'))).toBe(false);
    expect(line('5,844.24 ms', {operator: 'gt', value: 5844240564, unit: 'ns'})).toBe(false);
    expect(line('5,844.24 ms', undefined)).toBe(false);
  });
});
