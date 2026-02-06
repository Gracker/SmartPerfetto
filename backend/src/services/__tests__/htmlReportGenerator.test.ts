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
});
