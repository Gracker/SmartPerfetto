/**
 * Context Builder
 *
 * 根据策略构建隔离的上下文
 * 为不同角色的 Agent 提供适当的可见性
 */

import {
  ContextPolicy,
  ContextBuilderConfig,
  IsolatedContext,
  DEFAULT_CONTEXT_BUILDER_CONFIG,
  FieldVisibility,
  VisibilityLevel,
} from './contextTypes';
import { SubAgentContext, PipelineStage } from '../types';
import { plannerPolicy, evaluatorPolicy, workerPolicy } from './policies';

// =============================================================================
// Context Builder
// =============================================================================

/**
 * Context Builder 类
 * 负责根据策略构建隔离的上下文
 */
export class ContextBuilder {
  private config: ContextBuilderConfig;
  private policies: Map<string, ContextPolicy>;

  constructor(config: Partial<ContextBuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_BUILDER_CONFIG, ...config };
    this.policies = new Map();

    // 注册内置策略
    this.registerPolicy(plannerPolicy);
    this.registerPolicy(evaluatorPolicy);
    this.registerPolicy(workerPolicy);

    // 注册自定义策略
    if (config.customPolicies) {
      for (const [name, policy] of config.customPolicies) {
        this.registerPolicy(policy);
      }
    }
  }

  // ===========================================================================
  // Policy Management
  // ===========================================================================

  /**
   * 注册策略
   */
  registerPolicy(policy: ContextPolicy): void {
    this.policies.set(policy.name, policy);

    // 也按 agentType 索引
    for (const agentType of policy.agentTypes) {
      if (!this.policies.has(agentType)) {
        this.policies.set(agentType, policy);
      }
    }
  }

  /**
   * 获取策略
   */
  getPolicy(agentTypeOrName: string): ContextPolicy | undefined {
    return this.policies.get(agentTypeOrName);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * 为指定阶段和 Agent 类型构建隔离上下文
   */
  buildContext(
    context: SubAgentContext,
    stage: PipelineStage
  ): SubAgentContext | IsolatedContext {
    // 如果禁用隔离，返回原始上下文
    if (!this.config.enabled) {
      return context;
    }

    // 查找适用的策略
    const policy = this.findPolicy(stage.agentType);

    if (!policy) {
      // 没有匹配的策略，使用默认策略或返回原始上下文
      if (this.config.defaultPolicy) {
        const defaultPolicy = this.policies.get(this.config.defaultPolicy);
        if (defaultPolicy) {
          return this.applyPolicy(context, defaultPolicy, stage.id);
        }
      }
      return context;
    }

    return this.applyPolicy(context, policy, stage.id);
  }

  /**
   * 应用策略到上下文
   */
  private applyPolicy(
    context: SubAgentContext,
    policy: ContextPolicy,
    stageId: string
  ): IsolatedContext {
    if (this.config.logIsolation) {
      console.log(`[ContextBuilder] Applying policy "${policy.name}" for stage "${stageId}"`);
    }

    // 构建隔离上下文
    const isolated: IsolatedContext = {
      sessionId: context.sessionId,
      traceId: context.traceId,
      isIsolated: true,
      appliedPolicy: policy.name,
    };

    // 根据字段可见性设置各字段
    for (const fieldConfig of policy.visibleFields) {
      this.applyFieldVisibility(context, isolated, fieldConfig, policy);
    }

    if (this.config.logIsolation) {
      this.logIsolationResult(context, isolated, policy);
    }

    return isolated;
  }

  /**
   * 应用字段可见性
   */
  private applyFieldVisibility(
    source: SubAgentContext,
    target: IsolatedContext,
    fieldConfig: FieldVisibility,
    policy: ContextPolicy
  ): void {
    const { field, level } = fieldConfig;

    if (level === 'none') {
      // 字段不可见，不复制
      return;
    }

    switch (field) {
      case 'sessionId':
      case 'traceId':
        // 这些已经在构造时设置
        break;

      case 'intent':
        if (source.intent) {
          if (level === 'summary' && policy.transformIntent) {
            target.intent = policy.transformIntent(source.intent);
          } else {
            target.intent = source.intent;
          }
        }
        break;

      case 'plan':
        if (source.plan) {
          if (level === 'summary' && policy.transformPlan) {
            target.plan = policy.transformPlan(source.plan);
          } else {
            target.plan = source.plan;
          }
        }
        break;

      case 'previousResults':
        if (source.previousResults) {
          target.previousResults = policy.filterPreviousResults(source.previousResults);
        }
        break;

      case 'traceProcessor':
        if (level === 'full') {
          (target as any).traceProcessor = (source as any).traceProcessor;
        }
        break;

      case 'traceProcessorService':
        if (level === 'full') {
          (target as any).traceProcessorService = (source as any).traceProcessorService;
        }
        break;

      case 'metadata':
        if (level === 'full' && (source as any).metadata) {
          (target as any).metadata = (source as any).metadata;
        }
        break;
    }
  }

  /**
   * 查找适用的策略
   */
  private findPolicy(agentType: string): ContextPolicy | undefined {
    // 直接按 agentType 查找
    let policy = this.policies.get(agentType);
    if (policy) return policy;

    // 查找包含此 agentType 的策略
    for (const p of this.policies.values()) {
      if (p.agentTypes.includes(agentType)) {
        return p;
      }
    }

    return undefined;
  }

  /**
   * 记录隔离结果
   */
  private logIsolationResult(
    original: SubAgentContext,
    isolated: IsolatedContext,
    policy: ContextPolicy
  ): void {
    const originalSize = this.estimateContextSize(original);
    const isolatedSize = this.estimateContextSize(isolated);
    const reduction = ((originalSize - isolatedSize) / originalSize * 100).toFixed(1);

    console.log(`[ContextBuilder] Isolation result for policy "${policy.name}":`);
    console.log(`  - Original size: ~${originalSize} chars`);
    console.log(`  - Isolated size: ~${isolatedSize} chars`);
    console.log(`  - Reduction: ${reduction}%`);
  }

  /**
   * 估算上下文大小（用于日志）
   */
  private estimateContextSize(context: any): number {
    try {
      return JSON.stringify(context, (key, value) => {
        // 跳过不可序列化的对象
        if (typeof value === 'function') return '[Function]';
        if (value instanceof Map) return '[Map]';
        if (value instanceof Set) return '[Set]';
        return value;
      }).length;
    } catch {
      return 0;
    }
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * 启用/禁用隔离
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
   * 获取所有注册的策略名称
   */
  getPolicyNames(): string[] {
    const names = new Set<string>();
    for (const policy of this.policies.values()) {
      names.add(policy.name);
    }
    return Array.from(names);
  }
}

// =============================================================================
// Singleton and Factory
// =============================================================================

let _globalContextBuilder: ContextBuilder | null = null;

/**
 * 获取全局 Context Builder
 */
export function getContextBuilder(): ContextBuilder {
  if (!_globalContextBuilder) {
    _globalContextBuilder = new ContextBuilder();
  }
  return _globalContextBuilder;
}

/**
 * 设置全局 Context Builder
 */
export function setContextBuilder(builder: ContextBuilder): void {
  _globalContextBuilder = builder;
}

/**
 * 重置全局 Context Builder
 */
export function resetContextBuilder(): void {
  _globalContextBuilder = null;
}

/**
 * 创建 Context Builder（工厂函数）
 */
export function createContextBuilder(
  config: Partial<ContextBuilderConfig> = {}
): ContextBuilder {
  return new ContextBuilder(config);
}

export default ContextBuilder;
