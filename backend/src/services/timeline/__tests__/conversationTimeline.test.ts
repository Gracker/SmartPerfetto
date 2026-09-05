// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { deriveTimelineStep } from '../conversationTimeline';
import type { StreamingUpdate } from '../../../agent/types';

function update(type: StreamingUpdate['type'], content: unknown): StreamingUpdate {
  return {type, content, timestamp: 1_700_000_000_000};
}

describe('deriveTimelineStep', () => {
  describe('tool results', () => {
    it('uses the runtime narration and never the raw transport payload', () => {
      const step = deriveTimelineStep(
        update('agent_response', {
          taskId: 'call_1',
          toolName: 'execute_sql',
          // The transport field is a byte-truncated JSON dump. Rendering it is
          // what made a third of the timeline unreadable.
          result: '[{"type":"text","text":"{\\"success\\":true,\\"totalRows\\":376',
          resultNarration: 'SQL 返回 376 行（已摘要）',
        }),
        'zh-CN',
      );
      expect(step).toEqual({phase: 'result', role: 'agent', text: 'SQL 返回 376 行（已摘要）'});
    });

    it('drops the step entirely when there is no narration', () => {
      expect(deriveTimelineStep(
        update('agent_response', {
          taskId: 'call_1',
          result: '[{"type":"text","text":"{\\"success\\":true}"}]',
          resultNarration: '',
        }),
        'zh-CN',
      )).toBeNull();
    });

    it('does not fall back to an opaque task id', () => {
      expect(deriveTimelineStep(
        update('agent_response', {taskId: 'call_00_abcdef123456'}),
        'zh-CN',
      )).toBeNull();
    });

    it('marks a failed tool call as an error, not a result', () => {
      const step = deriveTimelineStep(
        update('agent_response', {
          taskId: 'call_1',
          toolName: 'update_plan_phase',
          isError: true,
          resultNarration: 'update_plan_phase 失败：summary 太短',
        }),
        'zh-CN',
      );
      expect(step?.phase).toBe('error');
      expect(step?.text).toContain('失败');
    });
  });

  describe('plan phase transitions', () => {
    it('shows automatic transitions, which nothing else in the stream reports', () => {
      const step = deriveTimelineStep(
        update('plan_phase_updated', {
          phaseId: 'p1',
          phaseName: '概览与架构信号',
          status: 'completed',
          summary: '已产生 20 个证据表',
          origin: 'auto',
        }),
        'zh-CN',
      );
      expect(step).toEqual({
        phase: 'progress',
        role: 'agent',
        text: '完成阶段「概览与架构信号」：已产生 20 个证据表',
      });
    });

    it('skips model-driven transitions, already narrated by the tool call', () => {
      expect(deriveTimelineStep(
        update('plan_phase_updated', {
          phaseId: 'p2',
          phaseName: '根因深钻',
          status: 'completed',
          summary: '根因确认',
          origin: 'model',
        }),
        'zh-CN',
      )).toBeNull();
    });

    it('skips a transition with no origin rather than guessing', () => {
      expect(deriveTimelineStep(
        update('plan_phase_updated', {phaseId: 'p1', status: 'completed', summary: 'x'}),
        'zh-CN',
      )).toBeNull();
    });

    it('renders a pending rollback as a rollback, not as progress', () => {
      const step = deriveTimelineStep(
        update('plan_phase_updated', {
          phaseId: 'p1',
          phaseName: '概览',
          status: 'pending',
          summary: '仍缺少关键工具证据。',
          origin: 'auto',
        }),
        'zh-CN',
      );
      expect(step?.text).toContain('退回待补证');
    });
  });

  describe('progress events', () => {
    it('drops progress that only restates the tool call above it', () => {
      expect(deriveTimelineStep(
        update('progress', {
          phase: 'analyzing',
          message: '运行分析技能: scrolling_analysis...',
          duplicatesToolCall: true,
        }),
        'zh-CN',
      )).toBeNull();
    });

    it('keeps progress that carries its own information', () => {
      const step = deriveTimelineStep(
        update('progress', {phase: 'analyzing', message: '技能 scrolling_analysis 完成 (642ms, 13 个结果层)'}),
        'zh-CN',
      );
      expect(step?.text).toContain('642ms');
    });
  });

  it('ignores event types that have no place in the process view', () => {
    expect(deriveTimelineStep(update('answer_token', {token: 'x'}), 'zh-CN')).toBeNull();
    expect(deriveTimelineStep(update('plan_submitted', {phases: []}), 'zh-CN')).toBeNull();
  });

  it('never emits a line that looks like a serialized payload', () => {
    const candidates: StreamingUpdate[] = [
      update('agent_response', {taskId: 'c1', result: '[{"type":"text","text":"{\\"a\\":1}"}]'}),
      update('agent_response', {taskId: 'c1', result: {deeply: {nested: true}}}),
      update('finding', {findings: [{title: '主线程阻塞'}]}),
    ];
    for (const candidate of candidates) {
      const text = deriveTimelineStep(candidate, 'zh-CN')?.text ?? '';
      expect(text).not.toContain('{"');
      expect(text).not.toContain('[{');
    }
  });
});

