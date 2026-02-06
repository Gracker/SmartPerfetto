import type { ModelRouter } from '../modelRouter';
import type { ProgressEmitter } from '../orchestratorTypes';
import type { AgentResponse, SharedAgentContext } from '../../types/agentProtocol';
import { synthesizeFeedback } from '../feedbackSynthesizer';

function makeEmitter(): ProgressEmitter {
  return {
    emitUpdate: jest.fn(),
    log: jest.fn(),
  };
}

function makeSharedContext(): SharedAgentContext {
  return {
    sessionId: 's1',
    traceId: 't1',
    hypotheses: new Map(),
    confirmedFindings: [],
    investigationPath: [],
  };
}

function makeModelRouter(contradictions: string[]): ModelRouter {
  return {
    callWithFallback: jest.fn().mockResolvedValue({
      success: true,
      response: JSON.stringify({
        correlatedFindings: [],
        contradictions,
        hypothesisUpdates: [],
        informationGaps: [],
      }),
      modelId: 'test-model',
      usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      latencyMs: 1,
    }),
  } as unknown as ModelRouter;
}

function makeResponse(findings: AgentResponse['findings']): AgentResponse {
  return {
    agentId: 'frame_agent',
    taskId: `task_${Math.random()}`,
    success: true,
    findings,
    confidence: 0.8,
    executionTimeMs: 1,
  };
}

describe('feedbackSynthesizer contradiction handling', () => {
  test('does not treat different session scopes as contradiction even with two evidence ids', async () => {
    const ev1 = 'ev_111111111111';
    const ev2 = 'ev_222222222222';
    const modelRouter = makeModelRouter([
      `第一次分析中掉帧数为25帧（${ev1}），第二次为38帧（${ev2}），需确认测试条件是否一致`,
    ]);

    const responses: AgentResponse[] = [
      makeResponse([{
        id: 'f1',
        category: 'frame',
        type: 'issue',
        severity: 'warning',
        title: '区间1 滑动卡顿检测: 25 帧 (7.6%)',
        description: '数据来源: Scrolling 帧列表',
        source: 'scrolling_analysis',
        confidence: 0.75,
        details: { sourceWindow: { sessionIds: [1], startTsNs: '1000', endTsNs: '2000' } },
        evidence: [{ evidenceId: ev1 }],
      }]),
      makeResponse([{
        id: 'f2',
        category: 'frame',
        type: 'issue',
        severity: 'critical',
        title: '区间2 滑动卡顿检测: 38 帧 (12.2%)',
        description: '数据来源: Scrolling 帧列表',
        source: 'scrolling_analysis',
        confidence: 0.75,
        details: { sourceWindow: { sessionIds: [2], startTsNs: '3000', endTsNs: '4000' } },
        evidence: [{ evidenceId: ev2 }],
      }]),
    ];

    const result = await synthesizeFeedback(
      responses,
      makeSharedContext(),
      modelRouter,
      makeEmitter()
    );

    const contradicted = result.newFindings.filter(f => (f.details as any)?._contradicted);
    expect(contradicted).toHaveLength(0);
    expect(result.informationGaps.some(g => g.includes('矛盾:'))).toBe(false);
  });

  test('marks findings as contradicted when evidence conflict is within the same session scope', async () => {
    const ev1 = 'ev_aaaaaaaaaaaa';
    const ev2 = 'ev_bbbbbbbbbbbb';
    const modelRouter = makeModelRouter([
      `同一区间内掉帧统计冲突：25帧（${ev1}） vs 38帧（${ev2}）`,
    ]);

    const responses: AgentResponse[] = [
      makeResponse([{
        id: 'f1',
        category: 'frame',
        type: 'issue',
        severity: 'warning',
        title: '区间1 滑动卡顿检测: 25 帧 (7.6%)',
        description: '数据来源: Scrolling 帧列表',
        source: 'scrolling_analysis',
        confidence: 0.75,
        details: { sourceWindow: { sessionIds: [1], startTsNs: '1000', endTsNs: '2000' } },
        evidence: [{ evidenceId: ev1 }],
      }]),
      makeResponse([{
        id: 'f2',
        category: 'frame',
        type: 'issue',
        severity: 'critical',
        title: '区间1 滑动卡顿检测: 38 帧 (12.2%)',
        description: '数据来源: Scrolling 帧列表',
        source: 'scrolling_analysis',
        confidence: 0.75,
        details: { sourceWindow: { sessionIds: [1], startTsNs: '1000', endTsNs: '2000' } },
        evidence: [{ evidenceId: ev2 }],
      }]),
    ];

    const result = await synthesizeFeedback(
      responses,
      makeSharedContext(),
      modelRouter,
      makeEmitter()
    );

    const contradicted = result.newFindings.filter(f => (f.details as any)?._contradicted);
    expect(contradicted.length).toBeGreaterThan(0);
    for (const f of contradicted) {
      expect((f.confidence || 0)).toBeLessThanOrEqual(0.75);
    }
    expect(result.informationGaps.some(g => g.includes('矛盾:'))).toBe(true);
  });
});
