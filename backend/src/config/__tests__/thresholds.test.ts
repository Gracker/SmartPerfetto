// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Thresholds Configuration Unit Tests
 *
 * Default frame-time display threshold consistency.
 */

import { describe, it, expect } from '@jest/globals';
import { DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS } from '../thresholds';

describe('Frame Time Display 阈值', () => {
  it('critical 应该大于 warning', () => {
    expect(DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.avgCriticalMs).toBeGreaterThan(
      DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.avgWarningMs
    );
    expect(DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.maxCriticalMs).toBeGreaterThan(
      DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.maxWarningMs
    );
  });

  it('avgWarningMs 应该等于 1 个 vsync (120Hz)', () => {
    expect(DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.avgWarningMs).toBeCloseTo(8.33, 1);
  });

  it('avgCriticalMs 应该等于 2 个 vsync (120Hz)', () => {
    expect(DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.avgCriticalMs).toBeCloseTo(16.67, 1);
  });
});
