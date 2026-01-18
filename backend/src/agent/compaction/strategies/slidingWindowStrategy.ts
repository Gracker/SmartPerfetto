/**
 * Sliding Window Strategy
 *
 * 滑动窗口压缩策略
 * 保留最近 N 个结果，将历史结果压缩为摘要
 */

import {
  ICompactionStrategy,
  CompactionConfig,
  CompactionResult,
  CompactionSummary,
  CompactionMetadata,
} from '../compactionTypes';
import { SubAgentContext, StageResult, Finding } from '../../types';
import { TokenEstimator, getTokenEstimator } from '../tokenEstimator';

// =============================================================================
// Sliding Window Strategy
// =============================================================================

/**
 * 滑动窗口压缩策略
 */
export class SlidingWindowStrategy implements ICompactionStrategy {
  name: 'sliding_window' = 'sliding_window';
  private tokenEstimator: TokenEstimator;

  constructor(tokenEstimator?: TokenEstimator) {
    this.tokenEstimator = tokenEstimator || getTokenEstimator();
  }

  // ===========================================================================
  // Main Methods
  // ===========================================================================

  /**
   * 执行压缩
   */
  async compact(
    context: SubAgentContext,
    config: CompactionConfig
  ): Promise<CompactionResult> {
    const originalEstimate = this.tokenEstimator.estimate(context);
    const originalTokens = originalEstimate.total;

    // 如果没有历史结果，直接返回
    if (!context.previousResults || context.previousResults.length === 0) {
      return this.createNoCompactionResult(context, originalTokens);
    }

    const results = context.previousResults;
    const preserveCount = config.preserveRecentCount;

    // 如果结果数量不超过保留数，不需要压缩
    if (results.length <= preserveCount) {
      return this.createNoCompactionResult(context, originalTokens);
    }

    // 分离：保留的结果 vs 要压缩的结果
    const resultsToCompress = results.slice(0, -preserveCount);
    const resultsToPreserve = results.slice(-preserveCount);

    // 收集所有要压缩的发现
    const findingsToCompress: Finding[] = [];
    for (const result of resultsToCompress) {
      if (result.findings) {
        findingsToCompress.push(...result.findings);
      }
    }

    // 根据配置决定是否保留 critical findings
    let preservedCriticalFindings: Finding[] = [];
    if (config.preserveCriticalFindings) {
      preservedCriticalFindings = findingsToCompress.filter(
        f => f.severity === 'critical'
      );
    }

    // 生成摘要
    const summary = this.generateSummary(
      resultsToCompress,
      findingsToCompress,
      preservedCriticalFindings
    );

    // 构建压缩后的上下文
    const compactedContext: SubAgentContext = {
      ...context,
      previousResults: resultsToPreserve,
      // 添加压缩摘要到 metadata
      compactionSummary: summary,
      preservedCriticalFindings:
        preservedCriticalFindings.length > 0 ? preservedCriticalFindings : undefined,
    } as SubAgentContext & {
      compactionSummary?: CompactionSummary;
      preservedCriticalFindings?: Finding[];
    };

    // 计算压缩后的 token 数
    const compactedEstimate = this.tokenEstimator.estimate(compactedContext);
    const compactedTokens = compactedEstimate.total;

    // 构建元数据
    const metadata: CompactionMetadata = {
      timestamp: Date.now(),
      strategy: this.name,
      originalIterations: results.length,
      preservedIterations: resultsToPreserve.length,
      reason: 'threshold_exceeded',
    };

    return {
      compactedContext,
      originalTokens,
      compactedTokens,
      compressionRatio: 1 - compactedTokens / originalTokens,
      removedResultsCount: resultsToCompress.length,
      removedFindingsCount: findingsToCompress.length - preservedCriticalFindings.length,
      hasSummary: true,
      summary,
      metadata,
    };
  }

  /**
   * 估算压缩后的 token 数
   */
  estimateCompactedTokens(
    context: SubAgentContext,
    config: CompactionConfig
  ): number {
    if (!context.previousResults || context.previousResults.length <= config.preserveRecentCount) {
      return this.tokenEstimator.estimate(context).total;
    }

    // 估算保留的结果
    const preservedResults = context.previousResults.slice(-config.preserveRecentCount);
    const preservedTokens = this.tokenEstimator.estimateArray(preservedResults);

    // 估算摘要（大约 300-500 tokens）
    const summaryTokens = 400;

    // 估算其他字段
    const otherTokens =
      this.tokenEstimator.estimateObject(context.intent) +
      this.tokenEstimator.estimateObject(context.plan) +
      200; // 基础开销

    return preservedTokens + summaryTokens + otherTokens;
  }

