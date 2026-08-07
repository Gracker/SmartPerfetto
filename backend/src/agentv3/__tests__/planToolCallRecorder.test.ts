// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { AnalysisPlanV3 } from '../types';
import {
  findCompletedPhaseEvidenceGaps,
  recordPlanToolCall,
  recordPlanOrPrePlanToolCall,
  replayPrePlanToolCalls,
} from '../planToolCallRecorder';
import {getSourceLookupCodeReferences} from '../../services/codebase/sourceLookupTools';

function createPlan(): AnalysisPlanV3 {
  return {
    phases: [
      {
        id: 'p1',
        name: '概览采集',
        goal: '获取滑动帧概览',
        expectedTools: ['invoke_skill'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'scrolling_analysis' }],
        status: 'completed',
        completedAt: 100,
        summary: '已完成滑动概览采集，包含掉帧帧统计和初步根因分布。',
      },
      {
        id: 'p2',
        name: '根因深钻',
        goal: '调用关键 Skill 确认每类掉帧根因',
        expectedTools: ['invoke_skill', 'fetch_artifact', 'lookup_knowledge'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
          { tool: 'invoke_skill', skillId: 'frame_blocking_calls' },
          { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
        ],
        status: 'completed',
        completedAt: 200,
        summary: '已完成主要掉帧深钻，并准备进入最终结论阶段。',
      },
      {
        id: 'p4',
        name: '综合结论',
        goal: '综合所有证据给出最终报告',
        expectedTools: ['fetch_artifact'],
        status: 'in_progress',
        summary: '',
      },
    ],
    successCriteria: '完整解释滑动掉帧根因',
    submittedAt: 1,
    toolCallLog: [
      {
        toolName: 'invoke_skill',
        timestamp: 10,
        skillId: 'scrolling_analysis',
        matchedPhaseId: 'p1',
      },
      {
        toolName: 'invoke_skill',
        timestamp: 20,
        skillId: 'jank_frame_detail',
        matchedPhaseId: 'p2',
      },
      {
        toolName: 'invoke_skill',
        timestamp: 30,
        skillId: 'frame_blocking_calls',
        matchedPhaseId: 'p2',
      },
    ],
  };
}

