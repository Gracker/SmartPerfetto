/**
 * ConclusionGenerator Unit Tests
 */

import {
  deriveConclusionContract,
  generateConclusion,
  normalizeConclusionOutput,
  renderConclusionContractMarkdown,
} from '../conclusionGenerator';
import type { Finding, Intent } from '../../types';
import type { SharedAgentContext } from '../../types/agentProtocol';
import type { ProgressEmitter } from '../orchestratorTypes';
import type { ModelRouter } from '../modelRouter';

describe('conclusionGenerator', () => {
  let mockModelRouter: jest.Mocked<Partial<ModelRouter>>;
  let emitter: ProgressEmitter;
  let emittedUpdates: Array<{ type: string; content: unknown }>;
  let logs: string[];

  const sharedContext: SharedAgentContext = {
    sessionId: 'session-1',
    traceId: 'trace-1',
    hypotheses: new Map(),
    confirmedFindings: [],
    investigationPath: [],
  };

  const intent: Intent = {
    primaryGoal: '分析滑动卡顿的根因',
    aspects: ['jank'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: 'initial',
  };

  const findings: Finding[] = [
    {
      id: 'f-1',
      severity: 'critical',
      title: '主线程阻塞导致掉帧',
      description: '在多个关键帧中观察到主线程长时间 Runnable/Running',
      details: { frame_id: 123, dur_ms: 45.2 },
      source: 'test',
      confidence: 0.9,
    },
  ];

  function createMockModelResponse(response: string): {
    success: boolean;
    response: string;
    modelId: string;
    usage: { inputTokens: number; outputTokens: number; totalCost: number };
    latencyMs: number;
  } {
    return {
      success: true,
      response,
      modelId: 'test-model',
      usage: { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
      latencyMs: 500,
    };
  }

  async function invokeGenerateConclusion(params: {
    context?: SharedAgentContext;
    currentFindings?: Finding[];
    currentIntent?: Intent;
    stopReason?: string;
    options?: { turnCount?: number; historyContext?: string };
  } = {}): Promise<string> {
    const {
      context = sharedContext,
      currentFindings = findings,
      currentIntent = intent,
      stopReason,
      options = {},
    } = params;

    return generateConclusion(
      context,
      currentFindings,
      currentIntent,
      mockModelRouter as unknown as ModelRouter,
      emitter,
      stopReason,
      options
    );
  }

  beforeEach(() => {
    emittedUpdates = [];
    logs = [];

    mockModelRouter = {
      callWithFallback: jest.fn().mockResolvedValue(createMockModelResponse('测试结论')),
    };

    emitter = {
      emitUpdate: (type, content) => {
        emittedUpdates.push({ type, content });
      },
      log: (message) => {
        logs.push(message);
      },
    };
  });

  test('uses insight-first prompt for early turns', async () => {
    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toBe('测试结论');
    expect(mockModelRouter.callWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('## 结论（按可能性排序）'),
      'synthesis',
      expect.objectContaining({
        promptId: 'agent.conclusionGenerator.insight.initial_report',
        promptVersion: '2.0.0',
        contractVersion: 'conclusion_contract_json@1.0.0',
        jsonMode: true,
      })
    );
  });

  test('emits answer_token stream updates for final conclusion text', async () => {
    await invokeGenerateConclusion({ options: { turnCount: 0 } });

    const tokenEvents = emittedUpdates.filter((u) => u.type === 'answer_token');
    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(tokenEvents[tokenEvents.length - 1].content).toEqual(
      expect.objectContaining({ done: true })
    );
  });

  test('uses focused-answer prompt when turnCount >= 1', async () => {
    const conclusion = await invokeGenerateConclusion({
      currentIntent: { ...intent, followUpType: 'extend' },
      stopReason: '连续多轮没有新增证据',
      options: { turnCount: 1, historyContext: 'HISTORY_CONTEXT' },
    });

    expect(conclusion).toBe('测试结论');
    expect(mockModelRouter.callWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('HISTORY_CONTEXT'),
      'synthesis',
      expect.objectContaining({
        promptId: 'agent.conclusionGenerator.insight.focused_answer',
        promptVersion: '2.0.0',
        contractVersion: 'conclusion_contract_json@1.0.0',
        jsonMode: true,
      })
    );

    // Ensure prompt includes core multi-turn instructions (but no forced Q/A template).
    const calledPrompt = (mockModelRouter.callWithFallback as jest.Mock).mock.calls[0][0] as string;
    expect(calledPrompt).toContain('多轮对话');
    expect(calledPrompt).toContain('## 输出要求（必须严格遵守）');
    expect(calledPrompt).toContain('总长度尽量控制在 25 行以内');
    expect(calledPrompt).toContain('## 根因机制拆解（直接原因/资源问题/放大因素）');
    expect(calledPrompt).toContain('直接原因:');
    expect(calledPrompt).toContain('资源问题:');
    expect(calledPrompt).toContain('放大因素:');
  });

  test('uses startup scene template instead of jank-only prompt rules', async () => {
    await invokeGenerateConclusion({
      currentIntent: {
        ...intent,
        primaryGoal: '分析应用冷启动慢的根因',
        aspects: ['startup'],
      },
      options: { turnCount: 0 },
    });

    const calledPrompt = (mockModelRouter.callWithFallback as jest.Mock).mock.calls[0][0] as string;
    expect(calledPrompt).toContain('## 场景化分析焦点');
    expect(calledPrompt).toContain('当前场景: 启动性能');
    expect(calledPrompt).toContain('慢在第几阶段');
    expect(calledPrompt).toContain('TTID/TTFD');
    expect(calledPrompt).toContain('clusters 可按时间阶段/样本分组给出；若无聚类证据可传空数组');
    expect(calledPrompt).not.toContain('候选包括：业务负载重 / 小核摆放 / 大核低频 / 调度延迟 / Binder 同步阻塞 / 频率爬升慢');
    expect(calledPrompt).not.toContain('## 掉帧归因裁决（规则预判）');
    expect(calledPrompt).not.toContain('## 根因机制拆解（直接原因/资源问题/放大因素）');
  });

  test('normalizeConclusionOutput keeps generic cluster heading without scene hints', () => {
    const normalized = normalizeConclusionOutput(`结论: 启动阶段存在初始化耗时
clusters: S1: 初始化阶段（3帧, 75%）
证据链: C1: 首帧延迟`);

    expect(normalized).toContain('## 聚类（先看大头）');
    expect(normalized).not.toContain('## 掉帧聚类（先看大头）');
  });

  test('deriveConclusionContract infers jank sceneId from markdown heading', () => {
    const contract = deriveConclusionContract(`## 结论（按可能性排序）
1. 存在掉帧

## 掉帧聚类（先看大头）
- K1: 主线程耗时（4帧, 66.7%）

## 证据链（对应上述结论）
- C1: ev_0123456789ab

## 不确定性与反例
- 暂无

## 下一步（最高信息增益）
- 继续下钻`);

    expect(contract?.metadata?.sceneId).toBe('jank');
  });

  test('deriveConclusionContract applies sceneId hint for generic cluster heading', () => {
    const contract = deriveConclusionContract(`## 结论（按可能性排序）
1. 存在掉帧

## 聚类（先看大头）
- K1: 主线程耗时（4帧, 66.7%）

## 证据链（对应上述结论）
- C1: ev_0123456789ab

## 不确定性与反例
- 暂无

## 下一步（最高信息增益）
- 继续下钻`, {
      sceneId: 'jank',
    });

    expect(contract?.metadata?.sceneId).toBe('jank');
    expect(renderConclusionContractMarkdown(contract!)).toContain('## 掉帧聚类（先看大头）');
  });

  test('filters startup framework-wrapper findings when actionable startup finding exists', async () => {
    const startupFindings: Finding[] = [
      {
        id: 'startup-old-wrapper',
        severity: 'warning',
        title: '[温启动 #2] 主线程操作 \'clientTransactionExecuted\' 最长耗时 844.5ms',
        description: '旧结论：框架包裹层切片',
        source: 'direct_skill:startup_detail',
        confidence: 0.95,
      },
      {
        id: 'startup-actionable',
        severity: 'warning',
        title: '[温启动 #2] 主线程可操作热点 \'LoadSimulator_ActivityInit\' 最长耗时 710.1ms（占比 53%）',
        description: '应用初始化阶段任务过重',
        source: 'direct_skill:startup_detail',
        confidence: 0.9,
      },
    ];

    await invokeGenerateConclusion({
      currentFindings: startupFindings,
      currentIntent: {
        ...intent,
        primaryGoal: '分析启动性能',
        aspects: ['startup'],
      },
      options: { turnCount: 2, historyContext: 'HISTORY' },
    });

    const calledPrompt = (mockModelRouter.callWithFallback as jest.Mock).mock.calls[0][0] as string;
    expect(calledPrompt).toContain('LoadSimulator_ActivityInit');
    expect(calledPrompt).not.toContain('主线程操作 \'clientTransactionExecuted\'');
  });

  test('applies single-frame drill-down guardrails and suppresses history carry-over hints', async () => {
    const conclusion = await invokeGenerateConclusion({
      currentIntent: {
        ...intent,
        followUpType: 'drill_down',
        referencedEntities: [{ type: 'frame', id: 1435508 }],
        extractedParams: { frame_id: 1435508 },
      },
      options: { turnCount: 2, historyContext: '历史结论: K1 Buffer Stuffing（9帧，36%）' },
    });

    expect(conclusion).toBe('测试结论');
    const calledPrompt = (mockModelRouter.callWithFallback as jest.Mock).mock.calls[0][0] as string;
    expect(calledPrompt).toContain('## 单帧 Drill-Down 范围约束');
    expect(calledPrompt).toContain('禁止沿用历史轮次的聚类帧数/占比');
    expect(calledPrompt).toContain('单帧 drill-down 禁止复用历史 K1/K2/K3');
    expect(calledPrompt).not.toContain('历史结论: K1 Buffer Stuffing（9帧，36%）');
    expect(calledPrompt).not.toContain('“## 掉帧聚类（先看大头）”必须按帧数降序列出 Top3 聚类');
  });

  test('aligns single-frame triad with structured root-cause fields', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`## 结论（按可能性排序）
1. 触发因子（直接原因）: 主线程RV Prefetch操作耗时11.75ms，远超帧预算5.84ms；供给约束（资源瓶颈）: 大核降频80.8%，频率不足；放大路径（问题放大环节）: RenderThread占用109.2%，渲染压力放大主线程延迟（置信度: 85%）

## 证据链（对应上述结论）
- 证据链信息缺失

## 不确定性与反例
- 单帧数据不足

## 下一步（最高信息增益）
- 继续分析`
    ));

    const frameFinding: Finding = {
      ...findings[0],
      evidence: [{ evidenceId: 'ev_0123456789ab', title: '[frame_agent] jank_frame_detail', kind: 'skill' }],
      details: {
        primary_cause: '主线程耗时操作 "RV Prefetch" 占用 11.75ms (帧预算 5.84ms)',
        secondary_info: '关键业务操作 RV Prefetch 执行 11.75ms',
        supply_constraint: 'none',
        amplification_path: 'unknown',
        cause_type: 'slice',
      },
    };

    const conclusion = await invokeGenerateConclusion({
      currentFindings: [frameFinding],
      currentIntent: {
        ...intent,
        followUpType: 'drill_down',
        referencedEntities: [{ type: 'frame', id: 1435508 }],
        extractedParams: { frame_id: 1435508 },
      },
      options: { turnCount: 2, historyContext: 'HISTORY' },
    });

    expect(conclusion).toContain('资源问题: 资源问题不明显（当前帧）');
    expect(conclusion).toContain('放大因素: 未观察到明确放大因素证据（当前帧）');
    expect(conclusion).toContain('C2: 资源问题证据：资源问题不明显（当前帧）');
    expect(conclusion).toContain('C3: 放大因素证据：未观察到明确放大因素证据（当前帧）');
    expect(conclusion).not.toContain('大核降频80.8%');
    expect(conclusion).not.toContain('RenderThread占用109.2%');
  });

  test('insight mode falls back to 4-section markdown when LLM fails (follow-up)', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockRejectedValue(new Error('LLM down'));

    const conclusion = await invokeGenerateConclusion({
      currentFindings: [],
      currentIntent: { ...intent, followUpType: 'extend' },
      options: { turnCount: 3, historyContext: 'HISTORY' },
    });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('## 不确定性与反例');
    expect(conclusion).toContain('## 下一步（最高信息增益）');
    expect(emittedUpdates.some(u => u.type === 'degraded')).toBe(true);
  });

  test('insight mode falls back to 4-section markdown when LLM fails (initial)', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockRejectedValue(new Error('LLM down'));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('主线程阻塞导致掉帧');
  });

  test('renders deterministic markdown from structured contract JSON', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(JSON.stringify({
      schema_version: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusion: [
        {
          rank: 1,
          statement: '滑动过程存在明显卡顿',
          confidence: 88,
          trigger: '主线程耗时操作（65%）',
          supply: '阻塞等待（57.1%）',
          amplification: 'SF消费端背压（100%）',
        },
      ],
      clusters: [
        { cluster: 'K1', description: '主线程耗时操作/阻塞等待/SF消费端背压', frames: 22, percentage: 34.9 },
      ],
      evidence_chain: [
        { conclusion_id: 'C1', evidence: ['逐帧根因显示主线程耗时占比65%（ev_111111111111）'] },
      ],
      uncertainties: ['主线程休眠占比与占用时间口径存在差异'],
      next_steps: ['对K1聚类下钻：分析 Choreographer#doFrame 耗时点'],
      metadata: { confidence: 83, rounds: 3 },
    })));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('## 掉帧聚类（先看大头）');
    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('滑动过程存在明显卡顿');
    expect(conclusion).toContain('对K1聚类下钻：分析 Choreographer#doFrame 耗时点');
    expect(conclusion).not.toContain('"schema_version"');
    expect(conclusion).not.toContain('"conclusion"');
  });

  test('injects system-context action item with owner/priority/verification for system skills', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(JSON.stringify({
      schema_version: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusion: [
        { rank: 1, statement: '存在热控导致的性能抖动', confidence: 82 },
      ],
      clusters: [],
      evidence_chain: [
        { conclusion_id: 'C1', evidence: ['观察到 CPU 频率持续下探（ev_111111111111）'] },
      ],
      uncertainties: ['当前温度采样粒度有限'],
      next_steps: ['复现关键场景并补充采样'],
      metadata: { confidence: 79, rounds: 2 },
    })));

    const systemFinding: Finding = {
      id: 'f-system-thermal',
      severity: 'critical',
      title: '[区间2] 检测到热节流：峰值 78C，4 核受影响',
      description: '建议降低主线程尖峰负载并分批执行重任务',
      source: 'direct_skill:thermal_throttling',
      confidence: 0.88,
    };

    const conclusion = await invokeGenerateConclusion({
      currentFindings: [systemFinding],
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('## 下一步（最高信息增益）');
    expect(conclusion).toContain('owner: 热管理/性能团队; priority: P0;');
    expect(conclusion).toContain('verification: 复跑同时间窗 trace');
    expect(conclusion).toContain('复现关键场景并补充采样');
  });

  test('prefers explicit details.system_context action fields in next steps', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`## 结论（按可能性排序）
1. 存在系统侧资源竞争（置信度: 78%）

## 掉帧聚类（先看大头）
- 暂无

## 证据链（对应上述结论）
- C1: 发现系统负载波动（ev_111111111111）

## 不确定性与反例
- 暂无

## 下一步（最高信息增益）
- 继续补充样本`
    ));

    const explicitSystemContextFinding: Finding = {
      id: 'f-system-context',
      severity: 'warning',
      title: '[区间1] 系统压力偏高',
      description: '系统线程争用导致渲染预算压缩',
      source: 'direct_skill:network_analysis',
      details: {
        system_context: {
          owner: '平台专项负责人',
          priority: 'P1',
          action: '合并短周期网络请求并限制后台心跳频率',
          verification: '复跑同窗口 trace，确认 active_periods 下降且卡顿率无回归',
        },
      },
    };

    const conclusion = await invokeGenerateConclusion({
      currentFindings: [explicitSystemContextFinding],
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('owner: 平台专项负责人; priority: P1;');
    expect(conclusion).toContain('action: 合并短周期网络请求并限制后台心跳频率;');
    expect(conclusion).toContain('verification: 复跑同窗口 trace，确认 active_periods 下降且卡顿率无回归');
  });

  test('injects per-conclusion evidence mapping into evidence-chain section when LLM forgets to cite', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`## 结论（按可能性排序）
1. 主线程阻塞（置信度: 80%）

## 证据链（对应上述结论）
- 观察到多次长时间 Runnable/Running

## 不确定性与反例
- 仍需排除 RenderThread/GPU 的影响

## 下一步（最高信息增益）
- 针对关键帧做 drill-down`
    ));

    const findingsWithEvidence: Finding[] = [
      {
        ...findings[0],
        evidence: [{ evidenceId: 'ev_0123456789ab', title: '[frame_agent] scrolling_analysis', kind: 'skill' }],
      },
    ];

    const conclusion = await invokeGenerateConclusion({
      currentFindings: findingsWithEvidence,
      currentIntent: { ...intent, followUpType: 'extend' },
      options: { turnCount: 2, historyContext: 'HISTORY' },
    });

    expect(conclusion).toContain('C1（自动补全）');
    expect(conclusion).toContain('ev_0123456789ab');
    expect(conclusion).not.toContain('证据链信息缺失');
  });

  test('normalizes json-like section output into markdown conclusion blocks', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`conclusion:
{"statement":"应用在惯性滚动期间存在严重的渲染性能问题，导致大量掉帧和卡顿","confidence":90}
{"statement":"主线程可能被阻塞，无法及时处理UI更新，特别是在滑动后的惯性滚动阶段","confidence":75}
evidence_chain:
{"conclusion_id":"C1","evidence":["- C1: 第一次惯性滚动期间85帧卡顿（ev_a26a983279b7）"]}
uncertainties:
无法确定具体是哪个组件或代码路径导致主线程阻塞
next_steps:
深入分析主线程的CPU使用情况，查找可能的阻塞点`
    ));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('## 不确定性与反例');
    expect(conclusion).toContain('## 下一步（最高信息增益）');
    expect(conclusion).toContain('应用在惯性滚动期间存在严重的渲染性能问题');
    expect(conclusion).not.toContain('\nconclusion:');
  });

  test('normalizes json-like output with uncertainty_and_counterexamples objects', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`conclusion:
{"statement":"应用在滑动期间存在严重性能问题，表现为频繁掉帧和缓冲区积压","confidence":85}
evidence_chain:
{"conclusion":"应用在滑动期间存在严重性能问题","evidence":["- C1: 第一次滑动期间出现严重掉帧（ev_6ee3e5cfa057）"]}
uncertainty_and_counterexamples:
{"point":"性能问题的具体归因证据不足","explanation":"当前证据无法确认是 APP 侧还是 SF/GPU 侧瓶颈。"}
next_steps:
{"action":"补充掉帧归因数据","reason":"当前证据不足以形成单侧归因。"}
`
    ));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('## 不确定性与反例');
    expect(conclusion).toContain('性能问题的具体归因证据不足：当前证据无法确认是 APP 侧还是 SF/GPU 侧瓶颈。');
    expect(conclusion).toContain('补充掉帧归因数据（原因：当前证据不足以形成单侧归因。）');
    expect(conclusion).not.toContain('\nuncertainty_and_counterexamples:');
  });

  test('keeps json-like evidence auditable when evidence field is string id', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`conclusion:
{"statement":"存在滑动掉帧问题","confidence":82}
evidence_chain:
{"conclusion_id":"C1","evidence":"ev_111111111111","data":"逐帧统计显示主线程耗时占比 65%（41/63 帧）","source":"jank_frame_detail"}
uncertainties:
- 暂无
next_steps:
- 继续分析`
    ));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('- C1: 逐帧统计显示主线程耗时占比 65%（41/63 帧）（来源: jank_frame_detail）');
    expect(conclusion).not.toContain('原始证据项缺少可展示文本');
  });

  test('adds metric-definition hint for contradiction uncertainties without context', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`conclusion:
{"statement":"存在归因冲突","confidence":70}
evidence_chain:
{"conclusion_id":"C1","evidence":["- C1: 责任分布显示 SF 100%"]}
uncertainties:
主线程占用帧时间109.8%与休眠/阻塞时间78.5%矛盾
next_steps:
统一统计口径`
    ));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('主线程占用帧时间109.8%与休眠/阻塞时间78.5%矛盾（可能由统计口径/分母差异导致，需统一时间窗与分母定义后再比较）');
  });

  test('normalizes english json-like section headers to chinese headings and avoids redundant data-backfill next steps', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`conclusion:
负载主导簇: K1（22帧, 34.9%）
{"confidence":85,"trigger":"主线程耗时操作（65%）","supply":"阻塞等待（57.1%）","amplification":"SF消费端背压（SF 100%，消费端 6.0%）"}
jank_clusters:
{"rank":1,"cluster":"K1: 主线程耗时操作/负载主导/SF消费端背压","frames":22,"percentage":34.9}
{"rank":2,"cluster":"K2: 主线程阻塞(Binder/锁)/阻塞等待/SF消费端背压","frames":22,"percentage":34.9}
evidence_chain:
{"conclusion":"C1: 主线程耗时操作是主要触发因子","evidence":"- C1: 逐帧根因显示主线程耗时操作占比65%"}
uncertainties:
主线程休眠占比与占用时间的矛盾（如帧1436259休眠88.2%但占用76.5%）
next_steps:
补充主线程休眠占比与占用时间的矛盾数据
analysis_metadata:
置信度: 83%
分析轮次: 3`
    ));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('## 掉帧聚类（先看大头）');
    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('## 下一步（最高信息增益）');
    expect(conclusion).toContain('## 分析元数据');
    expect(conclusion).toContain('直接原因: 主线程耗时操作（65%）；资源问题: 阻塞等待（57.1%）；放大因素: SF消费端背压（SF 100%，消费端 6.0%）');
    expect(conclusion).toContain('- K1: 主线程耗时操作/负载主导/SF消费端背压（22帧, 34.9%）');
    expect(conclusion).toContain('在同一帧同一时间窗统一统计口径，复核主线程休眠占比与占用时间的分母与计算方式');
    expect(conclusion).not.toContain('\njank_clusters:');
    expect(conclusion).not.toContain('\nanalysis_metadata:');
  });

  test('normalizes chinese key-style sections and keeps conclusion heading order', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`负载主导簇: K1（22帧, 34.9%），该簇以 APP 侧工作负载触发为主。
结论:
{"触发因子":"主线程耗时操作（65%）","供给约束":"阻塞等待（57.1%）","放大路径":"SF消费端背压"}
掉帧聚类:
{"聚类":"K1","帧数":22,"占比":"34.9%","描述":"主线程耗时操作/负载主导/SF消费端背压"}
证据链:
- C1: 逐帧根因显示主线程耗时操作占比65%（证据ID: ）
不确定性与反例:
同一区间1的滑动卡顿检测数据存在不一致：第一次报告25帧（7.6%），第二次报告38帧（12.2%）
下一步:
补充主线程休眠占比与占用时间的矛盾数据
分析元数据:
置信度: 83%
分析轮次: 3`
    ));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion.trim().startsWith('## 结论（按可能性排序）')).toBe(true);
    expect(conclusion).toContain('## 掉帧聚类（先看大头）');
    expect(conclusion).toContain('## 分析元数据');
    expect(conclusion).toContain('直接原因: 主线程耗时操作（65%）');
    expect(conclusion).toContain('资源问题: 阻塞等待（57.1%）');
    expect(conclusion).toContain('放大因素: SF消费端背压');
    expect(conclusion).toContain('- K1: 主线程耗时操作/负载主导/SF消费端背压（22帧, 34.9%）');
    expect(conclusion).toContain('主线程耗时操作（65%）');
    expect(conclusion).toContain('阻塞等待（57.1%）');
    expect(conclusion).toContain('SF消费端背压');
    expect(conclusion).toContain('在同一帧同一时间窗统一统计口径，复核主线程休眠占比与占用时间的分母与计算方式');
    expect(conclusion).not.toContain('\n结论:');
    expect(conclusion).not.toContain('\n掉帧聚类:');
    expect(conclusion).not.toContain('{"触发因子"');
    expect(conclusion).not.toContain('{"聚类"');
  });

  test('marks workload-dominant cluster explicitly in conclusion section', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`## 结论（按可能性排序）
1. 存在主线程相关卡顿（置信度: 80%）

## 掉帧聚类（先看大头）
- K1: 主线程耗时操作 / 负载主导（供给约束弱） / SF消费端背压（22帧, 34.9%）

## 证据链（对应上述结论）
- C1: 逐帧统计显示主线程相关占比更高

## 不确定性与反例
- 仍需补充更细粒度调用栈

## 下一步（最高信息增益）
- 针对 K1 代表帧做下钻`
    ));

    const contextWithWorkloadCluster = {
      ...sharedContext,
      jankCauseSummary: {
        totalJankFrames: 63,
        primaryCause: {
          causeType: 'slice',
          label: '主线程耗时操作',
          frameCount: 41,
          percentage: 65.1,
          severity: 'critical',
          exampleCauses: ['主线程耗时操作'],
        },
        secondaryCauses: [],
        allCauses: [
          {
            causeType: 'slice',
            label: '主线程耗时操作',
            frameCount: 41,
            percentage: 65.1,
            severity: 'critical',
            exampleCauses: ['主线程耗时操作'],
          },
        ],
        clusters: [
          {
            clusterId: 'K1',
            frameCount: 22,
            percentage: 34.9,
            triggerFactor: '主线程耗时操作',
            supplyConstraint: '负载主导（资源问题弱）',
            amplificationPath: 'SF 消费端背压',
            causeType: 'slice',
            frameIds: ['1435500'],
            representativeFrames: ['1435500'],
            samplePrimaryCauses: ['主线程耗时操作'],
          },
        ],
        summaryText: 'K1 为负载主导簇',
      },
    };

    const conclusion = await invokeGenerateConclusion({
      context: contextWithWorkloadCluster as SharedAgentContext,
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('负载主导簇: K1（22帧, 34.9%）');
    expect(conclusion).toContain('聚合帧: 1435500');
    expect(conclusion).toContain('关键切片: 主线程耗时操作');
  });

  test('injects all dropped-frame ids grouped by clusters in conclusion', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`## 结论（按可能性排序）
1. 示例

## 掉帧聚类（先看大头）
- K1: 示例

## 证据链（对应上述结论）
- C1: 示例

## 不确定性与反例
- 无

## 下一步（最高信息增益）
- 示例`));

    const contextWithClusterFrameIds = {
      ...sharedContext,
      jankCauseSummary: {
        totalJankFrames: 6,
        primaryCause: {
          causeType: 'slice',
          label: '主线程耗时操作',
          frameCount: 4,
          percentage: 66.7,
          severity: 'critical',
          exampleCauses: ['主线程耗时操作'],
        },
        secondaryCauses: [],
        allCauses: [
          {
            causeType: 'slice',
            label: '主线程耗时操作',
            frameCount: 4,
            percentage: 66.7,
            severity: 'critical',
            exampleCauses: ['主线程耗时操作'],
          },
        ],
        clusters: [
          {
            clusterId: 'K1',
            frameCount: 4,
            percentage: 66.7,
            triggerFactor: '主线程耗时操作',
            supplyConstraint: '频率不足',
            amplificationPath: 'SF 消费端背压',
            causeType: 'slice',
            frameIds: ['1435500', '1435508', '1435517', '1435526'],
            representativeFrames: ['1435500', '1435508', '1435517', '1435526'],
            samplePrimaryCauses: ['主线程耗时操作'],
          },
          {
            clusterId: 'K2',
            frameCount: 2,
            percentage: 33.3,
            triggerFactor: '主线程阻塞',
            supplyConstraint: '阻塞等待',
            amplificationPath: 'SF 消费端背压',
            causeType: 'blocking',
            frameIds: ['1435601', '1435609'],
            representativeFrames: ['1435601', '1435609'],
            samplePrimaryCauses: ['Binder 同步阻塞'],
          },
        ],
        summaryText: 'K1 4 帧；K2 2 帧',
      },
    };

    const conclusion = await invokeGenerateConclusion({
      context: contextWithClusterFrameIds as SharedAgentContext,
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('聚类帧聚合（全量帧，覆盖 6 帧）');
    expect(conclusion).toContain('K1（4帧）: 1435500 / 1435508 / 1435517 / 1435526');
    expect(conclusion).toContain('K2（2帧）: 1435601 / 1435609');
  });

  test('applies payload guard when cluster frame list exceeds configured full-mode limit', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`## 结论（按可能性排序）
1. 示例

## 掉帧聚类（先看大头）
- K1: 示例

## 证据链（对应上述结论）
- C1: 示例

## 不确定性与反例
- 无

## 下一步（最高信息增益）
- 示例`));

    const frameIds = Array.from({ length: 130 }, (_, idx) => String(1435000 + idx));
    const contextWithLongClusterFrames = {
      ...sharedContext,
      jankCauseSummary: {
        totalJankFrames: 130,
        primaryCause: {
          causeType: 'slice',
          label: '主线程耗时操作',
          frameCount: 130,
          percentage: 100,
          severity: 'critical',
          exampleCauses: ['主线程耗时操作'],
        },
        secondaryCauses: [],
        allCauses: [
          {
            causeType: 'slice',
            label: '主线程耗时操作',
            frameCount: 130,
            percentage: 100,
            severity: 'critical',
            exampleCauses: ['主线程耗时操作'],
          },
        ],
        clusters: [
          {
            clusterId: 'K1',
            frameCount: 130,
            percentage: 100,
            triggerFactor: '主线程耗时操作',
            supplyConstraint: '频率不足',
            amplificationPath: 'SF 消费端背压',
            causeType: 'slice',
            frameIds,
            representativeFrames: frameIds,
            samplePrimaryCauses: ['主线程耗时操作'],
          },
        ],
        summaryText: 'K1 130 帧',
      },
    };

    const conclusion = await invokeGenerateConclusion({
      context: contextWithLongClusterFrames as SharedAgentContext,
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('聚类帧聚合（全量帧，覆盖 130 帧）');
    expect(conclusion).toContain('其余 10 帧省略');
  });

  test('uses generic cluster heading for non-jank scenes to avoid scene leakage', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`{"schema_version":"conclusion_contract_v1","mode":"initial_report","conclusion":[{"rank":1,"statement":"启动阶段存在初始化耗时"}],"clusters":[{"cluster":"S1","description":"启动阶段分组","frames":3,"percentage":75}],"evidence_chain":[{"conclusion_id":"C1","text":"证据"}],"uncertainties":["无"],"next_steps":["继续下钻"],"metadata":{"confidence":80,"rounds":1}}`));

    const startupIntent: Intent = {
      ...intent,
      primaryGoal: '分析冷启动慢原因',
      aspects: ['startup'],
    };

    const conclusion = await invokeGenerateConclusion({
      currentIntent: startupIntent,
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('## 聚类（先看大头）');
    expect(conclusion).not.toContain('## 掉帧聚类（先看大头）');
  });

  test('keeps SF attribution guardrail when only SF-dominant signal exists', async () => {
    const sfOnlyFindings: Finding[] = [
      {
        id: 'f-sf',
        severity: 'warning',
        title: '洞见摘要 · 滑动性能分析',
        description: '- 责任归属分布: SF 25 (100%)',
        source: 'scrolling_analysis',
        confidence: 0.8,
      },
    ];

    await invokeGenerateConclusion({
      currentFindings: sfOnlyFindings,
      options: { turnCount: 0 },
    });

    const calledPrompt = (mockModelRouter.callWithFallback as jest.Mock).mock.calls[0][0] as string;
    expect(calledPrompt).toContain('## 归因护栏');
    expect(calledPrompt).toContain('不要直接给出“主线程/Choreographer 是主要根因”的高置信度结论');
  });

  test('suppresses SF guardrail when frame-level main-thread root cause is dominant', async () => {
    const mixedFindings: Finding[] = [
      {
        id: 'f-sf',
        severity: 'warning',
        title: '洞见摘要 · 滑动性能分析',
        description: '- 责任归属分布: SF 25 (100%)',
        source: 'scrolling_analysis',
        confidence: 0.8,
        evidence: [{ evidenceId: 'ev_111111111111', title: '[frame_agent] analyze_scrolling', kind: 'skill' }],
      },
      {
        id: 'f-main',
        severity: 'critical',
        title: '[区间1 · 帧1435500] 主线程耗时操作 "Choreographer#doFrame" 占用 13.92ms',
        description: '逐帧分析显示主线程明显超预算',
        source: 'direct_skill:jank_frame_detail',
        confidence: 0.9,
        details: {
          cause_type: 'slice',
          primary_cause: '主线程耗时操作 "Choreographer#doFrame"',
        },
        evidence: [{ evidenceId: 'ev_222222222222', title: '[frame_agent] jank_frame_detail', kind: 'skill' }],
      },
    ];

    const contextWithJankSummary = {
      ...sharedContext,
      jankCauseSummary: {
        totalJankFrames: 3,
        primaryCause: {
          causeType: 'slice',
          label: '主线程耗时操作',
          frameCount: 3,
          percentage: 100,
          severity: 'critical',
          exampleCauses: ['主线程耗时操作 "Choreographer#doFrame"'],
        },
        secondaryCauses: [],
        allCauses: [
          {
            causeType: 'slice',
            label: '主线程耗时操作',
            frameCount: 3,
            percentage: 100,
            severity: 'critical',
            exampleCauses: ['主线程耗时操作 "Choreographer#doFrame"'],
          },
        ],
        clusters: [],
        summaryText: '主线程耗时操作 3 帧 (100%)',
      },
    };

    await invokeGenerateConclusion({
      context: contextWithJankSummary as SharedAgentContext,
      currentFindings: mixedFindings,
      options: { turnCount: 0 },
    });

    const calledPrompt = (mockModelRouter.callWithFallback as jest.Mock).mock.calls[0][0] as string;
    expect(calledPrompt).toContain('## 掉帧归因裁决（规则预判）');
    expect(calledPrompt).toContain('逐帧根因显示主线程/APP 侧耗时信号占主导');
    expect(calledPrompt).not.toContain('不要直接给出“主线程/Choreographer 是主要根因”的高置信度结论');
  });

  test('replaces contradictory LLM conclusion with attribution-safe fallback', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockResolvedValue(createMockModelResponse(`## 结论（按可能性排序）
1. 滑动性能问题主要由SF层消费端掉帧导致（82.1%），而非App主线程操作（置信度: 85%）

## 证据链（对应上述结论）
- C1: 责任归属分布 SF 100%

## 不确定性与反例
- 无

## 下一步（最高信息增益）
- 补充更多 SF 数据`
    ));

    const contradictoryFindings: Finding[] = [
      {
        id: 'f-sf',
        severity: 'warning',
        title: '洞见摘要 · 滑动性能分析',
        description: '- 责任归属分布: SF 25 (100%)',
        source: 'scrolling_analysis',
        confidence: 0.8,
        evidence: [{ evidenceId: 'ev_333333333333', title: '[frame_agent] analyze_scrolling', kind: 'skill' }],
      },
      {
        id: 'f-main',
        severity: 'critical',
        title: '[区间1 · 帧1435500] 主线程耗时操作 "Choreographer#doFrame" 占用 13.92ms',
        description: '逐帧分析显示主线程明显超预算',
        source: 'direct_skill:jank_frame_detail',
        confidence: 0.95,
        details: {
          cause_type: 'slice',
          primary_cause: '主线程耗时操作 "Choreographer#doFrame"',
        },
        evidence: [{ evidenceId: 'ev_444444444444', title: '[frame_agent] jank_frame_detail', kind: 'skill' }],
      },
    ];

    const contextWithJankSummary = {
      ...sharedContext,
      jankCauseSummary: {
        totalJankFrames: 3,
        primaryCause: {
          causeType: 'slice',
          label: '主线程耗时操作',
          frameCount: 3,
          percentage: 100,
          severity: 'critical',
          exampleCauses: ['主线程耗时操作 "Choreographer#doFrame"'],
        },
        secondaryCauses: [],
        allCauses: [
          {
            causeType: 'slice',
            label: '主线程耗时操作',
            frameCount: 3,
            percentage: 100,
            severity: 'critical',
            exampleCauses: ['主线程耗时操作 "Choreographer#doFrame"'],
          },
        ],
        clusters: [],
        summaryText: '主线程耗时操作 3 帧 (100%)',
      },
    };

    const conclusion = await invokeGenerateConclusion({
      context: contextWithJankSummary as SharedAgentContext,
      currentFindings: contradictoryFindings,
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('混合型掉帧');
    expect(conclusion).toContain('直接原因:');
    expect(conclusion).toContain('资源问题:');
    expect(conclusion).toContain('放大因素:');
    expect(conclusion).not.toContain('而非App主线程操作');
    expect(conclusion).not.toContain('（自动补全）');
    expect((conclusion.match(/^- C1\b/gm) || []).length).toBe(1);
    expect(conclusion).toMatch(/ev_[0-9a-f]{12}/);
    expect(emittedUpdates.some(u =>
      u.type === 'degraded' &&
      (u.content as { fallback?: string } | undefined)?.fallback === 'rule-based attribution-safe conclusion'
    )).toBe(true);
  });

  test('fallback mechanism triad classifies supply constraints into frequency and core placement', async () => {
    mockModelRouter.callWithFallback = jest.fn().mockRejectedValue(new Error('LLM down'));

    const findingsWithEvidence: Finding[] = [
      {
        id: 'f-main',
        severity: 'critical',
        title: '[区间1 · 帧1435517] 主线程耗时 10.24ms',
        description: '逐帧分析显示主线程超预算，且存在大核频率与小核运行信号',
        source: 'direct_skill:jank_frame_detail',
        confidence: 0.92,
        details: {
          cause_type: 'slice',
          primary_cause: '主线程耗时操作',
        },
        evidence: [{ evidenceId: 'ev_555555555555', title: '[frame_agent] jank_frame_detail', kind: 'skill' }],
      },
      {
        id: 'f-sf',
        severity: 'warning',
        title: '洞见摘要 · 滑动性能分析',
        description: '- 责任归属分布: SF 20 (80%)',
        source: 'scrolling_analysis',
        confidence: 0.8,
      },
    ];

    const contextWithJankSummary = {
      ...sharedContext,
      jankCauseSummary: {
        totalJankFrames: 10,
        primaryCause: {
          causeType: 'slice',
          label: '主线程耗时操作',
          frameCount: 4,
          percentage: 40,
          severity: 'critical',
          exampleCauses: ['主线程耗时操作'],
        },
        secondaryCauses: [
          {
            causeType: 'freq_limit',
            label: 'CPU 限频',
            frameCount: 3,
            percentage: 30,
            severity: 'warning',
            exampleCauses: ['大核频率偏低'],
          },
          {
            causeType: 'small_core',
            label: '小核运行',
            frameCount: 2,
            percentage: 20,
            severity: 'warning',
            exampleCauses: ['RenderThread 大核占比偏低'],
          },
        ],
        allCauses: [
          {
            causeType: 'slice',
            label: '主线程耗时操作',
            frameCount: 4,
            percentage: 40,
            severity: 'critical',
            exampleCauses: ['主线程耗时操作'],
          },
          {
            causeType: 'freq_limit',
            label: 'CPU 限频',
            frameCount: 3,
            percentage: 30,
            severity: 'warning',
            exampleCauses: ['大核频率偏低'],
          },
          {
            causeType: 'small_core',
            label: '小核运行',
            frameCount: 2,
            percentage: 20,
            severity: 'warning',
            exampleCauses: ['RenderThread 大核占比偏低'],
          },
          {
            causeType: 'gpu_fence',
            label: 'GPU Fence 等待',
            frameCount: 1,
            percentage: 10,
            severity: 'warning',
            exampleCauses: ['GPU fence wait'],
          },
        ],
        clusters: [
          {
            clusterId: 'K1',
            frameCount: 6,
            percentage: 60,
            triggerFactor: '主线程耗时操作',
            supplyConstraint: '频率不足',
            amplificationPath: 'SF 消费端背压',
            causeType: 'slice',
            frameIds: ['1435517'],
            representativeFrames: ['1435517'],
            samplePrimaryCauses: ['主线程耗时操作'],
          },
          {
            clusterId: 'K2',
            frameCount: 4,
            percentage: 40,
            triggerFactor: '调度延迟',
            supplyConstraint: '核心摆放偏小核',
            amplificationPath: 'APP 截止超时',
            causeType: 'sched_latency',
            frameIds: ['1435500'],
            representativeFrames: ['1435500'],
            samplePrimaryCauses: ['Runnable 等待'],
          },
        ],
        summaryText: '主线程 40%，限频 30%，小核 20%，GPU fence 10%',
      },
    };

    const conclusion = await invokeGenerateConclusion({
      context: contextWithJankSummary as SharedAgentContext,
      currentFindings: findingsWithEvidence,
      options: { turnCount: 0 },
    });

    expect(conclusion).toContain('资源问题:');
    expect(conclusion).toContain('频率不足');
    expect(conclusion).toContain('核心摆放偏小核');
    expect(conclusion).toContain('## 掉帧聚类（先看大头）');
    expect(conclusion).toContain('K1:');
  });
});
