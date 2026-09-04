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
import {getAnalysisPlanCompletionStatus} from '../planCompletionStatus';
import {verifyPlanAdherence} from '../../agentRuntime/engines/claude/claudeVerifier';
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
  it('records source-use decisions as control calls without satisfying source or trace evidence', () => {
    const plan: AnalysisPlanV3 = {
      phases: [
        {
          id: 'source',
          name: 'Source decision',
          goal: 'Investigate the trace-supported source candidate',
          expectedTools: ['search_codebase'],
          expectedCalls: [{tool: 'search_codebase'}],
          status: 'completed',
          completedAt: 10,
          summary: 'Recorded a bounded source-use control decision for this run.',
        },
        {
          id: 'trace',
          name: 'Trace evidence',
          goal: 'Collect trace evidence with the required Skill',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{tool: 'invoke_skill', skillId: 'scrolling_analysis'}],
          status: 'completed',
          completedAt: 20,
          summary: 'Attempted to close the trace phase without running its Skill.',
        },
      ],
      successCriteria: 'Control calls remain separate from evidence calls',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'record_source_use_decision',
      input: {
        status: 'not_needed',
        reason: 'Trace evidence already resolves the question without source lookup.',
      },
      resultText: JSON.stringify({success: true, status: 'not_needed'}),
      returnedCodeReferences: true,
      timestamp: 30,
    });

    expect(record).toMatchObject({
      toolName: 'record_source_use_decision',
      planCapability: 'control',
      matchedPhaseId: 'source',
      success: true,
    });
    expect(record).not.toHaveProperty('returnedCodeReferences');
    expect(findCompletedPhaseEvidenceGaps(plan).map(gap => gap.phase.id))
      .toEqual(['source', 'trace']);
  });

  it('retains pre-plan source-use controls without replaying them as evidence', () => {
    const tracker: {current: AnalysisPlanV3 | null; prePlanToolCallLog?: AnalysisPlanV3['toolCallLog']} = {
      current: null,
    };
    const recorded = recordPlanOrPrePlanToolCall(tracker, {
      toolName: 'record_source_use_decision',
      input: {
        status: 'unverified',
        reason: 'No stable source anchor can be verified within the bounded run.',
      },
      resultText: JSON.stringify({success: true, status: 'unverified'}),
    });

    expect(recorded).toMatchObject({planCapability: 'control'});
    expect(tracker.prePlanToolCallLog).toHaveLength(1);

    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'trace',
        name: 'Trace evidence',
        goal: 'Collect trace-only evidence',
        expectedTools: ['execute_sql'],
        status: 'completed',
        completedAt: 10,
        summary: 'Closed only after collecting the required trace SQL evidence.',
      }],
      successCriteria: 'Trace evidence remains mandatory',
      submittedAt: 1,
      toolCallLog: [{
        toolName: 'execute_sql',
        timestamp: 5,
        success: true,
        matchedPhaseId: 'trace',
      }],
    };
    tracker.current = plan;

    expect(replayPrePlanToolCalls(tracker)).toBe(1);
    expect(plan.toolCallLog).toContainEqual(expect.objectContaining({
      toolName: 'record_source_use_decision',
      planCapability: 'control',
    }));
    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([]);
  });

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

  it('does not let a returned phase id bind the wrong tool to an expectedTools-only phase', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '对齐确认',
        goal: '读取双 Trace 对比上下文',
        expectedTools: ['get_comparison_context'],
        expectedCalls: [],
        status: 'completed',
        completedAt: 100,
        summary: '已完成双 Trace 对齐确认并记录左右窗口映射。',
      }],
      successCriteria: '确认双 Trace 可比',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'fetch_artifact',
      input: {artifactId: 'art-1'},
      resultText: '{"success":true,"planPhaseId":"p1"}',
      timestamp: 10,
    });

    expect(record?.matchedPhaseId).toBeUndefined();
    expect(verifyPlanAdherence(plan)).toContainEqual(expect.objectContaining({
      type: 'plan_deviation',
      severity: 'error',
    }));
  });

  it('does not let a failed returned phase call satisfy an expectedTools-only phase', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '对齐确认',
        goal: '读取双 Trace 对比上下文',
        expectedTools: ['get_comparison_context'],
        expectedCalls: [],
        status: 'completed',
        completedAt: 100,
        summary: '尝试读取双 Trace 对齐信息，但工具返回失败。',
      }],
      successCriteria: '确认双 Trace 可比',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'get_comparison_context',
      input: {},
      resultText: '{"success":false,"planPhaseId":"p1"}',
      timestamp: 10,
    });

    expect(record?.matchedPhaseId).toBeUndefined();
    expect(verifyPlanAdherence(plan)).toContainEqual(expect.objectContaining({
      type: 'plan_deviation',
      severity: 'error',
    }));
  });

  it('prefers an authoritative returned phase over an earlier generic expectedTools match', () => {
    const plan: AnalysisPlanV3 = {
      phases: [
        {
          id: 'p1',
          name: '第一批证据',
          goal: '采集第一批 artifact',
          expectedTools: ['fetch_artifact'],
          expectedCalls: [],
          status: 'pending',
        },
        {
          id: 'p2',
          name: '第二批证据',
          goal: '采集第二批 artifact',
          expectedTools: ['fetch_artifact'],
          expectedCalls: [],
          status: 'pending',
        },
      ],
      successCriteria: '采集两批证据',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'fetch_artifact',
      input: {artifactId: 'art-p2'},
      resultText: '{"success":true,"planPhaseId":"p2"}',
      timestamp: 10,
    });

    expect(record?.matchedPhaseId).toBe('p2');
  });

  it('does not arbitrarily bind duplicate structured gaps at the same priority', () => {
    const plan: AnalysisPlanV3 = {
      phases: [
        {
          id: 'p1',
          name: '第一组启动详情',
          goal: '采集第一组启动详情',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{tool: 'invoke_skill', skillId: 'startup_detail'}],
          status: 'pending',
        },
        {
          id: 'p2',
          name: '第二组启动详情',
          goal: '采集第二组启动详情',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{tool: 'invoke_skill', skillId: 'startup_detail'}],
          status: 'pending',
        },
      ],
      successCriteria: '分别验证两组启动详情',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'invoke_skill',
      input: {skillId: 'startup_detail'},
      resultText: '{"success":true}',
      timestamp: 10,
    });

    expect(record?.matchedPhaseId).toBeUndefined();
  });

  it('still records a unique pending expectedTools-only phase', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '对齐确认',
        goal: '读取双 Trace 对比上下文',
        expectedTools: ['get_comparison_context'],
        expectedCalls: [],
        status: 'pending',
      }],
      successCriteria: '确认双 Trace 可比',
      submittedAt: 1,
      toolCallLog: [],
    };

    const record = recordPlanToolCall(plan, {
      toolName: 'get_comparison_context',
      input: {},
      resultText: '{"success":true}',
      timestamp: 10,
    });

    expect(record?.matchedPhaseId).toBe('p1');
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

  it('replays pre-plan comparison context calls for expectedTools-only phases', () => {
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
        name: '对齐确认与概览',
        goal: '读取左右双 Trace 窗口映射和包名',
        expectedTools: ['get_comparison_context'],
        expectedCalls: [],
        status: 'completed',
        completedAt: 100,
        summary: '已确认左右 Trace 的窗口、进程和时间范围均可直接对齐比较。',
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
    expect(verifyPlanAdherence(plan).filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it.each([
    {
      name: 'a wrong tool',
      staleRecord: {
        toolName: 'fetch_artifact',
        success: true,
        timestamp: 5,
        matchedPhaseId: 'p1',
      },
    },
    {
      name: 'a failed expected tool',
      staleRecord: {
        toolName: 'get_comparison_context',
        success: false,
        timestamp: 5,
        matchedPhaseId: 'p1',
      },
    },
  ])('replays valid pre-plan evidence after $name was historically attributed to the phase', ({staleRecord}) => {
    const tracker: {
      current: AnalysisPlanV3 | null;
      prePlanToolCallLog?: AnalysisPlanV3['toolCallLog'];
    } = {current: null};

    recordPlanOrPrePlanToolCall(tracker, {
      toolName: 'get_comparison_context',
      input: {},
      resultText: '{"success":true}',
      timestamp: 10,
    });

    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '对齐确认与概览',
        goal: '读取左右双 Trace 窗口映射和包名',
        expectedTools: ['get_comparison_context'],
        expectedCalls: [],
        status: 'pending',
      }],
      successCriteria: '确认双 Trace 窗口映射',
      submittedAt: 20,
      toolCallLog: [staleRecord],
    };
    tracker.current = plan;

    expect(replayPrePlanToolCalls(tracker)).toBe(1);
    expect(plan.toolCallLog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: 'get_comparison_context',
        matchedPhaseId: 'p1',
        timestamp: 10,
      }),
    ]));
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

  it.each([
    {
      name: 'no call',
      toolCallLog: [],
    },
    {
      name: 'a failed expected call',
      toolCallLog: [{
        toolName: 'execute_sql',
        timestamp: 10,
        success: false,
        matchedPhaseId: 'p1',
      }],
    },
    {
      name: 'a wrong call attributed to the phase',
      toolCallLog: [{
        toolName: 'get_comparison_context',
        timestamp: 10,
        success: true,
        matchedPhaseId: 'p1',
      }],
    },
    {
      name: 'an unmatched expected call',
      toolCallLog: [{
        toolName: 'execute_sql',
        timestamp: 10,
        success: true,
      }],
    },
  ])('keeps an expectedTools-only completed phase open after $name', ({toolCallLog}) => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '补充验证与结论',
        goal: '交叉验证关键发现，补充缺失证据，输出综合分析结论',
        expectedTools: ['execute_sql', 'fetch_artifact', 'lookup_knowledge'],
        expectedCalls: [],
        status: 'completed',
        completedAt: 100,
        summary: '综合结论已经整理完成，并准备输出最终报告和证据索引。',
      }],
      successCriteria: '补充验证后输出综合结论',
      submittedAt: 1,
      toolCallLog,
    };

    const gaps = findCompletedPhaseEvidenceGaps(plan);
    expect(gaps).toEqual([
      expect.objectContaining({
        phase: plan.phases[0],
        matchedCalls: [],
        missingExpectedCalls: [],
        missingGenericToolEvidence: true,
      }),
    ]);
    expect(getAnalysisPlanCompletionStatus(plan, {minSummaryChars: 10})).toMatchObject({
      complete: false,
      pendingPhases: [plan.phases[0]],
    });
  });

  it('accepts one valid matching generic tool call for an expectedTools-only phase', () => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'p1',
        name: '补充验证与结论',
        goal: '交叉验证关键发现，补充缺失证据，输出综合分析结论',
        expectedTools: ['execute_sql', 'fetch_artifact', 'lookup_knowledge'],
        expectedCalls: [],
        status: 'completed',
        completedAt: 100,
        summary: '已通过 SQL 交叉验证关键发现，并输出综合分析结论和证据索引。',
      }],
      successCriteria: '补充验证后输出综合结论',
      submittedAt: 1,
      toolCallLog: [{
        toolName: 'execute_sql',
        timestamp: 10,
        success: true,
        matchedPhaseId: 'p1',
      }],
    };

    expect(findCompletedPhaseEvidenceGaps(plan)).toEqual([]);
    expect(getAnalysisPlanCompletionStatus(plan, {minSummaryChars: 10}).complete).toBe(true);
  });

  it.each(['pending', 'attempted'])('keeps final completion blocked while source use is %s', status => {
    const plan: AnalysisPlanV3 = {
      phases: [{
        id: 'source',
        name: 'Source investigation',
        goal: 'Look up the trace-supported source anchor',
        expectedTools: ['search_codebase'],
        expectedCalls: [{tool: 'search_codebase'}],
        status: 'completed',
        completedAt: 100,
        summary: 'The source phase was closed before its source-use decision resolved.',
      }],
      successCriteria: 'Resolve source use before final completion',
      submittedAt: 1,
      toolCallLog: [{
        toolName: 'search_codebase',
        timestamp: 10,
        success: true,
        matchedPhaseId: 'source',
      }],
    };
    plan.sourceUseDecisionStatus = status as AnalysisPlanV3['sourceUseDecisionStatus'];

    expect(getAnalysisPlanCompletionStatus(plan, {minSummaryChars: 10})).toMatchObject({
      complete: false,
      sourceUseDecisionPending: true,
      pendingPhases: [plan.phases[0]],
    });
  });

  it('returns the first existing plan phase when a pending source decision has no source phase', () => {
    const plan: AnalysisPlanV3 = {
      phases: [
        {
          id: 'trace-overview',
          name: 'Trace overview',
          goal: 'Collect the trace overview evidence',
          expectedTools: ['execute_sql'],
          status: 'completed',
          completedAt: 100,
          summary: 'Collected the trace overview evidence and closed the phase.',
        },
        {
          id: 'conclusion',
          name: 'Conclusion',
          goal: 'Write the final conclusion',
          expectedTools: [],
          status: 'completed',
          completedAt: 200,
          summary: 'Prepared the final conclusion after the trace overview phase.',
        },
      ],
      successCriteria: 'Never return an empty pending loop',
      submittedAt: 1,
      sourceUseDecisionStatus: 'pending',
      toolCallLog: [{
        toolName: 'execute_sql',
        timestamp: 10,
        success: true,
        matchedPhaseId: 'trace-overview',
      }],
    };

    expect(getAnalysisPlanCompletionStatus(plan, {minSummaryChars: 10})).toMatchObject({
      complete: false,
      sourceUseDecisionPending: true,
      pendingPhases: [plan.phases[0]],
    });
  });

  it('returns every existing source candidate in plan order for a pending source decision', () => {
    const plan: AnalysisPlanV3 = {
      phases: [
        {
          id: 'source-search',
          name: 'Source search',
          goal: 'Search the selected source tree',
          expectedTools: ['search_codebase'],
          expectedCalls: [{tool: 'search_codebase'}],
          status: 'completed',
          completedAt: 100,
          summary: 'Completed the bounded search against the selected source tree.',
        },
        {
          id: 'trace-evidence',
          name: 'Trace evidence',
          goal: 'Collect the trace evidence',
          expectedTools: ['execute_sql'],
          status: 'completed',
          completedAt: 200,
          summary: 'Collected the trace evidence independently from source control.',
        },
        {
          id: 'source-read',
          name: 'Source read',
          goal: 'Read the selected source file',
          expectedTools: ['read_codebase_file'],
          expectedCalls: [{tool: 'read_codebase_file'}],
          status: 'completed',
          completedAt: 300,
          summary: 'Completed the bounded read against the selected source file.',
        },
      ],
      successCriteria: 'Preserve every actionable source phase in plan order',
      submittedAt: 1,
      sourceUseDecisionStatus: 'attempted',
      toolCallLog: [
        {
          toolName: 'search_codebase',
          timestamp: 10,
          success: true,
          matchedPhaseId: 'source-search',
        },
        {
          toolName: 'execute_sql',
          timestamp: 20,
          success: true,
          matchedPhaseId: 'trace-evidence',
        },
        {
          toolName: 'read_codebase_file',
          timestamp: 30,
          success: true,
          matchedPhaseId: 'source-read',
        },
      ],
    };

    expect(getAnalysisPlanCompletionStatus(plan, {minSummaryChars: 10})).toMatchObject({
      complete: false,
      sourceUseDecisionPending: true,
      pendingPhases: [plan.phases[0], plan.phases[2]],
    });
  });

  it.each(['located', 'corroborated', 'not_needed', 'search_incomplete', 'unverified'])(
    'allows final completion after source use resolves as %s',
    status => {
      const plan: AnalysisPlanV3 = {
        phases: [{
          id: 'source',
          name: 'Source investigation',
          goal: 'Look up the trace-supported source anchor',
          expectedTools: ['search_codebase'],
          expectedCalls: [{tool: 'search_codebase'}],
          status: 'completed',
          completedAt: 100,
          summary: 'The source-use decision is resolved with a bounded run outcome.',
        }],
        successCriteria: 'Resolve source use before final completion',
        submittedAt: 1,
        toolCallLog: [{
          toolName: 'search_codebase',
          timestamp: 10,
          success: true,
          matchedPhaseId: 'source',
        }],
      };
      plan.sourceUseDecisionStatus = status as AnalysisPlanV3['sourceUseDecisionStatus'];

      expect(getAnalysisPlanCompletionStatus(plan, {minSummaryChars: 10})).toMatchObject({
        complete: true,
        pendingPhases: [],
      });
    },
  );

  it('lets a pure conclusion phase reuse valid evidence from a non-conclusion phase only', () => {
    const createConclusionPlan = (toolCallLog: AnalysisPlanV3['toolCallLog']): AnalysisPlanV3 => ({
      phases: [
        {
          id: 'p1',
          name: '证据采集',
          goal: '查询关键帧数据',
          expectedTools: ['execute_sql'],
          status: 'completed',
          completedAt: 50,
          summary: '已查询关键帧耗时并保存可复核证据。',
        },
        {
          id: 'p2',
          name: '综合结论',
          goal: '输出最终报告',
          expectedTools: ['fetch_artifact'],
          status: 'completed',
          completedAt: 100,
          summary: '已依据前序证据输出最终报告和证据索引。',
        },
      ],
      successCriteria: '输出有证据支持的最终报告',
      submittedAt: 1,
      toolCallLog,
    });

    const withoutPriorEvidence = createConclusionPlan([]);
    expect(findCompletedPhaseEvidenceGaps(withoutPriorEvidence).map(gap => gap.phase.id))
      .toEqual(['p1', 'p2']);

    const withPriorEvidence = createConclusionPlan([{
      toolName: 'execute_sql',
      timestamp: 10,
      success: true,
      matchedPhaseId: 'p1',
    }]);
    expect(findCompletedPhaseEvidenceGaps(withPriorEvidence)).toEqual([]);
  });
});

