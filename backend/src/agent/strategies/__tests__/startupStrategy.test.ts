import { describe, expect, it } from '@jest/globals';
import { startupStrategy } from '../startupStrategy';
import { intervalHelpers } from '../helpers';
import type { AgentResponse } from '../../types/agentProtocol';

function buildStartupResponse(rows: any[][]): AgentResponse {
  return {
    agentId: 'startup_agent',
    taskId: 'task-startup',
    success: true,
    findings: [],
    confidence: 0.9,
    executionTimeMs: 10,
    toolResults: [
      {
        success: true,
        executionTimeMs: 8,
        data: {
          startups: {
            columns: [
              'startup_id',
              'package',
              'startup_type',
              'dur_ms',
              'start_ts',
              'end_ts',
              'dur_ns',
              'ttid_ms',
              'ttfd_ms',
              'perfetto_start',
              'perfetto_end',
            ],
            rows,
          },
        },
      },
    ],
  };
}

describe('startupStrategy', () => {
  it('matches startup-related queries', () => {
    expect(startupStrategy.trigger('分析冷启动慢原因')).toBe(true);
    expect(startupStrategy.trigger('startup performance analysis')).toBe(true);
    expect(startupStrategy.trigger('分析滑动卡顿')).toBe(false);
  });

  it('extracts startup intervals with startup metadata', () => {
    const responses: AgentResponse[] = [
      buildStartupResponse([
        [12, 'com.example.app', 'cold', 1800, '1000000', '1801000000', '1800000000', 1200, 1600, '900000', '1900000000'],
        [13, 'com.example.app', 'warm', 350, '3000000000', '3350000000', '350000000', 220, 300, '2950000000', '3400000000'],
      ]),
    ];

    const extract = startupStrategy.stages[0].extractIntervals;
    expect(extract).toBeDefined();

    const intervals = extract!(responses, intervalHelpers);
    expect(intervals).toHaveLength(2);

    expect(intervals[0].metadata?.sourceEntityType).toBe('startup');
    expect(intervals[0].metadata?.startupId).toBe(12);
    expect(intervals[0].metadata?.startup_type).toBe('cold');
    expect(intervals[0].startTs).toBe('1000000');
    expect(intervals[0].endTs).toBe('1801000000');
    expect(intervals[0].metadata?.quality_status).toBe('PASS');
    expect(intervals[0].metadata?.dur_ms).toBe(1800);
  });

  it('marks duration mismatch as BLOCKER and normalizes dur_ms from start/end', () => {
    const responses: AgentResponse[] = [
      buildStartupResponse([
        [2, 'com.example.launch.aosp.heavy', 'warm', 1.34, '564166652267210', '564168258652583', '1606385373', 1.91, null, '564166652267210', '564168258652583'],
      ]),
    ];

    const extract = startupStrategy.stages[0].extractIntervals;
    const intervals = extract!(responses, intervalHelpers);
    expect(intervals).toHaveLength(1);

    const metadata = intervals[0].metadata || {};
    expect(metadata.quality_status).toBe('BLOCKER');
    expect(metadata.quality_blocker_count).toBeGreaterThan(0);
    expect(metadata.quality_issues).toContain('R001_DURATION_MISMATCH_START_END');
    expect(metadata.dur_ms).toBeGreaterThan(1300);
  });

  it('flags suspicious TTID/TTFD values as warnings', () => {
    const responses: AgentResponse[] = [
      buildStartupResponse([
        [7, 'com.example.app', 'warm', 900, '1000000000', '1900000000', '900000000', 2, 1, '900000000', '2000000000'],
      ]),
    ];

    const extract = startupStrategy.stages[0].extractIntervals;
    const intervals = extract!(responses, intervalHelpers);
    expect(intervals).toHaveLength(1);

    const metadata = intervals[0].metadata || {};
    expect(metadata.quality_status).toBe('WARN');
    expect(metadata.quality_warning_count).toBeGreaterThan(0);
    expect(metadata.quality_issues).toContain('R008_TTID_SUSPICIOUSLY_SMALL');
    expect(metadata.quality_issues).toContain('R008_TTFD_LT_TTID');
  });

  it('defines 3 staged pipeline with startup_detail deep dive', () => {
    expect(startupStrategy.stages.map(s => s.name)).toEqual([
      'startup_overview',
      'launch_event_overview',
      'launch_event_detail',
    ]);

    const detailTask = startupStrategy.stages[2].tasks[0];
    expect(detailTask.executionMode).toBe('direct_skill');
    expect(detailTask.directSkillId).toBe('startup_detail');
    expect(detailTask.paramMapping?.startup_id).toBe('startupId');
  });

  it('includes stage1 system context skills for IO/network/thermal', () => {
    const stage1Tasks = startupStrategy.stages[1].tasks;
    const directSkills = stage1Tasks
      .filter(task => task.executionMode === 'direct_skill')
      .map(task => task.directSkillId);

    expect(directSkills).toContain('io_pressure');
    expect(directSkills).toContain('network_analysis');
    expect(directSkills).toContain('thermal_throttling');
  });

  it('skips blocked intervals before startup_detail deep dive', () => {
    const detailTask = startupStrategy.stages[2].tasks[0];
    const filter = detailTask.intervalFilter;
    expect(filter).toBeDefined();

    expect(filter!({
      id: 1,
      processName: 'com.example.app',
      startTs: '1',
      endTs: '2',
      priority: 1,
      metadata: { quality_blocker_count: 1 },
    })).toBe(false);

    expect(filter!({
      id: 2,
      processName: 'com.example.app',
      startTs: '3',
      endTs: '4',
      priority: 1,
      metadata: { qualityBlockerCount: 0 },
    })).toBe(true);
  });

  it('stops stage1 when all intervals fail quality gate', () => {
    const stage1 = startupStrategy.stages[1];
    const shouldStop = stage1.shouldStop;
    expect(shouldStop).toBeDefined();

    const decision = shouldStop!([
      {
        id: 1,
        processName: 'com.example.app',
        startTs: '1',
        endTs: '2',
        priority: 1,
        metadata: { quality_blocker_count: 2 },
      },
    ]);

    expect(decision.stop).toBe(true);
    expect(decision.reason).toContain('门禁未通过');
  });
});
