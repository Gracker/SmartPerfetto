// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {COUNTED_PRODUCER_DIMENSIONS, countedUnitDimension, declaredUnitAcceptsProducerDimension} from '../claimUnits';

describe('declared unit / producer dimension equivalence (claimUnits)', () => {
  it('counts exactly frames and events as producer dimensions', () => {
    expect([...COUNTED_PRODUCER_DIMENSIONS].sort()).toEqual(['events', 'frames']);
  });

  it('resolves counted unit tokens, including singular aliases, and nothing else', () => {
    expect(countedUnitDimension('count')).toBe('count');
    expect(countedUnitDimension('frame')).toBe('frames');
    expect(countedUnitDimension('frames')).toBe('frames');
    expect(countedUnitDimension('event')).toBe('events');
    expect(countedUnitDimension('events')).toBe('events');
    for (const token of ['ns', 'ms', 'bytes', 'ratio', '%', 'Hz', 'fortnights', '', 'COUNT', 'constructor', '__proto__', undefined]) {
      expect(countedUnitDimension(token)).toBeUndefined();
    }
  });

  it.each([
    ['count', 'frames'],
    ['count', 'events'],
  ] as const)('accepts declared generic %s against counted producer dimension %s at 1:1', (declared, producer) => {
    expect(declaredUnitAcceptsProducerDimension(declared, producer)).toBe(true);
  });

  it.each([
    // Concrete declared units never accept a different or generic dimension.
    ['frames', 'events'], ['frames', 'count'], ['frame', 'events'],
    ['events', 'frames'], ['events', 'count'], ['event', 'count'],
    // Generic count never accepts a non-counted family or an unknown dimension.
    ['count', 'count'], ['count', 'time'], ['count', 'bytes'], ['count', 'ratio'],
    ['count', 'frequency'], ['count', ''], ['count', 'constructor'],
    // Unknown declared tokens accept nothing.
    ['ms', 'frames'], ['fortnights', 'frames'],
  ] as const)('rejects declared %s against producer dimension %s', (declared, producer) => {
    expect(declaredUnitAcceptsProducerDimension(declared, producer)).toBe(false);
  });
});
