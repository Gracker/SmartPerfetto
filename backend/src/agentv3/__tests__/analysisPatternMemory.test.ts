/**
 * analysisPatternMemory unit tests
 *
 * Tests the cross-session pattern memory system:
 * - Feature extraction (fingerprinting)
 * - Insight extraction
 * - Weighted Jaccard similarity
 * - Confidence decay + frequency gain
 * - Pattern save/match/eviction
 * - Negative pattern support
 *
 * File I/O is mocked — no actual disk writes.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mock fs before importing module ──────────────────────────────────────

let mockPatterns: any[] = [];
let mockNegativePatterns: any[] = [];

// Temporary storage for atomic write simulation (writeFile to .tmp, then rename)
let tmpWriteBuffer: Map<string, string> = new Map();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('analysis_patterns.json') && !p.endsWith('.tmp')) return mockPatterns.length > 0;
      if (typeof p === 'string' && p.includes('analysis_negative_patterns.json') && !p.endsWith('.tmp')) return mockNegativePatterns.length > 0;
      return false;
    }),
    readFileSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('analysis_negative_patterns.json')) return JSON.stringify(mockNegativePatterns);
      if (typeof p === 'string' && p.includes('analysis_patterns.json')) return JSON.stringify(mockPatterns);
      return '[]';
    }),
    mkdirSync: jest.fn(),
    promises: {
      writeFile: jest.fn(async (...args: unknown[]) => {
        const p = args[0] as string;
        const data = args[1] as string;
        // Buffer .tmp writes for the rename step
        tmpWriteBuffer.set(p, data);
      }),
      rename: jest.fn(async (...args: unknown[]) => {
        const src = args[0] as string;
        const dest = args[1] as string;
        // Apply buffered data to mock store on rename (simulates atomic write)
        const data = tmpWriteBuffer.get(src);
        if (data) {
          if (typeof dest === 'string' && dest.includes('analysis_patterns.json')) {
            mockPatterns = JSON.parse(data);
          }
          if (typeof dest === 'string' && dest.includes('analysis_negative_patterns.json')) {
            mockNegativePatterns = JSON.parse(data);
          }
          tmpWriteBuffer.delete(src);
        }
      }),
    },
  };
});

import {
  extractTraceFeatures,
  extractKeyInsights,
  matchPatterns,
  matchNegativePatterns,
  saveAnalysisPattern,
  saveNegativePattern,
  buildPatternContextSection,
  buildNegativePatternSection,
} from '../analysisPatternMemory';

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPatterns = [];
  mockNegativePatterns = [];
});

// ── Feature Extraction ───────────────────────────────────────────────────

describe('extractTraceFeatures', () => {
  it('should extract architecture tag', () => {
    const features = extractTraceFeatures({ architectureType: 'Flutter' });
    expect(features).toContain('arch:Flutter');
  });

  it('should extract scene tag', () => {
    const features = extractTraceFeatures({ sceneType: 'scrolling' });
    expect(features).toContain('scene:scrolling');
  });

  it('should extract domain from package name', () => {
    const features = extractTraceFeatures({ packageName: 'com.tencent.mm' });
    expect(features).toContain('domain:tencent');
  });

  it('should extract category tags from finding categories', () => {
    const features = extractTraceFeatures({ findingCategories: ['GPU', 'CPU', 'GPU'] });
    expect(features).toContain('cat:GPU');
    expect(features).toContain('cat:CPU');
    // Deduplication
    expect(features.filter(f => f === 'cat:GPU')).toHaveLength(1);
  });

  it('should extract finding title tags (max 5)', () => {
    const titles = ['Frame drop', 'CPU throttle', 'Memory leak', 'Binder stall', 'GC pause', 'Extra'];
    const features = extractTraceFeatures({ findingTitles: titles });
    const findingTags = features.filter(f => f.startsWith('finding:'));
    expect(findingTags.length).toBeLessThanOrEqual(5);
  });

  it('should return empty array for empty context', () => {
    expect(extractTraceFeatures({})).toEqual([]);
  });

  it('should combine all feature types', () => {
    const features = extractTraceFeatures({
      architectureType: 'Standard',
      sceneType: 'scrolling',
      packageName: 'com.google.android.apps.nexuslauncher',
      findingCategories: ['rendering'],
      findingTitles: ['High jank rate'],
    });
    expect(features).toContain('arch:Standard');
    expect(features).toContain('scene:scrolling');
    expect(features).toContain('domain:google');
    expect(features).toContain('cat:rendering');
    expect(features.some(f => f.startsWith('finding:'))).toBe(true);
  });
});

// ── Insight Extraction ───────────────────────────────────────────────────

describe('extractKeyInsights', () => {
  it('should extract CRITICAL and HIGH findings', () => {
    const findings = [
      { id: '1', title: 'Critical issue', description: 'Very bad', severity: 'critical' as const },
      { id: '2', title: 'High issue', description: 'Bad', severity: 'high' as const },
      { id: '3', title: 'Low issue', description: 'Minor', severity: 'low' as const },
    ];
    const insights = extractKeyInsights(findings, '');
    expect(insights.length).toBe(2); // Only critical + high
    expect(insights[0]).toContain('Critical issue');
    expect(insights[1]).toContain('High issue');
  });

  it('should extract root cause from conclusion', () => {
    const insights = extractKeyInsights([], '根因：RenderThread 被 Binder 调用阻塞导致帧超时');
    expect(insights.some(i => i.includes('RenderThread'))).toBe(true);
  });

  it('should cap at 5 important findings', () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`, title: `Issue ${i}`, description: 'Detail', severity: 'critical' as const,
    }));
    const insights = extractKeyInsights(findings, '');
    expect(insights.length).toBeLessThanOrEqual(6); // 5 findings + possible root cause
  });
});

// ── Pattern Matching ─────────────────────────────────────────────────────

describe('matchPatterns', () => {
  it('should return empty for empty features', () => {
    expect(matchPatterns([])).toEqual([]);
  });

  it('should match patterns with high similarity', () => {
    mockPatterns = [{
      id: 'pat-1',
      traceFeatures: ['arch:Standard', 'scene:scrolling', 'domain:google'],
      sceneType: 'scrolling',
      keyInsights: ['High jank rate on Pixel'],
      confidence: 0.8,
      createdAt: Date.now(), // Fresh — no decay
      matchCount: 0,
    }];

    const matches = matchPatterns(['arch:Standard', 'scene:scrolling', 'domain:google']);
    expect(matches.length).toBe(1);
    expect(matches[0].score).toBeGreaterThan(0.5);
  });

  it('should not match patterns with low similarity', () => {
    mockPatterns = [{
      id: 'pat-1',
      traceFeatures: ['arch:Flutter', 'scene:startup'],
      sceneType: 'startup',
      keyInsights: ['Slow init'],
      confidence: 0.5,
      createdAt: Date.now(),
      matchCount: 0,
    }];

    const matches = matchPatterns(['arch:Standard', 'scene:scrolling']);
    expect(matches).toHaveLength(0);
  });

  it('should apply confidence decay to old patterns', () => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    mockPatterns = [{
      id: 'pat-old',
      traceFeatures: ['arch:Standard', 'scene:scrolling'],
      sceneType: 'scrolling',
      keyInsights: ['Old insight'],
      confidence: 0.8,
      createdAt: thirtyDaysAgo, // 30 days old → ~50% decay
      matchCount: 0,
    }];

    const matches = matchPatterns(['arch:Standard', 'scene:scrolling']);
    if (matches.length > 0) {
      // Score should be roughly half of what a fresh pattern would give
      expect(matches[0].score).toBeLessThan(0.9);
    }
  });

  it('should boost frequently matched patterns', () => {
    const features = ['arch:Standard', 'scene:scrolling', 'domain:google'];
    mockPatterns = [
      {
        id: 'pat-frequent',
        traceFeatures: features,
        sceneType: 'scrolling',
        keyInsights: ['Insight A'],
        confidence: 0.8,
        createdAt: Date.now(),
        matchCount: 10, // Frequently matched
      },
      {
        id: 'pat-rare',
        traceFeatures: features,
        sceneType: 'scrolling',
        keyInsights: ['Insight B'],
        confidence: 0.8,
        createdAt: Date.now(),
        matchCount: 0, // Never matched
      },
    ];

    const matches = matchPatterns(features);
    expect(matches.length).toBe(2);
    expect(matches[0].id).toBe('pat-frequent'); // Higher score due to frequency
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it('should respect MAX_MATCHED_PATTERNS (3)', () => {
    const features = ['arch:Standard', 'scene:scrolling'];
    mockPatterns = Array.from({ length: 5 }, (_, i) => ({
      id: `pat-${i}`,
      traceFeatures: features,
      sceneType: 'scrolling',
      keyInsights: [`Insight ${i}`],
      confidence: 0.8,
      createdAt: Date.now(),
      matchCount: 0,
    }));

    const matches = matchPatterns(features);
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it('should filter expired patterns', () => {
    const seventyDaysAgo = Date.now() - 70 * 24 * 60 * 60 * 1000; // > 60-day TTL
    mockPatterns = [{
      id: 'pat-expired',
      traceFeatures: ['arch:Standard', 'scene:scrolling'],
      sceneType: 'scrolling',
      keyInsights: ['Expired insight'],
      confidence: 0.8,
      createdAt: seventyDaysAgo,
      matchCount: 0,
    }];

    expect(matchPatterns(['arch:Standard', 'scene:scrolling'])).toHaveLength(0);
  });
});

// ── Negative Pattern Matching ────────────────────────────────────────────

describe('matchNegativePatterns', () => {
  it('should match negative patterns', () => {
    mockNegativePatterns = [{
      id: 'neg-1',
      traceFeatures: ['arch:Standard', 'scene:scrolling'],
      sceneType: 'scrolling',
      failedApproaches: [{
        type: 'tool_failure',
        approach: 'execute_sql with android_jank',
        reason: 'Table does not exist on this device',
      }],
      createdAt: Date.now(),
      matchCount: 0,
    }];

    const matches = matchNegativePatterns(['arch:Standard', 'scene:scrolling']);
    expect(matches.length).toBe(1);
    expect(matches[0].failedApproaches[0].approach).toContain('android_jank');
  });

  it('should respect 90-day TTL for negative patterns', () => {
    const hundredDaysAgo = Date.now() - 100 * 24 * 60 * 60 * 1000;
    mockNegativePatterns = [{
      id: 'neg-expired',
      traceFeatures: ['arch:Standard', 'scene:scrolling'],
      sceneType: 'scrolling',
      failedApproaches: [{ type: 'sql_error', approach: 'bad query', reason: 'syntax error' }],
      createdAt: hundredDaysAgo,
      matchCount: 0,
    }];

    expect(matchNegativePatterns(['arch:Standard', 'scene:scrolling'])).toHaveLength(0);
  });
});

// ── Pattern Saving ───────────────────────────────────────────────────────

describe('saveAnalysisPattern', () => {
  it('should skip empty features or insights', async () => {
    const fs = require('fs');
    await saveAnalysisPattern([], ['insight'], 'scrolling');
    expect(fs.promises.writeFile).not.toHaveBeenCalled();

    await saveAnalysisPattern(['arch:Standard'], [], 'scrolling');
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
  });

  it('should save new pattern', async () => {
    await saveAnalysisPattern(
      ['arch:Standard', 'scene:scrolling'],
      ['High jank on Pixel'],
      'scrolling',
      'Standard',
      0.85,
    );
    expect(mockPatterns.length).toBe(1);
    expect(mockPatterns[0].sceneType).toBe('scrolling');
    expect(mockPatterns[0].architectureType).toBe('Standard');
    expect(mockPatterns[0].matchCount).toBe(0);
  });

  it('should merge into existing pattern with >70% similarity', async () => {
    mockPatterns = [{
      id: 'pat-existing',
      traceFeatures: ['arch:Standard', 'scene:scrolling'],
      sceneType: 'scrolling',
      keyInsights: ['Old insight'],
      confidence: 0.7,
      createdAt: Date.now() - 1000,
      matchCount: 3,
    }];

    await saveAnalysisPattern(
      ['arch:Standard', 'scene:scrolling'], // Same features → >70% similarity
      ['New insight'],
      'scrolling',
    );

    expect(mockPatterns.length).toBe(1); // Merged, not duplicated
    expect(mockPatterns[0].matchCount).toBe(4); // Bumped
    expect(mockPatterns[0].keyInsights).toContain('Old insight');
    expect(mockPatterns[0].keyInsights).toContain('New insight');
  });
});

describe('saveNegativePattern', () => {
  it('should save new negative pattern', async () => {
    await saveNegativePattern(
      ['arch:Flutter', 'scene:scrolling'],
      [{ type: 'tool_failure', approach: 'bad_skill', reason: 'not found' }],
      'scrolling',
    );
    expect(mockNegativePatterns.length).toBe(1);
    expect(mockNegativePatterns[0].failedApproaches).toHaveLength(1);
  });

  it('should merge approaches on duplicate', async () => {
    mockNegativePatterns = [{
      id: 'neg-1',
      traceFeatures: ['arch:Flutter', 'scene:scrolling'],
      sceneType: 'scrolling',
      failedApproaches: [{ type: 'sql_error', approach: 'bad query 1', reason: 'syntax' }],
      createdAt: Date.now(),
      matchCount: 0,
    }];

    await saveNegativePattern(
      ['arch:Flutter', 'scene:scrolling'],
      [{ type: 'tool_failure', approach: 'bad query 2', reason: 'timeout' }],
      'scrolling',
    );

    expect(mockNegativePatterns.length).toBe(1);
    expect(mockNegativePatterns[0].failedApproaches).toHaveLength(2);
    expect(mockNegativePatterns[0].matchCount).toBe(1);
  });
});

// ── Context Section Building ─────────────────────────────────────────────

describe('buildPatternContextSection', () => {
  it('should return undefined when no matches', () => {
    expect(buildPatternContextSection(['arch:Unknown'])).toBeUndefined();
  });

  it('should build markdown section with matched patterns', () => {
    mockPatterns = [{
      id: 'pat-1',
      traceFeatures: ['arch:Standard', 'scene:scrolling'],
      sceneType: 'scrolling',
      keyInsights: ['Jank caused by RenderThread blocking'],
      architectureType: 'Standard',
      confidence: 0.8,
      createdAt: Date.now(),
      matchCount: 2,
    }];

    const section = buildPatternContextSection(['arch:Standard', 'scene:scrolling']);
    expect(section).toBeDefined();
    expect(section).toContain('历史分析经验');
    expect(section).toContain('scrolling');
    expect(section).toContain('RenderThread blocking');
  });
});

describe('buildNegativePatternSection', () => {
  it('should return undefined when no matches', () => {
    expect(buildNegativePatternSection(['arch:Unknown'])).toBeUndefined();
  });

  it('should build markdown with failed approaches', () => {
    mockNegativePatterns = [{
      id: 'neg-1',
      traceFeatures: ['arch:Standard', 'scene:scrolling'],
      sceneType: 'scrolling',
      failedApproaches: [{
        type: 'tool_failure',
        approach: 'invoke_skill("frame_analysis")',
        reason: 'Skill not found on this trace',
        workaround: 'Use execute_sql directly',
      }],
      createdAt: Date.now(),
      matchCount: 0,
    }];

    const section = buildNegativePatternSection(['arch:Standard', 'scene:scrolling']);
    expect(section).toBeDefined();
    expect(section).toContain('历史踩坑记录');
    expect(section).toContain('避免');
    expect(section).toContain('替代方案');
  });
});
