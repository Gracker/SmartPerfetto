// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';

import type { ConclusionContract } from '../../agent/core/conclusionContract';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';
import type { DataEnvelope } from '../../types/dataContract';
import {
  buildRuntimeQuickEvidenceAttempt,
  buildRuntimeQuickEvidenceDirectAnswer,
  combineRuntimeQuickEvidenceDirectAnswers,
  countRuntimeQuickEvidenceCitedRefs,
  selectReusableRuntimeQuickEvidenceAttempt,
  type RuntimeQuickEvidenceDirectAnswer,
} from '../quickEvidenceDirectAnswer';

function envelope(input: {
  evidenceRefId: string;
  sourceToolCallId: string;
  title: string;
  columns: string[];
  rows: unknown[][];
}): DataEnvelope {
  return {
    meta: {
      type: 'sql_result',
      version: '2.0.0',
      source: input.sourceToolCallId,
      timestamp: 1,
      evidenceRefId: input.evidenceRefId,
      sourceToolCallId: input.sourceToolCallId,
      traceSide: 'current',
      traceId: 'trace-1',
    },
    data: {
      columns: input.columns,
      rows: input.rows,
    },
    display: {
      layer: 'list',
      format: 'table',
      title: input.title,
    },
  };
}

function answer(input: {
  id: string;
  statement: string;
  claimKind: 'categorical' | 'numeric';
  evidenceText: string;
  references: NonNullable<ConclusionContract['claims']>[number]['references'];
}): RuntimeQuickEvidenceDirectAnswer {
  return {
    conclusion: input.statement,
    conclusionContract: {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [{
        rank: 1,
        statement: input.statement,
        confidencePercent: 100,
      }],
      clusters: [],
      evidenceChain: [{
        conclusionId: input.id,
        text: input.evidenceText,
      }],
      claims: [{
        id: input.id,
        conclusionId: input.id,
        text: input.statement,
        kind: input.claimKind,
        references: input.references,
      }],
      uncertainties: [],
      nextSteps: [],
      metadata: {
        confidencePercent: 100,
        rounds: 0,
        claimDerivation: 'explicit_model_contract',
        claimVerificationScope: 'explicit_claims',
      },
    },
    confidence: 1,
  };
}

describe('combineRuntimeQuickEvidenceDirectAnswers', () => {
  it('combines process identity and trace fact direct answers without losing verifier coverage', () => {
    const identityEnvelope = envelope({
      evidenceRefId: 'data:skill:process_identity_resolver:current:abc:result_0',
      sourceToolCallId: 'runtime-skill:process_identity_resolver:abc',
      title: 'Runtime process identity pre-evidence',
      columns: [
        'canonical_package_name',
        'recommended_process_name_param',
        'process_name',
        'upid',
        'identity_status',
        'confidence_score',
      ],
      rows: [[
        'com.example.app',
        'com.example.app',
        'com.example.app',
        42,
        'confirmed',
        100,
      ]],
    });
    const traceFactEnvelope = envelope({
      evidenceRefId: 'data:runtime_trace_fact:jank_frame_count:current:def',
      sourceToolCallId: 'runtime-trace-fact:jank_frame_count:def',
      title: 'Runtime FrameTimeline janky frame count pre-evidence',
      columns: [
        'package_name',
        'total_frames',
        'jank_frames',
        'jank_rate_pct',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        347,
        21,
        6.05,
        'actual_frame_timeline_slice',
      ]],
    });

    const identityAnswer = answer({
      id: 'quick-process-identity',
      statement: '当前 trace 的包名、推荐进程参数和首选进程均为 com.example.app；UPID=42，status=confirmed，confidence=100。',
      claimKind: 'categorical',
      evidenceText: 'Runtime process identity pre-evidence: canonical_package_name=com.example.app, process_name=com.example.app',
      references: [
        {
          evidenceRefId: identityEnvelope.meta.evidenceRefId,
          sourceToolCallId: identityEnvelope.meta.sourceToolCallId,
          sourceRef: identityEnvelope.display.title,
          rowIndex: 0,
          column: 'canonical_package_name',
          value: 'com.example.app',
        },
        {
          evidenceRefId: identityEnvelope.meta.evidenceRefId,
          sourceToolCallId: identityEnvelope.meta.sourceToolCallId,
          sourceRef: identityEnvelope.display.title,
          rowIndex: 0,
          column: 'process_name',
          value: 'com.example.app',
        },
      ],
    });
    const traceFactAnswer = answer({
      id: 'quick-trace-fact-jank_frame_count',
      statement: '焦点应用 com.example.app 的 FrameTimeline 中共有 347 帧，其中 21 帧标记为掉帧/卡顿（6.05%）。',
      claimKind: 'numeric',
      evidenceText: 'Runtime FrameTimeline janky frame count pre-evidence: package_name=com.example.app, total_frames=347, jank_frames=21, jank_rate_pct=6.05',
      references: [
        {
          evidenceRefId: traceFactEnvelope.meta.evidenceRefId,
          sourceToolCallId: traceFactEnvelope.meta.sourceToolCallId,
          sourceRef: traceFactEnvelope.display.title,
          rowIndex: 0,
          column: 'jank_frames',
          value: 21,
        },
        {
          evidenceRefId: traceFactEnvelope.meta.evidenceRefId,
          sourceToolCallId: traceFactEnvelope.meta.sourceToolCallId,
          sourceRef: traceFactEnvelope.display.title,
          rowIndex: 0,
          column: 'jank_rate_pct',
          value: 6.05,
        },
      ],
    });

    const combined = combineRuntimeQuickEvidenceDirectAnswers({
      processIdentityAnswer: identityAnswer,
      traceFactAnswer,
      outputLanguage: 'zh-CN',
    });

    expect(combined?.conclusion).toContain('com.example.app');
    expect(combined?.conclusion).toContain('21 帧标记为掉帧/卡顿');
    expect(combined?.conclusionContract.conclusions).toHaveLength(2);
    expect(combined?.conclusionContract.claims).toHaveLength(2);
    expect(countRuntimeQuickEvidenceCitedRefs(combined!)).toBe(2);

    const verified = runClaimVerification({
      conclusionContract: combined?.conclusionContract,
      dataEnvelopes: [identityEnvelope, traceFactEnvelope],
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 2,
      unsupportedClaimCount: 0,
    }));
  });
});

