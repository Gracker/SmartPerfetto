/**
 * sceneClassifier unit tests
 *
 * Tests keyword/compound-pattern classification into SceneType.
 * The classifier is pure function (<1ms, no LLM), making it ideal for unit tests.
 */

import { jest, describe, it, expect } from '@jest/globals';

// Mock strategyLoader before importing classifier
jest.mock('../strategyLoader', () => ({
  getRegisteredScenes: jest.fn(() => [
    {
      scene: 'anr',
      priority: 1,
      keywords: ['anr', '死锁', 'not responding', 'deadlock'],
      compoundPatterns: [/anr.*(?:原因|分析|根因)/i],
    },
    {
      scene: 'startup',
      priority: 2,
      keywords: ['启动', 'launch', 'startup', '冷启动', '温启动', '热启动'],
      compoundPatterns: [/ttid.*ttfd/i, /启动.*耗时/],
    },
    {
      scene: 'scrolling',
      priority: 3,
      keywords: ['滑动', 'scroll', 'jank', '卡顿', '掉帧', 'fling'],
      compoundPatterns: [],
    },
    {
      scene: 'interaction',
      priority: 4,
      keywords: ['点击', 'click', 'touch', '响应'],
      compoundPatterns: [],
    },
    {
      scene: 'overview',
      priority: 5,
      keywords: ['概览', 'overview', '总览'],
      compoundPatterns: [],
    },
    {
      scene: 'general',
      priority: 99,
      keywords: [],
      compoundPatterns: [],
    },
  ]),
}));

import { classifyScene } from '../sceneClassifier';

describe('classifyScene', () => {
  describe('keyword matching', () => {
    it('should classify scrolling queries', () => {
      expect(classifyScene('分析滑动卡顿')).toBe('scrolling');
      expect(classifyScene('why is scroll janky?')).toBe('scrolling');
      expect(classifyScene('查看掉帧情况')).toBe('scrolling');
    });

    it('should classify startup queries', () => {
      expect(classifyScene('分析启动性能')).toBe('startup');
      expect(classifyScene('app launch is slow')).toBe('startup');
      expect(classifyScene('冷启动耗时多少')).toBe('startup');
    });

    it('should classify ANR queries', () => {
      expect(classifyScene('分析这个 ANR')).toBe('anr');
      expect(classifyScene('app not responding')).toBe('anr');
      expect(classifyScene('是否存在死锁')).toBe('anr');
    });

    it('should classify interaction queries', () => {
      expect(classifyScene('点击响应慢')).toBe('interaction');
    });

    it('should classify overview queries', () => {
      expect(classifyScene('给出概览')).toBe('overview');
    });

    it('should be case-insensitive for keywords', () => {
      expect(classifyScene('SCROLL performance')).toBe('scrolling');
      expect(classifyScene('ANR analysis')).toBe('anr');
      expect(classifyScene('STARTUP time')).toBe('startup');
    });
  });

  describe('compound pattern matching', () => {
    it('should match ANR compound pattern', () => {
      expect(classifyScene('ANR 的原因是什么')).toBe('anr');
    });

    it('should match startup compound pattern', () => {
      expect(classifyScene('TTID 和 TTFD 分别是多少')).toBe('startup');
      expect(classifyScene('启动到渲染的耗时')).toBe('startup');
    });

    it('should prioritize compound patterns over lower-priority keyword matches', () => {
      // "anr 原因分析" matches ANR compound pattern (priority 1)
      // even if some word might match elsewhere
      expect(classifyScene('anr 原因分析')).toBe('anr');
    });
  });

  describe('priority ordering', () => {
    it('should prefer higher priority (lower number) when multiple match', () => {
      // "ANR 导致的启动卡顿" has keywords from both ANR and startup
      // ANR (priority 1) should win over startup (priority 2)
      expect(classifyScene('ANR 导致的启动问题')).toBe('anr');
    });
  });

  describe('fallback', () => {
    it('should return general for unmatched queries', () => {
      expect(classifyScene('what happened in this trace?')).toBe('general');
      expect(classifyScene('帮我分析一下这个 trace')).toBe('general');
      expect(classifyScene('')).toBe('general');
    });

    it('should return general for empty query', () => {
      expect(classifyScene('')).toBe('general');
    });
  });
});
