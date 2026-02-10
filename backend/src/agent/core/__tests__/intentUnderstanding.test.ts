import { understandIntent } from '../intentUnderstanding';
import type { ModelRouter } from '../modelRouter';

function createEmitter() {
  return {
    log: jest.fn(),
    emitUpdate: jest.fn(),
  } as any;
}

function createSessionContext(turnsOrCount: number | any[] = 1) {
  const turns = Array.isArray(turnsOrCount)
    ? turnsOrCount
    : Array.from({ length: turnsOrCount }, (_, i) => ({ id: i }));
  return {
    generatePromptContext: jest.fn().mockReturnValue(''),
    getAllTurns: jest.fn().mockReturnValue(turns),
    extractReferenceableEntities: jest.fn().mockReturnValue([]),
    getSessionId: jest.fn().mockReturnValue('session-test'),
    getTraceId: jest.fn().mockReturnValue('trace-test'),
  } as any;
}

describe('intentUnderstanding', () => {
  test('normalizes comma-separated frame id and forces drill_down for follow-up', async () => {
    const modelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        success: true,
        response: JSON.stringify({
          primaryGoal: '分析指定帧',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'extend',
          referencedEntities: [{ type: 'frame', id: '1,435,508' }],
          extractedParams: { frame_id: '1,435,508' },
        }),
      }),
    } as unknown as ModelRouter;

    const intent = await understandIntent(
      '分析 1,435,508 这一帧的掉帧原因',
      createSessionContext(2),
      modelRouter,
      createEmitter()
    );

    expect(intent.followUpType).toBe('drill_down');
    expect(intent.extractedParams?.frame_id).toBe(1435508);
    expect(intent.referencedEntities?.[0]?.id).toBe(1435508);
  });

  test('fallback parser extracts comma-separated frame id when llm parsing fails', async () => {
    const modelRouter = {
      callWithFallback: jest.fn().mockRejectedValue(new Error('llm unavailable')),
    } as unknown as ModelRouter;

    const intent = await understandIntent(
      '分析 1,435,508 这一帧的掉帧原因',
      createSessionContext(2),
      modelRouter,
      createEmitter()
    );

    expect(intent.followUpType).toBe('drill_down');
    expect(intent.extractedParams?.frame_id).toBe(1435508);
    expect(intent.referencedEntities?.[0]?.type).toBe('frame');
    expect(intent.referencedEntities?.[0]?.id).toBe(1435508);
  });

  test('carries frame id from previous turn for implicit "这一帧" follow-up', async () => {
    const modelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        success: true,
        response: JSON.stringify({
          primaryGoal: '分析这一帧的 CPU 频率',
          aspects: ['cpu', 'frequency'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'extend',
          referencedEntities: [],
          extractedParams: {},
        }),
      }),
    } as unknown as ModelRouter;

    const sessionContext = createSessionContext([
      {
        id: 'turn-0',
        intent: {
          primaryGoal: '分析 1435500 这一帧的卡顿原因',
          aspects: ['frame'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          extractedParams: { frame_id: 1435500 },
          referencedEntities: [{ type: 'frame', id: 1435500 }],
        },
        findings: [],
      },
    ]);

    const intent = await understandIntent(
      '这一帧的 cpu 频率变化是怎么样？',
      sessionContext,
      modelRouter,
      createEmitter()
    );

    expect(intent.followUpType).toBe('drill_down');
    expect(intent.extractedParams?.frame_id).toBe(1435500);
    expect(intent.referencedEntities).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'frame', id: 1435500 })])
    );
  });

  test('extracts startup id and forces drill_down for startup follow-up queries', async () => {
    const modelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        success: true,
        response: JSON.stringify({
          primaryGoal: '分析启动事件',
          aspects: ['startup'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'extend',
          referencedEntities: [{ type: 'startup', id: '12' }],
          extractedParams: { startup_id: '12' },
        }),
      }),
    } as unknown as ModelRouter;

    const intent = await understandIntent(
      '分析启动 12 的详细瓶颈',
      createSessionContext(2),
      modelRouter,
      createEmitter()
    );

    expect(intent.followUpType).toBe('drill_down');
    expect(intent.extractedParams?.startup_id).toBe(12);
    expect(intent.referencedEntities).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'startup', id: 12 })])
    );
  });
});