describe('what the evidence line spends its words on', () => {
  const {summarizeDataEnvelopeForTimeline} =
    require('../conversationTimeline') as typeof import('../conversationTimeline');

  function envelope(title: string, extra: Record<string, unknown> = {}) {
    return {
      display: {title, format: 'table'},
      data: {rows: [[1], [2], [3]]},
      meta: {
        evidenceRefId: `data:skill:x:${title}`,
        planPhaseTitle: '概览与架构分支',
        producerReason: '调用 Skill scrolling_analysis，收集本阶段结构化证据。',
        traceSide: 'current',
        ...extra,
      },
    };
  }

  function summarize(envelopes: unknown[]): string {
    return summarizeDataEnvelopeForTimeline(
      {type: 'data', content: envelopes, timestamp: 1} as never,
      'zh-CN',
    );
  }

  it('names what arrived', () => {
    const text = summarize([envelope('洞见摘要'), envelope('显示配置')]);
    expect(text).toContain('洞见摘要');
    expect(text).toContain('显示配置');
  });

  it('does not spend the line on row totals or evidence-ID bookkeeping', () => {
    // A reader wants to know what arrived, not how many rows or how many
    // internal identifiers were registered.
    const text = summarize([envelope('洞见摘要'), envelope('显示配置')]);
    expect(text).not.toContain('行');
    expect(text).not.toContain('证据 ID');
  });

  it('does not repeat the plan phase, which has its own boundary line', () => {
    expect(summarize([envelope('洞见摘要')])).not.toContain('概览与架构分支');
  });

  it('does not repeat the tool dispatch line above it', () => {
    expect(summarize([envelope('洞见摘要')])).not.toContain('调用 Skill scrolling_analysis');
  });

  it('keeps a phase-attribution caveat, which changes how to read the evidence', () => {
    const text = summarize([envelope('洞见摘要', {planPhaseWarning: '工具结果语义匹配刚完成的阶段'})]);
    expect(text).toContain('阶段归因需核对');
  });

  it('names the trace only when more than one is in play', () => {
    expect(summarize([envelope('洞见摘要')])).not.toContain('Trace');
    const compared = summarize([
      envelope('洞见摘要'),
      envelope('对比洞见摘要', {traceSide: 'reference'}),
    ]);
    expect(compared).toContain('Trace');
  });
});

describe('the conclusion step', () => {
  it('does not claim a final conclusion before verification has run', () => {
    // `analysis_completed` is the terminal fact; the conclusion event is
    // withheld from clients until deterministic verification finishes.
    const step = deriveTimelineStep(update('conclusion', {}), 'zh-CN');
    expect(step?.text).toBe('结论已生成，正在核验证据');
    expect(step?.text).not.toContain('最终结论已生成');
  });

  it('prefers the runtime own summary when it has one', () => {
    const step = deriveTimelineStep(update('conclusion', {summary: '根因是主线程重负载'}), 'zh-CN');
    expect(step?.text).toBe('根因是主线程重负载');
  });
});
