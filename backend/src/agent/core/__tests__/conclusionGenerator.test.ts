// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
import {parseConclusionContractSidecar, parseTypedConclusionContractJson, parseConclusionContractDeclaration,
  parseDeclaredRelationProposals, renderConclusionContractSidecar, conclusionParseIssueTriageCodes,
  CONCLUSION_PARSE_ISSUE_CODES, type ConclusionContract, type ClaimSemanticsV1,
} from '../conclusionContract';

describe('complete generated conclusion collections', () => {
  const collection = (prefix: string, count: number) => Array.from({length: count}, (_, index) => `${prefix} ${index + 1}`);

  it('keeps every legacy JSON conclusion, cluster, evidence item, uncertainty and next step', () => {
    const raw = JSON.stringify({schema_version: 'conclusion_contract_v1',
      conclusion: collection('Conclusion', 4).map((statement, index) => ({rank: index + 1, statement})),
      clusters: collection('Cluster', 6).map((description, index) => ({cluster: `K${index + 1}`, description})),
      evidence_chain: collection('Evidence', 13).map(text => ({conclusion_id: 'C4', evidence: [text]})),
      uncertainties: collection('Uncertainty', 7), next_steps: collection('Next action', 7)});
    const contract = deriveConclusionContract(raw)!;
    expect(contract.conclusions).toHaveLength(4);
    expect(contract.clusters).toHaveLength(6);
    expect(contract.evidenceChain).toHaveLength(13);
    expect(contract.uncertainties).toHaveLength(7);
    expect(contract.nextSteps).toHaveLength(7);
    for (const rendered of [renderConclusionContractMarkdown(contract), normalizeConclusionOutput(raw)]) {
      for (const tail of ['Conclusion 4', 'Cluster 6', 'Evidence 13', 'Uncertainty 7', 'Next action 7']) {
        expect(rendered).toContain(tail);
      }
    }
  });

  it.each(['number', 'claim', 'bullet'] as const)('retains all %s conclusions through Markdown roundtrip', style => {
    const statements = collection('Observed statement', 12);
    const body = `## 结论（按可能性排序）\n${statements.map((text, index) =>
      `${style === 'number' ? `${index + 1}.` : style === 'claim' ? `C${index + 1}:` : '-'} ${text}`).join('\n')}`;
    const contract = deriveConclusionContract(body)!;
    expect(contract.conclusions.map(item => item.statement)).toEqual(statements);
    const rendered = renderConclusionContractMarkdown(contract);
    expect(deriveConclusionContract(rendered)?.conclusions.map(item => item.statement)).toEqual(statements);
    expect(normalizeConclusionOutput(rendered)).toContain('Observed statement 12');
  });

  it('keeps generated JSON-like conclusion and cluster tails before Markdown normalization', () => {
    const raw = ['conclusion:', ...collection('Observed conclusion', 4).map(statement => JSON.stringify({statement})),
      'clusters:', ...collection('Cluster detail', 6).map((description, index) => JSON.stringify({cluster: `K${index + 1}`, description})),
      'evidence_chain:', JSON.stringify({conclusion_id: 'C4', evidence: ['Evidence for the final conclusion']}),
      'uncertainties:', 'Uncertainty remains', 'next_steps:', 'Inspect the recorded event'].join('\n');
    const normalized = normalizeConclusionOutput(raw);
    expect(normalized).toContain('Observed conclusion 4');
    expect(normalized).toContain('Cluster detail 6');
    expect(deriveConclusionContract(normalized)?.conclusions).toHaveLength(4);
    expect(deriveConclusionContract(normalized)?.clusters).toHaveLength(6);
  });
});

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
      claims: [
        {
          id: 'Q1',
          conclusion_id: 'C1',
          text: '主线程耗时占比65%',
          references: [
            {
              evidence_ref_id: 'data:sql_table:current:trace-1:query-a:params-a',
              source_ref: '表 1',
              source_tool_call_id: 'execute_sql:1:params-a',
              row_index: 0,
              column: 'main_thread_pct',
              value: 65,
            },
          ],
        },
      ],
      uncertainties: ['主线程休眠占比与占用时间口径存在差异'],
      next_steps: ['对K1聚类下钻：分析 Choreographer#doFrame 耗时点'],
      metadata: { confidence: 83, rounds: 3 },
    })));

    const conclusion = await invokeGenerateConclusion({ options: { turnCount: 0 } });

    expect(conclusion).toContain('## 结论（按可能性排序）');
    expect(conclusion).toContain('## 掉帧聚类（先看大头）');
    expect(conclusion).toContain('## 证据链（对应上述结论）');
    expect(conclusion).toContain('## 逐句数据引用（结构化来源）');
    expect(conclusion).toContain('source_tool_call_id=execute_sql:1:params-a');
    expect(conclusion).toContain('滑动过程存在明显卡顿');
    expect(conclusion).toContain('对K1聚类下钻：分析 Choreographer#doFrame 耗时点');
    expect(conclusion).not.toContain('"schema_version"');
    expect(conclusion).not.toContain('"conclusion"');
  });

  test('round-trips claim references through deterministic contract markdown', () => {
    const initial = deriveConclusionContract(JSON.stringify({
      schema_version: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusion: [{ rank: 1, statement: '帧耗时异常', confidence: 90 }],
      clusters: [],
      evidence_chain: [{ conclusion_id: 'C1', evidence: ['帧耗时 45.6ms（ev_111111111111）'] }],
      claims: [{
        id: 'Q1',
        conclusion_id: 'C1',
        text: '帧耗时 45.6ms',
        references: [{
          evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
          source_ref: '表 1',
          source_tool_call_id: 'execute_sql:1:params-a',
          row_index: 0,
          row_selector: { frame_id: 123 },
          column: 'dur_ms',
          value: 45.6,
        }],
      }],
      uncertainties: [],
      next_steps: ['owner: perf; priority: P1; action: 继续下钻; verification: 复查表 1'],
    }));

    expect(initial?.claims?.[0]?.references[0]).toMatchObject({
      evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
      sourceRef: '表 1',
      sourceToolCallId: 'execute_sql:1:params-a',
      rowIndex: 0,
      rowSelector: { frame_id: 123 },
      column: 'dur_ms',
      value: 45.6,
    });

    const markdown = renderConclusionContractMarkdown(initial!);
    const roundTripped = deriveConclusionContract(markdown);
    expect(roundTripped?.claims?.[0]?.references[0]).toMatchObject({
      evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
      sourceRef: '表 1',
      sourceToolCallId: 'execute_sql:1:params-a',
      rowIndex: 0,
      rowSelector: { frame_id: 123 },
      column: 'dur_ms',
      value: 45.6,
    });

    const selectorFromPromptFormat = deriveConclusionContract([
      '## 逐句数据引用（结构化来源）',
      '- Q1 / C1: 帧 123 耗时 45.6ms',
      '  - evidence_ref_id=data:sql_table:current:trace-a:query-a:params-a; source_ref=表 1; row_selector=frame_id=123, thread=main; column=dur_ms; value=45.6',
    ].join('\n'));

    expect(selectorFromPromptFormat?.claims?.[0]?.references[0]).toMatchObject({
      evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
      sourceRef: '表 1',
      rowSelector: { frame_id: 123, thread: 'main' },
      column: 'dur_ms',
      value: 45.6,
    });

    const compressedReferences = deriveConclusionContract([
      '## 逐句数据引用（结构化来源）',
      '- Q1 / C1: 热点 self_ms 排名。',
      '  - evidence_ref_id=art-30; source_ref=可操作热点; row_index=0-1; column=slice_name,self_ms,self_percent; value=ChaosTask/456.32/34.1, LoadSimulator_ActivityInit/249.8/18.7',
      '- Q2 / C1: 热点状态。',
      '  - evidence_ref_id=art-35; source_ref=hot_slice_states; row_selector=slice_name=ChaosTask AND state=Running; column=state,state_pct; value=Running,100; row_selector=slice_name=SimulateInflation; column=state,state_pct; value=Running,98.4',
      '- Q3 / C1: 慢因。',
      '  - evidence_ref_id=art-39; source_ref=检测到的慢启动原因; row_index=0; column=reason_id,severity,evidence; value=SR12,critical,非框架 slice 占 bindApplication 98.8%, 总耗时 568.8 ms',
    ].join('\n'));

    expect(compressedReferences?.claims?.[0]?.references).toEqual([
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 0, column: 'slice_name', value: 'ChaosTask' }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 0, column: 'self_ms', value: 456.32 }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 0, column: 'self_percent', value: 34.1 }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 1, column: 'slice_name', value: 'LoadSimulator_ActivityInit' }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 1, column: 'self_ms', value: 249.8 }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 1, column: 'self_percent', value: 18.7 }),
    ]);
    expect(compressedReferences?.claims?.[1]?.references).toEqual([
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'ChaosTask', state: 'Running' }, column: 'state', value: 'Running' }),
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'ChaosTask', state: 'Running' }, column: 'state_pct', value: 100 }),
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'SimulateInflation' }, column: 'state', value: 'Running' }),
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'SimulateInflation' }, column: 'state_pct', value: 98.4 }),
    ]);
    expect(compressedReferences?.claims?.[2]?.references).toEqual([
      expect.objectContaining({ evidenceRefId: 'art-39', sourceRef: '检测到的慢启动原因', rowIndex: 0, column: 'reason_id', value: 'SR12' }),
      expect.objectContaining({ evidenceRefId: 'art-39', sourceRef: '检测到的慢启动原因', rowIndex: 0, column: 'severity', value: 'critical' }),
      expect.objectContaining({ evidenceRefId: 'art-39', sourceRef: '检测到的慢启动原因', rowIndex: 0, column: 'evidence', value: '非框架 slice 占 bindApplication 98.8%, 总耗时 568.8 ms' }),
    ]);
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

  it('sanitizes typed source provenance while keeping chat markdown unchanged', () => {
    const baseContract = {
      schemaVersion: 'conclusion_contract_v1' as const,
      mode: 'focused_answer' as const,
      conclusions: [{rank: 1, statement: 'Foo.run 与 trace 阻塞事件一致'}],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        text: 'Foo.run 与 trace 阻塞事件一致',
        references: [{evidenceRefId: 'data:trace-1'}],
      }],
      uncertainties: [],
      nextSteps: [],
    };
    const sourceContract = {
      ...baseContract,
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['app-source'],
        status: 'corroborated',
        attemptedTools: ['read_codebase_file'],
        queriedCodebaseIds: ['app-source'],
        usedCodebaseIds: ['app-source'],
        references: [{
          id: 'model-controlled-id',
          referenceId: 'lookup-1',
          codebaseId: 'app-source',
          filePath: 'src/main/Foo.kt',
          lookupKind: 'body',
          rootPath: '/private/raw-root-canary',
          snippet: 'raw-source-canary',
        }],
      },
      sourceReferences: [{
        id: 'model-controlled-id',
        referenceId: 'lookup-1',
        codebaseId: 'app-source',
        filePath: 'src/main/Foo.kt',
        lookupKind: 'body',
        text: 'raw-source-canary',
      }],
      sourceClaimBindings: [{
        claimId: 'claim-1',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: ['model-controlled-id'],
        traceEvidenceRefIds: ['data:trace-1'],
        reason: 'raw-source-canary',
      }],
    };

    const parsed = deriveConclusionContract(JSON.stringify(sourceContract));

    expect(parsed?.sourceUseDecision?.references[0]?.id).toMatch(/^source-ref-v1-/);
    expect(parsed?.sourceUseDecision?.references[0]?.id).not.toBe('model-controlled-id');
    expect(parsed?.sourceReferences?.[0]?.id).toBe(parsed?.sourceUseDecision?.references[0]?.id);
    expect(JSON.stringify(parsed)).not.toContain('/private/raw-root-canary');
    expect(JSON.stringify(parsed)).not.toContain('raw-source-canary');
    expect(renderConclusionContractMarkdown(parsed!)).toBe(
      renderConclusionContractMarkdown(deriveConclusionContract(JSON.stringify(baseContract))!),
    );
  });
});


