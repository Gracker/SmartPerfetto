// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Thresholds Configuration Unit Tests
 *
 * Tests for the centralized thresholds configuration module.
 * Covers:
 * 1. VSync period inference with various inputs
 * 2. Edge cases and boundary conditions
 * 3. Default value consistency
 */

import { describe, it, expect } from '@jest/globals';
import {
  inferVsyncPeriodNs,
  VSYNC_PERIODS_NS,
  DEFAULT_VSYNC_PERIOD_NS,
  DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS,
} from '../thresholds';

// =============================================================================
// inferVsyncPeriodNs Tests
// =============================================================================

describe('inferVsyncPeriodNs', () => {
  describe('无参数调用', () => {
    it('应该返回 120Hz 默认值 (现代旗舰设备)', () => {
      const result = inferVsyncPeriodNs();
      expect(result).toBe(DEFAULT_VSYNC_PERIOD_NS);
      expect(result).toBe(8333333n); // 120Hz = 8.33ms
    });
  });

  describe('使用 detectedVsyncPeriodNs', () => {
    it('应该优先使用检测到的值 (number)', () => {
      const result = inferVsyncPeriodNs({ detectedVsyncPeriodNs: 8333333 });
      expect(result).toBe(8333333n);
    });

    it('应该优先使用检测到的值 (string)', () => {
      const result = inferVsyncPeriodNs({ detectedVsyncPeriodNs: '11111111' });
      expect(result).toBe(11111111n);
    });

    it('应该优先使用检测到的值 (bigint)', () => {
      const result = inferVsyncPeriodNs({ detectedVsyncPeriodNs: 6944444n });
      expect(result).toBe(6944444n);
    });

    it('应该忽略值为 0 的检测值', () => {
      const result = inferVsyncPeriodNs({ detectedVsyncPeriodNs: 0 });
      expect(result).toBe(DEFAULT_VSYNC_PERIOD_NS);
    });

    it('应该忽略负数检测值', () => {
      const result = inferVsyncPeriodNs({ detectedVsyncPeriodNs: -1000 });
      expect(result).toBe(DEFAULT_VSYNC_PERIOD_NS);
    });

    it('应该处理无效字符串', () => {
      const result = inferVsyncPeriodNs({ detectedVsyncPeriodNs: 'invalid' as any });
      expect(result).toBe(DEFAULT_VSYNC_PERIOD_NS);
    });
  });

  describe('使用 deviceRefreshRate', () => {
    it('应该支持标准刷新率 60Hz', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: 60 });
      expect(result).toBe(VSYNC_PERIODS_NS[60]);
    });

    it('应该支持标准刷新率 90Hz', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: 90 });
      expect(result).toBe(VSYNC_PERIODS_NS[90]);
    });

    it('应该支持标准刷新率 120Hz', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: 120 });
      expect(result).toBe(VSYNC_PERIODS_NS[120]);
    });

    it('应该支持标准刷新率 144Hz', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: 144 });
      expect(result).toBe(VSYNC_PERIODS_NS[144]);
    });

    it('应该计算非标准刷新率 (75Hz)', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: 75 });
      // 1000000000 / 75 = 13333333.33... -> 13333333
      expect(result).toBe(BigInt(Math.round(1_000_000_000 / 75)));
    });

    it('应该忽略 0 刷新率', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: 0 });
      expect(result).toBe(DEFAULT_VSYNC_PERIOD_NS);
    });

    it('应该忽略负数刷新率', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: -60 });
      expect(result).toBe(DEFAULT_VSYNC_PERIOD_NS);
    });

    it('应该忽略超过 500Hz 的刷新率', () => {
      const result = inferVsyncPeriodNs({ deviceRefreshRate: 600 });
      expect(result).toBe(DEFAULT_VSYNC_PERIOD_NS);
    });
  });

  describe('优先级测试', () => {
    it('detectedVsyncPeriodNs 优先于 deviceRefreshRate', () => {
      const result = inferVsyncPeriodNs({
        detectedVsyncPeriodNs: 8333333,
        deviceRefreshRate: 60,
      });
      expect(result).toBe(8333333n);
    });

    it('无效的 detectedVsyncPeriodNs 时回退到 deviceRefreshRate', () => {
      const result = inferVsyncPeriodNs({
        detectedVsyncPeriodNs: 0,
        deviceRefreshRate: 120,
      });
      expect(result).toBe(VSYNC_PERIODS_NS[120]);
    });
  });
});

// =============================================================================
// Default Values Consistency Tests
// =============================================================================

describe('默认值一致性', () => {
  describe('VSync 周期', () => {
    it('60Hz 应该对应 ~16.67ms', () => {
      expect(Number(VSYNC_PERIODS_NS[60]) / 1_000_000).toBeCloseTo(16.67, 1);
    });

    it('120Hz 应该对应 ~8.33ms', () => {
      expect(Number(VSYNC_PERIODS_NS[120]) / 1_000_000).toBeCloseTo(8.33, 1);
    });

    it('DEFAULT_VSYNC_PERIOD_NS 应该等于 120Hz (现代旗舰设备)', () => {
      expect(DEFAULT_VSYNC_PERIOD_NS).toBe(VSYNC_PERIODS_NS[120]);
    });
  });

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
});
