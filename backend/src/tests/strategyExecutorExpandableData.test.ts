import { describe, it, expect } from '@jest/globals';
import { StrategyExecutor } from '../agent/core/executors/strategyExecutor';

describe('StrategyExecutor expandableData synthesis', () => {
  it('binds per-frame direct skill results back into get_app_jank_frames table', () => {
    const executor = new StrategyExecutor({ id: 't', name: 't', trigger: () => true, stages: [] } as any, {} as any);

    const tableEnvelope = {
      meta: { type: 'skill_result', version: '2.0.0', source: 'scrolling_analysis:get_app_jank_frames#x', timestamp: Date.now(), skillId: 'scrolling_analysis', stepId: 'get_app_jank_frames' },
      display: { layer: 'list', format: 'table', title: '掉帧列表' },
      data: {
        columns: ['frame_id', 'start_ts', 'session_id', 'dur_ms'],
        rows: [
          [101, '1000', 1, 20.5],
          [102, '2000', 1, 35.0],
        ],
      },
    } as any;

    const tasks = [
      { interval: { id: 101, startTs: '1000', endTs: '1016', processName: 'com.example', priority: 1, metadata: { sessionId: 1, frameId: 101 } } },
      { interval: { id: 102, startTs: '2000', endTs: '2033', processName: 'com.example', priority: 1, metadata: { sessionId: 1, frameId: 102 } } },
    ] as any[];

    const responses = [
      {
        success: true,
        findings: [{ severity: 'warning', title: 'CPU 密集', description: '主线程占用高', source: 'direct_skill:janky_frame_analysis' }],
        toolResults: [{
          success: true,
          executionTimeMs: 1,
          data: {
            cpu: {
              stepId: 'cpu',
              success: true,
              executionTimeMs: 1,
              data: { columns: ['total_cpu_ms'], rows: [[18.2]] },
              display: { title: 'CPU' },
            },
          },
        }],
      },
      {
        success: false,
        findings: [],
        toolResults: [{
          success: false,
          executionTimeMs: 1,
          error: 'timeout',
          data: {},
        }],
      },
    ] as any[];

    const merged = (executor as any).attachExpandableDataToDeferredTables([tableEnvelope], tasks, responses) as any[];
    expect(merged).toHaveLength(1);
    expect(merged[0].data.expandableData).toHaveLength(2);

    // Row 0 gets bound and includes sections.
    expect(merged[0].data.expandableData[0].item.frame_id).toBe(101);
    expect(merged[0].data.expandableData[0].result.success).toBe(true);
    expect(merged[0].data.expandableData[0].result.sections.findings.data[0].title).toContain('CPU');
    expect(merged[0].data.expandableData[0].result.sections.cpu.data[0].total_cpu_ms).toBe(18.2);

    // Row 1 is bound and shows error state.
    expect(merged[0].data.expandableData[1].item.frame_id).toBe(102);
    expect(merged[0].data.expandableData[1].result.success).toBe(false);
    expect(merged[0].data.expandableData[1].result.error).toBe('timeout');
  });
});

