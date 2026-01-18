/**
 * Planner Policy
 *
 * Planner Agent 的 Context 隔离策略
 * Planner 主要负责理解意图和创建计划，不需要看详细的分析结果
 */

import {
  ContextPolicy,
  FieldVisibility,
  IntentSummary,
  PlanSummary,
  StageResultSummary,
} from '../contextTypes';
import { StageResult, Finding, Intent, AnalysisPlan } from '../../types';

/**
 * Planner 策略
 *
 * 可见内容：
 * - sessionId, traceId（必需）
 * - intent（完整，用于理解用户意图）
 * - previousResults（摘要，只需知道执行情况）
 *
 * 不可见内容：
 * - plan（Planner 自己创建，不需要看）
 * - traceProcessor/traceProcessorService（不直接查询数据）
 */
export const plannerPolicy: ContextPolicy = {
  name: 'planner',
  agentTypes: ['planner'],

  visibleFields: [
    { field: 'sessionId', level: 'full' },
    { field: 'traceId', level: 'full' },
    { field: 'intent', level: 'full' },
    { field: 'previousResults', level: 'summary' },
    { field: 'plan', level: 'none' },
    { field: 'traceProcessor', level: 'none' },
    { field: 'traceProcessorService', level: 'none' },
  ],

  filterPreviousResults(results: StageResult[]): StageResult[] {
    // Planner 只需要看摘要信息
    return results.map(result => ({
      ...result,
      // 保留基本信息，简化 findings
      findings: result.findings.slice(0, 3), // 最多保留 3 个
      data: undefined, // 移除详细数据
    }));
  },

  filterFindings(findings: Finding[]): Finding[] {
    // Planner 只看高优先级发现
    return findings
      .filter(f => f.severity === 'critical' || f.severity === 'warning')
      .slice(0, 5); // 最多 5 个
  },

  // Planner 不需要转换 intent，它需要完整信息来理解意图
  transformIntent: undefined,

  // Planner 创建 plan，不需要看已有的 plan
  transformPlan: undefined,
};

/**
 * 创建摘要版本的 StageResult（供内部使用）
 */
export function summarizeStageResult(result: StageResult): StageResultSummary {
  const findings = result.findings || [];
  return {
    stageId: result.stageId,
    success: result.success,
    findingCount: findings.length,
    criticalCount: findings.filter(f => f.severity === 'critical').length,
    warningCount: findings.filter(f => f.severity === 'warning').length,
    isSummary: true,
  };
}

export default plannerPolicy;
