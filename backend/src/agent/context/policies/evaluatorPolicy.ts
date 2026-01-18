/**
 * Evaluator Policy
 *
 * Evaluator Agent 的 Context 隔离策略
 * Evaluator 负责评估分析结果的质量，需要看意图、计划和所有结果
 */

import {
  ContextPolicy,
  FieldVisibility,
  IntentSummary,
  PlanSummary,
} from '../contextTypes';
import { StageResult, Finding, Intent, AnalysisPlan } from '../../types';

/**
 * Evaluator 策略
 *
 * 可见内容：
 * - sessionId, traceId（必需）
 * - intent（完整，需要对比分析结果是否满足意图）
 * - plan（完整，需要检查是否按计划执行）
 * - previousResults（完整，需要评估所有结果）
 *
 * 不可见内容：
 * - traceProcessor/traceProcessorService（评估不需要查询原始数据）
 */
export const evaluatorPolicy: ContextPolicy = {
  name: 'evaluator',
  agentTypes: ['evaluator'],

  visibleFields: [
    { field: 'sessionId', level: 'full' },
    { field: 'traceId', level: 'full' },
    { field: 'intent', level: 'full' },
    { field: 'plan', level: 'full' },
    { field: 'previousResults', level: 'full' },
    { field: 'traceProcessor', level: 'none' },
    { field: 'traceProcessorService', level: 'none' },
  ],

  filterPreviousResults(results: StageResult[]): StageResult[] {
    // Evaluator 需要看所有结果，但可以简化 data 字段
    return results.map(result => ({
      ...result,
      // 保留 findings，但简化大型 data
      data: result.data ? summarizeData(result.data) : undefined,
    }));
  },

  filterFindings(findings: Finding[]): Finding[] {
    // Evaluator 需要看所有发现来做完整评估
    return findings;
  },

  // Evaluator 需要完整 intent
  transformIntent: undefined,

  // Evaluator 需要完整 plan
  transformPlan: undefined,
};

/**
 * 简化大型数据对象
 * 保留结构但移除大型数组的详细内容
 */
function summarizeData(data: any): any {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const result: any = {};

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      // 大型数组只保留前几项和计数
      if (value.length > 10) {
        result[key] = {
          _type: 'array',
          _count: value.length,
          _sample: value.slice(0, 3),
        };
      } else {
        result[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      // 递归简化嵌套对象
      result[key] = summarizeData(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export default evaluatorPolicy;
