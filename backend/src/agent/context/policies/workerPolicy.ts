/**
 * Worker Policy
 *
 * Worker Agent 的 Context 隔离策略
 * Worker 负责执行具体分析任务，需要访问数据服务但不需要完整历史
 */

import {
  ContextPolicy,
  FieldVisibility,
  IntentSummary,
  PlanSummary,
} from '../contextTypes';
import { StageResult, Finding, Intent, AnalysisPlan } from '../../types';

/**
 * Worker 策略
 *
 * 可见内容：
 * - sessionId, traceId（必需）
 * - intent（摘要，只需要知道分析目标）
 * - plan（摘要，只需要知道当前任务）
 * - traceProcessor/traceProcessorService（需要查询数据）
 * - previousResults（摘要，只需要知道依赖的结果）
 *
 * 优化目标：
 * - 减少传递给 Worker 的 token 数量
 * - 只传递与当前任务相关的信息
 */
export const workerPolicy: ContextPolicy = {
  name: 'worker',
  agentTypes: ['worker', 'analysisWorker', 'scrollingExpert'],

  visibleFields: [
    { field: 'sessionId', level: 'full' },
    { field: 'traceId', level: 'full' },
    { field: 'intent', level: 'summary' },
    { field: 'plan', level: 'summary' },
    { field: 'previousResults', level: 'summary' },
    { field: 'traceProcessor', level: 'full' },
    { field: 'traceProcessorService', level: 'full' },
  ],

  filterPreviousResults(results: StageResult[]): StageResult[] {
    // Worker 只需要看最近的相关结果
    // 保留最近 2 个阶段的结果
    const recentResults = results.slice(-2);

    return recentResults.map(result => ({
      stageId: result.stageId,
      success: result.success,
      // 只保留高优先级发现
      findings: result.findings
        .filter(f => f.severity === 'critical' || f.severity === 'warning')
        .slice(0, 3),
      startTime: result.startTime,
      endTime: result.endTime,
      retryCount: result.retryCount,
      // 移除详细数据
      data: undefined,
      error: result.error,
    }));
  },

  filterFindings(findings: Finding[]): Finding[] {
    // Worker 只看关键发现作为参考
    return findings
      .filter(f => f.severity === 'critical')
      .slice(0, 3);
  },

  transformIntent(intent: Intent): IntentSummary {
    return {
      primaryGoal: intent.primaryGoal,
      analysisType: intent.expectedOutputType,
      isSummary: true,
    };
  },

  transformPlan(plan: AnalysisPlan): PlanSummary {
    return {
      totalSteps: plan.tasks.length,
      stepNames: plan.tasks.map((t: { id: string }) => t.id),
      isSummary: true,
    };
  },
};

/**
 * 创建针对特定阶段的 Worker 策略
 * 可以进一步限制可见的依赖
 */
export function createWorkerPolicyForStage(
  stageId: string,
  dependencies: string[]
): ContextPolicy {
  return {
    ...workerPolicy,
    name: `worker:${stageId}`,

    filterPreviousResults(results: StageResult[]): StageResult[] {
      // 只保留声明的依赖阶段的结果
      const dependentResults = results.filter(r => dependencies.includes(r.stageId));

      return dependentResults.map(result => ({
        stageId: result.stageId,
        success: result.success,
        findings: result.findings.slice(0, 5),
        startTime: result.startTime,
        endTime: result.endTime,
        retryCount: result.retryCount,
        data: undefined,
        error: result.error,
      }));
    },
  };
}

export default workerPolicy;