describe('result facts survive transport truncation', () => {
  const {readToolResultFacts, extractPlanPhaseIdFromToolResult, extractToolCallSuccessFromResult} =
    require('../planToolCallRecorder') as typeof import('../planToolCallRecorder');
  const {summarizeExternalToolResult} =
    require('../../agentRuntime/runtimeLimits') as typeof import('../../agentRuntime/runtimeLimits');

  /**
   * `planPhaseId` and `success` are appended after the result body, so a byte
   * cap removes them first. Re-deriving them from the transported string
   * silently degraded plan phase attribution to semantic inference and left
   * tool success unknown for every large result.
   */
  function largeSkillResult() {
    return [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        skillId: 'scrolling_analysis',
        displayResults: Array.from({length: 13}, (_, i) => ({
          stepId: `s${i}`,
          data: {rows: Array.from({length: 20}, (_, r) => [r, 'x'.repeat(40)])},
        })),
        planPhaseId: 'p1',
      }),
    }];
  }

  it('loses the facts when they are read back from the truncated text', () => {
    const truncated = summarizeExternalToolResult(largeSkillResult());
    expect(truncated.length).toBeLessThan(JSON.stringify(largeSkillResult()).length);
    expect(extractPlanPhaseIdFromToolResult(truncated)).toBeUndefined();
    expect(extractToolCallSuccessFromResult(truncated)).toBeUndefined();
  });

  it('keeps the facts when they are read from the intact result', () => {
    expect(readToolResultFacts(largeSkillResult())).toEqual({planPhaseId: 'p1', success: true});
  });

  it('reads the facts through every envelope shape the runtimes use', () => {
    const raw = largeSkillResult();
    for (const shape of [raw, JSON.stringify(raw), {content: raw}]) {
      expect(readToolResultFacts(shape)).toEqual({planPhaseId: 'p1', success: true});
    }
  });

  it('reports nothing rather than guessing when the result is unparseable', () => {
    expect(readToolResultFacts('ERROR: boom')).toEqual({});
    expect(readToolResultFacts(undefined)).toEqual({});
  });

  it('records a failed tool call as failed', () => {
    expect(readToolResultFacts([{type: 'text', text: '{"success":false,"error":"x"}'}]))
      .toEqual({success: false});
  });
});