describe('buildRuntimeQuickEvidenceAttempt', () => {
  it('keeps valid partial trace evidence private when required quick evidence is incomplete', async () => {
    const updates: unknown[] = [];
    const traceProcessorService = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('android_battery_stats_event_slices')) {
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [['com.example.app', 2_000_000_000, 2]],
            durationMs: 1,
          };
        }
        if (sql.includes('runtime_frame_metrics')) {
          return {
            columns: [
              'package_name',
              'process_names',
              'upid_count',
              'total_frames',
              'window_start_ns',
              'window_end_ns',
              'duration_s',
              'fps',
              'source_table',
            ],
            rows: [[
              'com.example.app',
              'com.example.app',
              1,
              120,
              100,
              200,
              0.0000001,
              58,
              'actual_frame_timeline_slice',
            ]],
            durationMs: 1,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    const attempt = await buildRuntimeQuickEvidenceAttempt({
      query: '滑动 FPS 是多少？',
      traceId: 'trace-quick-private-partial',
      traceProcessorService: traceProcessorService as any,
      outputLanguage: 'zh-CN',
      quickFocusAppPreEvidence: true,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: true,
      quickScrollingTriagePreEvidence: false,
      emitUpdate: update => updates.push(update),
    });

    expect(attempt).toMatchObject({
      directAnswer: undefined,
      effectivePackageName: 'com.example.app',
      evidenceCounts: {
        currentRunDataEnvelopes: 0,
        citedEvidenceRefs: 0,
      },
    });
    expect(attempt?.runtimeEvidenceContext).toContain('非引用运行时路由上下文');
    expect(attempt?.runtimeEvidenceContext).toContain('frame_metrics');
    expect(attempt?.runtimeEvidenceContext).toContain('| fps |');
    expect(attempt?.runtimeEvidenceContext).toContain('| 58 |');
    expect(attempt?.runtimeEvidenceContext).not.toContain('evidence_ref_id');
    expect(attempt?.runtimeEvidenceContext).not.toContain('source_tool_call_id');
    expect(attempt?.runtimeEvidenceContext).not.toContain('evidenceRefId');
    expect(attempt?.runtimeEvidenceContext).not.toContain('sourceToolCallId');
    expect(attempt?.runtimeEvidenceContext).not.toContain('data:runtime_trace_fact');
    expect(attempt?.runtimeEvidenceContext).not.toContain('运行时预证据');
    expect(attempt?.runtimeEvidenceContext).not.toContain('Current Trace Runtime Evidence');
    expect(updates).toHaveLength(0);
  });

  it('keeps selection time range on skip-focus explicit package trace facts', async () => {
    const traceProcessorService = {
      query: jest.fn(async () => {
        throw new Error('skip-focus selection duration should not query trace processor');
      }),
    };

    const attempt = await buildRuntimeQuickEvidenceAttempt({
      query: '选区持续多久？',
      traceId: 'trace-quick-selection-explicit-package',
      packageName: 'com.example.app',
      selectionContext: {
        kind: 'area',
        source: 'area_selection',
        startNs: 100,
        endNs: 250,
      },
      traceProcessorService: traceProcessorService as any,
      outputLanguage: 'zh-CN',
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: true,
      quickScrollingTriagePreEvidence: false,
      emitUpdate: jest.fn(),
    });

    expect(attempt?.focusResult).toMatchObject({
      apps: [],
      method: 'none',
      timeRange: { startNs: 100, endNs: 250 },
    });
    expect(attempt?.directAnswer?.conclusion).toContain('duration_ns');
    expect(attempt?.directAnswer?.conclusion).toContain('value=`150`');
    expect(traceProcessorService.query).not.toHaveBeenCalled();
  });

  it('preserves the direct-answer wrapper shape on successful quick evidence', async () => {
    const updates: unknown[] = [];
    const traceProcessorService = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('android_battery_stats_event_slices')) {
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [['com.example.app', 2_000_000_000, 2]],
            durationMs: 1,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const baseInput = {
      query: '当前焦点应用是什么？',
      traceId: 'trace-quick-attempt-direct',
      traceProcessorService: traceProcessorService as any,
      outputLanguage: 'zh-CN' as const,
      quickFocusAppPreEvidence: true,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
      emitUpdate: (update: unknown) => updates.push(update),
    };

    const attempt = await buildRuntimeQuickEvidenceAttempt(baseInput);
    const wrapper = await buildRuntimeQuickEvidenceDirectAnswer({
      ...baseInput,
      traceId: 'trace-quick-wrapper-direct',
    });

    expect(attempt?.directAnswer).toBeDefined();
    expect(attempt?.focusResult).toMatchObject({
      primaryApp: 'com.example.app',
      method: 'battery_stats',
    });
    expect(wrapper).toMatchObject({
      directAnswer: {
        confidence: attempt?.directAnswer?.confidence,
      },
      effectivePackageName: 'com.example.app',
      evidenceCounts: attempt?.evidenceCounts,
    });
    expect(wrapper?.directAnswer.conclusion).toContain('com.example.app');
    expect((wrapper as any).focusResult).toBeUndefined();
    expect(updates).toHaveLength(2);
  });

  it('returns reusable focus state without publishing incomplete direct evidence', async () => {
    const updates: unknown[] = [];
    const sqlQueries: string[] = [];
    const traceProcessorService = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        sqlQueries.push(sql);
        if (sql.includes('android_battery_stats_event_slices')) {
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [['com.example.app', 2_000_000_000, 2]],
            durationMs: 1,
          };
        }
        if (sql.includes('runtime_frame_metrics')) {
          return {
            columns: [
              'package_name',
              'process_names',
              'upid_count',
              'total_frames',
              'window_start_ns',
              'window_end_ns',
              'duration_s',
              'fps',
              'source_table',
            ],
            rows: [],
            durationMs: 1,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    const attempt = await buildRuntimeQuickEvidenceAttempt({
      query: '滑动 FPS 是多少？',
      traceId: 'trace-quick-attempt',
      selectionContext: { kind: 'area', startNs: 100, endNs: 200 },
      traceProcessorService: traceProcessorService as any,
      outputLanguage: 'zh-CN',
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: true,
      quickScrollingTriagePreEvidence: false,
      emitUpdate: update => updates.push(update),
    });

    expect(attempt).toMatchObject({
      directAnswer: undefined,
      effectivePackageName: 'com.example.app',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'battery_stats',
        timeRange: { startNs: 100, endNs: 200 },
      },
      evidenceCounts: {
        currentRunDataEnvelopes: 0,
        citedEvidenceRefs: 0,
      },
    });
    expect(traceProcessorService.query).toHaveBeenCalledTimes(2);
    expect(sqlQueries.filter(sql => sql.includes('android_battery_stats_event_slices'))).toHaveLength(1);
    expect(sqlQueries.filter(sql => sql.includes('runtime_frame_metrics'))).toHaveLength(1);
    expect(updates).toHaveLength(0);

    const wrapper = await buildRuntimeQuickEvidenceDirectAnswer({
      query: '滑动 FPS 是多少？',
      traceId: 'trace-quick-attempt-wrapper',
      selectionContext: { kind: 'area', startNs: 100, endNs: 200 },
      traceProcessorService: traceProcessorService as any,
      outputLanguage: 'zh-CN',
      quickFocusAppPreEvidence: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: true,
      quickScrollingTriagePreEvidence: false,
      emitUpdate: update => updates.push(update),
    });
    expect(wrapper).toBeUndefined();
  });

  it('keeps failed-attempt routing reuse default-off and enables it only for Task 4 admission', () => {
    const attempt = {
      focusResult: {apps: [], method: 'none' as const},
      effectivePackageName: 'com.example.app',
      evidenceCounts: {currentRunDataEnvelopes: 0, citedEvidenceRefs: 0},
    };
    expect(selectReusableRuntimeQuickEvidenceAttempt(attempt, {})).toBeUndefined();
    expect(selectReusableRuntimeQuickEvidenceAttempt(attempt, {
      SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task4',
    })).toBe(attempt);
    expect(selectReusableRuntimeQuickEvidenceAttempt(attempt, {
      SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task5',
    })).toBeUndefined();
  });
});