  // ===========================================================================
  // Summary Generation
  // ===========================================================================

  /**
   * 生成规则基础的摘要
   */
  private generateSummary(
    compressedResults: StageResult[],
    compressedFindings: Finding[],
    preservedCriticalFindings: Finding[]
  ): CompactionSummary {
    // 统计信息
    const successCount = compressedResults.filter(r => r.success).length;
    const failureCount = compressedResults.length - successCount;
    const criticalCount = compressedFindings.filter(f => f.severity === 'critical').length;
    const warningCount = compressedFindings.filter(f => f.severity === 'warning').length;

    // 生成历史结果摘要
    const historicalResultsSummary = this.generateHistoricalSummary(
      compressedResults,
      successCount,
      failureCount
    );

    // 生成关键发现摘要
    const keyFindingsSummary = this.generateFindingsSummary(
      compressedFindings,
      criticalCount,
      warningCount,
      preservedCriticalFindings
    );

    return {
      historicalResultsSummary,
      keyFindingsSummary,
      compactedIterations: {
        from: 1,
        to: compressedResults.length,
      },
      generatedBy: 'rule',
    };
  }

  /**
   * 生成历史结果摘要文本
   */
  private generateHistoricalSummary(
    results: StageResult[],
    successCount: number,
    failureCount: number
  ): string {
    const stageIds = results.map(r => r.stageId);
    const uniqueStages = [...new Set(stageIds)];

    let summary = `已压缩 ${results.length} 个历史结果。`;
    summary += ` 成功: ${successCount}, 失败: ${failureCount}。`;
    summary += ` 涉及阶段: ${uniqueStages.join(', ')}。`;

    // 添加时间信息（如果有）
    if (results.length > 0 && results[0].startTime && results[results.length - 1].endTime) {
      const duration = results[results.length - 1].endTime! - results[0].startTime;
      summary += ` 总耗时: ${(duration / 1000).toFixed(1)}s。`;
    }

    return summary;
  }

  /**
   * 生成发现摘要文本
   */
  private generateFindingsSummary(
    findings: Finding[],
    criticalCount: number,
    warningCount: number,
    preservedCritical: Finding[]
  ): string {
    const infoCount = findings.length - criticalCount - warningCount;

    let summary = `历史发现统计: `;
    summary += `Critical: ${criticalCount}, Warning: ${warningCount}, Info: ${infoCount}。`;

    if (preservedCritical.length > 0) {
      summary += ` 保留的 Critical 发现: `;
      summary += preservedCritical.map(f => f.title).join('; ');
      summary += '。';
    }

    // 列出主要问题类型（去重）
    const categories = [...new Set(findings.map(f => f.category).filter(Boolean))];
    if (categories.length > 0) {
      summary += ` 涉及类别: ${categories.slice(0, 5).join(', ')}`;
      if (categories.length > 5) {
        summary += ` 等 ${categories.length} 个类别`;
      }
      summary += '。';
    }

    return summary;
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * 创建无压缩结果
   */
  private createNoCompactionResult(
    context: SubAgentContext,
    tokenCount: number
  ): CompactionResult {
    return {
      compactedContext: context,
      originalTokens: tokenCount,
      compactedTokens: tokenCount,
      compressionRatio: 0,
      removedResultsCount: 0,
      removedFindingsCount: 0,
      hasSummary: false,
      metadata: {
        timestamp: Date.now(),
        strategy: this.name,
        originalIterations: context.previousResults?.length || 0,
        preservedIterations: context.previousResults?.length || 0,
        reason: 'threshold_exceeded',
      },
    };
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * 创建滑动窗口策略
 */
export function createSlidingWindowStrategy(
  tokenEstimator?: TokenEstimator
): SlidingWindowStrategy {
  return new SlidingWindowStrategy(tokenEstimator);
}

export default SlidingWindowStrategy;
