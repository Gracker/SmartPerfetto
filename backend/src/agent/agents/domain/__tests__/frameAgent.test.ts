import { FrameAgent } from '../frameAgent';
import type { ModelRouter } from '../../../core/modelRouter';
import type { SkillExecutionResult, StepResult } from '../../../../services/skillEngine/types';

jest.mock('../../tools/adbTools', () => ({
  getAdbAgentTools: jest.fn().mockReturnValue([]),
}));

function stepResult(data: any): StepResult {
  return {
    stepId: 'x',
    stepType: 'atomic',
    success: true,
    data,
    executionTimeMs: 1,
  } as StepResult;
}

function makeResult(rawResults: Record<string, StepResult>): SkillExecutionResult {
  return {
    skillId: 'scrolling_analysis',
    skillName: 'scrolling_analysis',
    success: true,
    displayResults: [],
    diagnostics: [],
    rawResults,
    executionTimeMs: 10,
  };
}

describe('FrameAgent', () => {
  const mockModelRouter = {
    callWithFallback: jest.fn(),
  } as unknown as ModelRouter;

  test('does not recommend consumer jank tool for generic scrolling query', () => {
    const agent = new FrameAgent(mockModelRouter);
    const tools = (agent as any).getRecommendedTools({ query: '分析滑动掉帧原因' });

    expect(tools).toContain('analyze_scrolling');
    expect(tools).not.toContain('detect_consumer_jank');
  });

  test('recommends consumer jank tool for explicit SF/consumer query', () => {
    const agent = new FrameAgent(mockModelRouter);
    const tools = (agent as any).getRecommendedTools({ query: '分析 surfaceflinger 合成卡顿' });

    expect(tools).toContain('detect_consumer_jank');
  });

  test('prioritizes scrolling frame list over consumer summary in consolidated finding', () => {
    const agent = new FrameAgent(mockModelRouter);

    const appFrames = Array.from({ length: 39 }, (_, i) => ({ frame_id: i + 1 }));
    const consumerFrames = Array.from({ length: 526 }, (_, i) => ({ frame_id: i + 1 }));

    const result = makeResult({
      performance_summary: stepResult([{ total_frames: 642, janky_frames: 39, jank_rate: 6.07 }]),
      get_app_jank_frames: stepResult(appFrames),
      consumer_jank_summary: stepResult([{ consumer_jank_frames: 526, consumer_jank_rate: 82.1 }]),
      consumer_jank_frames: stepResult(consumerFrames),
    });

    const findings = (agent as any).extractFindingsFromResult(result, 'scrolling_analysis', 'frame');
    const consolidated = findings.find((f: any) => String(f.title || '').includes('滑动卡顿检测'));

    expect(consolidated).toBeDefined();
    expect(consolidated.title).toContain('39 帧');
    expect(consolidated.description).toContain('Scrolling 帧列表');
    expect(consolidated.evidence.join(' | ')).toContain('Scrolling 帧列表');
  });

  test('adds session scope to consolidated finding when interval metadata is available', () => {
    const agent = new FrameAgent(mockModelRouter);

    const result = makeResult({
      performance_summary: stepResult([{ total_frames: 311, janky_frames: 18, jank_rate: 5.79 }]),
      get_app_jank_frames: stepResult([
        { frame_id: 1, session_id: 1, start_ts: '1000', end_ts: '2000' },
        { frame_id: 2, session_id: 1, start_ts: '2000', end_ts: '3000' },
      ]),
      session_jank: stepResult([{ session_id: 1, janky_count: 18 }]),
    });

    const findings = (agent as any).extractFindingsFromResult(result, 'scrolling_analysis', 'frame');
    const consolidated = findings.find((f: any) => String(f.title || '').includes('滑动卡顿检测'));

    expect(consolidated).toBeDefined();
    expect(consolidated.title).toContain('区间1 滑动卡顿检测');
    expect(consolidated.description).toContain('session=1');
    expect(consolidated.details?.sourceWindow?.sessionIds).toEqual([1]);
  });
});
