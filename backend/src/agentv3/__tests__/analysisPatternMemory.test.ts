// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mock fs before importing module ──────────────────────────────────────

let mockPatterns: any[] = [];
let mockNegativePatterns: any[] = [];
let mockQuickPatterns: any[] = [];
let mockPatternFileRaw: string | undefined;
let mockNegativePatternFileRaw: string | undefined;
let mockQuickPatternFileRaw: string | undefined;
let mockCorruptBackups: Array<{ src: string; dest: string }> = [];
const mockRecordRunManifestInjection = jest.fn();
const originalEnterprise = process.env.SMARTPERFETTO_ENTERPRISE;
const originalMigrationPhase = process.env.SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE;

// Temporary storage for atomic write simulation (writeFile to .tmp, then rename)
let tmpWriteBuffer: Map<string, string> = new Map();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  // The negative file substring also matches the positive file path, so check
  // 'negative' first and 'quick' before the broader 'analysis_patterns'.
  const isNegativeFile = (p: string) => p.includes('analysis_negative_patterns.json');
  const isQuickFile = (p: string) => p.includes('analysis_quick_patterns.json');
  const isPositiveFile = (p: string) =>
    p.includes('analysis_patterns.json') && !isNegativeFile(p) && !isQuickFile(p);
  return {
    ...actual,
    existsSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p !== 'string' || p.includes('.tmp')) return false;
      if (isNegativeFile(p)) return mockNegativePatternFileRaw !== undefined || mockNegativePatterns.length > 0;
      if (isQuickFile(p)) return mockQuickPatternFileRaw !== undefined || mockQuickPatterns.length > 0;
      if (isPositiveFile(p)) return mockPatternFileRaw !== undefined || mockPatterns.length > 0;
      return false;
    }),
    readFileSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && isNegativeFile(p)) {
        return mockNegativePatternFileRaw ?? JSON.stringify(mockNegativePatterns);
      }
      if (typeof p === 'string' && isQuickFile(p)) {
        return mockQuickPatternFileRaw ?? JSON.stringify(mockQuickPatterns);
      }
      if (typeof p === 'string' && isPositiveFile(p)) {
        return mockPatternFileRaw ?? JSON.stringify(mockPatterns);
      }
      return '[]';
    }),
    mkdirSync: jest.fn(),
    renameSync: jest.fn((...args: unknown[]) => {
      const src = args[0] as string;
      const dest = args[1] as string;
      mockCorruptBackups.push({ src, dest });
      if (isNegativeFile(src)) mockNegativePatternFileRaw = undefined;
      if (isQuickFile(src)) mockQuickPatternFileRaw = undefined;
      if (isPositiveFile(src)) mockPatternFileRaw = undefined;
    }),
    promises: {
      writeFile: jest.fn(async (...args: unknown[]) => {
        const p = args[0] as string;
        const data = args[1] as string;
        tmpWriteBuffer.set(p, data);
      }),
      rename: jest.fn(async (...args: unknown[]) => {
        const src = args[0] as string;
        const dest = args[1] as string;
        const data = tmpWriteBuffer.get(src);
        if (data) {
          if (typeof dest === 'string' && isNegativeFile(dest)) {
            mockNegativePatterns = JSON.parse(data);
            mockNegativePatternFileRaw = undefined;
          } else if (typeof dest === 'string' && isQuickFile(dest)) {
            mockQuickPatterns = JSON.parse(data);
            mockQuickPatternFileRaw = undefined;
          } else if (typeof dest === 'string' && isPositiveFile(dest)) {
            mockPatterns = JSON.parse(data);
            mockPatternFileRaw = undefined;
          }
          tmpWriteBuffer.delete(src);
        }
      }),
    },
  };
});

jest.mock('../../services/filesystemRegistryLock', () => ({
  withFilesystemRegistryLockAsync: jest.fn(
    async (
      _storagePath: string,
      _busyError: string,
      operation: (lease: {assertHeld(): void}) => Promise<unknown>,
    ) => operation({assertHeld: () => {}}),
  ),
}));