describe('versioned conclusion declaration sidecar', () => {
  function semantics(): ClaimSemanticsV1 {
    return {schemaVersion: 'claim_semantics@1', predicate: 'future.metric@7', polarity: 'affirmed',
      discourse: 'asserted', quantifier: 'some', modality: 'possible', conditions: ['condition'],
      scope: {population: 'selected_interval', timeRangeNs: {start: '9007199254740993', end: '9007199254741993'},
        subjectRefs: [{artifactId: 'art-1', rowSelector: {code: '001'}, column: 'value', value: '001'}]},
      numeric: {operator: 'gt', value: '2.00', unit: 'ms'}};
  }

  function contract(): ConclusionContract {
    return {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: 'Original statement'}], clusters: [], evidenceChain: [],
      claims: [{id: 'claim:original', conclusionId: 'C-original', text: 'Original claim', kind: 'numeric',
        references: [{artifactId: 'art-1', sourceToolCallId: 'call-1', rowSelector: {code: '001'}, column: 'value', value: '001'}],
        artifactRefs: [{artifactId: 'art-1', rowIndex: 501}], relationRefs: ['proposal:relation-1'], semantics: semantics()}],
      relationProposals: [{schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:relation-1', kind: 'overlap',
        direction: 'symmetric', subject: {artifactId: 'art-1', rowIndex: 501, column: 'ts', value: '9007199254740993'},
        object: {artifactId: 'art-2', rowIndex: 0, column: 'ts', value: '9007199254740993'}}],
      uncertainties: [], nextSteps: []};
  }

  function rawSidecar(raw: unknown): string {
    return '<!-- smartperfetto:conclusion-contract@1\n```json\n' + JSON.stringify(raw) + '\n```\n-->';
  }

  const sourceBinding = {claimId: 'claim:original', mechanismStatus: 'compatible' as const,
    sourceReferenceIds: ['source-ref-v1-original'], traceEvidenceRefIds: []};

  it.each(['absent', 'empty', 'duplicate'] as const)('preserves %s original source-binding declarations', mode => {
    const original = contract();
    if (mode === 'empty') original.sourceClaimBindings = [];
    if (mode === 'duplicate') original.sourceClaimBindings = [sourceBinding, {...sourceBinding}];
    for (const parsed of [parseConclusionContractSidecar(rawSidecar(original)), parseTypedConclusionContractJson(JSON.stringify(original))]) {
      expect(parsed).toMatchObject({status: 'valid', bindingEligibility: 'eligible', issues: []});
      expect(parsed.contract?.sourceClaimBindings).toEqual(original.sourceClaimBindings);
      expect(Object.prototype.hasOwnProperty.call(parsed.contract, 'sourceClaimBindings')).toBe(mode !== 'absent');
    }
  });

  it.each([
    null, {}, 'bindings', 1, [null], [{}], [{...sourceBinding, claimId: undefined}],
    [{...sourceBinding, sourceReferenceIds: undefined}], [{...sourceBinding, traceEvidenceRefIds: null}],
    [{...sourceBinding, sourceReferenceIds: [null]}], [{...sourceBinding, claimId: ' claim:original '}],
    [{...sourceBinding, sourceReferenceIds: [' source-ref-v1-original ']}],
    [{...sourceBinding, mechanismStatus: 'verified'}], [{...sourceBinding, reason: 1}],
    [sourceBinding, {claimId: 'other'}], [sourceBinding, null],
  ])('keeps malformed original source bindings invalid through typed and sidecar round trips: %j', sourceClaimBindings => {
    const original = {...contract(), sourceClaimBindings};
    for (const parsed of [parseConclusionContractSidecar(rawSidecar(original)), parseTypedConclusionContractJson(JSON.stringify(original))]) {
      expect(parsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible', issues: [
        {code: 'invalid_reference', path: 'sourceClaimBindings'},
      ]});
      expect(parsed.contract?.rawDeclaration).toEqual(JSON.parse(JSON.stringify(original)));
      const reparsed = parseConclusionContractSidecar(renderConclusionContractSidecar(parsed.contract!));
      expect(reparsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible'});
      expect(reparsed.rawPayload).toEqual(parsed.rawPayload);
    }
  });

  it.each([undefined, new Array(1), [{...sourceBinding, sourceReferenceIds: new Array(1)}],
    [{...sourceBinding, traceEvidenceRefIds: new Array(1)}]])('rejects explicit undefined or sparse local bindings: %j', sourceClaimBindings => {
    const parsed = parseConclusionContractDeclaration({...contract(), sourceClaimBindings});
    expect(parsed).toMatchObject({contract: {bindingEligibility: 'ineligible'}, issues: [
      {code: 'invalid_reference', path: 'sourceClaimBindings'},
    ]});
    expect(Object.prototype.hasOwnProperty.call(parsed.contract?.rawDeclaration, 'sourceClaimBindings')).toBe(true);
  });

  it('round-trips an original source location without inferring or normalizing its tuple', () => {
    const original = contract();
    original.claims![0].semantics!.source = {sourceReferenceId: 'source-ref-v1-original',
      filePath: '目录/Probe "Data".kt', lineRange: {start: 9, end: 15}};
    const parsed = parseConclusionContractSidecar(rawSidecar(original));
    expect(parsed.status).toBe('valid');
    expect(parsed.contract?.claims![0].semantics?.source).toEqual(original.claims![0].semantics!.source);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractMarkdown(parsed.contract!, {includeMachineSidecar: true}));
    expect(roundTrip.contract?.claims![0].semantics?.source).toEqual(original.claims![0].semantics!.source);
  });

  it.each([
    {}, {sourceReferenceId: 'id', filePath: 'File.kt'},
    {sourceReferenceId: '', filePath: 'File.kt', lineRange: {start: 1, end: 2}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: 0, end: 2}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: 2, end: 1}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: '1', end: 2}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: 1, end: 2}, verified: true},
  ])('retains invalid source declarations as invalid: %j', source => {
    const original = structuredClone(contract()) as any;
    original.claims[0].semantics.source = source;
    const parsed = parseConclusionContractSidecar(rawSidecar(original));
    expect(parsed.status).toBe('invalid');
    expect(parsed.contract?.claims![0].rawSemantics).toEqual(original.claims[0].semantics);
  });

  it('preserves explicit SQL null in reference values and relation endpoints', () => {
    const original = contract();
    original.claims![0].references[0].value = null;
    original.claims![0].semantics!.scope.subjectRefs![0].value = null;
    original.relationProposals![0].subject.value = null;
    const parsed = parseConclusionContractSidecar(rawSidecar(original));
    expect(parsed).toMatchObject({status: 'valid', bindingEligibility: 'eligible', issues: []});
    expect(parsed.contract?.claims![0].references[0]).toHaveProperty('value', null);
    expect(parsed.contract?.claims![0].semantics?.scope.subjectRefs![0]).toHaveProperty('value', null);
    expect(parsed.contract?.relationProposals![0].subject).toHaveProperty('value', null);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractMarkdown(parsed.contract!, {includeMachineSidecar: true}));
    expect(roundTrip.contract?.claims).toEqual(original.claims);
    expect(roundTrip.contract?.relationProposals).toEqual(original.relationProposals);
  });

  it('classifies every closed relation proposal shape failure without changing admission', () => {
    const valid = () => ({schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:relation-1',
      kind: 'comparison_delta', direction: 'subject_to_object',
      subject: {evidenceRefId: 'subject', rowIndex: 0, rowSelector: {side: 'current'}, column: 'value', value: null},
      object: {artifactId: 'object', rowIndex: 1}, proof: {sourceToolCallId: 'proof'},
      proofBindings: {subject: {endpointColumn: 'subject_id', proofColumn: 'left_id'},
        object: {endpointColumn: 'object_id', proofColumn: 'right_id'}},
      metricColumn: 'delta', value: 1, unit: 'ms', deltaDirection: 'current_minus_reference'} as any);
    const cases: Array<[string, (proposal: any) => void]> = [
      ['item_not_object', proposal => {proposal.valueOf = () => null;}],
      ['unknown_field', proposal => {proposal.PRIVATE_RELATION_KEY_CANARY = true;}],
      ['invalid_schema_version', proposal => {proposal.schemaVersion = 'other';}],
      ['invalid_id', proposal => {proposal.id = 'not-a-proposal';}],
      ['invalid_kind', proposal => {proposal.kind = 'causes';}],
      ['invalid_direction', proposal => {proposal.direction = 'forward';}],
      ['invalid_subject', proposal => {proposal.subject = {column: 'value'};}],
      ['invalid_object', proposal => {proposal.object = {evidenceRefId: ''};}],
      ['invalid_proof', proposal => {proposal.proof = {private: 'PRIVATE_RELATION_VALUE_CANARY'};}],
      ['invalid_value', proposal => {proposal.value = null;}],
      ['invalid_unit', proposal => {proposal.unit = ' ';}],
      ['invalid_metric_column', proposal => {proposal.metricColumn = 1;}],
      ['invalid_delta_direction', proposal => {proposal.deltaDirection = 'reference_minus_current';}],
      ['invalid_proof_bindings', proposal => {delete proposal.proofBindings.object;}],
    ];
    for (const [reason, mutate] of cases) {
      let proposal: any = valid();
      if (reason === 'item_not_object') proposal = null;
      else mutate(proposal);
      const parsed = parseDeclaredRelationProposals([proposal]);
      expect(parsed.relationProposals).toEqual([]);
      expect(parsed.issues).toEqual([{code: 'invalid_relation_proposal', path: 'relationProposals[0]',
        relationProposalDiagnostic: {scope: 'item', ordinal: 1, reason}}]);
    }
    expect(parseDeclaredRelationProposals([valid()])).toEqual({relationProposals: [valid()], issues: []});
  });

  it('keeps endpoint null distinct from proposal null and requires both proof binding sides', () => {
    const base = structuredClone(contract().relationProposals![0]) as any;
    base.subject.value = null;
    expect(parseDeclaredRelationProposals([base]).issues).toEqual([]);
    for (const mutate of [
      (proposal: any) => {proposal.value = null;},
      (proposal: any) => {proposal.proofBindings = {subject: {endpointColumn: 'a', proofColumn: 'b'}};},
      (proposal: any) => {proposal.proofBindings = {object: {endpointColumn: 'a', proofColumn: 'b'}};},
      (proposal: any) => {proposal.proofBindings = {subject: {endpointColumn: 'a', proofColumn: 'b'},
        object: {endpointColumn: 'c', proofColumn: 'd', PRIVATE_RELATION_KEY_CANARY: true}};},
    ]) {
      const proposal = structuredClone(base);
      mutate(proposal);
      expect(parseDeclaredRelationProposals([proposal]).issues[0].relationProposalDiagnostic?.reason)
        .toBe(proposal.value === null ? 'invalid_value' : 'invalid_proof_bindings');
    }
  });

  it('uses original one-based relation ordinals up to 24 and never fabricates collection or later ordinals', () => {
    const collection = parseDeclaredRelationProposals({PRIVATE_RELATION_VALUE_CANARY: true});
    expect(collection.issues).toEqual([{code: 'invalid_relation_proposal', path: 'relationProposals',
      relationProposalDiagnostic: {scope: 'collection', reason: 'collection_not_array'}}]);
    expect(collection.issues[0].relationProposalDiagnostic).not.toHaveProperty('ordinal');

    const proposals = Array.from({length: 25}, (_, index) => ({...structuredClone(contract().relationProposals![0]),
      id: `proposal:item_${index + 1}`})) as any[];
    for (const index of [0, 23, 24]) proposals[index].kind = 'invalid';
    const issues = parseDeclaredRelationProposals(proposals).issues;
    expect(issues.map(issue => issue.path)).toEqual([
      'relationProposals[0]', 'relationProposals[23]', 'relationProposals[24]',
    ]);
    expect(issues.map(issue => issue.relationProposalDiagnostic)).toEqual([
      {scope: 'item', ordinal: 1, reason: 'invalid_kind'},
      {scope: 'item', ordinal: 24, reason: 'invalid_kind'},
      undefined,
    ]);
  });

  it('projects parse issues into closed triage codes with one slot per base code', () => {
    const proposals = Array.from({length: 26}, (_, index) => ({...structuredClone(contract().relationProposals![0]),
      id: `proposal:item_${index + 1}`})) as any[];
    proposals[0].kind = 'invalid';
    proposals[1].direction = 'sideways';
    proposals[2].kind = 'invalid';
    proposals[25].kind = 'invalid';
    const relationIssues = parseDeclaredRelationProposals(proposals).issues;
    expect(conclusionParseIssueTriageCodes([
      ...relationIssues,
      {code: 'invalid_semantics', path: 'claims[0].semantics'},
    ])).toEqual(['invalid_relation_proposal:invalid_kind+invalid_direction', 'invalid_semantics']);

    // Items past the diagnostic cap keep the bare code; the collection reason is closed too.
    expect(conclusionParseIssueTriageCodes([relationIssues[3]])).toEqual(['invalid_relation_proposal']);
    expect(conclusionParseIssueTriageCodes(parseDeclaredRelationProposals({x: 1}).issues))
      .toEqual(['invalid_relation_proposal:collection_not_array']);

    // Already-projected strings round-trip; anything outside the vocabulary is never echoed.
    expect(conclusionParseIssueTriageCodes([
      'invalid_relation_proposal:invalid_kind+invalid_direction', 'invalid_json',
      'PRIVATE_CODE_CANARY', 'invalid_json:invalid_kind', 'invalid_relation_proposal:PRIVATE_REASON_CANARY',
      'invalid_relation_proposal:invalid_kind:extra', {code: 'PRIVATE_OBJECT_CANARY'}, null,
    ])).toEqual(['invalid_relation_proposal:invalid_kind+invalid_direction', 'invalid_json']);

    expect(conclusionParseIssueTriageCodes(['invalid_json', 'invalid_claim', 'invalid_semantics', 'duplicate_marker']))
      .toEqual(['invalid_json', 'invalid_claim', 'invalid_semantics']);
    expect([...CONCLUSION_PARSE_ISSUE_CODES].sort()).toEqual([
      'duplicate_claim_id', 'duplicate_marker', 'duplicate_proposal_id', 'invalid_claim', 'invalid_contract',
      'invalid_framing', 'invalid_json', 'invalid_reference', 'invalid_relation_proposal', 'invalid_semantics',
      'untrusted_parser_metadata',
    ]);
  });

  it.each(['rowSelector', 'numeric', 'proposal_value'] as const)(
    'does not widen %s to accept null when reference values become nullable', target => {
      const invalid = structuredClone(contract()) as any;
      if (target === 'rowSelector') invalid.claims[0].references[0].rowSelector = {code: null};
      if (target === 'numeric') invalid.claims[0].semantics.numeric.value = null;
      if (target === 'proposal_value') invalid.relationProposals[0].value = null;
      const parsed = parseConclusionContractSidecar(rawSidecar(invalid));
      expect(parsed.status).toBe('invalid');
      expect(parsed.bindingEligibility).toBe('ineligible');
      expect(parsed.issues.length).toBeGreaterThan(0);
    },
  );

  it('round-trips typed declarations, exact scalar types and proposal IDs without proof', () => {
    const original = contract();
    const markdown = renderConclusionContractMarkdown(original, {includeMachineSidecar: true});
    const result = parseConclusionContractSidecar(markdown);
    expect(result.status).toBe('valid');
    expect(result.bindingEligibility).toBe('eligible');
    expect(result.contract?.claims).toEqual(original.claims);
    expect(result.contract?.relationProposals).toEqual(original.relationProposals);
    expect(result.contract?.claims?.[0].semantics?.numeric?.value).toBe('2.00');
    expect(result.contract?.claims?.[0].references[0].value).toBe('001');
    expect(result.contract).not.toHaveProperty('verified');
    expect(deriveConclusionContract(markdown)?.claims).toEqual(original.claims);
    expect(deriveConclusionContract(JSON.stringify(original))?.claims).toEqual(original.claims);
    expect(deriveConclusionContract('```json\n' + JSON.stringify(original) + '\n```')?.claims).toEqual(original.claims);
  });

  it('keeps machine emission opt-in even when a caller supplies new declaration fields', () => {
    expect(parseConclusionContractSidecar(renderConclusionContractMarkdown(contract())).status).toBe('absent');
  });

  it('accepts an unknown predicate declaration without inferring or verifying it', () => {
    const result = parseConclusionContractSidecar(rawSidecar(contract()));
    expect(result.status).toBe('valid');
    expect(result.contract?.claims?.[0].semantics?.predicate).toBe('future.metric@7');
    expect(result.contract?.claims?.[0]).not.toHaveProperty('supportLevel');
  });

  it.each([
    ['missing', undefined, 'missing', 'missing_required'],
    ['null', null, 'null', 'wrong_type'],
    ['array', [], 'array', 'wrong_type'],
    ['object', {private: 'PRIVATE_STRUCTURE_CANARY'}, 'object', 'wrong_type'],
    ['literal', 'PRIVATE_STRUCTURE_CANARY', 'string', 'invalid_enum'],
  ])('explains a %s root mode without exposing its value or admitting the declaration', (_label, value, actual, reason) => {
    const input: Record<string, unknown> = {...contract(), mode: value};
    if (value === undefined) delete input.mode;
    const parsed = parseConclusionContractSidecar(rawSidecar(input));
    expect(parsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible', issues: [{
      code: 'invalid_contract', path: '$', details: [{field: '$.mode', expected: 'conclusion_mode', actual, reason}],
    }]});
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.contract).toBeUndefined();
    expect(parsed.rawPayload).toEqual(input);
    expect(JSON.stringify(parsed.issues)).not.toContain('PRIVATE_STRUCTURE_CANARY');
  });

  it.each([NaN, Infinity, -Infinity])('distinguishes nonfinite rank %s without changing finite numeric boundaries', rank => {
    const invalid = parseConclusionContractDeclaration({...contract(), conclusions: [{rank, statement: 'Synthetic'}]});
    expect(invalid.issues).toMatchObject([{code: 'invalid_contract', path: '$', details: [{
      field: '$.conclusions[].rank', expected: 'finite_number', actual: 'nonfinite_number', reason: 'invalid_number',
    }]}]);
    expect(invalid.contract).toBeUndefined();
    for (const finite of [0, -0, -1, Number.MAX_VALUE, Number.MIN_VALUE]) {
      expect(parseConclusionContractDeclaration({...contract(), conclusions: [{rank: finite, statement: ''}]}).issues).toEqual([]);
    }
  });

  it('reports numeric overflow parsed from JSON as nonfinite while preserving the original rejection', () => {
    const raw = rawSidecar({...contract(), conclusions: [{rank: 7, statement: 'Synthetic'}]}).replace(/"rank":\s*7/, '"rank":1e400');
    expect(parseConclusionContractSidecar(raw)).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible', issues: [{
      code: 'invalid_contract', details: [{field: '$.conclusions[].rank', expected: 'finite_number',
        actual: 'nonfinite_number', reason: 'invalid_number'}],
    }]});
  });

  it('does not reclassify typed JSON with a wrong schemaVersion while sidecars diagnose the fixed literal', () => {
    const input = {...contract(), schemaVersion: 'PRIVATE_STRUCTURE_CANARY'};
    expect(parseTypedConclusionContractJson(JSON.stringify(input))).toMatchObject({status: 'absent', issues: []});
    expect(parseConclusionContractSidecar(rawSidecar(input))).toMatchObject({status: 'invalid', issues: [{
      code: 'invalid_contract', path: '$', details: [{field: '$.schemaVersion', expected: 'conclusion_contract_v1',
        actual: 'string', reason: 'invalid_literal'}],
    }]});
  });

  it('deduplicates repeated collection shape failures without inflating the original parse issue count', () => {
    const parsed = parseConclusionContractDeclaration({...contract(), conclusions: Array.from({length: 100}, () => ({rank: '1', statement: null}))});
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues).toMatchObject([{details: [
      {field: '$.conclusions[].statement', expected: 'string', actual: 'null', reason: 'wrong_type'},
      {field: '$.conclusions[].rank', expected: 'finite_number', actual: 'string', reason: 'wrong_type'},
    ]}]);
  });

  it('caps unique structure details while preserving one root rejection and avoiding user keys or values', () => {
    const invalidItems = [{}, null, [], 'PRIVATE_STRUCTURE_CANARY', 0, false, undefined, Infinity, () => undefined];
    const parsed = parseConclusionContractDeclaration({...contract(), conclusions: invalidItems,
      clusters: invalidItems, evidenceChain: invalidItems});
    expect(parsed.contract).toBeUndefined();
    expect(parsed.issues).toHaveLength(1);
    const details = parsed.issues[0].details!;
    expect(details).toHaveLength(24);
    expect(new Set(details.map(detail => `${detail.field}:${detail.actual}`)).size).toBe(24);
    expect(JSON.stringify(details)).not.toContain('PRIVATE_STRUCTURE_CANARY');
  });

  it.each(['uncertainties', 'nextSteps'] as const)(
    'rejects object-valued %s while valid strings preserve the same original declarations', field => {
      const claims: NonNullable<ConclusionContract['claims']> = [
        {id: 'c1', text: 'The app identity was inferred from the available activity.', kind: 'identity',
          references: [{evidenceRefId: 'data:processes', column: 'process_name', value: 'example.app'}]},
        {id: 'c2', text: 'The main process has the highest observed activity.', kind: 'comparison',
          references: [{evidenceRefId: 'data:activity', column: 'slice_count', value: 164643}]},
      ];
      const base: ConclusionContract = {...contract(), claims, relationProposals: []};
      const entry = {topic: 'Identity inference', detail: 'A canonical identity resolver was not used.'};
      const invalidDeclaration = {...base, [field]: [entry]};
      const raw = rawSidecar(invalidDeclaration);
      const invalid = parseConclusionContractSidecar(raw);
      expect(invalid).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible',
        issues: [{code: 'invalid_contract', path: '$'}], rawPayload: invalidDeclaration});
      expect(invalid.contract).toBeUndefined();
      expect(normalizeConclusionOutput(raw)).toBe(raw);
      const validDeclaration = {...base, [field]: [`${entry.topic}: ${entry.detail}`]};
      const valid = parseConclusionContractSidecar(rawSidecar(validDeclaration));
      expect(valid).toMatchObject({status: 'valid', bindingEligibility: 'eligible', issues: []});
      expect(valid.contract?.claims).toEqual(claims);
      expect(valid.contract?.[field]).toEqual(validDeclaration[field]);
      expect(valid.contract?.claims?.every(claim => claim.semantics === undefined && claim.supportLevel === undefined)).toBe(true);
    },
  );

  it.each(['Simple answer', '# Arbitrary title\nNo required heading', 'A prose answer with no final punctuation'])(
    'keeps body formatting independent of binding: %s', body => {
      const original = body + '\r\n\r\n' + renderConclusionContractSidecar(contract()).replace(/\n/g, '\r\n');
      const result = parseConclusionContractSidecar(original);
      expect(result.status).toBe('valid');
      expect(result.narrative).toBe(body + '\r\n\r\n');
      expect(normalizeConclusionOutput(original)).toBe(original);
      expect(deriveConclusionContract(original)?.claims?.[0].id).toBe('claim:original');
    },
  );

  it('does not activate markers inside fences, blockquotes, indented code, comments or JSON strings', () => {
    const marker = renderConclusionContractSidecar(contract());
    const examples = [
      '````text\n' + marker + '\n````',
      '~~~example\n' + marker + '\n~~~',
      marker.split('\n').map(line => '> ' + line).join('\n'),
      marker.split('\n').map(line => '    ' + line).join('\n'),
      '<!-- example\n' + marker + '\n-->',
      JSON.stringify({text: marker}),
    ];
    for (const example of examples) expect(parseConclusionContractSidecar(example).status).toBe('absent');
    expect(parseConclusionContractSidecar(examples[0] + '\n\n' + marker).status).toBe('valid');
  });

  it.each(['missing-close', 'missing-json-fence', 'tail-garbage', 'wrong-version', 'duplicate'])(
    'blocks legacy extraction after invalid machine framing: %s', variant => {
      const marker = renderConclusionContractSidecar(contract());
      const broken = variant === 'missing-close' ? marker.slice(0, -3) :
        variant === 'missing-json-fence' ? marker.replace('```json\n', '') :
        variant === 'tail-garbage' ? marker.replace('\n```\n-->', '\n{"other":true}\n```\n-->') :
        variant === 'wrong-version' ? marker.replace('contract@1', 'contract@2') : marker + '\n' + marker;
      const input = '## 结论（按可能性排序）\n1. Legacy fallback must not win\n\n' + broken;
      const result = parseConclusionContractSidecar(input);
      expect(result.status).toBe('invalid');
      expect(result.bindingEligibility).toBe('ineligible');
      expect(result.contract).toBeUndefined();
      expect(deriveConclusionContract(input)).toBeNull();
      expect(normalizeConclusionOutput(input)).toBe(input);
    },
  );

  it('returns exact nonoverlapping machine spans for valid, duplicate and interrupted declarations', () => {
    const marker = renderConclusionContractSidecar(contract());
    const input = '前缀😀\r\n' + marker.replace(/\n/g, '\r\n') + '\r\n中间\r\n' + marker + '\n结尾';
    const result = parseConclusionContractSidecar(input);
    expect(result.status).toBe('invalid');
    expect(result.machineSegments).toHaveLength(2);
    expect(result.machineSegments.map(segment => input.slice(segment.start, segment.end))).toEqual([
      marker.replace(/\n/g, '\r\n'), marker,
    ]);
    expect(result.narrative).toBe('前缀😀\r\n\r\n中间\r\n\n结尾');
    const interrupted = 'Body\n' + marker.slice(0, -3);
    const partial = parseConclusionContractSidecar(interrupted);
    expect(partial.machineSegments).toEqual([{start: 5, end: interrupted.length}]);
    expect(partial.narrative).toBe('Body\n');
    const nested = marker.replace('\n```\n-->', '\n' + marker + '\n```\n-->');
    const duplicate = parseConclusionContractSidecar(nested);
    expect(duplicate.status).toBe('invalid');
    expect(duplicate.issues[0].code).toBe('duplicate_marker');
    expect(duplicate.machineSegments).toHaveLength(1);
  });

  it('retains invalid semantics and parser issues across render and parse', () => {
    const original = contract();
    const invalid = {...original, claims: [{...original.claims![0], semantics: {...semantics(), polarity: ['affirmed']}}]};
    const parsed = parseConclusionContractSidecar(rawSidecar(invalid));
    expect(parsed.status).toBe('invalid');
    expect(parsed.contract?.claims?.[0].semantics).toBeUndefined();
    expect(parsed.contract?.claims?.[0].rawSemantics).toEqual(invalid.claims[0].semantics);
    expect(parsed.issues).toContainEqual({code: 'invalid_semantics', path: 'claims[0].semantics',
      claimDiagnostic: {ordinal: 1, code: 'invalid_semantics', field: 'semantics.polarity'}});
    const derived = deriveConclusionContract(rawSidecar(invalid));
    expect(derived?.bindingEligibility).toBe('ineligible');
    expect(derived?.claims?.[0].text).toBe(invalid.claims[0].text);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractMarkdown(derived!, {includeMachineSidecar: true}));
    expect(roundTrip.status).toBe('invalid');
    expect(roundTrip.contract?.claims?.[0].rawSemantics).toEqual(invalid.claims[0].semantics);
  });

  it('preserves duplicate claim and proposal items without assigning replacement IDs', () => {
    const original = contract();
    original.claims!.push({...original.claims![0], text: 'Second distinct original claim'});
    original.relationProposals!.push({...original.relationProposals![0], unit: 'ns'});
    const result = parseConclusionContractSidecar(rawSidecar(original));
    expect(result.status).toBe('invalid');
    expect(result.contract?.claims?.map(claim => [claim.id, claim.text])).toEqual(original.claims!.map(claim => [claim.id, claim.text]));
    expect(result.contract?.relationProposals).toEqual(original.relationProposals);
    expect(result.issues.map(issue => issue.code)).toEqual(['duplicate_claim_id', 'duplicate_proposal_id']);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractMarkdown(result.contract!, {includeMachineSidecar: true}));
    expect(roundTrip.issues.map(issue => issue.code)).toEqual(['duplicate_claim_id', 'duplicate_proposal_id']);
  });

  it('keeps invalid citations and proposals visible as raw declarations, never valid bindings', () => {
    const original = contract();
    const invalid = {...original, claims: [{...original.claims![0], references: [{column: 'value', value: '999'}]}],
      relationProposals: [{...original.relationProposals![0], id: 'backend-proof-id'}]};
    const result = parseConclusionContractSidecar(rawSidecar(invalid));
    expect(result.status).toBe('invalid');
    expect(result.contract?.claims?.[0].text).toBe('Original claim');
    expect(result.contract?.claims?.[0].rawReferences).toEqual(invalid.claims[0].references);
    expect(result.contract?.rawRelationProposals).toEqual(invalid.relationProposals);
    expect(result.contract?.relationProposals).toEqual([]);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractMarkdown(result.contract!, {includeMachineSidecar: true}));
    expect(roundTrip.contract?.claims?.[0].rawReferences).toEqual(invalid.claims[0].references);
    expect(roundTrip.contract?.rawRelationProposals).toEqual(invalid.relationProposals);
  });

  it('cannot take parser state from model-controlled metadata', () => {
    const original = contract();
    const result = parseConclusionContractSidecar(rawSidecar({...original, parseIssues: [], bindingEligibility: 'eligible', verified: true,
      claims: [{...original.claims![0], semantics: {predicate: 'incomplete'}, semanticsParseIssues: []}]}));
    expect(result.status).toBe('invalid');
    expect(result.bindingEligibility).toBe('ineligible');
    expect(result.contract).not.toHaveProperty('verified');
    expect(result.issues).toEqual(expect.arrayContaining([
      {code: 'untrusted_parser_metadata', path: '$'},
      {code: 'invalid_semantics', path: 'claims[0].semantics',
        // The omitted schema version is the canonical default, so the first real failure is polarity.
        claimDiagnostic: {ordinal: 1, code: 'invalid_semantics', field: 'semantics.polarity'}},
    ]));
  });

  it.each(['parseIssues', 'bindingEligibility', 'verified', 'rawDeclaration'])(
    'does not launder a root parser-owned field through machine rendering: %s', key => {
      const input = {...contract(), [key]: key === 'parseIssues' ? [] : key === 'rawDeclaration' ? contract() : true};
      const first = parseConclusionContractSidecar(rawSidecar(input));
      expect(first.status).toBe('invalid');
      expect(first.issues).toEqual([{code: 'untrusted_parser_metadata', path: '$'}]);
      expect(first.contract?.rawDeclaration).toEqual(input);
      const rendered = renderConclusionContractMarkdown(first.contract!, {includeMachineSidecar: true});
      const second = parseConclusionContractSidecar(rendered);
      expect(second.status).toBe('invalid');
      expect(second.bindingEligibility).toBe('ineligible');
      expect(second.issues).toEqual(first.issues);
      expect(second.rawPayload).toEqual(input);
    },
  );

  it.each(['semanticsParseIssues', 'parseIssues', 'rawDeclaration'])(
    'preserves a claim-only parser metadata rejection without a second invalid field: %s', key => {
      const original = contract();
      const input = {...original, claims: [{...original.claims![0], [key]: []}]};
      const first = parseConclusionContractSidecar(rawSidecar(input));
      expect(first.status).toBe('invalid');
      expect(first.issues).toEqual([{code: 'untrusted_parser_metadata', path: 'claims[0]',
        claimDiagnostic: {ordinal: 1, code: 'untrusted_parser_metadata', field: 'parser_metadata'}}]);
      expect(first.contract?.claims?.[0].semantics).toEqual(original.claims![0].semantics);
      expect(first.contract?.rawClaims).toEqual(input.claims);
      const second = parseConclusionContractSidecar(renderConclusionContractMarkdown(first.contract!, {includeMachineSidecar: true}));
      expect(second.status).toBe('invalid');
      expect(second.bindingEligibility).toBe('ineligible');
      expect(second.issues).toEqual(first.issues);
      expect(second.rawPayload).toEqual(input);
    },
  );

  it.each([
    ['root', 'verified'], ['root', 'parseIssues'], ['root', 'rawDeclaration'],
    ['claim', 'semanticsParseIssues'], ['claim', 'rawReferences'], ['claim', 'rawDeclaration'],
    ['claim', 'parseIssues'], ['claim', 'bindingEligibility'], ['claim', 'verified'],
  ])('detects reserved %s.%s without other typed declaration signals', (level, key) => {
    const base = contract();
    delete base.relationProposals;
    delete base.claims![0].semantics;
    const input = level === 'root' ? {...base, [key]: []} :
      {...base, claims: [{...base.claims![0], [key]: []}]};
    const json = JSON.stringify(input);
    for (const text of [json, '```json\n' + json + '\n```']) {
      const parsed = parseTypedConclusionContractJson(text);
      expect(parsed.status).toBe('invalid');
      expect(parsed.issues).toEqual([level === 'root' ? {code: 'untrusted_parser_metadata', path: '$'}
        : {code: 'untrusted_parser_metadata', path: 'claims[0]',
          claimDiagnostic: {ordinal: 1, code: 'untrusted_parser_metadata', field: 'parser_metadata'}}]);
      const derived = deriveConclusionContract(text);
      expect(derived?.bindingEligibility).toBe('ineligible');
      expect(derived?.parseIssues).toEqual(parsed.issues);
      expect(normalizeConclusionOutput(text)).toBe(text);
      const roundTrip = parseConclusionContractSidecar(renderConclusionContractMarkdown(derived!, {includeMachineSidecar: true}));
      expect(roundTrip.status).toBe('invalid');
      expect(roundTrip.rawPayload).toEqual(input);
    }
  });

  it.each(['invalid-mode', 'missing-uncertainties'])(
    'blocks typed JSON shell failures before legacy headings can discard claims: %s', defect => {
      const input: Record<string, unknown> = {...contract(), conclusion: 'Original narrative'};
      if (defect === 'invalid-mode') input.mode = 'invalid';
      else delete input.uncertainties;
      const json = JSON.stringify(input);
      for (const text of [json, '```json\n' + json + '\n```', '```json\r\n' + json + '\r\n```']) {
        const parsed = parseTypedConclusionContractJson(text);
        expect(parsed.status).toBe('invalid');
        expect(parsed.bindingEligibility).toBe('ineligible');
        expect(parsed.issues).toEqual([{code: 'invalid_contract', path: '$', details: [defect === 'invalid-mode'
          ? {field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'}
          : {field: '$.uncertainties', expected: 'array', actual: 'missing', reason: 'missing_required'}]}]);
        expect(parsed.raw).toBe(text);
        expect(parsed.rawPayload).toEqual(input);
        expect(parsed.contract).toBeUndefined();
        expect(deriveConclusionContract(text)).toBeNull();
        expect(normalizeConclusionOutput(text)).toBe(text);
      }
    },
  );

  it('does not let the legacy first-object extractor repair typed JSON framing', () => {
    const invalid = {...contract(), mode: 'invalid', conclusion: 'Original narrative'};
    for (const json of [JSON.stringify(contract()), JSON.stringify(invalid)]) {
      for (const text of [json + '\ntrailing text', '```json\n' + json + '\n```\ntrailing text']) {
        expect(deriveConclusionContract(text)).toBeNull();
        expect(normalizeConclusionOutput(text)).toBe(text);
      }
    }
  });

  it('keeps non-typed legacy JSON aliases on the compatibility parser', () => {
    const legacy = JSON.stringify({schema_version: 'conclusion_contract_v1', conclusion: 'Legacy statement',
      evidence_chain: [], claims: [{claim_id: 'legacy-claim', statement: 'Legacy statement', references: []}],
      uncertainties: [], next_steps: []});
    expect(parseTypedConclusionContractJson(legacy).status).toBe('absent');
    expect(deriveConclusionContract(legacy)?.claims?.[0]).toMatchObject({id: 'legacy-claim', text: 'Legacy statement'});
  });

  it('escapes comment closers and preserves decoded quotes, fences and multiline values', () => {
    const original = contract();
    const value = 'literal --> & <tag> "quote"\n```json\nline\n```\n<!-- smartperfetto:conclusion-contract@1';
    original.claims![0].text = value;
    original.claims![0].semantics!.conditions = [value];
    original.claims![0].references[0].value = value;
    const rendered = renderConclusionContractMarkdown(original, {includeMachineSidecar: true});
    const result = parseConclusionContractSidecar(rendered);
    expect(result.status).toBe('valid');
    expect(result.contract?.claims?.[0].text).toBe(value);
    expect(result.contract?.claims?.[0].semantics?.conditions).toEqual([value]);
    expect(result.contract?.claims?.[0].references[0].value).toBe(value);
    const unescaped = rawSidecar(original);
    expect(parseConclusionContractSidecar(unescaped).status).toBe('invalid');
  });

  it('leaves plain legacy contracts on their existing visible rendering', () => {
    const original = contract();
    delete original.relationProposals;
    delete original.claims![0].semantics;
    delete original.claims![0].kind;
    delete original.claims![0].artifactRefs;
    delete original.claims![0].relationRefs;
    const rendered = renderConclusionContractMarkdown(original);
    expect(parseConclusionContractSidecar(rendered).status).toBe('absent');
    expect(deriveConclusionContract(JSON.stringify(original))?.claims?.[0].text).toBe('Original claim');
  });
});