describe('recordPlanToolCall', () => {
  it('backfills a completed phase expectedCall gap before trusting a returned active phase id', () => {
    const plan = createPlan();

    const record = recordPlanToolCall(plan, {
      toolName: 'invoke_skill',
      input: { skillId: 'blocking_chain_analysis', params: '{}' },
      resultText: '{"success":true,"planPhaseId":"p4"}',
      timestamp: 40,
    });

    expect(record).toMatchObject({
      toolName: 'invoke_skill',
      skillId: 'blocking_chain_analysis',
      matchedPhaseId: 'p2',
    });
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([]);
  });

  it('keeps an active phase match when that phase has the same missing expectedCall', () => {
    const plan = createPlan();
    plan.phases[2] = {
      ...plan.phases[2],
      expectedTools: ['invoke_skill'],
      expectedCalls: [{ tool: 'invoke_skill', skillId: 'blocking_chain_analysis' }],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'invoke_skill',
      input: { skillId: 'blocking_chain_analysis', params: '{}' },
      resultText: '{"success":true,"planPhaseId":"p4"}',
      timestamp: 40,
    });

    expect(record?.matchedPhaseId).toBe('p4');
    expect(findCompletedPhaseEvidenceGaps(plan)).toHaveLength(1);
  });

  it('matches compare_skill expectedCalls by skillId for raw trace pair comparison', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '启动对比',
        goal: '对比左右两个 Trace 的启动指标',
        expectedTools: ['compare_skill', 'invoke_skill'],
        expectedCalls: [{ tool: 'compare_skill', skillId: 'startup_analysis' }],
        status: 'completed',
        completedAt: 100,
        summary: '已执行启动对比，准备汇总左右 Trace 的差异。',
      }],
      successCriteria: '解释左右 Trace 启动速度差异',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'compare_skill',
      input: {
        skillId: 'startup_analysis',
        params: {
          currentTraceId: 'left-trace',
          referenceTraceId: 'right-trace',
        },
      },
      timestamp: 10,
    });

    expect(record).toMatchObject({
      toolName: 'compare_skill',
      skillId: 'startup_analysis',
      matchedPhaseId: 'p1',
    });
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([]);
  });

  it('records failed evidence calls for audit without letting them satisfy expectedCalls', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '启动对比',
        goal: '对比左右两个 Trace 的启动指标',
        expectedTools: ['compare_skill'],
        expectedCalls: [{ tool: 'compare_skill', skillId: 'startup_analysis' }],
        status: 'completed',
        completedAt: 100,
        summary: '已尝试执行启动对比，但参考 Trace 缺少必要参数。',
      }],
      successCriteria: '解释左右 Trace 启动速度差异',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'compare_skill',
      input: { skillId: 'startup_analysis' },
      resultText: JSON.stringify({
        success: false,
        failedSides: ['reference'],
      }),
      timestamp: 10,
    });

    expect(record).toMatchObject({
      toolName: 'compare_skill',
      skillId: 'startup_analysis',
      success: false,
    });
    expect(record?.matchedPhaseId).toBeUndefined();
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([
      expect.objectContaining({
        phase: plan.phases[0],
        matchedCalls: [],
        missingExpectedCalls: [{ tool: 'compare_skill', skillId: 'startup_analysis' }],
      }),
    ]);
  });

  it('records whether a source lookup actually returned a CodeRef', () => {
    const plan = createPlan();
    const withCodeRef = recordPlanToolCall(plan, {
      toolName: 'lookup_app_source',
      resultText: JSON.stringify({content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          result: {
            hits: [{
              chunkId: 'chunk-1',
              metadata: {
                filePath: 'app/src/main/java/demo/StartupHooks.kt',
                lineRange: {start: 10, end: 20},
              },
            }],
          },
        }),
      }]}),
    });
    const withoutCodeRef = recordPlanToolCall(plan, {
      toolName: 'lookup_app_source',
      resultText: JSON.stringify({success: true, result: {hits: []}}),
    });
    const detectedBeforePrivacyProjection = recordPlanToolCall(plan, {
      toolName: 'lookup_app_source',
      resultText: JSON.stringify({success: true, chunkRefs: [{chunkId: 'chunk-1'}]}),
      returnedCodeReferences: true,
    });
    const withRawPublicCodeRef = recordPlanToolCall(plan, {
      toolName: 'lookup_aosp_source',
      resultText: JSON.stringify({
        success: true,
        results: [{chunk: {
          chunkId: 'aosp-chunk-1',
          filePath: 'frameworks/base/core/java/android/app/ActivityThread.java',
        }}],
      }),
    });

    expect(withCodeRef).toMatchObject({
      success: true,
      returnedCodeReferences: true,
    });
    expect(withRawPublicCodeRef).toMatchObject({returnedCodeReferences: true});
    expect(detectedBeforePrivacyProjection).toMatchObject({returnedCodeReferences: true});
    expect(withoutCodeRef).toMatchObject({success: true});
    expect(withoutCodeRef).not.toHaveProperty('returnedCodeReferences');
  });

  it('keeps locatable source metadata ephemeral while persisting only the audit boolean', () => {
    const plan = createPlan();
    const reference = {
      chunkId: 'chunk-private',
      filePath: 'app/src/main/java/demo/StartupHooks.kt',
      lineRange: {start: 10, end: 20},
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'lookup_app_source',
      resultText: JSON.stringify({success: true, chunkRefs: [{chunkId: reference.chunkId}]}),
      returnedCodeReferenceHints: [reference],
    });

    expect(record).toMatchObject({success: true, returnedCodeReferences: true});
    expect(JSON.stringify(record)).not.toContain(reference.filePath);
    expect(JSON.stringify(plan)).not.toContain(reference.filePath);
    expect(getSourceLookupCodeReferences(plan)).toEqual([reference]);
  });

  it('records on-demand source references as ephemeral CodeRef evidence', () => {
    const plan = createPlan();
    const reference = {
      referenceId: 'source-a1b2c3',
      filePath: 'app/src/main/java/demo/StartupHooks.kt',
      lineRange: {start: 42, end: 48},
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'read_codebase_file',
      resultText: '{"success":true}',
      returnedCodeReferenceHints: [reference],
    });

    expect(record).toMatchObject({success: true, returnedCodeReferences: true});
    expect(JSON.stringify(plan)).not.toContain(reference.filePath);
    expect(getSourceLookupCodeReferences(plan)).toEqual([reference]);
  });

  it('moves ephemeral source metadata onto a plan when a pre-plan lookup is replayed', () => {
    const tracker: {current: AnalysisPlanV3 | null; prePlanToolCallLog?: AnalysisPlanV3['toolCallLog']} = {
      current: null,
    };
    const reference = {
      chunkId: 'chunk-pre-plan',
      filePath: 'app/src/main/java/demo/StartupHooks.kt',
      lineRange: {start: 30, end: 40},
    };
    recordPlanOrPrePlanToolCall(tracker, {
      toolName: 'lookup_app_source',
      resultText: '{"success":true}',
      returnedCodeReferenceHints: [reference],
    });

    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p-source',
        name: '源码定位',
        goal: '定位启动源码',
        expectedTools: ['lookup_app_source'],
        expectedCalls: [{tool: 'lookup_app_source'}],
        status: 'completed',
        summary: '源码定位完成。',
      }],
      successCriteria: '解释启动瓶颈',
      submittedAt: 1,
      toolCallLog: [],
    };
    tracker.current = plan;

    expect(replayPrePlanToolCalls(tracker)).toBe(1);
    expect(getSourceLookupCodeReferences(plan)).toEqual([reference]);
    expect(JSON.stringify(plan)).not.toContain(reference.filePath);
  });

  it('replays pre-plan comparison context calls into the accepted raw trace pair plan', () => {
    const tracker: { current: AnalysisPlanV3 | null; prePlanToolCallLog?: AnalysisPlanV3['toolCallLog'] } = {
      current: null,
    };

    recordPlanOrPrePlanToolCall(tracker, {
      toolName: 'get_comparison_context',
      input: {},
      resultText: '{"success":true}',
      timestamp: 10,
    });

    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '窗口映射确认',
        goal: '读取左右双 Trace 窗口映射和包名',
        expectedTools: ['get_comparison_context'],
        expectedCalls: [{ tool: 'get_comparison_context' }],
        status: 'completed',
        completedAt: 100,
        summary: '已确认左侧和右侧 Trace 的窗口映射。补充说明确保摘要足够长。',
      }],
      successCriteria: '确认双 Trace 窗口映射',
      submittedAt: 20,
      toolCallLog: [],
    };
    tracker.current = plan;

    expect(replayPrePlanToolCalls(tracker)).toBe(1);
    expect(plan.toolCallLog).toEqual([
      expect.objectContaining({
        toolName: 'get_comparison_context',
        matchedPhaseId: 'p1',
      }),
    ]);
    expect(tracker.prePlanToolCallLog).toEqual([]);
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([]);
  });

  it('replays pre-plan compare_skill calls with the requested skillId', () => {
    const tracker: { current: AnalysisPlanV3 | null; prePlanToolCallLog?: AnalysisPlanV3['toolCallLog'] } = {
      current: null,
    };

    recordPlanOrPrePlanToolCall(tracker, {
      toolName: 'compare_skill',
      input: {
        skillId: 'startup_analysis',
        currentParams: { process_name: 'left.app' },
        referenceParams: { process_name: 'right.app' },
      },
      timestamp: 10,
    });

    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p2',
        name: '启动概览对比',
        goal: '对比左右两个 Trace 的启动指标',
        expectedTools: ['compare_skill'],
        expectedCalls: [{ tool: 'compare_skill', skillId: 'startup_analysis' }],
        status: 'completed',
        completedAt: 100,
        summary: '已完成启动概览对比，包含左右 Trace 的启动指标差异。',
      }],
      successCriteria: '解释左右 Trace 启动速度差异',
      submittedAt: 20,
      toolCallLog: [],
    };
    tracker.current = plan;

    expect(replayPrePlanToolCalls(tracker)).toBe(1);
    expect(plan.toolCallLog).toEqual([
      expect.objectContaining({
        toolName: 'compare_skill',
        skillId: 'startup_analysis',
        matchedPhaseId: 'p2',
      }),
    ]);
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([]);
  });

  it('does not let informational strategy detail lookups satisfy evidence gaps', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '策略细节读取',
        goal: '读取 on-demand detail，但不能把它当 trace 证据',
        expectedTools: ['lookup_strategy_detail'],
        expectedCalls: [{ tool: 'lookup_strategy_detail' }],
        status: 'completed',
        completedAt: 100,
        summary: '只读取了策略说明，没有采集 trace 证据。',
      }],
      successCriteria: 'Detail lookup must remain informational',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'lookup_strategy_detail',
      input: { detailRef: 'scrolling:architecture' },
      resultText: '{"success":true,"informational":true,"planPhaseId":"p1"}',
      timestamp: 10,
    });

    expect(record?.matchedPhaseId).toBeUndefined();
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([
      expect.objectContaining({
        phase: plan.phases[0],
        matchedCalls: [],
        missingExpectedCalls: [{ tool: 'lookup_strategy_detail' }],
      }),
    ]);
  });
});
