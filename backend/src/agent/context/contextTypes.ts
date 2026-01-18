/**
 * Context Isolation Types
 *
 * 定义 Context 隔离系统的核心类型
 * 借鉴 Claude Agent SDK 的 Context 管理理念
 */

import { SubAgentContext, StageResult, Finding, Intent, AnalysisPlan } from '../types';

// =============================================================================
// Context Field Definitions
// =============================================================================

/**
 * 可见字段枚举
 * 定义 SubAgentContext 中可以被策略控制的字段
 */
export type ContextField =
  // 基础标识
  | 'sessionId'
  | 'traceId'

  // 分析相关
  | 'intent'
  | 'plan'
  | 'previousResults'

  // 服务和工具
  | 'traceProcessor'
  | 'traceProcessorService'

  // 元数据
  | 'metadata';

/**
 * 字段可见性级别
 */
export type VisibilityLevel =
  | 'full'      // 完整访问
  | 'summary'   // 只看摘要
  | 'none';     // 不可见

/**
 * 字段可见性配置
 */
export interface FieldVisibility {
  field: ContextField;
  level: VisibilityLevel;
}

// =============================================================================
// Context Policy Interface
// =============================================================================

/**
 * Context 策略接口
 * 定义如何为特定角色过滤上下文
 */
export interface ContextPolicy {
  /** 策略名称 */
  name: string;

  /** 适用的 Agent 类型 */
  agentTypes: string[];

  /** 可见字段配置 */
  visibleFields: FieldVisibility[];

  /**
   * 过滤之前阶段的结果
   * @param results 所有之前的阶段结果
   * @returns 过滤后的结果
   */
  filterPreviousResults(results: StageResult[]): StageResult[];

  /**
   * 过滤发现
   * @param findings 所有发现
   * @returns 过滤后的发现
   */
  filterFindings(findings: Finding[]): Finding[];

  /**
   * 转换 Intent（可选，用于简化）
   * @param intent 原始 Intent
   * @returns 转换后的 Intent（可能是摘要）
   */
  transformIntent?(intent: Intent): Intent | IntentSummary;

  /**
   * 转换 Plan（可选，用于简化）
   * @param plan 原始 Plan
   * @returns 转换后的 Plan（可能是摘要）
   */
  transformPlan?(plan: AnalysisPlan): AnalysisPlan | PlanSummary;
}

// =============================================================================
// Summary Types (用于简化传递的数据)
// =============================================================================

/**
 * Intent 摘要（减少 token）
 */
export interface IntentSummary {
  primaryGoal: string;
  analysisType: string;
  isSummary: true;
}

/**
 * Plan 摘要（减少 token）
 */
export interface PlanSummary {
  totalSteps: number;
  currentStep?: number;
  stepNames: string[];
  isSummary: true;
}

/**
 * StageResult 摘要
 */
export interface StageResultSummary {
  stageId: string;
  success: boolean;
  findingCount: number;
  criticalCount: number;
  warningCount: number;
  isSummary: true;
}

// =============================================================================
// Isolated Context
// =============================================================================

/**
 * 隔离后的上下文
 * 继承 SubAgentContext 但某些字段可能被简化或移除
 */
export interface IsolatedContext extends Omit<SubAgentContext, 'intent' | 'plan' | 'previousResults'> {
  /** Intent（可能是完整或摘要） */
  intent?: Intent | IntentSummary;

  /** Plan（可能是完整或摘要） */
  plan?: AnalysisPlan | PlanSummary;

  /** 之前的结果（可能被过滤或摘要化） */
  previousResults?: (StageResult | StageResultSummary)[];

  /** 标记这是隔离后的上下文 */
  isIsolated: true;

  /** 应用的策略名称 */
  appliedPolicy: string;
}

// =============================================================================
// Context Builder Config
// =============================================================================

/**
 * Context Builder 配置
 */
export interface ContextBuilderConfig {
  /** 是否启用隔离 */
  enabled: boolean;

  /** 默认策略（当没有匹配的策略时） */
  defaultPolicy?: string;

  /** 是否记录隔离操作 */
  logIsolation?: boolean;

  /** 自定义策略映射 */
  customPolicies?: Map<string, ContextPolicy>;
}

/**
 * 默认配置
 */
export const DEFAULT_CONTEXT_BUILDER_CONFIG: ContextBuilderConfig = {
  enabled: true,  // 默认启用，减少 token 浪费
  logIsolation: false,
};
