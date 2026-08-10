// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { PlanPhase } from './types';

type PlanPhaseIdentity = Pick<PlanPhase, 'id' | 'name' | 'goal'>;

const CONCLUSION_LIKE_PHASE_PATTERN =
  /(结构化结论|结构化报告|综合结论|最终结论|结论输出|输出结论|输出最终报告|最终报告|综合报告|优化建议|structured report|final conclusion|\bconclusion\b|final report|analysis report|final answer|write final answer|overall summary|final summary|recommendations?|optimization recommendations?|synthesis)/i;

const COMPARISON_SYNTHESIS_PHASE_PATTERN =
  /((差异|对比|比较|delta|comparison|compare).*(深钻|深入|根因|定位|归因|综合|复盘|synthesis|root cause|deep dive)|(深钻|深入|根因|定位|归因).*(差异|对比|比较|delta|comparison|compare))/i;

const CHINESE_REPORT_DELIVERY_PHASE_PATTERN =
  /(?:报告输出|输出[^，,；;。！？.!?\n]{0,12}分析报告)(?=$|[，,；;、及和与并])/;
const CHINESE_REPORT_FOLLOWUP_EXECUTION_PATTERN =
  /^[\s，,；;、及和与并]*[^，,；;。！？.!?\n]{0,24}(?:(?:补采|补证|取证)|(?:采集|查询|调用|运行|执行)[^，,；;。！？.!?\n]{0,8}(?:证据|数据|Trace|SQL|源码|工具|Skill)|(?:证据|数据|Trace|SQL|源码|工具|Skill)[^，,；;。！？.!?\n]{0,4}(?:采集|查询|调用|运行|执行)(?!结果|关系|限制|摘要|统计|明细|情况|口径|链路))/i;

function classifyChineseReportDeliveryPhaseField(
  value: string,
): 'none' | 'delivery' | 'delivery_with_evidence_work' {
  const match = CHINESE_REPORT_DELIVERY_PHASE_PATTERN.exec(value);
  if (!match) return 'none';
  const suffix = value.slice((match.index ?? 0) + match[0].length);
  return CHINESE_REPORT_FOLLOWUP_EXECUTION_PATTERN.test(suffix)
    ? 'delivery_with_evidence_work'
    : 'delivery';
}

export function isConclusionLikePlanPhase(phase: PlanPhaseIdentity): boolean {
  const reportDeliveryFields = [phase.id, phase.name, phase.goal]
    .map(classifyChineseReportDeliveryPhaseField);
  if (reportDeliveryFields.includes('delivery_with_evidence_work')) return false;
  if (CONCLUSION_LIKE_PHASE_PATTERN.test(`${phase.id} ${phase.name} ${phase.goal}`)) {
    return true;
  }
  return reportDeliveryFields.includes('delivery');
}

export function isComparisonSynthesisPlanPhase(phase: PlanPhaseIdentity): boolean {
  return COMPARISON_SYNTHESIS_PHASE_PATTERN.test(`${phase.id} ${phase.name} ${phase.goal}`);
}
