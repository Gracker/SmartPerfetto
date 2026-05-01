// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { HTMLReportGenerator } from '../htmlReportGenerator';
import type { DataEnvelope } from '../../types/dataContract';

const originalOutputLanguage = process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;

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
  beforeEach(() => {
    delete process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
  });

  afterAll(() => {
    if (originalOutputLanguage === undefined) {
      delete process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
    } else {
      process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = originalOutputLanguage;
    }
  });

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

  test('renders ordered conversation timeline in report', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-2',
      query: '分析启动慢',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      conversationTimeline: [
        {
          eventId: 'evt-2',
          ordinal: 2,
          phase: 'tool',
          role: 'agent',
          text: '执行关键 SQL',
          timestamp: Date.now(),
          sourceEventType: 'tool_call',
        },
        {
          eventId: 'evt-1',
          ordinal: 1,
          phase: 'progress',
          role: 'system',
          text: '进入阶段 discovery',
          timestamp: Date.now() - 10,
          sourceEventType: 'stage_transition',
        },
      ],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-2',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.9,
        rounds: 1,
        totalDurationMs: 800,
      },
    });

    expect(html).toContain('🧵 对话时间线');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('进入阶段 discovery');
    expect(html).toContain('执行关键 SQL');
    expect(html.indexOf('进入阶段 discovery')).toBeLessThan(html.indexOf('执行关键 SQL'));
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

  test('renders mermaid diagrams with stronger visual defaults for causal chains', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-3',
      query: '分析因果链',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-3',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: [
          '### 根因分析：因果链',
          '```mermaid',
          'graph TB',
          'A[输入] --> B[处理]',
          'B --> C[结果]',
          '```',
        ].join('\n'),
        confidence: 0.85,
        rounds: 1,
        totalDurationMs: 500,
      },
    });

    expect(html).toContain('class="mermaid-wrapper"');
    expect(html).toContain('function parseMermaidFlowSource(source)');
    expect(html).toContain("className = 'causal-map'");
    expect(html).toContain("textContent = '因果链流程图'");
    expect(html).toContain("textContent = '查看原始 Mermaid 图'");
    expect(html).toContain("querySelector: 'pre.mermaid[data-render-mode=\"mermaid\"]'");
  });

  test('renders agent-driven report shell in English when configured', () => {
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'en';
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-en',
      query: 'Why is startup slow?',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      conversationTimeline: [{
        eventId: 'evt-en-1',
        ordinal: 1,
        phase: 'progress',
        role: 'system',
        text: 'Starting analysis',
        timestamp: Date.now(),
      }],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-en',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: [
          '### Causal chain',
          '```mermaid',
          'graph TB',
          'A[Input] --> B[Processing]',
          'B --> C[Result]',
          '```',
        ].join('\n'),
        confidence: 0.85,
        rounds: 1,
        totalDurationMs: 500,
      },
    });

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('SmartPerfetto Agent-Driven Analysis Report');
    expect(html).toContain('Execution Overview');
    expect(html).toContain('User Question');
    expect(html).toContain('Conversation Timeline');
    expect(html).toContain('Analysis Conclusion');
    expect(html).toContain('Causal Chain Flow');
    expect(html).toContain('View original Mermaid diagram');
    expect(html).not.toContain('SmartPerfetto Agent-Driven 分析报告');
    expect(html).not.toContain('用户问题');
    expect(html).not.toContain('对话时间线');
    expect(html).not.toContain('查看原始 Mermaid 图');
  });
});
