// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { HTMLReportGenerator } from '../htmlReportGenerator';
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import {QUERY_REVIEW_SCHEMA_VERSION, type QueryReviewV1} from '../../types/queryReviewContract';

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

function makeEnvelopeWithQueryReview(): DataEnvelope {
  const queryReview: QueryReviewV1 = {
    schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
    id: 'qr:execute_sql:report',
    producer: {kind: 'execute_sql', sourceToolCallId: 'execute_sql:report'},
    title: 'SQL review',
    purpose: 'Review SQL output',
    source: {evidenceRefId: 'data:sql:report', queryHash: 'hash-report'},
    reads: [{table: 'thread_state', confidence: 'observed'}],
    filters: [{expression: 'dur > 0', confidence: 'observed'}],
    outputShape: [{name: 'dur_ms', type: 'duration', required: true}],
    guardrails: [{ruleId: 'safe-duration-boundary', message: 'review duration handling', severity: 'warning'}],
    limitations: ['review-only metadata'],
    observedExecution: {executed: true, executableSql: 'SELECT dur FROM thread_state WHERE dur > 0', rowCount: 1},
    allowedUse: 'review_metadata_only',
  };
  return createDataEnvelope(
    {columns: ['dur_ms'], rows: [[10]]},
    {
      type: 'sql_result',
      source: 'execute_sql',
      title: 'SQL Query',
      evidenceRefId: 'data:sql:report',
      queryHash: 'hash-report',
      queryReview,
    },
  );
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

  test('escapes nested report keys and object values', () => {
    const generator = new HTMLReportGenerator();
    const renderDeepAnalysisCard = (
      generator as unknown as {
        renderDeepAnalysisCard(item: unknown, index: number): string;
      }
    ).renderDeepAnalysisCard.bind(generator);
    const payload = '</span><img src=x onerror="fetch(\'/api/v1/providers\')">';

    const html = renderDeepAnalysisCard({
      title: 'safe',
      [`metric_${payload}`]: {nested: {payload}},
    }, 0);

    expect(html).not.toContain('<img');
    expect(html).not.toContain('</span><img');
    expect(html).toContain('&lt;/span&gt;&lt;img');
  });

  test('renders partial warning for degraded agent results', () => {
    const generator = new HTMLReportGenerator();
    const message = '最终结果质量闸门发现 provider 没有产出可独立交付的完整结论';
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-partial',
      query: '分析启动慢',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-partial',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '## 综合结论\n\n阶段摘要',
        confidence: 0.55,
        rounds: 1,
        totalDurationMs: 1000,
        partial: true,
        terminationMessage: message,
      },
    });

    expect(html).toContain('结果完整性提示');
    expect(html).toContain(message);
  });

  test('renders query review sidecar in data envelope section', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-query-review',
      query: '分析线程状态',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [makeEnvelopeWithQueryReview()],
      result: {
        sessionId: 'session-query-review',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('Query Review');
    expect(html).toContain('qr:execute_sql:report');
    expect(html).toContain('thread_state');
    expect(html).toContain('safe-duration-boundary');
  });

  test('renders analysis receipt aggregate audit section', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-receipt',
      query: '分析启动慢',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-receipt',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
        analysisReceipt: {
          schemaVersion: 1,
          runId: 'run-receipt',
          sessionId: 'session-receipt',
          traceId: 'trace-receipt',
          mode: 'fast',
          resolvedMode: 'quick',
          providerId: null,
          generatedAt: 1,
          traceEvidence: {
            sqlCount: 2,
            skillCount: 1,
            dataEnvelopeCount: 3,
            artifactCount: 1,
            evidenceRefCount: 4,
          },
          nonEvidenceContext: {
            frontendPrequeryCount: 1,
            memoryHintCount: 2,
            conversationContextCount: 3,
            strategyHintCount: 4,
          },
          claimAudit: {
            totalClaims: 5,
            verifiedClaims: 4,
            unsupportedClaims: 1,
            uncertainClaims: 0,
          },
          qualityGates: {
            finalReportContract: 'passed',
            claimVerification: 'partial',
            identityResolution: 'not_applicable',
          },
          outputs: {
            reportId: 'report-receipt',
            resultSnapshotId: 'snapshot-receipt',
          },
          capabilityManifest: {
            schemaVersion: 'capability_manifest_attribution@1',
            resolution: {
              status: 'ready',
              manifestId: 'manifest&lt;unsafe',
              contentHash: 'hash\"unsafe',
              manifestSchemaVersion: 'capability_manifest@1',
              traceFingerprintSha256: 'trace>unsafe',
              traceProcessor: {
                source: 'custom',
                binarySha256: 'processor<script>alert(1)</script>',
              },
            },
            probeCache: {hits: 3, misses: 1, bypasses: 2, keyHash: 'must-not-render'},
          },
          traceSummary: {
            schemaVersion: 'trace_summary_attribution@1',
            status: 'ready',
            specId: 'smartperfetto.core.v1<script>alert(2)</script>',
            specDigestSha256: '1'.repeat(64),
            traceFingerprintSha256: '2'.repeat(64),
            traceProcessor: {source: 'custom', binarySha256: '3'.repeat(64)},
            resultDigestSha256: '4'.repeat(64),
            availableMetricIds: ['metric_a'],
            missingMetricIds: ['metric_b'],
          },
        },
        uiActionProposals: [
          {
            schemaVersion: 1,
            id: 'ui-open_evidence_table-1',
            kind: 'open_evidence_table',
            title: '打开启动证据表',
            reason: '查看支撑结论的原始证据行',
            source: {
              evidenceRefId: 'data:startup:summary:123',
              artifactId: 'artifact-startup',
              skillId: 'startup_analysis',
            },
            payload: {
              artifactId: 'artifact-startup',
              evidenceRefId: 'data:startup:summary:123',
            },
            requiresConfirmation: true,
          },
          {
            schemaVersion: 1,
            id: 'ui-pin_evidence-1',
            kind: 'pin_evidence',
            title: '保存启动证据快照',
            reason: '保存到当前会话',
            source: {evidenceRefId: 'data:startup:summary:123'},
            payload: {evidenceRefId: 'data:startup:summary:123'},
            requiresConfirmation: true,
          },
        ],
      },
    });

    expect(html).toContain('分析回执');
    expect(html).toContain('Trace 证据');
    expect(html).toContain('Evidence refs');
    expect(html).toContain('report-receipt');
    expect(html).toContain('snapshot-receipt');
    expect(html).toContain('Capability Manifest');
    expect(html).toContain('manifest&amp;lt;unsafe');
    expect(html).toContain('hash&quot;unsafe');
    expect(html).toContain('trace&gt;unsafe');
    expect(html).toContain('processor&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Hits');
    expect(html).not.toContain('must-not-render');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Trace Summary');
    expect(html).toContain('smartperfetto.core.v1&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('metric_a');
    expect(html).toContain('metric_b');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('UI 动作提案');
    expect(html).toContain('收藏证据');
    expect(html).toContain('打开启动证据表');
    expect(html).toContain('artifact-startup');
    expect(html).not.toContain('SELECT ');
  });

  test.each([
    ['Unavailable', 'unavailable', 'identity_resolution_failed'],
    ['Failed', 'failed', 'capability_manifest_build_failed'],
  ] as const)('renders fixed capability %s reason without detail codes', (_label, status, reason) => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-capability-status',
      query: 'analyze',
      timestamp: 1,
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-capability-status',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
        analysisReceipt: {
          schemaVersion: 1,
          runId: 'run-capability-status',
          sessionId: 'session-capability-status',
          traceId: 'trace-capability-status',
          mode: 'full',
          resolvedMode: 'full',
          providerId: null,
          generatedAt: 1,
          traceEvidence: {sqlCount: 0, skillCount: 0, dataEnvelopeCount: 0, artifactCount: 0, evidenceRefCount: 0},
          nonEvidenceContext: {frontendPrequeryCount: 0, memoryHintCount: 0, conversationContextCount: 0, strategyHintCount: 0},
          claimAudit: {totalClaims: 0, verifiedClaims: 0, unsupportedClaims: 0, uncertainClaims: 0},
          qualityGates: {finalReportContract: 'not_applicable', claimVerification: 'not_applicable', identityResolution: 'not_applicable'},
          outputs: {},
          capabilityManifest: {
            schemaVersion: 'capability_manifest_attribution@1',
            resolution: status === 'unavailable'
              ? {status, reason, detailCode: 'must_not_render'}
              : {status, reason},
            probeCache: {hits: 0, misses: 0, bypasses: 1},
          },
        },
      },
    });

    expect(html).toContain(reason);
    expect(html).not.toContain('must_not_render');
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

  test('renders summary DataEnvelope provenance and metrics', () => {
    const generator = new HTMLReportGenerator();
    const summaryEnvelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId: 'data:sql_summary:reference:trace-hash:query-hash:tool-hash',
        traceSide: 'reference',
        paneSide: 'right',
        traceId: 'trace-ref',
        queryHash: 'query-hash',
        sourceToolCallId: 'execute_sql_on:1:params_hash:reference',
        paramsHash: 'params_hash',
        planPhaseId: 'p1',
        planPhaseTitle: 'Compare baseline',
        planPhaseGoal: 'Summarize reference trace',
        producerReason: '执行参考 Trace SQL，验证对比差异。',
      },
      display: {
        layer: 'overview',
        format: 'summary',
        title: 'Reference SQL Summary',
      },
      data: {
        summary: {
          title: 'SQL Summary (10 rows)',
          content: 'Total rows: 10',
          metrics: [
            { label: 'total_rows', value: 10, severity: 'info' },
          ],
        },
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-4',
      query: '对比参考 trace',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [summaryEnvelope],
      result: {
        sessionId: 'session-4',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('Reference SQL Summary');
    expect(html).toContain('右侧/参考 Trace');
    expect(html).toContain('来源: execute_sql');
    expect(html).toContain('DataEnvelope.overview');
    expect(html).toContain('阶段: p1 Compare baseline');
    expect(html).toContain('用途: 执行参考 Trace SQL，验证对比差异。');
    expect(html).toContain('技术细节（默认收起）');
    expect(html).toContain('data:sql_summary:reference:trace-hash:query-hash:tool-hash');
    expect(html).toContain('execute_sql_on:1:params_hash:reference');
    expect(html).toContain('total_rows');
    expect(html).toContain('10');
    expect(html).toContain('smartperfetto-report-layout-fix-v2');
    expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))');
    expect(html).toContain('.header .meta .badge');
    expect(html).toContain('.summary-box .metric-card .metric-label');
    expect(html).toContain('.summary-box .metric-card .metric-value');
    expect(html).toMatch(
      /\.summary-box \.metric-card \.metric-value \{[\s\S]*?font-size: 14px;/,
    );
    expect(html).toMatch(
      /\.metric-card \.value,[\s\S]*?font-size: 28px;/,
    );
    expect(html).toContain('class="metric-label label"');
    expect(html).toContain('class="metric-value value"');
    expect(html).not.toContain('无汇总数据');
  });

  test('renders structured conclusion claim references in report', () => {
    const generator = new HTMLReportGenerator();
    const evidenceRefId = 'data:sql_table:current:trace-hash:query-hash:tool-hash';
    const sourceToolCallId = 'execute_sql:7:params_hash';
    const envelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId,
        sourceToolCallId,
      },
      display: {
        layer: 'list',
        format: 'table',
        title: 'Frame duration table',
        columns: [
          { name: 'frame_id', label: '帧 ID', type: 'number' as any },
          { name: 'dur_ms', label: '帧耗时', type: 'number' as any },
        ],
      },
      data: {
        columns: ['frame_id', 'dur_ms'],
        rows: [[1435508, 45.6]],
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-claim',
      query: '解释掉帧来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [envelope],
      result: {
        sessionId: 'session-claim',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '帧 1435508 耗时 45.6ms。',
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          claim_refs: [{
            claim_id: 'Q1',
            conclusion_id: 'C1',
            claim: '帧 1435508 耗时 45.6ms。',
            evidence_refs: [{
              evidence_ref_id: evidenceRefId,
              source_ref: '表 1',
              tool_call_id: sourceToolCallId,
              row_index: 0,
              row_selector: { frame_id: 1435508 },
              col: 'dur_ms',
              value: 45.6,
            }],
          }],
          uncertainties: [],
          nextSteps: [],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('证据引用摘要');
    expect(html).toContain('Q1 / C1');
    expect(html).toContain('帧 1435508 耗时 45.6ms。');
    expect(html).toContain('报告来源: 数据表 1 · Frame duration table');
    expect(html).toContain('行号: 0 / 行选择器: frame_id=1435508');
    expect(html).toContain('<code>dur_ms</code>=45.6');
    expect(html).toContain('已找到来源表');
  });

  test('marks duplicate claim evidence refs as ambiguous unless tool call disambiguates them', () => {
    const generator = new HTMLReportGenerator();
    const evidenceRefId = 'data:sql_table:duplicate';
    const firstEnvelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId,
        sourceToolCallId: 'execute_sql:1:params',
      },
      display: {
        layer: 'list',
        format: 'table',
        title: 'First duplicate table',
      },
      data: {
        columns: ['value'],
        rows: [[1]],
      } as any,
    };
    const secondEnvelope: DataEnvelope = {
      ...firstEnvelope,
      meta: {
        ...firstEnvelope.meta,
        sourceToolCallId: 'execute_sql:2:params',
      },
      display: {
        ...firstEnvelope.display,
        title: 'Second duplicate table',
      },
      data: {
        columns: ['value'],
        rows: [[2]],
      } as any,
    };

    const ambiguousHtml = generator.generateAgentDrivenHTML({
      traceId: 'trace-claim-duplicate',
      query: '解释重复来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [firstEnvelope, secondEnvelope],
      result: {
        sessionId: 'session-claim-duplicate',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '值为 2。',
        conclusionContract: {
          claims: [{
            id: 'Q1',
            text: '值为 2。',
            references: [{ evidence_ref_id: evidenceRefId, column: 'value', value: 2 }],
          }],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(ambiguousHtml).toContain('来源不唯一');
    expect(ambiguousHtml).toContain('匹配到 2 个来源');

    const disambiguatedHtml = generator.generateAgentDrivenHTML({
      traceId: 'trace-claim-duplicate',
      query: '解释重复来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [firstEnvelope, secondEnvelope],
      result: {
        sessionId: 'session-claim-duplicate',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '值为 2。',
        conclusionContract: {
          claims: [{
            id: 'Q1',
            text: '值为 2。',
            references: [{
              evidence_ref_id: evidenceRefId,
              source_tool_call_id: 'execute_sql:2:params',
              column: 'value',
              value: 2,
            }],
          }],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(disambiguatedHtml).toContain('报告来源: 数据表 2 · Second duplicate table');
    expect(disambiguatedHtml).toContain('已找到来源表');
    expect(disambiguatedHtml).not.toContain('来源不唯一');
  });

  test('falls back to visible source_ref labels when claim machine ids are missing', () => {
    const generator = new HTMLReportGenerator();
    const envelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
      },
      display: {
        layer: 'list',
        format: 'table',
        title: 'Frame duration table',
      },
      data: {
        columns: ['frame_id', 'dur_ms'],
        rows: [[1435508, 45.6]],
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-source-ref-only',
      query: '解释掉帧来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [envelope],
      result: {
        sessionId: 'session-source-ref-only',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '帧 1435508 耗时 45.6ms。',
        conclusionContract: {
          claims: [{
            id: 'Q1',
            text: '帧 1435508 耗时 45.6ms。',
            references: [{
              source_ref: '表 1',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
            }],
          }],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('模型标签: <code>表 1</code>');
    expect(html).toContain('报告来源: 数据表 1 · Frame duration table');
    expect(html).toContain('已找到来源表');
    expect(html).not.toContain('缺少机器 ID');
  });

  test('renders text DataEnvelope diagnostics instead of an empty table', () => {
    const generator = new HTMLReportGenerator();
    const diagnosticEnvelope: DataEnvelope = {
      meta: {
        type: 'diagnostic',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId: 'data:sql_diagnostic:current:trace-hash:query-hash:tool-hash',
        sourceToolCallId: 'execute_sql:1:params_hash',
        planPhaseAttribution: 'inferred',
      },
      display: {
        layer: 'diagnosis',
        format: 'text',
        title: 'SQL execution diagnostic',
      },
      data: {
        text: 'SQL execution did not produce a table: bad sql',
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-5',
      query: '分析失败 SQL',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [diagnosticEnvelope],
      result: {
        sessionId: 'session-5',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('SQL execution diagnostic');
    expect(html).toContain('SQL execution did not produce a table: bad sql');
    expect(html).not.toContain('阶段归因: inferred');
    expect(html).toContain('data:sql_diagnostic:current:trace-hash:query-hash:tool-hash');
    expect(html).toContain('execute_sql:1:params_hash');
    expect(html).not.toContain('无数据');
  });

  test('renders generic SQL DataEnvelope with an explanatory report title and purpose', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-sql',
      query: '分析启动性能',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [{
        meta: {
          type: 'sql_result',
          version: '2.0.0',
          source: 'execute_sql',
          timestamp: Date.now(),
          evidenceRefId: 'data:sql_table:current:trace-hash:query-hash:tool-hash',
          sourceToolCallId: 'execute_sql:9:params_hash',
          traceSide: 'current',
          planPhaseId: 'p3',
          planPhaseTitle: '综合结论',
          producerReason: '执行当前 Trace SQL，验证本阶段的具体数据点。',
        },
        display: {
          layer: 'list',
          format: 'table',
          title: 'SQL Query (2 rows)',
          columns: [
            { name: 'slice_name', type: 'string' as any },
            { name: 'total_ms', type: 'duration' as any, format: 'duration_ms' as any, unit: 'ms' },
            { name: 'self_ms', type: 'duration' as any, format: 'duration_ms' as any, unit: 'ms' },
          ],
        },
        data: {
          columns: ['slice_name', 'total_ms', 'self_ms'],
          rows: [
            ['LoadSimulator_ActivityInit', 710.06, 249.8],
            ['ChaosTask', 15.97, 15.97],
          ],
        } as any,
        sql: 'SELECT slice_name, total_ms, self_ms FROM hot_slices',
      } as any],
      result: {
        sessionId: 'session-sql',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('SQL 结果 · 主线程热点 Slice');
    expect(html).toContain('用途: 定位主线程里真正消耗 self time 的可优化 slice');
    expect(html).toContain('来源: execute_sql');
    expect(html).toContain('阶段: p3 综合结论');
    expect(html).toContain('2 行');
    expect(html).not.toContain('SQL Query (2 rows)');
    expect(html).not.toContain('执行当前 Trace SQL，验证本阶段的具体数据点。');
    expect(html).toContain('data:sql_table:current:trace-hash:query-hash:tool-hash');
    expect(html).toContain('execute_sql:9:params_hash');
    expect(html).toContain('SELECT slice_name, total_ms, self_ms FROM hot_slices');
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

  test('renders case recommendations with strong guidance and partial evidence gaps', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-case-rec',
      query: '分析滑动掉帧',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-case-rec',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'shader compile 是主要根因。',
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'initial_report',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          caseRecommendations: [
            {
              caseId: 'scroll_shader_compile_pixel8_001',
              title: '首次滑动 RenderThread shader compile',
              scene: 'scrolling',
              primaryRootCause: 'shader_compile',
              matchStrength: 'strong',
              evidenceRefs: ['ev_shader_compile'],
              learnedProvenance: {
                candidateId: 'cand-html-1',
                supportingEvidence: 3,
                contradictingEvidence: 0,
                supported: true,
              },
              recommendations: {
                app: [{
                  id: 'app.precompile_shader',
                  priority: 'P0',
                  action: '提前 warm-up / precompile shader，避免首次滑动同步编译。',
                  applies_when: 'RenderThread 出现 shader/makePipeline 编译且与掉帧窗口重叠',
                  risks: '预热会增加启动或首屏内存/CPU，需要选择低影响窗口',
                }],
                oem: [{
                  id: 'oem.gpu_cpu_boost',
                  priority: 'P1',
                  action: '检查 GPU/CPU 频率响应和 RenderThread 调度优先级。',
                  applies_when: 'shader 编译不可完全消除，且同帧存在低频或调度延迟证据',
                  risks: '频率策略会影响功耗，需要按场景白名单或短时 boost',
                }],
              },
            },
            {
              case_id: 'scroll_scheduler_freq_mixed_001',
              title: '滑动线程调度与频率响应混合问题',
              scene: 'scrolling',
              primary_root_cause: 'sched_delay_in_slice',
              match_strength: 'partial',
              evidence_gap: '缺少 CPU 频率 ramp 与掉帧窗口重叠证据。',
              recommendations: {
                app: [{
                  id: 'app.reduce_ui_work',
                  priority: 'P1',
                  action: '减少 UI 线程同步工作。',
                  applies_when: 'UI 线程已经存在 workload_heavy 或 sched_delay 证据',
                  risks: '拆分任务可能改变交互时序，需要 A/B 验证',
                }],
                oem: [],
              },
            },
          ],
          uncertainties: [],
          nextSteps: [],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('相似案例与优化建议');
    expect(html).toContain('case_id');
    expect(html).toContain('scroll_shader_compile_pixel8_001');
    expect(html).toContain('学习案例');
    expect(html).toContain('3 次正向反馈');
    expect(html).toContain('strong 匹配');
    expect(html).toContain('可作为直接建议');
    expect(html).toContain('App 侧建议');
    expect(html).toContain('OEM/厂商侧建议');
    expect(html).toContain('applies_when');
    expect(html).toContain('RenderThread 出现 shader/makePipeline 编译且与掉帧窗口重叠');
    expect(html).toContain('risks');
    expect(html).toContain('预热会增加启动或首屏内存/CPU');
    expect(html).toContain('scroll_scheduler_freq_mixed_001');
    expect(html).toContain('partial 匹配');
    expect(html).toContain('仅作背景参考');
    expect(html).toContain('evidence_gap');
    expect(html).toContain('缺少 CPU 频率 ramp 与掉帧窗口重叠证据。');
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