jest.mock('../../services/selfEvolution/runManifestLifecycle', () => ({
  currentRunManifestAttributionSink: () => ({
    recordInjection: mockRecordRunManifestInjection,
  }),
}));

import {
  extractTraceFeatures,
  extractKeyInsights,
  matchPatterns,
  matchNegativePatterns,
  saveAnalysisPattern,
  saveNegativePattern,
  saveQuickPathPattern,
  matchQuickPatternsAsBackup,
  promoteQuickPatternIfMatching,
  applyFeedbackToPattern,
  sweepAutoConfirm,
  buildPatternContextSection,
  buildNegativePatternSection,
  setSupersedeStoreForTesting,
} from '../analysisPatternMemory';
import { bucketPackageDomain } from '../../services/caseEvolution/domainBucket';
import { canonicalContentHash } from '../../services/selfEvolution/canonicalJson';

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPatterns = [];
  mockNegativePatterns = [];
  mockQuickPatterns = [];
  mockPatternFileRaw = undefined;
  mockNegativePatternFileRaw = undefined;
  mockQuickPatternFileRaw = undefined;
  mockCorruptBackups = [];
  mockRecordRunManifestInjection.mockClear();
  tmpWriteBuffer = new Map();
  // Disable the real SQLite supersede store for fs-mocked tests; PR9b's
  // own integration tests cover the live store behaviour.
  setSupersedeStoreForTesting(null);
  process.env.SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE = 'legacy';
});

