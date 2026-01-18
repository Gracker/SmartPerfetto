/**
 * SmartPerfetto Agent Circuit Breaker
 *
 * 断路器模式实现，负责：
 * 1. 监控 Agent 失败次数
 * 2. 在达到阈值时熔断
 * 3. 实现指数退避重试
 * 4. 触发用户介入机制
 */

import { EventEmitter } from 'events';
import {
  CircuitState,
  CircuitBreakerConfig,
  CircuitDecision,
  CircuitDiagnostics,
  CircuitBreakerState,
} from '../types';
import { circuitBreakerConfig as cbConfig } from '../../config';

// 默认配置 (从统一配置文件获取)
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxRetriesPerAgent: cbConfig.maxRetriesPerAgent,
  maxIterationsPerStage: cbConfig.maxIterationsPerStage,
  cooldownMs: cbConfig.cooldownMs,
  halfOpenAttempts: cbConfig.halfOpenAttempts,
  failureThreshold: cbConfig.failureThreshold,
  successThreshold: cbConfig.successThreshold,
};

/**
 * 断路器实现
 *
 * 状态转换：
 * - closed: 正常状态，允许请求通过
 * - open: 熔断状态，拒绝请求，等待冷却
 * - half-open: 半开状态，允许有限请求测试恢复
 */
