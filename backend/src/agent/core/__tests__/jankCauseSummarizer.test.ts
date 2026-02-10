/**
 * Tests for JankCauseSummarizer
 *
 * Validates:
 * 1. Grouping findings by cause_type
 * 2. Computing statistics (counts, percentages)
 * 3. Identifying primary and secondary causes
 * 4. Generating human-readable summary text
 */

import { summarizeJankCauses, formatJankSummaryForPrompt, CAUSE_TYPE_LABELS } from '../jankCauseSummarizer';
import { Finding } from '../../types';
import type { FrameMechanismRecord } from '../../types/jankCause';

describe('JankCauseSummarizer', () => {
  // Helper to create test findings
  function createFinding(
    id: string,
    causeType: string,
    primaryCause: string,
    severity: 'critical' | 'warning' | 'info' = 'warning'
  ): Finding {
    return {
      id,
      title: `Test Finding ${id}`,
      description: `Description for ${id}`,
      severity,
      details: {
        cause_type: causeType,
        primary_cause: primaryCause,
        confidence_level: '高',
      },
    };
  }

  function createRecord(
    frameId: string,
    causeType: string,
    primaryCause: string,
    overrides: Partial<FrameMechanismRecord> = {}
  ): FrameMechanismRecord {
    return {
      frameId,
      sessionId: '1',
      startTs: `1000${frameId}`,
      endTs: `1100${frameId}`,
      scopeLabel: `frame-${frameId}`,
      causeType,
      primaryCause,
      sourceStep: 'root_cause',
      ...overrides,
    };
  }

  describe('summarizeJankCauses', () => {
    it('should return empty summary when no findings have cause_type', () => {
      const findings: Finding[] = [
        { id: '1', title: 'Test', description: 'Test', severity: 'warning' },
        { id: '2', title: 'Test2', description: 'Test2', severity: 'info', details: {} },
      ];

      const summary = summarizeJankCauses(findings);

      expect(summary.totalJankFrames).toBe(0);
      expect(summary.primaryCause).toBeNull();
      expect(summary.secondaryCauses).toHaveLength(0);
      expect(summary.allCauses).toHaveLength(0);
      expect(summary.clusters).toHaveLength(0);
      expect(summary.summaryText).toBe('未检测到可分类的根因数据');
    });

    it('should correctly group findings by cause_type', () => {
      const findings = [
        createFinding('1', 'slice', '主线程耗时操作 "doFrame"'),
        createFinding('2', 'slice', '主线程耗时操作 "measure"'),
        createFinding('3', 'gpu_fence', 'GPU Fence 等待'),
        createFinding('4', 'slice', '主线程耗时操作 "layout"'),
        createFinding('5', 'sched_latency', '调度延迟'),
      ];

      const summary = summarizeJankCauses(findings);

      expect(summary.totalJankFrames).toBe(5);
      expect(summary.allCauses).toHaveLength(3);

      // Slice should be primary (3 frames = 60%)
      expect(summary.primaryCause).not.toBeNull();
      expect(summary.primaryCause!.causeType).toBe('slice');
      expect(summary.primaryCause!.frameCount).toBe(3);
      expect(summary.primaryCause!.percentage).toBe(60);
    });

    it('should identify secondary causes (>=10% of total)', () => {
      const findings = [
        // 5 slice (50%)
        createFinding('1', 'slice', 'Slice 1'),
        createFinding('2', 'slice', 'Slice 2'),
        createFinding('3', 'slice', 'Slice 3'),
        createFinding('4', 'slice', 'Slice 4'),
        createFinding('5', 'slice', 'Slice 5'),
        // 3 gpu_fence (30%)
        createFinding('6', 'gpu_fence', 'GPU Fence 1'),
        createFinding('7', 'gpu_fence', 'GPU Fence 2'),
        createFinding('8', 'gpu_fence', 'GPU Fence 3'),
        // 2 sched_latency (20%)
        createFinding('9', 'sched_latency', 'Sched 1'),
        createFinding('10', 'sched_latency', 'Sched 2'),
      ];

      const summary = summarizeJankCauses(findings);

      expect(summary.totalJankFrames).toBe(10);
      expect(summary.primaryCause!.causeType).toBe('slice');
      expect(summary.primaryCause!.percentage).toBe(50);

      // Both gpu_fence (30%) and sched_latency (20%) are secondary
      expect(summary.secondaryCauses).toHaveLength(2);
      expect(summary.secondaryCauses[0].causeType).toBe('gpu_fence');
      expect(summary.secondaryCauses[0].percentage).toBe(30);
      expect(summary.secondaryCauses[1].causeType).toBe('sched_latency');
      expect(summary.secondaryCauses[1].percentage).toBe(20);
    });

    it('should not include causes below 10% in secondaryCauses', () => {
      const findings = [
        // 9 slice (90%)
        ...Array(9).fill(null).map((_, i) => createFinding(`slice_${i}`, 'slice', 'Slice')),
        // 1 gpu_fence (10%)
        createFinding('gpu_1', 'gpu_fence', 'GPU Fence'),
      ];

      const summary = summarizeJankCauses(findings);

      expect(summary.totalJankFrames).toBe(10);
      expect(summary.primaryCause!.causeType).toBe('slice');
      expect(summary.primaryCause!.percentage).toBe(90);

      // gpu_fence is exactly 10%, should be included
      expect(summary.secondaryCauses).toHaveLength(1);
      expect(summary.secondaryCauses[0].causeType).toBe('gpu_fence');
    });

    it('should collect unique example causes (max 3)', () => {
      const findings = [
        createFinding('1', 'slice', 'doFrame 耗时'),
        createFinding('2', 'slice', 'measure 耗时'),
        createFinding('3', 'slice', 'layout 耗时'),
        createFinding('4', 'slice', 'draw 耗时'),  // This should not appear (max 3)
        createFinding('5', 'slice', 'doFrame 耗时'),  // Duplicate
      ];

      const summary = summarizeJankCauses(findings);

      expect(summary.primaryCause!.exampleCauses).toHaveLength(3);
      expect(summary.primaryCause!.exampleCauses).toContain('doFrame 耗时');
      expect(summary.primaryCause!.exampleCauses).toContain('measure 耗时');
      expect(summary.primaryCause!.exampleCauses).toContain('layout 耗时');
      expect(summary.primaryCause!.exampleCauses).not.toContain('draw 耗时');
    });

    it('should use human-readable labels from CAUSE_TYPE_LABELS', () => {
      const findings = [
        createFinding('1', 'slice', 'Test'),
        createFinding('2', 'gpu_fence', 'Test'),
      ];

      const summary = summarizeJankCauses(findings);

      expect(summary.primaryCause!.label).toBe(CAUSE_TYPE_LABELS['slice']);
      expect(summary.allCauses.find(c => c.causeType === 'gpu_fence')!.label)
        .toBe(CAUSE_TYPE_LABELS['gpu_fence']);
    });

    it('should determine severity from findings', () => {
      const findings = [
        createFinding('1', 'slice', 'Test 1', 'warning'),
        createFinding('2', 'slice', 'Test 2', 'critical'),
        createFinding('3', 'gpu_fence', 'Test', 'info'),
      ];

      const summary = summarizeJankCauses(findings);

      // slice has a critical finding, so severity should be critical
      expect(summary.primaryCause!.severity).toBe('critical');
      // gpu_fence only has info
      expect(summary.allCauses.find(c => c.causeType === 'gpu_fence')!.severity).toBe('info');
    });

    it('should prefer frame mechanism records when provided', () => {
      const findings = [
        createFinding('1', 'slice', 'Finding slice 1', 'warning'),
        createFinding('2', 'slice', 'Finding slice 2', 'warning'),
      ];

      const records: FrameMechanismRecord[] = [
        createRecord('1', 'gpu_fence', 'GPU fence wait'),
        createRecord('2', 'gpu_fence', 'GPU fence wait'),
        createRecord('3', 'gpu_fence', 'GPU fence wait'),
        createRecord('4', 'gpu_fence', 'GPU fence wait'),
        createRecord('5', 'gpu_fence', 'GPU fence wait'),
        createRecord('6', 'gpu_fence', 'GPU fence wait'),
        createRecord('7', 'gpu_fence', 'GPU fence wait'),
        createRecord('8', 'gpu_fence', 'GPU fence wait'),
        createRecord('9', 'sched_latency', 'Runnable wait'),
        createRecord('10', 'sched_latency', 'Runnable wait'),
      ];

      const summary = summarizeJankCauses(findings, records);

      expect(summary.totalJankFrames).toBe(10);
      expect(summary.primaryCause?.causeType).toBe('gpu_fence');
      expect(summary.primaryCause?.percentage).toBe(80);
      expect(summary.allCauses).toHaveLength(2);
      expect(summary.clusters).toHaveLength(2);
      expect(summary.clusters[0].clusterId).toBe('K1');
    });

    it('should dedupe duplicate frame mechanism records', () => {
      const records: FrameMechanismRecord[] = [
        createRecord('1', 'slice', 'doFrame'),
        createRecord('1', 'slice', 'doFrame'),
        createRecord('2', 'slice', 'measure'),
      ];

      const summary = summarizeJankCauses([], records);

      expect(summary.totalJankFrames).toBe(2);
      expect(summary.primaryCause?.causeType).toBe('slice');
      expect(summary.primaryCause?.frameCount).toBe(2);
    });

    it('should split clusters by supply/amplification signature', () => {
      const records: FrameMechanismRecord[] = [
        createRecord('1', 'slice', 'doFrame', {
          supplyConstraint: 'frequency_insufficient',
          amplificationPath: 'sf_consumer_backpressure',
        }),
        createRecord('2', 'slice', 'doFrame', {
          supplyConstraint: 'frequency_insufficient',
          amplificationPath: 'sf_consumer_backpressure',
        }),
        createRecord('3', 'slice', 'doFrame', {
          supplyConstraint: 'scheduling_delay',
          amplificationPath: 'app_deadline_miss',
        }),
      ];

      const summary = summarizeJankCauses([], records);

      expect(summary.clusters).toHaveLength(2);
      expect(summary.clusters[0].frameCount).toBe(2);
      expect(summary.clusters[0].supplyConstraint).toBe('频率不足');
      expect(summary.clusters[1].frameCount).toBe(1);
      expect(summary.clusters[1].supplyConstraint).toBe('调度延迟');
    });

    it('should derive record severity from findings when available', () => {
      const findings = [
        createFinding('f1', 'slice', 'from finding', 'critical'),
      ];
      const records: FrameMechanismRecord[] = [
        createRecord('1', 'slice', 'doFrame'),
      ];

      const summary = summarizeJankCauses(findings, records);

      expect(summary.primaryCause?.severity).toBe('critical');
    });

    it('should label slice+none clusters as workload-dominant', () => {
      const records: FrameMechanismRecord[] = [
        createRecord('1', 'slice', 'doFrame', {
          supplyConstraint: 'none',
          amplificationPath: 'sf_consumer_backpressure',
        }),
      ];

      const summary = summarizeJankCauses([], records);

      expect(summary.clusters).toHaveLength(1);
      expect(summary.clusters[0].supplyConstraint).toBe('负载主导（资源问题弱）');
    });
  });

  describe('formatJankSummaryForPrompt', () => {
    it('should return empty string for undefined summary', () => {
      expect(formatJankSummaryForPrompt(undefined)).toBe('');
    });

    it('should return empty string for summary with 0 frames', () => {
      const summary = summarizeJankCauses([]);
      expect(formatJankSummaryForPrompt(summary)).toBe('');
    });

    it('should include header and summary text', () => {
      const findings = [
        createFinding('1', 'slice', 'Test 1'),
        createFinding('2', 'slice', 'Test 2'),
        createFinding('3', 'gpu_fence', 'Test 3'),
      ];

      const summary = summarizeJankCauses(findings);
      const formatted = formatJankSummaryForPrompt(summary);

      expect(formatted).toContain('## 掉帧根因汇总（自动统计）');
      expect(formatted).toContain('3 帧');
      expect(formatted).toContain('掉帧聚类');
      expect(formatted).toContain('K1');
      expect(formatted).toContain('首要原因');
    });
  });

  describe('CAUSE_TYPE_LABELS', () => {
    it('should have labels for all expected cause types', () => {
      const expectedTypes = [
        'slice', 'gpu_fence', 'sched_latency', 'cpu_contention',
        'io_blocking', 'blocking', 'render_wait', 'small_core',
        'freq_limit', 'cpu_overload', 'unknown',
      ];

      for (const type of expectedTypes) {
        expect(CAUSE_TYPE_LABELS[type]).toBeDefined();
        expect(typeof CAUSE_TYPE_LABELS[type]).toBe('string');
      }
    });
  });
});
