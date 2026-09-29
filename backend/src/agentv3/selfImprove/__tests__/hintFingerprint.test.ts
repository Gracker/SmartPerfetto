// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `computeHintFingerprint` is the canonical identity of a `phase_hints`
 * entry; `strategyFingerprint` uses it for drift detection of stored hints.
 */

import { describe, it, expect } from '@jest/globals';
import { computeHintFingerprint } from '../hintFingerprint';
import { computePatchFingerprint } from '../strategyFingerprint';

describe('computeHintFingerprint', () => {
  it('produces a 16-char hex hash', () => {
    const fp = computeHintFingerprint({
      keywords: ['vsync', 'vrr'],
      constraints: 'invoke vsync_dynamics_analysis first',
      criticalTools: ['vsync_dynamics_analysis'],
      critical: true,
    });
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is stable across cosmetic differences', () => {
    const a = computeHintFingerprint({
      keywords: ['vsync', 'vrr'],
      constraints: 'invoke vsync_dynamics_analysis first',
      criticalTools: ['vsync_dynamics_analysis'],
      critical: true,
    });
    const b = computeHintFingerprint({
      keywords: ['VRR', 'VSYNC'],
      constraints: '  invoke vsync_dynamics_analysis first  ',
      criticalTools: ['  vsync_dynamics_analysis '],
      critical: true,
    });
    expect(a).toBe(b);
  });

  it('differs when `critical` flips', () => {
    const base = {
      keywords: ['x'],
      constraints: 'y',
      criticalTools: ['z'],
      critical: true,
    };
    expect(computeHintFingerprint(base)).not.toBe(
      computeHintFingerprint({ ...base, critical: false }),
    );
  });
});

describe('strategyFingerprint shares the canonical identity', () => {
  it('computePatchFingerprint ignores the derived id and matches computeHintFingerprint', () => {
    const hint = {
      keywords: ['workload heavy', 'fallback'],
      constraints: 'Do not classify as workload_heavy without IO peer evidence',
      criticalTools: ['blocking_chain_analysis'],
      critical: false,
    };
    expect(computePatchFingerprint({ id: 'auto_a', ...hint }))
      .toBe(computePatchFingerprint({ id: 'auto_b', ...hint }));
    expect(computePatchFingerprint({ id: 'auto_a', ...hint })).toBe(computeHintFingerprint(hint));
  });
});