export class CircuitBreaker extends EventEmitter {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.createInitialState();
  }

  private createInitialState(): CircuitBreakerState {
    return {
      state: 'closed',
      retryCounters: new Map(),
      iterationCounters: new Map(),
      failureHistory: new Map(),
      lastStateChange: Date.now(),
      tripReason: undefined,
    };
  }

  // ==========================================================================
  // 状态查询
  // ==========================================================================

  get circuitState(): CircuitState {
    return this.state.state;
  }

  get isTripped(): boolean {
    return this.state.state === 'open';
  }

  get isHalfOpen(): boolean {
    return this.state.state === 'half-open';
  }

  get isClosed(): boolean {
    return this.state.state === 'closed';
  }

  get tripReason(): string | undefined {
    return this.state.tripReason;
  }

  // ==========================================================================
  // 失败记录
  // ==========================================================================

  /**
   * 记录 Agent 失败
   */
  recordFailure(agentId: string, error?: string): CircuitDecision {
    const count = (this.state.retryCounters.get(agentId) || 0) + 1;
    this.state.retryCounters.set(agentId, count);

    // 记录失败历史
    this.addToFailureHistory(agentId, error || 'Unknown error');

    // 触发事件
    this.emit('failure', { agentId, count, error });

    // 检查是否需要熔断
    if (count >= this.config.maxRetriesPerAgent) {
      return this.trip(`Agent ${agentId} 失败次数达到上限 (${count}/${this.config.maxRetriesPerAgent})`);
    }

    // 返回重试决策
    return {
      action: 'retry',
      delay: this.calculateBackoff(count),
      reason: `重试第 ${count} 次`,
    };
  }

  /**
   * 记录阶段迭代
   */
  recordIteration(stageId: string): CircuitDecision {
    const count = (this.state.iterationCounters.get(stageId) || 0) + 1;
    this.state.iterationCounters.set(stageId, count);

    // 触发事件
    this.emit('iteration', { stageId, count });

    // 检查是否超过最大迭代次数
    if (count >= this.config.maxIterationsPerStage) {
      return {
        action: 'ask_user',
        reason: `阶段 ${stageId} 已迭代 ${count} 次，需要用户决策`,
        context: this.getDiagnostics(stageId),
      };
    }

    return { action: 'continue' };
  }

  /**
   * 记录成功
   */
  recordSuccess(agentId: string): void {
    // 重置该 Agent 的失败计数
    this.state.retryCounters.set(agentId, 0);

    // 如果处于半开状态，检查是否可以关闭断路器
    if (this.state.state === 'half-open') {
      this.checkHalfOpenRecovery();
    }

    this.emit('success', { agentId });
  }

  // ==========================================================================
  // 断路器状态管理
  // ==========================================================================

  /**
   * 触发熔断
   */
  private trip(reason: string): CircuitDecision {
    this.state.state = 'open';
    this.state.tripReason = reason;
    this.state.lastStateChange = Date.now();

    this.emit('tripped', { reason, diagnostics: this.getAllDiagnostics() });

    // 启动冷却计时器
    this.scheduleCooldown();

    return {
      action: 'ask_user',
      reason,
      context: this.getAllDiagnostics(),
    };
  }

  /**
   * 进入半开状态
   */
  private halfOpen(): void {
    this.state.state = 'half-open';
    this.state.lastStateChange = Date.now();
    this.emit('halfOpen');
  }

  /**
   * 关闭断路器（恢复正常）
   */
  private close(): void {
    this.state.state = 'closed';
    this.state.tripReason = undefined;
    this.state.lastStateChange = Date.now();
    this.emit('closed');
  }

  /**
   * 检查半开状态是否可以恢复
   */
  private checkHalfOpenRecovery(): void {
    // 简化实现：第一次成功就关闭
    this.close();
  }

  /**
   * 安排冷却后的状态转换
   */
  private scheduleCooldown(): void {
    setTimeout(() => {
      if (this.state.state === 'open') {
        this.halfOpen();
      }
    }, this.config.cooldownMs);
  }

  // ==========================================================================
  // 退避算法
  // ==========================================================================

  /**
   * 计算指数退避延迟
   */
  private calculateBackoff(attemptNumber: number): number {
    // 指数退避：使用配置的基础延迟和最大延迟
    const baseDelay = cbConfig.backoffBaseDelayMs;
    const maxDelay = cbConfig.backoffMaxDelayMs;
    const delay = Math.min(baseDelay * Math.pow(2, attemptNumber - 1), maxDelay);

    // 添加抖动 (±20%)
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  // ==========================================================================
  // 诊断信息
  // ==========================================================================

  /**
   * 获取单个 Agent 的诊断信息
   */
  getDiagnostics(agentId: string): CircuitDiagnostics {
    const history = this.state.failureHistory.get(agentId) || [];
    const recentErrors = history.slice(-5); // 最近 5 条错误

    return {
      agentId,
      failureCount: this.state.retryCounters.get(agentId) || 0,
      iterationCount: this.state.iterationCounters.get(agentId) || 0,
      lastError: recentErrors.length > 0 ? recentErrors[recentErrors.length - 1].error : undefined,
      lastAttemptTime: recentErrors.length > 0 ? recentErrors[recentErrors.length - 1].time : 0,
      state: this.state.state,
      recentErrors,
    };
  }

  /**
   * 获取所有诊断信息
   */
  getAllDiagnostics(): CircuitDiagnostics {
    const allErrors: Array<{ time: number; error: string }> = [];
    let totalFailures = 0;
    let totalIterations = 0;

    for (const [, count] of this.state.retryCounters) {
      totalFailures += count;
    }

    for (const [, count] of this.state.iterationCounters) {
      totalIterations += count;
    }

    for (const [, history] of this.state.failureHistory) {
      allErrors.push(...history);
    }

    // 按时间排序
    allErrors.sort((a, b) => b.time - a.time);

    return {
      agentId: '*',
      failureCount: totalFailures,
      iterationCount: totalIterations,
      lastError: allErrors.length > 0 ? allErrors[0].error : undefined,
      lastAttemptTime: allErrors.length > 0 ? allErrors[0].time : 0,
      state: this.state.state,
      recentErrors: allErrors.slice(0, 10),
    };
  }

  /**
   * 添加失败历史记录
   */
  private addToFailureHistory(agentId: string, error: string): void {
    const history = this.state.failureHistory.get(agentId) || [];
    history.push({ time: Date.now(), error });

    // 保留最近 20 条
    if (history.length > 20) {
      history.shift();
    }

    this.state.failureHistory.set(agentId, history);
  }

  // ==========================================================================
  // 请求检查
  // ==========================================================================

  /**
   * 检查是否允许执行
   */
  canExecute(): CircuitDecision {
    switch (this.state.state) {
      case 'closed':
        return { action: 'continue' };

      case 'open':
        // 检查是否已过冷却期
        const elapsed = Date.now() - this.state.lastStateChange;
        if (elapsed >= this.config.cooldownMs) {
          this.halfOpen();
          return { action: 'continue', reason: '断路器进入半开状态' };
        }
        return {
          action: 'ask_user',
          reason: this.state.tripReason || '断路器已熔断',
          context: this.getAllDiagnostics(),
        };

      case 'half-open':
        return { action: 'continue', reason: '断路器半开状态，测试中' };

      default:
        return { action: 'continue' };
    }
  }

  // ==========================================================================
  // 重置和清理
  // ==========================================================================

  /**
   * 重置单个 Agent 的计数器
   */
  resetAgent(agentId: string): void {
    this.state.retryCounters.set(agentId, 0);
    this.state.iterationCounters.set(agentId, 0);
    this.state.failureHistory.delete(agentId);
    this.emit('agentReset', { agentId });
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    this.state = this.createInitialState();
    this.emit('reset');
  }

  /**
   * 手动关闭断路器（用户干预后）
   */
  forceClose(): void {
    this.close();
    this.emit('forceClosed');
  }

  /**
   * 手动触发熔断（用于测试）
   */
  forceTrip(reason: string): CircuitDecision {
    return this.trip(reason);
  }

  // ==========================================================================
  // 用户响应处理
  // ==========================================================================

  /**
   * 处理用户响应
   */
  handleUserResponse(decision: 'continue' | 'abort' | 'skip'): CircuitDecision {
    switch (decision) {
      case 'continue':
        this.forceClose();
        return { action: 'continue', reason: '用户选择继续' };

      case 'abort':
        return { action: 'abort', reason: '用户选择中止' };

      case 'skip':
        return { action: 'skip', reason: '用户选择跳过当前阶段' };

      default:
        return { action: 'abort', reason: '未知用户决策' };
    }
  }

  // ==========================================================================
  // 配置更新
  // ==========================================================================

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configUpdated', this.config);
  }

  /**
   * 获取当前配置
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  // ==========================================================================
  // 序列化
  // ==========================================================================

  /**
   * 导出状态（用于持久化）
   */
  exportState(): CircuitBreakerState {
    return {
      ...this.state,
      retryCounters: new Map(this.state.retryCounters),
      iterationCounters: new Map(this.state.iterationCounters),
      failureHistory: new Map(this.state.failureHistory),
    };
  }

  /**
   * 导入状态（用于恢复）
   */
  importState(state: CircuitBreakerState): void {
    this.state = {
      ...state,
      retryCounters: new Map(state.retryCounters),
      iterationCounters: new Map(state.iterationCounters),
      failureHistory: new Map(state.failureHistory),
    };
    this.emit('stateImported');
  }
}

export default CircuitBreaker;
