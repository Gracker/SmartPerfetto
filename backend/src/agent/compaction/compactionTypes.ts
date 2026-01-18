/**
 * Context Compaction Types
 *
 * 定义 Context 压缩系统的核心类型
 */

import { SubAgentContext, StageResult, Finding } from '../types';

// =============================================================================
// Compaction Strategy
// =============================================================================

/**
 * 压缩策略类型
 */
export type CompactionStrategy =
  | 'sliding_window'  // 滑动窗口：保留最近 N 个结果
  | 'severity'        // 按严重程度：优先保留高优先级发现
  | 'hybrid';         // 混合策略：滑动窗口 + 严重程度

/**
 * 压缩策略接口
 */
export interface ICompactionStrategy {
  /** 策略名称 */
  name: CompactionStrategy;

  /**
   * 压缩上下文
   * @param context 原始上下文
   * @param config 压缩配置
   * @returns 压缩后的上下文和元数据
   */
  compact(
    context: SubAgentContext,
    config: CompactionConfig
  ): Promise<CompactionResult>;

  /**
   * 估算压缩后的 token 数
   */
  estimateCompactedTokens(
    context: SubAgentContext,
    config: CompactionConfig
  ): number;
}

// =============================================================================
// Compaction Configuration
// =============================================================================

/**
 * 压缩配置
 */
export interface CompactionConfig {
  /** 最大上下文 token 数（默认 8000） */
  maxContextTokens: number;

  /** 触发压缩的阈值（默认 6000，即 80%） */
  compactionThreshold: number;

  /** 保留最近的结果数量（默认 3） */
  preserveRecentCount: number;

  /** 压缩策略 */
  strategy: CompactionStrategy;

  /** 是否使用 LLM 生成摘要（成本更高但质量更好） */
  useLLMSummarization: boolean;

  /** LLM 摘要的最大 token 数 */
  summaryMaxTokens?: number;

  /** 是否保留所有 critical 发现 */
  preserveCriticalFindings?: boolean;

  /** 自定义字段权重（用于决定保留优先级） */
  fieldWeights?: Partial<Record<CompactableField, number>>;
}

/**
 * 可压缩的字段
 */
export type CompactableField =
  | 'previousResults'
  | 'findings'
  | 'plan'
  | 'intent';

/**
 * 默认配置
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  maxContextTokens: 8000,
  compactionThreshold: 6000,  // 80%
  preserveRecentCount: 3,
  strategy: 'sliding_window',
  useLLMSummarization: false,
  summaryMaxTokens: 500,
  preserveCriticalFindings: true,
  fieldWeights: {
    previousResults: 0.6,  // 最大占比
    findings: 0.2,
    plan: 0.1,
    intent: 0.1,
  },
};

// =============================================================================
// Compaction Result
// =============================================================================

/**
 * 压缩结果
 */
export interface CompactionResult {
  /** 压缩后的上下文 */
  compactedContext: SubAgentContext;

  /** 原始 token 数 */
  originalTokens: number;

  /** 压缩后 token 数 */
  compactedTokens: number;

  /** 压缩率 (0-1) */
  compressionRatio: number;

  /** 被移除的结果数量 */
  removedResultsCount: number;

  /** 被移除的发现数量 */
  removedFindingsCount: number;

  /** 是否生成了摘要 */
  hasSummary: boolean;

  /** 摘要内容（如果有） */
  summary?: CompactionSummary;

  /** 压缩元数据 */
  metadata: CompactionMetadata;
}

/**
 * 压缩摘要
 */
export interface CompactionSummary {
  /** 历史结果摘要 */
  historicalResultsSummary: string;

  /** 关键发现摘要 */
  keyFindingsSummary: string;

  /** 被压缩的迭代范围 */
  compactedIterations: {
    from: number;
    to: number;
  };

  /** 摘要生成方式 */
  generatedBy: 'rule' | 'llm';
}

/**
 * 压缩元数据
 */
export interface CompactionMetadata {
  /** 压缩时间戳 */
  timestamp: number;

  /** 使用的策略 */
  strategy: CompactionStrategy;

  /** 压缩前的迭代次数 */
  originalIterations: number;

  /** 压缩后保留的迭代次数 */
  preservedIterations: number;

  /** 压缩原因 */
  reason: 'threshold_exceeded' | 'manual' | 'pre_iteration';
}

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Token 估算结果
 */
export interface TokenEstimate {
  /** 总 token 数 */
  total: number;

  /** 各字段的 token 数 */
  breakdown: {
    sessionId: number;
    traceId: number;
    intent: number;
    plan: number;
    previousResults: number;
    findings: number;
    other: number;
  };

  /** 是否超过阈值 */
  exceedsThreshold: boolean;

  /** 建议的压缩量 */
  suggestedReduction: number;
}

/**
 * Token 估算器配置
 */
export interface TokenEstimatorConfig {
  /** 平均每个字符的 token 数（中文约 0.5，英文约 0.25） */
  charsPerToken: number;

  /** JSON 结构开销因子 */
  jsonOverheadFactor: number;
}

/**
 * 默认 Token 估算器配置
 */
export const DEFAULT_TOKEN_ESTIMATOR_CONFIG: TokenEstimatorConfig = {
  charsPerToken: 0.4,  // 中英文混合估算
  jsonOverheadFactor: 1.2,  // JSON 结构额外开销
};

// =============================================================================
// Compactor State
// =============================================================================

/**
 * 压缩器状态（用于跟踪压缩历史）
 */
export interface CompactorState {
  /** 会话 ID */
  sessionId: string;

  /** 已执行的压缩次数 */
  compactionCount: number;

  /** 累计移除的结果数 */
  totalRemovedResults: number;

  /** 累计移除的发现数 */
  totalRemovedFindings: number;

  /** 历史摘要（累积） */
  accumulatedSummaries: CompactionSummary[];

  /** 上次压缩时间 */
  lastCompactionTime: number;
}
