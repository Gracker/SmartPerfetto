import { HTMLReportGenerator } from '../htmlReportGenerator';
import type { DataEnvelope } from '../../types/dataContract';

function makeEnvelopeWithFrameId(frameId: number): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'scrolling_analysis:get_app_jank_frames#t1',
      timestamp: Date.now(),
      skillId: 'scrolling_analysis',
      stepId: 'get_app_jank_frames',
    },
    display: {
      layer: 'list',
      format: 'table',
      title: '掉帧列表',
      columns: [
        { name: 'frame_id', label: '帧 ID', type: 'number' as any },
        { name: 'dur_ms', label: '帧耗时', type: 'number' as any },
      ],
    },
    data: {
      columns: ['frame_id', 'dur_ms'],
      rows: [[frameId, 16.9]],
    } as any,
  };
}

describe('HTMLReportGenerator', () => {
  test('does not render identifier columns with thousands separators', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-1',
      query: '分析滑动掉帧',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [makeEnvelopeWithFrameId(1435508)],
      result: {
        sessionId: 'session-1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('1435508');
    expect(html).not.toContain('1,435,508');
  });

  test('formats layered duration-like keys in ms only', () => {
    const generator = new HTMLReportGenerator() as any;
    expect(generator.formatLayeredCellValue(1338654478, 'dur_ns')).toBe('1338.65ms');
    expect(generator.formatLayeredCellValue(1500, 'startup_time_ms')).toBe('1500.00ms');
  });

  test('renders legacy duration_us format as ms', () => {
    const generator = new HTMLReportGenerator() as any;
    const formatted = generator.formatCellValueFromDefinition(
      1910,
      { name: 'ttid_us', type: 'duration', format: 'duration_us', unit: 'us' },
      null
    );
    expect(formatted).toContain('1.91 ms');
    expect(formatted).not.toContain('μs');
  });
});
