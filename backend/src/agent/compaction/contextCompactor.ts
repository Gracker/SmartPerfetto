/**
 * Context Compactor
 *
 * 上下文压缩服务
 * 当上下文超过阈值时自动压缩，防止 token 溢出
 */

import {
  CompactionConfig,
  CompactionResult,
  CompactionStrategy,
  ICompactionStrategy,
  CompactorState,
  DEFAULT_COMPACTION_CONFIG,
} from './compactionTypes';
import { SubAgentContext } from '../types';
import { TokenEstimator, getTokenEstimator } from './tokenEstimator';
import { SlidingWindowStrategy } from './strategies/slidingWindowStrategy';

// =============================================================================
// Context Compactor
// =============================================================================

/**
 * Context Compactor 配置
 */
export interface ContextCompactorConfig extends CompactionConfig {
  /** 是否启用 */
  enabled: boolean;

  /** 是否记录压缩操作 */
  logCompaction?: boolean;
}

/**
 * 默认配置
 */
export const DEFAULT_CONTEXT_COMPACTOR_CONFIG: ContextCompactorConfig = {
  ...DEFAULT_COMPACTION_CONFIG,
  enabled: true,  // 默认启用，防止 token 溢出
  logCompaction: false,
};

/**
 * Context Compactor
 */
export class ContextCompactor {
  private config: ContextCompactorConfig;
  private tokenEstimator: TokenEstimator;
  private strategies: Map<CompactionStrategy, ICompactionStrategy>;
  private sessionStates: Map<string, CompactorState>;

  constructor(config: Partial<ContextCompactorConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_COMPACTOR_CONFIG, ...config };
    this.tokenEstimator = getTokenEstimator();
    this.strategies = new Map();
    this.sessionStates = new Map();

    // 注册内置策略
    this.registerStrategy(new SlidingWindowStrategy(this.tokenEstimator));
  }

  // ===========================================================================
  // Strategy Management
  // ===========================================================================

  /**
   * 注册压缩策略
   */
  registerStrategy(strategy: ICompactionStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * 获取策略
   */
  getStrategy(name: CompactionStrategy): ICompactionStrategy | undefined {
    return this.strategies.get(name);
  }

  // ===========================================================================
  // Main Methods
  // ===========================================================================

  /**
   * 检查是否需要压缩
   */
  needsCompaction(context: SubAgentContext): boolean {
    if (!this.config.enabled) {
      return false;
    }

    return this.tokenEstimator.needsCompaction(
      context,
      this.config.compactionThreshold
    );
  }

  /**
   * 执行压缩
   */
  async compact(
    context: SubAgentContext,
    reason: 'threshold_exceeded' | 'manual' | 'pre_iteration' = 'threshold_exceeded'
  ): Promise<CompactionResult> {
    // 获取策略
    const strategy = this.strategies.get(this.config.strategy);
    if (!strategy) {
      throw new Error(`Unknown compaction strategy: ${this.config.strategy}`);
    }

    // 执行压缩
    const result = await strategy.compact(context, this.config);
    result.metadata.reason = reason;

    // 更新会话状态
    this.updateSessionState(context.sessionId, result);

    // 记录日志
    if (this.config.logCompaction) {
      this.logCompactionResult(result);
    }

    return result;
  }

  /**
   * 自动压缩（如果需要）
   */
  async compactIfNeeded(context: SubAgentContext): Promise<SubAgentContext> {
    if (!this.needsCompaction(context)) {
      return context;
    }

    const result = await this.compact(context, 'threshold_exceeded');
    return result.compactedContext;
  }

  /**
   * 估算上下文 token 数
   */
  estimateTokens(context: SubAgentContext): number {
    return this.tokenEstimator.estimate(context).total;
  }

  /**
   * 获取详细的 token 估算
   */
  getDetailedEstimate(context: SubAgentContext) {
    return this.tokenEstimator.estimateWithThreshold(context, this.config);
  }

  // ===========================================================================
  // Session State Management
  // ===========================================================================

  /**
   * 获取会话压缩状态
   */
  getSessionState(sessionId: string): CompactorState | undefined {
    return this.sessionStates.get(sessionId);
  }

  /**
   * 更新会话状态
   */
  private updateSessionState(sessionId: string, result: CompactionResult): void {
    let state = this.sessionStates.get(sessionId);

    if (!state) {
      state = {
        sessionId,
        compactionCount: 0,
        totalRemovedResults: 0,
        totalRemovedFindings: 0,
        accumulatedSummaries: [],
        lastCompactionTime: 0,
      };
    }

    state.compactionCount++;
    state.totalRemovedResults += result.removedResultsCount;
    state.totalRemovedFindings += result.removedFindingsCount;
    state.lastCompactionTime = result.metadata.timestamp;

    if (result.summary) {
      state.accumulatedSummaries.push(result.summary);
    }

    this.sessionStates.set(sessionId, state);
  }

  /**
   * 清除会话状态
   */
  clearSessionState(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * 启用/禁用压缩
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ContextCompactorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): ContextCompactorConfig {
    return { ...this.config };
  }

  // ===========================================================================
  // Logging
  // ===========================================================================

  /**
   * 记录压缩结果
   */
  private logCompactionResult(result: CompactionResult): void {
    console.log(`[ContextCompactor] Compaction completed:`);
    console.log(`  - Strategy: ${result.metadata.strategy}`);
    console.log(`  - Original tokens: ${result.originalTokens}`);
    console.log(`  - Compacted tokens: ${result.compactedTokens}`);
    console.log(`  - Compression ratio: ${(result.compressionRatio * 100).toFixed(1)}%`);
    console.log(`  - Removed results: ${result.removedResultsCount}`);
    console.log(`  - Removed findings: ${result.removedFindingsCount}`);
    console.log(`  - Has summary: ${result.hasSummary}`);
  }
}

// =============================================================================
// Singleton and Factory
// =============================================================================

let _globalContextCompactor: ContextCompactor | null = null;

/**
 * 获取全局 Context Compactor
 */
export function getContextCompactor(): ContextCompactor {
  if (!_globalContextCompactor) {
    _globalContextCompactor = new ContextCompactor();
  }
  return _globalContextCompactor;
}

/**
 * 设置全局 Context Compactor
 */
export function setContextCompactor(compactor: ContextCompactor): void {
  _globalContextCompactor = compactor;
}

/**
 * 重置全局 Context Compactor
 */
export function resetContextCompactor(): void {
  _globalContextCompactor = null;
}

/**
 * 创建 Context Compactor
 */
export function createContextCompactor(
  config: Partial<ContextCompactorConfig> = {}
): ContextCompactor {
  return new ContextCompactor(config);
}

export default ContextCompactor;