afterEach(() => {
  if (originalEnterprise === undefined) {
    delete process.env.SMARTPERFETTO_ENTERPRISE;
  } else {
    process.env.SMARTPERFETTO_ENTERPRISE = originalEnterprise;
  }
  if (originalMigrationPhase === undefined) {
    delete process.env.SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE;
  } else {
    process.env.SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE = originalMigrationPhase;
  }
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
    expect(features).toContain(`domain:${bucketPackageDomain('com.tencent.mm')}`);
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

  it('serializes concurrent writes so both new patterns survive', async () => {
    const fs = require('fs');

    await Promise.all([
      saveAnalysisPattern(['arch:STANDARD', 'scene:startup'], ['startup insight'], 'startup', 'STANDARD'),
      saveAnalysisPattern(['arch:FLUTTER', 'scene:scrolling'], ['scrolling insight'], 'scrolling', 'FLUTTER'),
    ]);

    expect(mockPatterns.map(p => p.keyInsights[0]).sort()).toEqual([
      'scrolling insight',
      'startup insight',
    ]);
    expect(() => JSON.parse(JSON.stringify(mockPatterns))).not.toThrow();

    const tmpPaths = fs.promises.writeFile.mock.calls.map((call: unknown[]) => call[0]);
    expect(new Set(tmpPaths).size).toBe(tmpPaths.length);
    expect(tmpPaths.every((p: string) => p.includes(`.tmp-${process.pid}-`))).toBe(true);
  });

  it('backs up corrupt positive store, logs an error, and falls back to last known good patterns', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const features = ['arch:STANDARD', 'scene:scrolling'];
    mockPatterns = [{
      id: 'pat-good',
      traceFeatures: features,
      sceneType: 'scrolling',
      keyInsights: ['cached insight'],
      confidence: 0.8,
      createdAt: Date.now(),
      matchCount: 0,
      status: 'confirmed',
    }];

    expect(matchPatterns(features)).toHaveLength(1);

    mockPatternFileRaw = '{"not valid json"';
    const matches = matchPatterns(features);

    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('pat-good');
    expect(mockCorruptBackups.some(b => b.dest.includes('analysis_patterns.json.corrupt-'))).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('keeps last known good patterns after a corrupt store is quarantined and then missing', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const features = ['arch:STANDARD', 'scene:scrolling'];
    mockPatterns = [{
      id: 'pat-good',
      traceFeatures: features,
      sceneType: 'scrolling',
      keyInsights: ['cached insight'],
      confidence: 0.8,
      createdAt: Date.now(),
      matchCount: 0,
      status: 'confirmed',
    }];

    expect(matchPatterns(features)).toHaveLength(1);

    mockPatternFileRaw = '{"not valid json"';
    expect(matchPatterns(features).map(match => match.id)).toEqual(['pat-good']);

    mockPatterns = [];
    expect(matchPatterns(features).map(match => match.id)).toEqual(['pat-good']);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
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

  it('backs up corrupt negative store, logs an error, and returns an empty cold-cache result', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(matchNegativePatterns(['arch:NO_FILE', 'scene:missing'])).toEqual([]);
    mockNegativePatternFileRaw = '{definitely not json';

    expect(matchNegativePatterns(['arch:STANDARD', 'scene:scrolling'])).toEqual([]);
    expect(mockCorruptBackups.some(b => b.dest.includes('analysis_negative_patterns.json.corrupt-'))).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
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
    const renderedContribution = section?.split('\n\n')[2];
    expect(renderedContribution).toBeDefined();
    expect(mockRecordRunManifestInjection).toHaveBeenCalledWith(
      'patterns',
      'pat-1',
      canonicalContentHash(renderedContribution),
    );
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
    const renderedContribution = section?.split('\n\n')[2];
    expect(renderedContribution).toBeDefined();
    expect(mockRecordRunManifestInjection).toHaveBeenCalledWith(
      'patterns',
      'neg-1',
      canonicalContentHash(renderedContribution),
    );
  });
});

// ── Self-Improving v3.3 — state machine + buckets + promote + feedback ───

describe('saveAnalysisPattern with extras', () => {
  it('defaults new entries to status=provisional', async () => {
    await saveAnalysisPattern(['arch:STANDARD', 'scene:scrolling'], ['root cause: jank'], 'scrolling', 'STANDARD');
    expect(mockPatterns).toHaveLength(1);
    expect(mockPatterns[0].status).toBe('provisional');
  });

  it('honors explicit status from extras', async () => {
    await saveAnalysisPattern(
      ['arch:STANDARD', 'scene:scrolling'],
      ['insight'],
      'scrolling',
      'STANDARD',
      0.7,
      { status: 'confirmed' },
    );
    expect(mockPatterns[0].status).toBe('confirmed');
  });

  it('attaches failureModeHash + provenance + bucketKey when provided', async () => {
    await saveAnalysisPattern(
      ['arch:STANDARD'],
      ['insight'],
      'scrolling',
      'STANDARD',
      undefined,
      {
        failureModeHash: 'cafebabe12345678',
        bucketKey: 'scrolling::STANDARD::tencent',
        provenance: { sessionId: 's1', turnIndex: 0 },
      },
    );
    expect(mockPatterns[0].failureModeHash).toBe('cafebabe12345678');
    expect(mockPatterns[0].bucketKey).toBe('scrolling::STANDARD::tencent');
    expect(mockPatterns[0].provenance).toEqual({ sessionId: 's1', turnIndex: 0 });
  });

  it('does not downgrade an already-confirmed entry on re-save', async () => {
    await saveAnalysisPattern(['arch:STANDARD', 'scene:scrolling'], ['v1'], 'scrolling', 'STANDARD', 0.7, { status: 'confirmed' });
    expect(mockPatterns[0].status).toBe('confirmed');
    // Re-save with overlapping features → triggers the merge branch.
    await saveAnalysisPattern(['arch:STANDARD', 'scene:scrolling'], ['v2'], 'scrolling', 'STANDARD');
    expect(mockPatterns[0].status).toBe('confirmed');
  });
});

describe('enterprise scope isolation', () => {
  const scopeA = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
  const scopeB = {tenantId: 'tenant-b', workspaceId: 'workspace-b', userId: 'user-b'};
  const features = ['arch:STANDARD', 'scene:scrolling'];

  beforeEach(() => {
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
  });

  it('saves source scope provenance and filters positive matches before similarity ranking', async () => {
    await saveAnalysisPattern(
      features,
      ['tenant-a insight'],
      'scrolling',
      'STANDARD',
      0.9,
      {knowledgeScope: scopeA},
    );
    await saveAnalysisPattern(
      features,
      ['tenant-b insight'],
      'scrolling',
      'STANDARD',
      0.9,
      {knowledgeScope: scopeB},
    );

    expect(mockPatterns).toHaveLength(2);
    expect(mockPatterns.map(pattern => pattern.provenance.sourceTenantId).sort()).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    expect(matchPatterns(features, scopeA).map(p => p.keyInsights[0])).toEqual([
      'tenant-a insight',
    ]);
    expect(matchPatterns(features, scopeB).map(p => p.keyInsights[0])).toEqual([
      'tenant-b insight',
    ]);
  });

  it('filters negative and quick-path matches by the same enterprise scope', async () => {
    await saveNegativePattern(
      features,
      [{type: 'sql_error', approach: 'bad sql', reason: 'tenant-a'}],
      'scrolling',
      'STANDARD',
      {knowledgeScope: scopeA},
    );
    await saveNegativePattern(
      features,
      [{type: 'sql_error', approach: 'bad sql', reason: 'tenant-b'}],
      'scrolling',
      'STANDARD',
      {knowledgeScope: scopeB},
    );
    await saveQuickPathPattern(
      features,
      ['tenant-a quick'],
      'scrolling',
      'STANDARD',
      {knowledgeScope: scopeA},
    );

    expect(matchNegativePatterns(features, scopeA)[0].failedApproaches[0].reason)
      .toBe('tenant-a');
    expect(matchNegativePatterns(features, scopeB)[0].failedApproaches[0].reason)
      .toBe('tenant-b');
    expect(matchQuickPatternsAsBackup(features, scopeB)).toHaveLength(0);
  });
});

describe('matchPatterns status weighting', () => {
  it('drops entries with status=rejected', async () => {
    mockPatterns = [{
      id: 'p1', traceFeatures: ['arch:STANDARD', 'scene:scrolling'],
      sceneType: 'scrolling', keyInsights: ['x'], confidence: 0.9,
      createdAt: Date.now(), matchCount: 5, status: 'rejected',
    }];
    expect(matchPatterns(['arch:STANDARD', 'scene:scrolling'])).toEqual([]);
  });

  it('confirmed entries score higher than provisional for same features', async () => {
    const now = Date.now();
    mockPatterns = [
      { id: 'p_conf', traceFeatures: ['arch:STANDARD', 'scene:scrolling'], sceneType: 'scrolling', keyInsights: ['a'], confidence: 0.9, createdAt: now, matchCount: 0, status: 'confirmed' },
      { id: 'p_prov', traceFeatures: ['arch:STANDARD', 'scene:scrolling'], sceneType: 'scrolling', keyInsights: ['b'], confidence: 0.9, createdAt: now, matchCount: 0, status: 'provisional' },
    ];
    const matches = matchPatterns(['arch:STANDARD', 'scene:scrolling']);
    expect(matches[0].id).toBe('p_conf');
    expect(matches[1].id).toBe('p_prov');
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it('legacy entries (no status field) behave as confirmed', async () => {
    mockPatterns = [{
      id: 'legacy', traceFeatures: ['arch:STANDARD', 'scene:scrolling'],
      sceneType: 'scrolling', keyInsights: ['x'], confidence: 0.7, createdAt: Date.now(), matchCount: 0,
    }];
    const matches = matchPatterns(['arch:STANDARD', 'scene:scrolling']);
    expect(matches.length).toBe(1);
    // Legacy gets full status weight (1.0) — score should be similar to a confirmed entry.
    expect(matches[0].score).toBeGreaterThan(0.5);
  });
});

describe('quick-path bucket', () => {
  it('saves and retrieves quick-path entries', async () => {
    await saveQuickPathPattern(['arch:FLUTTER', 'scene:scrolling'], ['quick insight'], 'scrolling', 'FLUTTER');
    expect(mockQuickPatterns).toHaveLength(1);
    const matches = matchQuickPatternsAsBackup(['arch:FLUTTER', 'scene:scrolling']);
    expect(matches.length).toBe(1);
  });

  it('injects quick-path matches into the prompt when full-path memory has no match', () => {
    mockQuickPatterns = [{
      id: 'quick',
      traceFeatures: ['arch:FLUTTER', 'scene:scrolling'],
      sceneType: 'scrolling',
      keyInsights: ['quick fallback insight'],
      confidence: 0.3,
      createdAt: Date.now(),
      matchCount: 0,
      status: 'confirmed',
    }];

    const section = buildPatternContextSection(['arch:FLUTTER', 'scene:scrolling']);

    expect(section).toContain('历史分析经验');
    expect(section).toContain('quick fallback insight');
    expect(section).toContain('相似度 30%');
  });

  it('does not read quick-path fallback when full-path memory already matches', () => {
    mockPatterns = [{
      id: 'long',
      traceFeatures: ['arch:FLUTTER', 'scene:scrolling'],
      sceneType: 'scrolling',
      keyInsights: ['long-term insight'],
      confidence: 0.9,
      createdAt: Date.now(),
      matchCount: 0,
      status: 'confirmed',
    }];
    mockQuickPatternFileRaw = '{not valid json';

    const section = buildPatternContextSection(['arch:FLUTTER', 'scene:scrolling']);

    expect(section).toContain('long-term insight');
    expect(section).not.toContain('quick fallback insight');
    expect(mockCorruptBackups).toHaveLength(0);
  });

  it('quick-path matches score lower than long-term confirmed for same features', async () => {
    const now = Date.now();
    mockPatterns = [{
      id: 'long', traceFeatures: ['arch:FLUTTER', 'scene:scrolling'],
      sceneType: 'scrolling', keyInsights: ['l'], confidence: 0.9, createdAt: now, matchCount: 0, status: 'confirmed',
    }];
    mockQuickPatterns = [{
      id: 'quick', traceFeatures: ['arch:FLUTTER', 'scene:scrolling'],
      sceneType: 'scrolling', keyInsights: ['q'], confidence: 0.3, createdAt: now, matchCount: 0, status: 'confirmed',
    }];
    const longMatch = matchPatterns(['arch:FLUTTER', 'scene:scrolling'])[0];
    const quickMatch = matchQuickPatternsAsBackup(['arch:FLUTTER', 'scene:scrolling'])[0];
    expect(longMatch.score).toBeGreaterThan(quickMatch.score);
  });
});

describe('promoteQuickPatternIfMatching', () => {
  const features = ['arch:FLUTTER', 'scene:scrolling'];

  it('returns false when verifierPassed is false', async () => {
    mockQuickPatterns = [{
      id: 'q1', traceFeatures: features, sceneType: 'scrolling', keyInsights: ['root cause: jank'],
      architectureType: 'FLUTTER', confidence: 0.5, createdAt: Date.now(), matchCount: 0, status: 'provisional',
    }];
    const promoted = await promoteQuickPatternIfMatching({
      fullPathFeatures: features,
      fullPathInsights: ['root cause: jank'],
      sceneType: 'scrolling',
      architectureType: 'FLUTTER',
      verifierPassed: false,
    });
    expect(promoted).toBe(false);
    expect(mockPatterns).toHaveLength(0);
  });

  it('promotes when similarity ≥0.65 and at least one insight overlaps', async () => {
    mockQuickPatterns = [{
      id: 'q1', traceFeatures: features, sceneType: 'scrolling', keyInsights: ['root cause: dropped frames'],
      architectureType: 'FLUTTER', confidence: 0.5, createdAt: Date.now(), matchCount: 0, status: 'provisional',
    }];
    const promoted = await promoteQuickPatternIfMatching({
      fullPathFeatures: features,
      fullPathInsights: ['root cause: dropped frames', 'extra detail'],
      sceneType: 'scrolling',
      architectureType: 'FLUTTER',
      verifierPassed: true,
    });
    expect(promoted).toBe(true);
    expect(mockPatterns).toHaveLength(1);
    expect(mockPatterns[0].status).toBe('confirmed');
  });

  it('refuses to promote when no insight overlaps', async () => {
    mockQuickPatterns = [{
      id: 'q1', traceFeatures: features, sceneType: 'scrolling', keyInsights: ['something unrelated'],
      architectureType: 'FLUTTER', confidence: 0.5, createdAt: Date.now(), matchCount: 0, status: 'provisional',
    }];
    const promoted = await promoteQuickPatternIfMatching({
      fullPathFeatures: features,
      fullPathInsights: ['totally different insight'],
      sceneType: 'scrolling',
      architectureType: 'FLUTTER',
      verifierPassed: true,
    });
    expect(promoted).toBe(false);
  });

  it('refuses to promote when scene/arch differ', async () => {
    mockQuickPatterns = [{
      id: 'q1', traceFeatures: features, sceneType: 'scrolling', keyInsights: ['x'],
      architectureType: 'FLUTTER', confidence: 0.5, createdAt: Date.now(), matchCount: 0, status: 'provisional',
    }];
    const promoted = await promoteQuickPatternIfMatching({
      fullPathFeatures: features,
      fullPathInsights: ['x'],
      sceneType: 'startup', // mismatch
      architectureType: 'FLUTTER',
      verifierPassed: true,
    });
    expect(promoted).toBe(false);
  });

  it('refuses to promote rejected/disputed quick entries', async () => {
    mockQuickPatterns = [{
      id: 'q1', traceFeatures: features, sceneType: 'scrolling', keyInsights: ['x'],
      architectureType: 'FLUTTER', confidence: 0.5, createdAt: Date.now(), matchCount: 0, status: 'rejected',
    }];
    const promoted = await promoteQuickPatternIfMatching({
      fullPathFeatures: features,
      fullPathInsights: ['x'],
      sceneType: 'scrolling',
      architectureType: 'FLUTTER',
      verifierPassed: true,
    });
    expect(promoted).toBe(false);
  });
});

describe('applyFeedbackToPattern state machine', () => {
  const feedbackScope = {
    tenantId: 'default-dev-tenant',
    workspaceId: 'default-workspace',
  };
  const baseEntry = {
    id: 'p1', traceFeatures: ['arch:STANDARD'], sceneType: 'scrolling',
    keyInsights: ['x'], confidence: 0.7, matchCount: 0,
    provenance: {
      sourceTenantId: feedbackScope.tenantId,
      sourceWorkspaceId: feedbackScope.workspaceId,
    },
  };

  it('returns null when patternId not found', async () => {
    const result = await applyFeedbackToPattern('missing', 'positive', feedbackScope);
    expect(result).toBeNull();
  });

  it('flips provisional → confirmed on positive feedback', async () => {
    mockPatterns = [{ ...baseEntry, status: 'provisional', createdAt: Date.now() }];
    const status = await applyFeedbackToPattern('p1', 'positive', feedbackScope);
    expect(status).toBe('confirmed');
    expect(mockPatterns[0].status).toBe('confirmed');
    expect(mockPatterns[0].lastFeedbackAt).toBeDefined();
  });

  it('flips provisional → rejected on negative feedback', async () => {
    mockPatterns = [{ ...baseEntry, status: 'provisional', createdAt: Date.now() }];
    const status = await applyFeedbackToPattern('p1', 'negative', feedbackScope);
    expect(status).toBe('rejected');
  });

  it('reverse feedback within 10s is treated as misclick (last-write-wins)', async () => {
    const t0 = 1_700_000_000_000;
    mockPatterns = [{
      ...baseEntry, status: 'confirmed', createdAt: t0 - 1000,
      firstFeedbackAt: t0, lastFeedbackAt: t0,
    }];
    const status = await applyFeedbackToPattern('p1', 'negative', feedbackScope, t0 + 5_000);
    expect(status).toBe('rejected');
  });

  it('reverse feedback in the 10s–24h window enters disputed', async () => {
    const t0 = 1_700_000_000_000;
    mockPatterns = [{
      ...baseEntry, status: 'confirmed', createdAt: t0 - 1000,
      firstFeedbackAt: t0, lastFeedbackAt: t0,
    }];
    const status = await applyFeedbackToPattern('p1', 'negative', feedbackScope, t0 + 60 * 60 * 1000); // 1h later
    expect(status).toBe('disputed');
  });

  it('reverse feedback >24h later enters disputed_late', async () => {
    const t0 = 1_700_000_000_000;
    mockPatterns = [{
      ...baseEntry, status: 'confirmed', createdAt: t0 - 1000,
      firstFeedbackAt: t0, lastFeedbackAt: t0,
    }];
    const status = await applyFeedbackToPattern('p1', 'negative', feedbackScope, t0 + 48 * 60 * 60 * 1000); // 2 days later
    expect(status).toBe('disputed_late');
  });

  it('rejected entries stay rejected regardless of subsequent positives', async () => {
    mockPatterns = [{ ...baseEntry, status: 'rejected', createdAt: Date.now() }];
    const status = await applyFeedbackToPattern('p1', 'positive', feedbackScope);
    expect(status).toBe('rejected');
  });

  it('finds patterns across positive / quick / negative buckets', async () => {
    mockQuickPatterns = [{ ...baseEntry, id: 'q1', status: 'provisional', createdAt: Date.now() }];
    const status = await applyFeedbackToPattern('q1', 'positive', feedbackScope);
    expect(status).toBe('confirmed');
    expect(mockQuickPatterns[0].status).toBe('confirmed');
  });

  it('does not mutate a matching id owned by another tenant', async () => {
    mockPatterns = [{...baseEntry, status: 'provisional', createdAt: Date.now()}];
    const status = await applyFeedbackToPattern('p1', 'negative', {
      tenantId: 'tenant-b',
      workspaceId: feedbackScope.workspaceId,
    });

    expect(status).toBeNull();
    expect(mockPatterns[0].status).toBe('provisional');
  });
});

describe('sweepAutoConfirm', () => {
  it('promotes provisional entries past the 24h window to confirmed', async () => {
    const now = 1_700_000_000_000;
    mockPatterns = [
      { id: 'old', traceFeatures: ['x'], sceneType: 's', keyInsights: ['i'], confidence: 0.5,
        createdAt: now - 2 * 24 * 60 * 60 * 1000, matchCount: 0, status: 'provisional' },
      { id: 'fresh', traceFeatures: ['y'], sceneType: 's', keyInsights: ['i'], confidence: 0.5,
        createdAt: now - 60 * 1000, matchCount: 0, status: 'provisional' },
    ];
    await sweepAutoConfirm(now);
    const old = mockPatterns.find(p => p.id === 'old');
    const fresh = mockPatterns.find(p => p.id === 'fresh');
    expect(old.status).toBe('confirmed');
    expect(fresh.status).toBe('provisional');
  });

  it('does not touch confirmed/rejected entries', async () => {
    const now = 1_700_000_000_000;
    mockPatterns = [
      { id: 'conf', traceFeatures: ['x'], sceneType: 's', keyInsights: ['i'], confidence: 0.5,
        createdAt: now - 2 * 24 * 60 * 60 * 1000, matchCount: 0, status: 'confirmed' },
      { id: 'rej', traceFeatures: ['x'], sceneType: 's', keyInsights: ['i'], confidence: 0.5,
        createdAt: now - 2 * 24 * 60 * 60 * 1000, matchCount: 0, status: 'rejected' },
    ];
    await sweepAutoConfirm(now);
    expect(mockPatterns.find(p => p.id === 'conf').status).toBe('confirmed');
    expect(mockPatterns.find(p => p.id === 'rej').status).toBe('rejected');
  });

  it('promotes only patterns in the requested enterprise scope', async () => {
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    const now = 1_700_000_000_000;
    const old = now - 2 * 24 * 60 * 60 * 1000;
    const scopeA = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    mockPatterns = [
      { id: 'pos-a', traceFeatures: ['x'], sceneType: 's', keyInsights: ['a'], confidence: 0.5,
        createdAt: old, matchCount: 0, status: 'provisional',
        provenance: {sourceTenantId: 'tenant-a', sourceWorkspaceId: 'workspace-a'} },
      { id: 'pos-b', traceFeatures: ['x'], sceneType: 's', keyInsights: ['b'], confidence: 0.5,
        createdAt: old, matchCount: 0, status: 'provisional',
        provenance: {sourceTenantId: 'tenant-b', sourceWorkspaceId: 'workspace-b'} },
    ];
    mockNegativePatterns = [
      { id: 'neg-a', traceFeatures: ['x'], sceneType: 's', failedApproaches: [],
        createdAt: old, matchCount: 0, status: 'provisional',
        provenance: {sourceTenantId: 'tenant-a', sourceWorkspaceId: 'workspace-a'} },
      { id: 'neg-b', traceFeatures: ['x'], sceneType: 's', failedApproaches: [],
        createdAt: old, matchCount: 0, status: 'provisional',
        provenance: {sourceTenantId: 'tenant-b', sourceWorkspaceId: 'workspace-b'} },
    ];

    const result = await sweepAutoConfirm(now, scopeA);

    expect(result).toEqual({
      positivePromoted: 1,
      negativePromoted: 1,
      totalPromoted: 2,
    });
    expect(mockPatterns.find(p => p.id === 'pos-a').status).toBe('confirmed');
    expect(mockPatterns.find(p => p.id === 'pos-b').status).toBe('provisional');
    expect(mockNegativePatterns.find(p => p.id === 'neg-a').status).toBe('confirmed');
    expect(mockNegativePatterns.find(p => p.id === 'neg-b').status).toBe('provisional');
  });
});

describe('startPatternMemoryAutoConfirmSweep', () => {
  it('registers an hourly background sweep and logs tick failures without throwing', async () => {
    const patternMemoryModule = require('../analysisPatternMemory');
    expect(typeof patternMemoryModule.startPatternMemoryAutoConfirmSweep).toBe('function');

    let tick: (() => Promise<void> | void) | undefined;
    const timer = {unref: jest.fn()};
    const setIntervalFn = jest.fn((fn: () => Promise<void> | void, _ms: number) => {
      tick = fn;
      return timer;
    });
    const clearIntervalFn = jest.fn();
    const sweep = jest
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('sweep failed'))
      .mockResolvedValueOnce({positivePromoted: 0, negativePromoted: 0, totalPromoted: 0});
    const logger = {error: jest.fn()};

    const handle = patternMemoryModule.startPatternMemoryAutoConfirmSweep({
      sweep,
      logger,
      setIntervalFn,
      clearIntervalFn,
    });

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    expect(timer.unref).toHaveBeenCalled();
    await tick?.();
    expect(logger.error).toHaveBeenCalled();
    await tick?.();
    expect(sweep).toHaveBeenCalledTimes(2);

    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });
});
