/**
 * Token Estimator
 *
 * 估算上下文的 token 数量
 * 用于决定是否需要压缩以及压缩多少
 */

import {
  TokenEstimate,
  TokenEstimatorConfig,
  DEFAULT_TOKEN_ESTIMATOR_CONFIG,
  CompactionConfig,
} from './compactionTypes';
import { SubAgentContext } from '../types';

// =============================================================================
// Token Estimator
// =============================================================================

/**
 * Token 估算器
 * 快速估算 JSON 对象序列化后的 token 数量
 */
export class TokenEstimator {
  private config: TokenEstimatorConfig;

  constructor(config: Partial<TokenEstimatorConfig> = {}) {
    this.config = { ...DEFAULT_TOKEN_ESTIMATOR_CONFIG, ...config };
  }

  // ===========================================================================
  // Main Estimation Methods
  // ===========================================================================

  /**
   * 估算上下文的 token 数量
   */
  estimate(context: SubAgentContext): TokenEstimate {
    const breakdown = {
      sessionId: this.estimateString(context.sessionId || ''),
      traceId: this.estimateString(context.traceId || ''),
      intent: this.estimateObject(context.intent),
      plan: this.estimateObject(context.plan),
      previousResults: this.estimateArray(context.previousResults),
      findings: this.estimateFindingsFromResults(context.previousResults),
      other: this.estimateOtherFields(context),
    };

    const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);

    return {
      total: Math.ceil(total * this.config.jsonOverheadFactor),
      breakdown,
      exceedsThreshold: false,  // 由调用者根据 config 判断
      suggestedReduction: 0,
    };
  }

  /**
   * 估算并判断是否超过阈值
   */
  estimateWithThreshold(
    context: SubAgentContext,
    config: CompactionConfig
  ): TokenEstimate {
    const estimate = this.estimate(context);

    estimate.exceedsThreshold = estimate.total > config.compactionThreshold;
    estimate.suggestedReduction = estimate.exceedsThreshold
      ? estimate.total - config.compactionThreshold
      : 0;

    return estimate;
  }

  /**
   * 快速检查是否需要压缩（不计算详细分解）
   */
  needsCompaction(context: SubAgentContext, threshold: number): boolean {
    const quickEstimate = this.quickEstimate(context);
    return quickEstimate > threshold;
  }

  // ===========================================================================
  // Component Estimation Methods
  // ===========================================================================

  /**
   * 估算字符串的 token 数
   */
  estimateString(str: string | undefined | null): number {
    if (!str) return 0;
    return Math.ceil(str.length * this.config.charsPerToken);
  }

  /**
   * 估算对象的 token 数
   */
  estimateObject(obj: any): number {
    if (!obj) return 0;

    try {
      const json = JSON.stringify(obj);
      return this.estimateString(json);
    } catch {
      return 0;
    }
  }

  /**
   * 估算数组的 token 数
   */
  estimateArray(arr: any[] | undefined): number {
    if (!arr || arr.length === 0) return 0;

    return arr.reduce((total, item) => total + this.estimateObject(item), 0);
  }

  /**
   * 从结果中估算 findings 的 token 数
   */
  private estimateFindingsFromResults(results: any[] | undefined): number {
    if (!results) return 0;

    let total = 0;
    for (const result of results) {
      if (result.findings && Array.isArray(result.findings)) {
        total += this.estimateArray(result.findings);
      }
    }
    return total;
  }

  /**
   * 估算其他字段的 token 数
   */
  private estimateOtherFields(context: SubAgentContext): number {
    // 估算不在主要字段中的其他数据
    const knownFields = ['sessionId', 'traceId', 'intent', 'plan', 'previousResults'];
    let total = 0;

    for (const [key, value] of Object.entries(context)) {
      if (!knownFields.includes(key) && value !== undefined) {
        // 跳过函数和复杂对象（如 traceProcessor）
        if (typeof value === 'function') continue;
        if (key === 'traceProcessor' || key === 'traceProcessorService') continue;

        total += this.estimateObject(value);
      }
    }

    return total;
  }

  /**
   * 快速估算（只看主要字段）
   */
  private quickEstimate(context: SubAgentContext): number {
    let total = 0;

    // 只估算最可能很大的字段
    if (context.previousResults) {
      total += this.estimateArray(context.previousResults);
    }

    if (context.plan) {
      total += this.estimateObject(context.plan);
    }

    if (context.intent) {
      total += this.estimateObject(context.intent);
    }

    // 添加基础开销
    total += 200; // sessionId, traceId, 结构开销等

    return Math.ceil(total * this.config.jsonOverheadFactor);
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * 估算单个 StageResult 的 token 数
   */
  estimateStageResult(result: any): number {
    return this.estimateObject(result);
  }

  /**
   * 估算 findings 数组的 token 数
   */
  estimateFindings(findings: any[]): number {
    return this.estimateArray(findings);
  }

  /**
   * 获取配置
   */
  getConfig(): TokenEstimatorConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TokenEstimatorConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// =============================================================================
// Singleton and Factory
// =============================================================================

let _globalTokenEstimator: TokenEstimator | null = null;

/**
 * 获取全局 Token 估算器
 */
export function getTokenEstimator(): TokenEstimator {
  if (!_globalTokenEstimator) {
    _globalTokenEstimator = new TokenEstimator();
  }
  return _globalTokenEstimator;
}

/**
 * 创建 Token 估算器
 */
export function createTokenEstimator(
  config: Partial<TokenEstimatorConfig> = {}
): TokenEstimator {
  return new TokenEstimator(config);
}

export default TokenEstimator;
